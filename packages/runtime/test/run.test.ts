import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentCapExceededError,
  BudgetExceededError,
  DepthExceededError,
  Limiter,
  runWorkflow,
  type AgentLike,
  type PromptResponseLike,
} from '../src/index.js';

type PromptImpl = (sid: string, text: string, opts?: Record<string, unknown>) => Promise<PromptResponseLike>;

function fakeRuntime(impl: PromptImpl): AgentLike & { calls: { sid: string; text: string }[] } {
  const calls: { sid: string; text: string }[] = [];
  return {
    calls,
    async session(sid = 'default') {
      return {
        prompt(text: string, opts?: Record<string, unknown>) {
          calls.push({ sid, text });
          return impl(sid, text, opts);
        },
      };
    },
  };
}

const usage = (input: number, output: number, costTotal?: number) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  ...(costTotal !== undefined ? { cost: { total: costTotal } } : {}),
});

const echo: PromptImpl = async (_sid, text, opts) => ({
  data: opts?.schema !== undefined ? { echoed: text } : undefined,
  text: `echo: ${text}`,
  usage: usage(100, 50, 0.001),
  model: { id: 'fake/model-1' },
});

describe('agent()', () => {
  it('returns parsed data with a schema, text without', async () => {
    const rt = fakeRuntime(echo);
    const out = await runWorkflow(rt, { runId: 'r1' }, async ({ agent }) => ({
      structured: await agent('hi', { schema: { fake: true } }),
      plain: await agent('hi'),
    }));
    expect(out.structured).toEqual({ echoed: 'hi' });
    expect(out.plain).toBe('echo: hi');
  });

  it('returns null when the subagent throws, and the run continues', async () => {
    let n = 0;
    const rt = fakeRuntime(async (_sid, text) => {
      n++;
      if (text === 'boom') throw new Error('provider 500');
      return { text: 'ok', usage: usage(1, 1, 0.0001), model: { id: 'fake/m' } };
    });
    const out = await runWorkflow(rt, { runId: 'r1' }, async ({ agent }) => [
      await agent('boom'),
      await agent('fine'),
    ]);
    expect(out).toEqual([null, 'ok']);
    expect(n).toBe(2);
  });

  it('forwards model/role/thinkingLevel to the session prompt', async () => {
    let seen: Record<string, unknown> | undefined;
    const rt = fakeRuntime(async (_sid, _text, opts) => {
      seen = opts;
      return { text: 'ok', usage: usage(1, 1, 0.0001), model: { id: 'fake/m' } };
    });
    await runWorkflow(rt, { runId: 'r1' }, ({ agent }) =>
      agent('p', { model: 'deepseek/v4', role: 'finder', thinkingLevel: 'extended' }));
    expect(seen).toMatchObject({ model: 'deepseek/v4', role: 'finder', thinkingLevel: 'extended' });
  });
});

describe('budget', () => {
  it('hard-stops: agent() throws once spent >= budget', async () => {
    const rt = fakeRuntime(async () => ({ text: 'ok', usage: usage(0, 0, 0.6), model: { id: 'fake/m' } }));
    await expect(
      runWorkflow(rt, { runId: 'r1', budgetUsd: 1 }, async ({ agent }) => {
        await agent('a'); // $0.60
        await agent('b'); // $1.20 total — next call must throw
        await agent('c');
        return 'unreachable';
      }),
    ).rejects.toThrow(BudgetExceededError);
    expect(rt.calls.length).toBe(2);
  });

  it('falls back to the pricing table when the provider reports no cost', async () => {
    const rt = fakeRuntime(async () => ({ text: 'ok', usage: usage(1_000_000, 0), model: { id: 'custom/m' } }));
    let spent = 0;
    await runWorkflow(rt, { runId: 'r1', pricing: { 'custom/m': [2, 4] } }, async ({ agent, budget }) => {
      await agent('a');
      spent = budget.spent();
    });
    expect(spent).toBeCloseTo(2);
  });

  it('budget.remaining() is Infinity with no ceiling', async () => {
    const rt = fakeRuntime(echo);
    await runWorkflow(rt, { runId: 'r1' }, async ({ budget }) => {
      expect(budget.total).toBeNull();
      expect(budget.remaining()).toBe(Infinity);
    });
  });
});

describe('parallel() and pipeline()', () => {
  it('parallel isolates thrown thunks to null', async () => {
    const rt = fakeRuntime(echo);
    const out = await runWorkflow(rt, { runId: 'r1' }, ({ parallel }) =>
      parallel([
        () => Promise.resolve(1),
        () => Promise.reject(new Error('nope')),
        () => 3,
      ]));
    expect(out).toEqual([1, null, 3]);
  });

  it('pipeline passes (prev, originalItem, index) and drops throwing items', async () => {
    const rt = fakeRuntime(echo);
    const out = await runWorkflow(rt, { runId: 'r1' }, ({ pipeline }) =>
      pipeline(
        ['a', 'b'],
        (item: string) => item.toUpperCase(),
        (prev: string, original: string, i: number) => {
          if (original === 'b') throw new Error('drop me');
          return `${prev}:${original}:${i}`;
        },
      ));
    expect(out).toEqual(['A:a:0', null]);
  });

  it('respects the concurrency cap', async () => {
    let active = 0, peak = 0;
    const rt = fakeRuntime(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 10));
      active--;
      return { text: 'ok', usage: usage(1, 1, 0.0001), model: { id: 'fake/m' } };
    });
    await runWorkflow(rt, { runId: 'r1', concurrency: 2 }, ({ agent, parallel }) =>
      parallel(Array.from({ length: 6 }, (_, i) => () => agent(`p${i}`))));
    expect(peak).toBe(2);
  });
});

