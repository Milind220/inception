import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Provider detection for `inception init`. detectProviders() is pure: every
 * probe (env, PATH, ~/.codex/auth.json) is injected so tests never touch the
 * real machine. realProbes() supplies the actual ones.
 */

export interface DetectedProvider {
  name: string;                                    // flue provider key, e.g. 'anthropic', 'openai', 'openai-codex', 'deepseek', 'fireworks', 'openrouter', 'groq'
  kind: 'builtin-env' | 'codex-oauth' | 'openai-compat';
  envVar?: string;                                 // e.g. 'ANTHROPIC_API_KEY'
  baseUrl?: string;                                // openai-compat registrations only
  detected: boolean;
  detail: string;                                  // one human-readable report line
}

export interface Probes {
  env: Readonly<Record<string, string | undefined>>;
  isOnPath: (bin: string) => boolean;
  hasCodexAuth: () => boolean;
}

const BUILTIN_ENV = [
  { name: 'anthropic', envVar: 'ANTHROPIC_API_KEY' },
  { name: 'openai', envVar: 'OPENAI_API_KEY' },
] as const;

const OPENAI_COMPAT = [
  { name: 'deepseek', envVar: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com/v1' },
  { name: 'fireworks', envVar: 'FIREWORKS_API_KEY', baseUrl: 'https://api.fireworks.ai/inference/v1' },
  { name: 'openrouter', envVar: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1' },
  { name: 'groq', envVar: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1' },
] as const;

/** Scaffold keys off this prefix to know a runtime token fetch will work. */
export const CODEX_BRIDGE_ON_PATH = 'codex-bridge on PATH';

function codexDetail(bridge: boolean, authFile: boolean): string {
  if (bridge && authFile) return `${CODEX_BRIDGE_ON_PATH}; ~/.codex/auth.json present`;
  if (bridge) return CODEX_BRIDGE_ON_PATH;
  if (authFile) return '~/.codex/auth.json present, but codex-bridge is not on PATH — install it or wire your own token fetch in .flue/app.ts';
  return 'codex-bridge not on PATH and no usable ~/.codex/auth.json';
}

export function detectProviders(probes: Probes): DetectedProvider[] {
  const out: DetectedProvider[] = [];

  for (const { name, envVar } of BUILTIN_ENV) {
    const detected = Boolean(probes.env[envVar]);
    out.push({ name, kind: 'builtin-env', envVar, detected, detail: detected ? `${envVar} set` : `${envVar} not set` });
  }

  const bridge = probes.isOnPath('codex-bridge');
  const authFile = probes.hasCodexAuth();
  out.push({
    name: 'openai-codex',
    kind: 'codex-oauth',
    detected: bridge || authFile,
    detail: codexDetail(bridge, authFile),
  });

  for (const { name, envVar, baseUrl } of OPENAI_COMPAT) {
    const detected = Boolean(probes.env[envVar]);
    out.push({ name, kind: 'openai-compat', envVar, baseUrl, detected, detail: detected ? `${envVar} set` : `${envVar} not set` });
  }

  return out;
}

export function isOnPath(bin: string, pathVar: string | undefined): boolean {
  if (!pathVar) return false;
  return pathVar.split(delimiter).some(dir => dir && existsSync(join(dir, bin)));
}

/**
 * Defensive disk boundary: a present-but-garbled auth.json (interrupted
 * write, future format change) must downgrade to "not detected", not crash.
 */
export function codexAuthUsable(file: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { tokens?: { access_token?: unknown } };
    return typeof parsed?.tokens?.access_token === 'string' && parsed.tokens.access_token.length > 0;
  } catch {
    return false;
  }
}

export function realProbes(env: Readonly<Record<string, string | undefined>> = process.env, home: string = homedir()): Probes {
  return {
    env,
    isOnPath: bin => isOnPath(bin, env.PATH),
    hasCodexAuth: () => codexAuthUsable(join(home, '.codex', 'auth.json')),
  };
}
