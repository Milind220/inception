/** Minimal FIFO semaphore. acquire() resolves with a release function. */
export class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly max: number) {
    if (!Number.isFinite(max) || max < 1) throw new Error(`Limiter max must be >= 1, got ${max}`);
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) {
      // The releaser hands its slot over without decrementing, so a fresh
      // acquire() can never steal it from the woken waiter mid-tick.
      await new Promise<void>(resolve => this.queue.push(resolve));
    } else {
      this.active++;
    }
    // Once-guarded: a double release must not under-count the semaphore.
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export function defaultConcurrency(cpuCount: number): number {
  return Math.max(1, Math.min(16, cpuCount - 2));
}
