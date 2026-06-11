import { cpus } from 'node:os';
import { Budget, BudgetExceededError } from './budget.js';
import { Journal } from './journal.js';
import { defaultConcurrency, Limiter } from './limiter.js';
import type { AgentLike, AgentOpts, RunOptions, Stage, Thunk, WorkflowApi } from './types.js';

export class AgentCapExceededError extends Error {
  constructor(cap: number) {
    super(`workflow agent cap exceeded: ${cap} agents already spawned this run`);
    this.name = 'AgentCapExceededError';
  }
}

export class DepthExceededError extends Error {
  constructor(depth: number, max: number) {
    super(`nested workflow depth ${depth} exceeds the cap of ${max}`);
    this.name = 'DepthExceededError';
  }
}

interface Shared {
  runtime: AgentLike;
  runId: string;
  budget: Budget;
  journal: Journal;
  limiter: Limiter;
  maxAgents: number;
  maxDepth: number;
  seq: number;
  agentsSpawned: number;
}

function makeApi(shared: Shared, depth: number, phaseRef: { current: string | undefined }): WorkflowApi {
  const agent = async (prompt: string, opts: AgentOpts = {}): Promise<any> => {
    shared.budget.assertAvailable();

    const sid = `${shared.runId}-a${shared.seq++}`;
    const label = opts.label ?? prompt.slice(0, 60).replace(/\s+/g, ' ');
    const phase = opts.phase ?? phaseRef.current;
    const key = Journal.callKey(prompt, opts);

    // Cached replays spawn nothing: no cap slot, no agent_start — observers see
    // agent_end{status:'cached'} alone.
    const cached = shared.journal.lookup(key);
    if (cached.hit) {
      shared.journal.emit('agent_end', { sid, status: 'cached', label, phase, depth, costUsd: 0, duration_ms: 0 });
      return cached.data;
    }

    if (shared.agentsSpawned >= shared.maxAgents) throw new AgentCapExceededError(shared.maxAgents);
    shared.agentsSpawned++;

    // Everything observable happens after the slot is acquired, so agent_start
    // means "executing now" (not "queued") and duration_ms excludes queue wait.
    return shared.limiter.run(async () => {
      const t0 = Date.now();
      shared.journal.emit('agent_start', {
        sid, label, phase, depth,
        model: opts.model,
        prompt_head: prompt.slice(0, 400),
        prompt_file: shared.journal.savePrompt(sid, prompt),
      });
      try {
        // Budget may have been exhausted while queued; skip rather than spend.
        shared.budget.assertAvailable();
        const session = await shared.runtime.session(sid);
        const promptOpts: Record<string, unknown> = {};
        // inception's public option is `schema`; Flue >= 0.11 calls it `result`.
        if (opts.schema !== undefined) promptOpts.result = opts.schema;
        if (opts.model !== undefined) promptOpts.model = opts.model;
        if (opts.thinkingLevel !== undefined) promptOpts.thinkingLevel = opts.thinkingLevel;
        if (opts.tools !== undefined) promptOpts.tools = opts.tools;
        if (opts.images !== undefined) promptOpts.images = opts.images;

        const res = await session.prompt(prompt, promptOpts);
        const result = opts.schema !== undefined ? res.data : (res.data ?? res.text);
        const modelId = res.model?.id ?? opts.model ?? 'unknown';
        const costUsd = shared.budget.charge(modelId, res.usage);

        shared.journal.record(key, result);
        shared.journal.emit('agent_end', {
          sid, status: 'ok', label, phase, depth,
          model: modelId,
          usage: { input: res.usage?.input ?? 0, output: res.usage?.output ?? 0, cacheRead: res.usage?.cacheRead ?? 0 },
          costUsd: Number(costUsd.toFixed(6)),
          duration_ms: Date.now() - t0,
        });
        return result;
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          shared.journal.emit('agent_end', { sid, status: 'skipped', label, phase, depth, error: err.message, duration_ms: Date.now() - t0 });
          throw err;
        }
        shared.journal.emit('agent_end', {
          sid, status: 'error', label, phase, depth,
          error: String((err as Error)?.message ?? err).slice(0, 500),
          duration_ms: Date.now() - t0,
        });
        return null; // a dead subagent never kills the run
      }
    });
  };

  // Budget exhaustion is a run-level condition, not an item-level failure:
  // swallowing it would let a budget-dead run "succeed" with all-null results.
  // Propagated, the run ends loudly and a re-run with the same runDir replays
  // every completed call from the journal for free.
  const swallowItemError = (err: unknown): null => {
    if (err instanceof BudgetExceededError) throw err;
    return null;
  };

  const parallel = async <T>(thunks: Thunk<T>[]): Promise<(T | null)[]> =>
    Promise.all(thunks.map(t => Promise.resolve().then(t).catch(swallowItemError)));

  const pipeline = async (items: any[], ...stages: Stage[]): Promise<any[]> =>
    Promise.all(items.map(async (item, index) => {
      let prev: any = item;
      for (const stage of stages) {
        try {
          prev = await stage(prev, item, index);
        } catch (err) {
          return swallowItemError(err); // a throwing stage drops the item, not the run
        }
      }
      return prev;
    }));

  const api: WorkflowApi = {
    agent,
    parallel,
    pipeline,
    phase(title: string) {
      phaseRef.current = title;
      shared.journal.emit('phase', { title, depth });
    },
    log(message: string) {
      shared.journal.emit('log', { message, depth });
    },
    budget: shared.budget,
    async workflow<T>(name: string, body: (wf: WorkflowApi) => Promise<T>): Promise<T> {
      if (depth + 1 > shared.maxDepth) throw new DepthExceededError(depth + 1, shared.maxDepth);
      shared.journal.emit('workflow_start', { name, depth: depth + 1 });
      const child = makeApi(shared, depth + 1, { current: phaseRef.current });
      try {
        const result = await body(child);
        shared.journal.emit('workflow_end', { name, depth: depth + 1, status: 'ok' });
        return result;
      } catch (err) {
        shared.journal.emit('workflow_end', { name, depth: depth + 1, status: 'error', error: String((err as Error)?.message ?? err).slice(0, 500) });
        throw err;
      }
    },
    get depth() {
      return depth;
    },
  };
  return api;
}

