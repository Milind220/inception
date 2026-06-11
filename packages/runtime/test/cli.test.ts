import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexAuthUsable, detectProviders, isOnPath, type DetectedProvider, type Probes } from '../src/cli/detect.js';
import { pickDefaultModel, renderAppTs, renderExampleAgent, scaffold } from '../src/cli/scaffold.js';
import { nodeSatisfies } from '../src/cli/init.js';

const probes = (over: Partial<Probes> = {}): Probes => ({
  env: {},
  isOnPath: () => false,
  hasCodexAuth: () => false,
  ...over,
});

const byName = (providers: DetectedProvider[], name: string): DetectedProvider => {
  const p = providers.find(x => x.name === name);
  if (!p) throw new Error(`provider ${name} missing from detection output`);
  return p;
};

describe('detectProviders', () => {
  it('reports every probe undetected with empty injected probes, regardless of the real env', () => {
    const out = detectProviders(probes());
    expect(out.map(p => p.name).sort()).toEqual(
      ['anthropic', 'deepseek', 'fireworks', 'groq', 'openai', 'openai-codex', 'openrouter'],
    );
    expect(out.every(p => !p.detected)).toBe(true);
  });

  it('detects builtin-env providers from the injected env only', () => {
    const out = detectProviders(probes({ env: { ANTHROPIC_API_KEY: 'sk-ant-x' } }));
    const anthropic = byName(out, 'anthropic');
    expect(anthropic).toMatchObject({ kind: 'builtin-env', envVar: 'ANTHROPIC_API_KEY', detected: true });
    expect(anthropic.detail).toContain('ANTHROPIC_API_KEY');
    expect(byName(out, 'openai').detected).toBe(false);
  });

  it('detects openai-compat providers with their baseUrl', () => {
    const out = detectProviders(probes({ env: { DEEPSEEK_API_KEY: 'x', GROQ_API_KEY: 'y' } }));
    expect(byName(out, 'deepseek')).toMatchObject({
      kind: 'openai-compat',
      baseUrl: 'https://api.deepseek.com/v1',
      detected: true,
    });
    expect(byName(out, 'groq')).toMatchObject({ baseUrl: 'https://api.groq.com/openai/v1', detected: true });
    expect(byName(out, 'fireworks')).toMatchObject({ baseUrl: 'https://api.fireworks.ai/inference/v1', detected: false });
    expect(byName(out, 'openrouter')).toMatchObject({ baseUrl: 'https://openrouter.ai/api/v1', detected: false });
  });

  it('treats an empty env value as not detected', () => {
    const out = detectProviders(probes({ env: { OPENAI_API_KEY: '' } }));
    expect(byName(out, 'openai').detected).toBe(false);
  });

  it('detects codex via codex-bridge on PATH and says so', () => {
    const out = detectProviders(probes({ isOnPath: bin => bin === 'codex-bridge' }));
    const codex = byName(out, 'openai-codex');
    expect(codex).toMatchObject({ kind: 'codex-oauth', detected: true });
    expect(codex.detail).toContain('codex-bridge on PATH');
  });

  it('detects codex via auth.json alone and points at codex-bridge install', () => {
    const out = detectProviders(probes({ hasCodexAuth: () => true }));
    const codex = byName(out, 'openai-codex');
    expect(codex.detected).toBe(true);
    expect(codex.detail).toContain('auth.json');
    expect(codex.detail).toContain('not on PATH');
  });

  it('leaves codex undetected when neither probe hits', () => {
    expect(byName(detectProviders(probes()), 'openai-codex').detected).toBe(false);
  });
});

