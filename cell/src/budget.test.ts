import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BudgetTracker } from './budget.js';

function makeTracker(options: Partial<ConstructorParameters<typeof BudgetTracker>[0]> = {}): { tracker: BudgetTracker; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'budget-test-'));
  const tracker = new BudgetTracker({ basePath: dir, ...options });
  return { tracker, dir };
}

describe('BudgetTracker', () => {
  it('loads a default unlimited budget', async () => {
    const { tracker } = makeTracker();
    const budget = await tracker.load();
    assert.equal(budget.tokenLimit, 0);
    assert.equal(budget.costLimit, 0);
    assert.equal(budget.elapsedMsLimit, 0);
    assert.equal(budget.currentTokens, 0);
    assert.equal(budget.currency, 'USD');
  });

  it('records consumed tokens and derives cost', async () => {
    const { tracker } = makeTracker({ costPer1kTokens: 0.005 });
    await tracker.recordTokens(2000);
    const budget = await tracker.load();
    assert.equal(budget.currentTokens, 2000);
    assert.equal(budget.currentCost, 0.01);
  });

  it('records elapsed time', async () => {
    const { tracker } = makeTracker();
    await tracker.recordElapsed(1500);
    const budget = await tracker.load();
    assert.equal(budget.elapsedMs, 1500);
  });

  it('passes check when under budget', async () => {
    const { tracker } = makeTracker({ tokenLimit: 1000 });
    await tracker.recordTokens(500);
    const status = await tracker.check();
    assert.equal(status.ok, true);
  });

  it('fails check when token limit is reached', async () => {
    const { tracker } = makeTracker({ tokenLimit: 1000 });
    await tracker.recordTokens(1000);
    const status = await tracker.check();
    assert.equal(status.ok, false);
    assert.match(status.reason ?? '', /token limit reached/i);
  });

  it('fails check when cost limit is reached', async () => {
    const { tracker } = makeTracker({ costLimit: 0.01, costPer1kTokens: 0.01 });
    await tracker.recordTokens(1000);
    const status = await tracker.check();
    assert.equal(status.ok, false);
    assert.match(status.reason ?? '', /cost limit reached/i);
  });

  it('fails check when runtime limit is reached', async () => {
    const { tracker } = makeTracker({ elapsedMsLimit: 1000 });
    await tracker.recordElapsed(1000);
    const status = await tracker.check();
    assert.equal(status.ok, false);
    assert.match(status.reason ?? '', /runtime limit reached/i);
  });

  it('updates limits', async () => {
    const { tracker } = makeTracker({ tokenLimit: 1000 });
    await tracker.setLimits({ tokenLimit: 2000, costLimit: 5 });
    const budget = await tracker.load();
    assert.equal(budget.tokenLimit, 2000);
    assert.equal(budget.costLimit, 5);
  });

  it('resets counters while keeping limits', async () => {
    const { tracker } = makeTracker({ tokenLimit: 1000 });
    await tracker.recordTokens(800);
    await tracker.recordElapsed(500);
    const reset = await tracker.reset();
    assert.equal(reset.currentTokens, 0);
    assert.equal(reset.elapsedMs, 0);
    assert.equal(reset.tokenLimit, 1000);
  });

  it('estimates tokens from text length', () => {
    const { tracker } = makeTracker();
    const estimate = tracker.estimateTokens('hello world');
    assert.equal(estimate, 3); // 11 chars / 4 rounded up
  });

  it('persists across instances', async () => {
    const { tracker, dir } = makeTracker();
    await tracker.recordTokens(1234);
    const second = new BudgetTracker({ basePath: dir });
    const budget = await second.load();
    assert.equal(budget.currentTokens, 1234);
  });
});
