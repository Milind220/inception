import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { WorkflowEvent } from './types.js';

/**
 * Stable-enough identity for schemas and tool definitions: valibot schemas are
 * plain data plus validator functions, so serializing with functions reduced to
 * their names captures the structure. Anything unserializable (circular lazy
 * schemas) degrades to a constant — still keyed as "present", never a crash.
 */
function structuralFingerprint(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'function' ? `fn:${v.name || 'anon'}` : v)) ?? 'present';
  } catch {
    return 'present';
  }
}

/**
 * Per-run persistence: an NDJSON event stream for observers (events.ndjson),
 * full prompts mirrored to prompts/<sid>.txt, and a result journal
 * (results.ndjson) that makes runs resumable.
 *
 * Resume keying: results are keyed by a content hash of the full call shape
 * (prompt, model, label, thinkingLevel, schema/tools fingerprints), not
 * by call sequence — completion order under concurrency is nondeterministic,
 * so sequence numbers don't survive re-runs. Identical calls are disambiguated
 * by an occurrence counter; since their inputs are identical, their cached
 * results are treated as interchangeable. Corollary: if a journal line is ever
 * lost (torn write, manual edit), occurrence matching shifts by one for that
 * key — safe under the interchangeability assumption, but identical calls are
 * NOT guaranteed to map back to the same physical result across runs.
 *
 * All filesystem writes are best-effort: observability and resumability must
 * never alter run behavior.
 */
export class Journal {
  private dirReady = false;
  private cached = new Map<string, unknown[]>();
  private taken = new Map<string, number>();

  constructor(
    private readonly runDir: string | undefined,
    resume: boolean,
    private readonly onEvent?: (evt: WorkflowEvent) => void,
  ) {
    if (runDir && resume) this.load();
  }

  /**
   * Every option that can change what the provider returns is part of the key —
   * a cached structured object must never be served to a call that dropped the
   * schema, raised thinkingLevel, or changed its tools.
   */
  static callKey(
    prompt: string,
    opts: { model?: string; label?: string; thinkingLevel?: string; schema?: unknown; tools?: unknown[]; images?: unknown[] },
  ): string {
    return createHash('sha256')
      .update(JSON.stringify({
        prompt,
        model: opts.model ?? '',
        label: opts.label ?? '',
        thinkingLevel: opts.thinkingLevel ?? '',
        schema: structuralFingerprint(opts.schema),
        tools: structuralFingerprint(opts.tools),
        images: opts.images?.length ?? 0,
      }))
      .digest('hex')
      .slice(0, 24);
  }

  private load(): void {
    try {
      const lines = readFileSync(`${this.runDir}/results.ndjson`, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as { key: string; data: unknown };
          const list = this.cached.get(entry.key) ?? [];
          list.push(entry.data);
          this.cached.set(entry.key, list);
        } catch { /* skip torn line (e.g. interrupted write) */ }
      }
    } catch { /* no prior journal — fresh run */ }
  }

  /** Returns {hit: true} with the cached result for the next unconsumed occurrence of this key. */
  lookup(key: string): { hit: boolean; data?: unknown } {
    const list = this.cached.get(key);
    if (!list) return { hit: false };
    const n = this.taken.get(key) ?? 0;
    if (n >= list.length) return { hit: false };
    this.taken.set(key, n + 1);
    return { hit: true, data: list[n] };
  }

  record(key: string, data: unknown): void {
    if (!this.runDir) return;
    try {
      this.ensureDir();
      appendFileSync(`${this.runDir}/results.ndjson`, JSON.stringify({ key, data }) + '\n');
    } catch { /* best-effort */ }
  }

  emit(type: string, data: Record<string, unknown> = {}): void {
    const evt: WorkflowEvent = { t: Date.now(), type, ...data };
    try {
      this.onEvent?.(evt);
    } catch { /* observer errors never propagate */ }
    if (!this.runDir) return;
    try {
      this.ensureDir();
      appendFileSync(`${this.runDir}/events.ndjson`, JSON.stringify(evt) + '\n');
    } catch { /* best-effort */ }
  }

  savePrompt(sid: string, prompt: string): string | undefined {
    if (!this.runDir) return undefined;
    try {
      this.ensureDir();
      writeFileSync(`${this.runDir}/prompts/${sid}.txt`, prompt);
      return `prompts/${sid}.txt`;
    } catch {
      return undefined;
    }
  }

  private ensureDir(): void {
    if (this.dirReady) return;
    mkdirSync(`${this.runDir}/prompts`, { recursive: true });
    this.dirReady = true;
  }
}
