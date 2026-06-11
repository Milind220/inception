import type { BudgetView, UsageLike } from './types.js';

export class BudgetExceededError extends Error {
  constructor(spent: number, total: number) {
    super(`workflow budget exhausted: spent $${spent.toFixed(4)} of $${total.toFixed(2)}`);
    this.name = 'BudgetExceededError';
  }
}

const FALLBACK_RATE: [number, number] = [5, 25]; // $/1M tokens, pessimistic

/**
 * USD budget with a hard stop. Prefers the provider-computed usage.cost.total
 * (pi-ai populates it from the model's cost table); falls back to a
 * caller-supplied $/1M-token pricing table for custom or proxied endpoints,
 * and to a pessimistic default rate so spend is never silently charged $0.
 */
export class Budget implements BudgetView {
  private spentUsd = 0;

  constructor(
    readonly total: number | null,
    private readonly pricing: Record<string, [number, number]> = {},
  ) {}

  spent(): number {
    return this.spentUsd;
  }

  remaining(): number {
    return this.total === null ? Infinity : Math.max(0, this.total - this.spentUsd);
  }

  exhausted(): boolean {
    return this.total !== null && this.spentUsd >= this.total;
  }

  costOf(model: string, usage: UsageLike | undefined): number {
    const reported = usage?.cost?.total;
    const tokens = (usage?.input ?? 0) + (usage?.output ?? 0);
    // A reported 0 is trustworthy only for a zero-token call: pi-ai also reports
    // cost.total: 0 for models missing from its price registry, and trusting
    // that would silently charge $0 for real spend.
    if (typeof reported === 'number' && Number.isFinite(reported) && (reported > 0 || tokens === 0)) {
      return Math.max(0, reported);
    }
    const [inRate, outRate] = this.pricing[model] ?? FALLBACK_RATE;
    return ((usage?.input ?? 0) * inRate + (usage?.output ?? 0) * outRate) / 1_000_000;
  }

  charge(model: string, usage: UsageLike | undefined): number {
    const cost = this.costOf(model, usage);
    this.spentUsd += cost;
    return cost;
  }

  assertAvailable(): void {
    if (this.exhausted()) throw new BudgetExceededError(this.spentUsd, this.total as number);
  }
}
