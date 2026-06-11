import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { WorkflowEvent } from './types.js';

/**
 * Per-run persistence: an NDJSON event stream for observers (events.ndjson),
 * full prompts mirrored to prompts/<sid>.txt, and a result journal
 * (results.ndjson) that makes runs resumable.
 *
 * Resume keying: results are keyed by a content hash of the call
 * (prompt + model + role + label), not by call sequence — completion order
 * under concurrency is nondeterministic, so sequence numbers don't survive
 * re-runs. Identical calls are disambiguated by an occurrence counter;
 * since their inputs are identical, their cached results are interchangeable.
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

  static callKey(prompt: string, opts: { model?: string; role?: string; label?: string }): string {
    return createHash('sha256')
      .update(JSON.stringify({ prompt, model: opts.model ?? '', role: opts.role ?? '', label: opts.label ?? '' }))
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
