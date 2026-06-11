/** Minimal FIFO semaphore. acquire() resolves with a release function. */
export class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly max: number) {
    if (!Number.isFinite(max) || max < 1) throw new Error(`Limiter max must be >= 1, got ${max}`);
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return this.release;
    }
    await new Promise<void>(resolve => this.queue.push(resolve));
    this.active++;
    return this.release;
  }

  private release = (): void => {
    this.active--;
    this.queue.shift()?.();
  };

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