/**
 * Run a workflow body against a Flue harness (or any AgentLike).
 *
 * ```ts
 * // src/workflows/my-workflow.ts (Flue >= 0.11)
 * import { createAgent, type FlueContext } from '@flue/runtime';
 * const worker = createAgent(() => ({ model: 'anthropic/claude-fable-5' }));
 *
 * export async function run({ init, payload, id }: FlueContext) {
 *   const harness = await init(worker);
 *   return runWorkflow(harness, { runId: id, runDir: payload.runDir, budgetUsd: payload.budgetUsd },
 *     async ({ agent, parallel, phase, budget }) => { ... });
 * }
 * ```
 */
export async function runWorkflow<T>(
  runtime: AgentLike,
  options: RunOptions,
  body: (wf: WorkflowApi) => Promise<T>,
): Promise<T> {
  const budget = new Budget(options.budgetUsd ?? null, options.pricing);
  const journal = new Journal(options.runDir, options.resume ?? true, options.onEvent);
  const shared: Shared = {
    runtime,
    runId: options.runId,
    budget,
    journal,
    limiter: new Limiter(options.concurrency ?? defaultConcurrency(cpus().length)),
    maxAgents: options.maxAgents ?? 1000,
    maxDepth: options.maxDepth ?? 5,
    seq: 0,
    agentsSpawned: 0,
  };

  const t0 = Date.now();
  journal.emit('run_start', {
    runId: options.runId,
    budgetUsd: options.budgetUsd ?? null,
    maxAgents: shared.maxAgents,
    maxDepth: shared.maxDepth,
  });

  try {
    const result = await body(makeApi(shared, 0, { current: undefined }));
    journal.emit('run_end', {
      status: 'ok',
      totals: { agents: shared.agentsSpawned, spentUsd: Number(budget.spent().toFixed(4)), elapsed_ms: Date.now() - t0 },
    });
    return result;
  } catch (err) {
    journal.emit('run_end', {
      status: 'error',
      error: String((err as Error)?.message ?? err).slice(0, 500),
      totals: { agents: shared.agentsSpawned, spentUsd: Number(budget.spent().toFixed(4)), elapsed_ms: Date.now() - t0 },
    });
    throw err;
  }
}