describe('caps', () => {
  it('throws past maxAgents', async () => {
    const rt = fakeRuntime(echo);
    await expect(
      runWorkflow(rt, { runId: 'r1', maxAgents: 2 }, async ({ agent }) => {
        await agent('1');
        await agent('2');
        await agent('3');
      }),
    ).rejects.toThrow(AgentCapExceededError);
  });

  it('caps nested workflow depth', async () => {
    const rt = fakeRuntime(echo);
    await expect(
      runWorkflow(rt, { runId: 'r1', maxDepth: 2 }, async ({ workflow }) =>
        workflow('d1', wf1 =>
          wf1.workflow('d2', wf2 =>
            wf2.workflow('d3', async () => 'too deep')))),
    ).rejects.toThrow(DepthExceededError);
  });

  it('nested workflows share the budget', async () => {
    const rt = fakeRuntime(async () => ({ text: 'ok', usage: usage(0, 0, 0.4), model: { id: 'fake/m' } }));
    await expect(
      runWorkflow(rt, { runId: 'r1', budgetUsd: 1 }, async ({ agent, workflow }) => {
        await agent('outer'); // $0.40
        await workflow('child', async wf => {
          await wf.agent('inner'); // $0.80
          await wf.agent('inner2'); // $1.20 — exhausted
          await wf.agent('inner3'); // throws
        });
      }),
    ).rejects.toThrow(BudgetExceededError);
  });
});

describe('journal + resume', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes events.ndjson and replays cached results on resume', async () => {
    dir = mkdtempSync(join(tmpdir(), 'inception-'));
    const rt1 = fakeRuntime(echo);
    const first = await runWorkflow(rt1, { runId: 'r1', runDir: dir }, async ({ agent, phase }) => {
      phase('Work');
      return [await agent('alpha', { schema: { s: 1 } }), await agent('beta', { schema: { s: 1 } })];
    });
    expect(rt1.calls.length).toBe(2);

    const events = readFileSync(join(dir, 'events.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(events.map(e => e.type)).toEqual([
      'run_start', 'phase', 'agent_start', 'agent_end', 'agent_start', 'agent_end', 'run_end',
    ]);

    // Second run, same script: every agent() hits the journal, zero live calls.
    const rt2 = fakeRuntime(echo);
    const second = await runWorkflow(rt2, { runId: 'r2', runDir: dir }, async ({ agent, phase }) => {
      phase('Work');
      return [await agent('alpha', { schema: { s: 1 } }), await agent('beta', { schema: { s: 1 } })];
    });
    expect(rt2.calls.length).toBe(0);
    expect(second).toEqual(first);
  });

  it('an edited prompt re-runs live while unchanged calls stay cached', async () => {
    dir = mkdtempSync(join(tmpdir(), 'inception-'));
    const rt1 = fakeRuntime(echo);
    await runWorkflow(rt1, { runId: 'r1', runDir: dir }, async ({ agent }) => {
      await agent('stable');
      await agent('original');
    });

    const rt2 = fakeRuntime(echo);
    await runWorkflow(rt2, { runId: 'r2', runDir: dir }, async ({ agent }) => {
      await agent('stable');
      await agent('edited'); // changed → must run live
    });
    expect(rt2.calls.map(c => c.text)).toEqual(['edited']);
  });

  it('resume: false ignores the journal', async () => {
    dir = mkdtempSync(join(tmpdir(), 'inception-'));
    const rt1 = fakeRuntime(echo);
    await runWorkflow(rt1, { runId: 'r1', runDir: dir }, ({ agent }) => agent('x'));
    const rt2 = fakeRuntime(echo);
    await runWorkflow(rt2, { runId: 'r2', runDir: dir, resume: false }, ({ agent }) => agent('x'));
    expect(rt2.calls.length).toBe(1);
  });

  it('identical prompts called N times journal N independent results', async () => {
    dir = mkdtempSync(join(tmpdir(), 'inception-'));
    let n = 0;
    const rt1 = fakeRuntime(async () => ({ text: `v${n++}`, usage: usage(1, 1, 0.0001), model: { id: 'f/m' } }));
    const first = await runWorkflow(rt1, { runId: 'r1', runDir: dir }, ({ agent, parallel }) =>
      parallel([() => agent('same'), () => agent('same')]));
    expect(new Set(first).size).toBe(2);

    const rt2 = fakeRuntime(echo);
    const second = await runWorkflow(rt2, { runId: 'r2', runDir: dir }, ({ agent, parallel }) =>
      parallel([() => agent('same'), () => agent('same')]));
    expect(rt2.calls.length).toBe(0);
    expect(second!.slice().sort()).toEqual(first!.slice().sort());
  });
});

describe('Limiter', () => {
  it('rejects a sub-1 cap', () => {
    expect(() => new Limiter(0)).toThrow();
  });
});
