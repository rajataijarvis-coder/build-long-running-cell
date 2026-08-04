import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import type { Budget } from './types.js';

export interface BudgetOptions {
  basePath: string;
  /** Token limit. 0 means unlimited. */
  tokenLimit?: number;
  /** Cost limit in the configured currency. 0 means unlimited. */
  costLimit?: number;
  /** Runtime limit in milliseconds. 0 means unlimited. */
  elapsedMsLimit?: number;
  /** Currency symbol. */
  currency?: string;
  /** Estimated cost per 1,000 tokens. */
  costPer1kTokens?: number;
}

export interface BudgetStatus {
  ok: boolean;
  reason?: string;
  budget: Budget;
}

export class BudgetTracker {
  private readonly basePath: string;
  private readonly statePath: string;
  private readonly defaultOptions: BudgetOptions;
  private cache?: Budget;

  constructor(options: BudgetOptions) {
    this.basePath = options.basePath;
    this.statePath = join(options.basePath, 'state', 'budget.json');
    this.defaultOptions = options;
    this.cache = undefined;
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(dirname(this.statePath), { recursive: true });
  }

  private defaultBudget(options: BudgetOptions): Budget {
    return {
      tokenLimit: options.tokenLimit ?? 0,
      costLimit: options.costLimit ?? 0,
      elapsedMsLimit: options.elapsedMsLimit ?? 0,
      currentTokens: 0,
      currentCost: 0,
      elapsedMs: 0,
      lastUpdatedAt: new Date().toISOString(),
      currency: options.currency ?? 'USD',
      costPer1kTokens: options.costPer1kTokens ?? 0.002,
    };
  }

  async load(): Promise<Budget> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.statePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<Budget>;
      this.cache = { ...this.defaultBudget(this.defaultOptions), ...parsed };
      return this.cache;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = this.defaultBudget(this.defaultOptions);
        return this.cache;
      }
      throw err;
    }
  }

  async save(budget: Budget): Promise<void> {
    this.cache = budget;
    await this.ensureDir();
    await fs.writeFile(this.statePath, JSON.stringify(budget, null, 2), 'utf-8');
  }

  /**
   * Check whether a proposed action is still within budget. This is a
   * pre-flight check: it does not mutate state and is safe to call from
   * guardrails, the scheduler, or the cell loop.
   */
  async check(): Promise<BudgetStatus> {
    const budget = await this.load();
    if (budget.tokenLimit > 0 && budget.currentTokens >= budget.tokenLimit) {
      return { ok: false, reason: `token limit reached (${budget.currentTokens} >= ${budget.tokenLimit})`, budget };
    }
    if (budget.costLimit > 0 && budget.currentCost >= budget.costLimit) {
      return { ok: false, reason: `cost limit reached (${budget.currentCost.toFixed(4)} ${budget.currency} >= ${budget.costLimit})`, budget };
    }
    if (budget.elapsedMsLimit > 0 && budget.elapsedMs >= budget.elapsedMsLimit) {
      return { ok: false, reason: `runtime limit reached (${budget.elapsedMs}ms >= ${budget.elapsedMsLimit}ms)`, budget };
    }
    return { ok: true, budget };
  }

  /** Record tokens consumed and derive the estimated cost. */
  async recordTokens(tokens: number): Promise<Budget> {
    const budget = await this.load();
    budget.currentTokens += tokens;
    budget.currentCost += (tokens / 1000) * budget.costPer1kTokens;
    budget.lastUpdatedAt = new Date().toISOString();
    await this.save(budget);
    return budget;
  }

  /** Record wall-clock milliseconds elapsed since the last update. */
  async recordElapsed(ms: number): Promise<Budget> {
    const budget = await this.load();
    budget.elapsedMs += Math.max(0, ms);
    budget.lastUpdatedAt = new Date().toISOString();
    await this.save(budget);
    return budget;
  }

  /** Update the budget limits without resetting current consumption. */
  async setLimits(patch: Partial<Pick<Budget, 'tokenLimit' | 'costLimit' | 'elapsedMsLimit' | 'costPer1kTokens'>>): Promise<Budget> {
    const budget = await this.load();
    if (patch.tokenLimit !== undefined) budget.tokenLimit = patch.tokenLimit;
    if (patch.costLimit !== undefined) budget.costLimit = patch.costLimit;
    if (patch.elapsedMsLimit !== undefined) budget.elapsedMsLimit = patch.elapsedMsLimit;
    if (patch.costPer1kTokens !== undefined) budget.costPer1kTokens = patch.costPer1kTokens;
    budget.lastUpdatedAt = new Date().toISOString();
    await this.save(budget);
    return budget;
  }

  /** Reset current counters to zero. Limits are preserved. */
  async reset(): Promise<Budget> {
    const budget = await this.load();
    budget.currentTokens = 0;
    budget.currentCost = 0;
    budget.elapsedMs = 0;
    budget.lastUpdatedAt = new Date().toISOString();
    await this.save(budget);
    return budget;
  }

  /** Estimate tokens for a block of text using a simple character heuristic. */
  estimateTokens(text: string): number {
    // A rough approximation: ~4 characters per token for English text.
    return Math.ceil(text.length / 4);
  }

  /** Convenience: record the estimated tokens for an arbitrary string. */
  async recordText(text: string): Promise<Budget> {
    return this.recordTokens(this.estimateTokens(text));
  }
}
