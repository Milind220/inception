import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CODEX_BRIDGE_ON_PATH, type DetectedProvider } from './detect.js';

export interface ScaffoldResult {
  written: string[];
  skipped: string[];
}

export function renderAppTs(providers: DetectedProvider[]): string {
  const detected = providers.filter(p => p.detected);
  const builtin = detected.filter(p => p.kind === 'builtin-env');
  const compat = detected.filter(p => p.kind === 'openai-compat');
  const codex = detected.find(p => p.kind === 'codex-oauth');

  const sdkImports: string[] = [];
  if (builtin.length > 0 || codex) sdkImports.push('configureProvider');
  if (compat.length > 0) sdkImports.push('registerProvider');
  sdkImports.push('flue');

  const lines: string[] = [];
  if (codex) lines.push(`import { execFileSync } from 'node:child_process';`);
  lines.push(`import { ${sdkImports.join(', ')} } from '@flue/sdk/app';`);
  lines.push('');

  if (codex) {
    // The Codex OAuth token expires (the CLI auto-refreshes it), so it must
    // be fetched at startup — never embedded by init.
    lines.push('// Codex OAuth tokens expire, so fetch a fresh one every startup rather than');
    lines.push('// embedding it; codex-bridge reads (and refreshes) the Codex CLI session.');
    if (!codex.detail.startsWith(CODEX_BRIDGE_ON_PATH)) {
      lines.push('// ~/.codex/auth.json was found but codex-bridge is NOT on your PATH:');
      lines.push('// install codex-bridge, or replace the execFileSync call below with your');
      lines.push('// own fetch of tokens.access_token from ~/.codex/auth.json.');
    }
    lines.push('try {');
    lines.push(`  const codexToken = execFileSync('codex-bridge', ['print-token'], { encoding: 'utf8' }).trim();`);
    lines.push(`  configureProvider('openai-codex', { apiKey: codexToken });`);
    lines.push(`  configureProvider('openai-codex-responses', { apiKey: codexToken });`);
    lines.push('} catch {');
    lines.push('  // codex-bridge missing/unauthed — codex-routed calls fail loudly at call time');
    lines.push('}');
    lines.push('');
  }

  for (const p of builtin) {
    lines.push(`configureProvider('${p.name}', { apiKey: process.env.${p.envVar} });`);
  }
  if (builtin.length > 0) lines.push('');

  for (const p of compat) {
    lines.push(`registerProvider('${p.name}', {`);
    lines.push(`  api: 'openai-completions',`);
    lines.push(`  baseUrl: '${p.baseUrl}',`);
    lines.push(`  apiKey: process.env.${p.envVar},`);
    lines.push(`  provider: '${p.name}',`);
    lines.push('});');
    lines.push('');
  }

  if (detected.length === 0) {
    lines.push('// inception init detected no provider credentials. Wire at least one, e.g.:');
    lines.push(`//   configureProvider('anthropic', { apiKey: process.env.ANTHROPIC_API_KEY });`);
    lines.push('// or an OpenAI-compatible endpoint (vLLM/llama.cpp/ollama):');
    lines.push(`//   registerProvider('local', { api: 'openai-completions', baseUrl: 'http://localhost:8000/v1', apiKey: 'none', provider: 'local' });`);
    lines.push('');
  }

  lines.push('export default flue();');
  lines.push('');
  return lines.join('\n');
}

/** A model the probed machine can actually run, so the scaffold works on first try. */
export function pickDefaultModel(providers: DetectedProvider[]): string {
  const detected = new Set(providers.filter(p => p.detected).map(p => p.name));
  if (detected.has('anthropic')) return 'anthropic/claude-fable-5';
  if (detected.has('openai-codex')) return 'openai-codex/gpt-5.3-codex-spark';
  if (detected.has('openai')) return 'openai/gpt-5.5';
  if (detected.has('deepseek')) return 'deepseek/deepseek-v4-flash';
  return 'anthropic/claude-fable-5';
}

export function renderExampleAgent(defaultModel = 'anthropic/claude-fable-5'): string {
  return `/**
 * Example inception workflow as a Flue agent handler.
 *
 * Run:    flue run example --target node --id run-1 --payload '{
 *           "runDir": "/tmp/example-1", "budgetUsd": 1
 *         }'
 * Watch:  inception watch /tmp/example-1
 */
import type { FlueContext } from '@flue/sdk/client';
import { runWorkflow } from 'inception-workflows';
import * as v from 'valibot';

export const triggers = { webhook: true };

const Idea = v.object({
  title: v.string(),
  summary: v.string(),
});

const ANGLES = ['practical', 'contrarian', 'long-term'];

export default async function ({ init, payload, id }: FlueContext) {
  const flueAgent = await init({
    model: '${defaultModel}',
    sandbox: 'empty',
  });

  return runWorkflow(
    flueAgent,
    { runId: id, runDir: payload.runDir, budgetUsd: payload.budgetUsd ?? 1 },
    async ({ agent, parallel, phase, log }) => {
      phase('Brainstorm');
      const ideas = (await parallel(ANGLES.map(angle => () =>
        agent(
          \`Propose one \${angle} idea for: \${payload.topic ?? 'making onboarding docs people actually read'}. Be concrete.\`,
          { schema: Idea, label: \`idea:\${angle}\` },
        ),
      ))).filter(Boolean);
      log(\`\${ideas.length}/\${ANGLES.length} ideas survived\`);
      return { ideas };
    },
  );
}
`;
}

export function scaffold(dir: string, providers: DetectedProvider[], force = false): ScaffoldResult {
  const files: Array<[string, string]> = [
    [join('.flue', 'app.ts'), renderAppTs(providers)],
    [join('.flue', 'agents', 'example.ts'), renderExampleAgent(pickDefaultModel(providers))],
  ];

  const written: string[] = [];
  const skipped: string[] = [];
  for (const [rel, content] of files) {
    const abs = join(dir, rel);
    if (existsSync(abs) && !force) {
      skipped.push(rel);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    written.push(rel);
  }
  return { written, skipped };
}