describe('disk-boundary probes', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('codexAuthUsable accepts a tokens.access_token and rejects garbage or absence', () => {
    dir = mkdtempSync(join(tmpdir(), 'inception-cli-'));
    const file = join(dir, 'auth.json');
    expect(codexAuthUsable(file)).toBe(false);
    writeFileSync(file, 'not json {');
    expect(codexAuthUsable(file)).toBe(false);
    writeFileSync(file, JSON.stringify({ tokens: {} }));
    expect(codexAuthUsable(file)).toBe(false);
    writeFileSync(file, JSON.stringify({ tokens: { access_token: 'tok' } }));
    expect(codexAuthUsable(file)).toBe(true);
  });

  it('isOnPath resolves Windows PATHEXT variants', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inception-pathext-'));
    try {
      writeFileSync(join(dir, 'codex-bridge.exe'), '');
      expect(isOnPath('codex-bridge', dir, '.COM;.EXE;.BAT')).toBe(true);
      expect(isOnPath('codex-bridge', dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('isOnPath finds a binary only in the given PATH string', () => {
    dir = mkdtempSync(join(tmpdir(), 'inception-cli-'));
    writeFileSync(join(dir, 'codex-bridge'), '#!/bin/sh\n');
    expect(isOnPath('codex-bridge', dir)).toBe(true);
    expect(isOnPath('codex-bridge', '/nonexistent-dir-xyz')).toBe(false);
    expect(isOnPath('codex-bridge', undefined)).toBe(false);
  });
});

describe('scaffold', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const detect = (over: Partial<Probes> = {}) => detectProviders(probes(over));

  it('writes .flue/app.ts and .flue/agents/example.ts', () => {
    dir = mkdtempSync(join(tmpdir(), 'inception-cli-'));
    const res = scaffold(dir, detect({ env: { ANTHROPIC_API_KEY: 'x' } }));
    expect(res.written.sort()).toEqual([join('.flue', 'agents', 'example.ts'), join('.flue', 'app.ts')]);
    expect(res.skipped).toEqual([]);
    expect(existsSync(join(dir, '.flue', 'app.ts'))).toBe(true);

    const example = readFileSync(join(dir, '.flue', 'agents', 'example.ts'), 'utf8');
    expect(example).toContain(`import { runWorkflow } from 'inception-workflows'`);
    expect(example).toContain(`import * as v from 'valibot'`);
    expect(example).toContain('budgetUsd: payload.budgetUsd');
    expect(example).toContain('parallel(');
    expect(example).toContain("phase('Brainstorm')");
  });

  it('is idempotent: the second run skips everything, force overwrites', () => {
    dir = mkdtempSync(join(tmpdir(), 'inception-cli-'));
    const providers = detect();
    scaffold(dir, providers);

    const appPath = join(dir, '.flue', 'app.ts');
    writeFileSync(appPath, '// hand-edited\n');

    const second = scaffold(dir, providers);
    expect(second.written).toEqual([]);
    expect(second.skipped.sort()).toEqual([join('.flue', 'agents', 'example.ts'), join('.flue', 'app.ts')]);
    expect(readFileSync(appPath, 'utf8')).toBe('// hand-edited\n');

    const forced = scaffold(dir, providers, true);
    expect(forced.written.sort()).toEqual([join('.flue', 'agents', 'example.ts'), join('.flue', 'app.ts')]);
    expect(forced.skipped).toEqual([]);
    expect(readFileSync(appPath, 'utf8')).not.toBe('// hand-edited\n');
  });

  it('app.ts wires detected providers and omits undetected ones', () => {
    const app = renderAppTs(detect({ env: { ANTHROPIC_API_KEY: 'x', DEEPSEEK_API_KEY: 'y' } }));
    expect(app).toContain(`configureProvider('anthropic', { apiKey: process.env.ANTHROPIC_API_KEY });`);
    expect(app).toContain(`registerProvider('deepseek', {`);
    expect(app).toContain(`baseUrl: 'https://api.deepseek.com/v1'`);
    expect(app).toContain(`apiKey: process.env.DEEPSEEK_API_KEY`);
    expect(app).not.toContain('OPENAI_API_KEY'); // 'openai-completions' is the compat api id, so match the env var
    expect(app).not.toContain('openai-codex');
    expect(app).not.toContain('fireworks');
    expect(app).not.toContain('openrouter');
    expect(app).not.toContain('groq');
    expect(app.trimEnd().endsWith('export default flue();')).toBe(true);
  });

  it('app.ts fetches the codex token at startup instead of embedding it', () => {
    const app = renderAppTs(detect({ isOnPath: bin => bin === 'codex-bridge' }));
    expect(app).toContain(`import { execFileSync } from 'node:child_process';`);
    expect(app).toContain(`execFileSync('codex-bridge', ['print-token']`);
    expect(app).toContain(`configureProvider('openai-codex', { apiKey: codexToken });`);
    expect(app).toContain('try {');
    expect(app).not.toContain('NOT on your PATH');
  });

  it('app.ts explains the codex-bridge gap when only auth.json was found', () => {
    const app = renderAppTs(detect({ hasCodexAuth: () => true }));
    expect(app).toContain(`execFileSync('codex-bridge', ['print-token']`);
    expect(app).toContain('NOT on your PATH');
    expect(app).toContain('install codex-bridge');
  });

  it('app.ts with nothing detected still exports flue() with commented examples', () => {
    const app = renderAppTs(detect());
    expect(app).toContain(`import { flue } from '@flue/sdk/app';`);
    expect(app).not.toContain('\nconfigureProvider');
    expect(app).not.toContain('\nregisterProvider');
    expect(app).toContain('// inception init detected no provider credentials');
    expect(app.trimEnd().endsWith('export default flue();')).toBe(true);
  });
});

describe('default model selection', () => {
  it('prefers anthropic, then codex, then openai, then deepseek', () => {
    const detect = (env: Record<string, string>, bridge = false) =>
      detectProviders(probes({ env, isOnPath: () => bridge }));
    expect(pickDefaultModel(detect({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' }, true))).toBe('anthropic/claude-fable-5');
    expect(pickDefaultModel(detect({ OPENAI_API_KEY: 'k' }, true))).toBe('openai-codex/gpt-5.3-codex-spark');
    expect(pickDefaultModel(detect({ OPENAI_API_KEY: 'k' }))).toBe('openai/gpt-5.5');
    expect(pickDefaultModel(detect({ DEEPSEEK_API_KEY: 'k' }))).toBe('deepseek/deepseek-v4-flash');
    expect(pickDefaultModel(detect({}))).toBe('anthropic/claude-fable-5');
  });

  it('the example agent uses the picked model', () => {
    expect(renderExampleAgent('openai-codex/gpt-5.3-codex-spark')).toContain("model: 'openai-codex/gpt-5.3-codex-spark'");
  });
});

describe('codex provider parity', () => {
  it('app.ts configures both openai-codex and openai-codex-responses from one token', () => {
    const src = renderAppTs(detectProviders(probes({ isOnPath: bin => bin === 'codex-bridge' })));
    expect(src).toContain("configureProvider('openai-codex', { apiKey: codexToken })");
    expect(src).toContain("configureProvider('openai-codex-responses', { apiKey: codexToken })");
  });
});

describe('nodeSatisfies', () => {
  it('gates on the 22.18.0 floor', () => {
    expect(nodeSatisfies('22.18.0')).toBe(true);
    expect(nodeSatisfies('22.18.1')).toBe(true);
    expect(nodeSatisfies('22.19.0')).toBe(true);
    expect(nodeSatisfies('23.0.0')).toBe(true);
    expect(nodeSatisfies('22.17.9')).toBe(false);
    expect(nodeSatisfies('22.2.0')).toBe(false);
    expect(nodeSatisfies('21.99.0')).toBe(false);
    expect(nodeSatisfies('18.20.4')).toBe(false);
  });
});
