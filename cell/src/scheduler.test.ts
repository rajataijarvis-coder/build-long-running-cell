import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Scheduler } from './scheduler.js';

describe('Scheduler', () => {
  function makeScheduler(): { scheduler: Scheduler; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'scheduler-test-'));
    const scheduler = new Scheduler({
      basePath: dir,
      maxConcurrency: 1,
      minIntervalMs: 0,
    });
    return { scheduler, dir };
  }

  it('computes the next run for a simple cron expression', () => {
    const { scheduler } = makeScheduler();
    const base = Date.UTC(2026, 7, 4, 10, 0, 0, 0);
    const next = scheduler.nextRun('30 12 * * *', 'UTC', undefined, base);
    assert.ok(next);
    const nextDate = new Date(next!);
    assert.equal(nextDate.getUTCHours(), 12);
    assert.equal(nextDate.getUTCMinutes(), 30);
    assert.equal(nextDate.getUTCDate(), 4);
  });

  it('computes the next run for a stepped cron expression', () => {
    const { scheduler } = makeScheduler();
    const base = Date.UTC(2026, 7, 4, 10, 0, 0, 0);
    const next = scheduler.nextRun('*/15 * * * *', 'UTC', undefined, base);
    assert.ok(next);
    const nextDate = new Date(next!);
    assert.equal(nextDate.getUTCMinutes() % 15, 0);
    assert.ok(nextDate.getTime() > base);
  });

  it('schedules a task and computes its next run', async () => {
    const { scheduler } = makeScheduler();
    const task = await scheduler.schedule({
      name: 'verify-every-minute',
      cron: '* * * * *',
      action: 'verify',
      payload: '',
      enabled: true,
    });
    assert.equal(task.name, 'verify-every-minute');
    assert.ok(task.id);
    assert.ok(task.nextRunAt);
    assert.equal(task.consecutiveFailures, 0);
  });

  it('lists tasks', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.schedule({ name: 'a', cron: '0 * * * *', action: 'verify', payload: '', enabled: true });
    await scheduler.schedule({ name: 'b', cron: '0 * * * *', action: 'verify', payload: '', enabled: false });
    const all = await scheduler.list();
    assert.equal(all.length, 2);
    assert.equal((await scheduler.list(true)).length, 1);
  });

  it('updates a task cron expression and recomputes next run', async () => {
    const { scheduler } = makeScheduler();
    const created = await scheduler.schedule({ name: 'old', cron: '0 0 * * *', action: 'verify', payload: '', enabled: true });
    const originalNext = created.nextRunAt;
    const updated = await scheduler.update(created.id, { cron: '*/5 * * * *' });
    assert.ok(updated);
    assert.notEqual(updated!.nextRunAt, originalNext);
  });

  it('removes a task', async () => {
    const { scheduler } = makeScheduler();
    const task = await scheduler.schedule({ name: 'remove-me', cron: '0 * * * *', action: 'verify', payload: '', enabled: true });
    assert.equal(await scheduler.remove(task.id), true);
    assert.equal(await scheduler.remove('missing'), false);
    assert.equal((await scheduler.list()).length, 0);
  });

  it('ticks run a due mission task', async () => {
    const { scheduler } = makeScheduler();
    const now = Date.now();
    const task = await scheduler.schedule({
      name: 'self-check',
      cron: '* * * * *',
      action: 'mission',
      payload: 'run verification suite',
      enabled: true,
    });
    // Force the task to be due.
    await scheduler.update(task.id, { nextRunAt: new Date(now - 1000).toISOString() });
    const results = await scheduler.tick(now);
    assert.equal(results.length, 1);
    assert.equal(results[0].taskId, task.id);
    assert.equal(results[0].ran, true);
    assert.ok((results[0].output as { missionId: string }).missionId);
  });

  it('does not run a task before its next scheduled time', async () => {
    const { scheduler } = makeScheduler();
    const now = Date.now();
    const task = await scheduler.schedule({
      name: 'future',
      cron: '* * * * *',
      action: 'mission',
      payload: '',
      enabled: true,
    });
    await scheduler.update(task.id, { nextRunAt: new Date(now + 60_000).toISOString() });
    const results = await scheduler.tick(now);
    assert.equal(results.length, 0);
  });

  it('enforces max concurrency', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scheduler-concurrency-'));
    const scheduler = new Scheduler({ basePath: dir, maxConcurrency: 1, minIntervalMs: 10_000 });
    const now = Date.now();
    const a = await scheduler.schedule({ name: 'a', cron: '* * * * *', action: 'mission', payload: '', enabled: true });
    const b = await scheduler.schedule({ name: 'b', cron: '* * * * *', action: 'mission', payload: '', enabled: true });
    await scheduler.update(a.id, { nextRunAt: new Date(now - 1000).toISOString() });
    await scheduler.update(b.id, { nextRunAt: new Date(now - 1000).toISOString() });
    const results = await scheduler.tick(now);
    assert.equal(results.length, 2);
    const ranCount = results.filter((r) => r.ran).length;
    const blockedCount = results.filter((r) => !r.ran).length;
    assert.equal(ranCount, 1);
    assert.equal(blockedCount, 1);
    const blockedReason = results.find((r) => !r.ran)?.error ?? '';
    assert.ok(blockedReason.includes('concurrency') || blockedReason.includes('minimum interval'));
  });

  it('applies exponential backoff after failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scheduler-backoff-'));
    const scheduler = new Scheduler({ basePath: dir, maxConcurrency: 1, minIntervalMs: 0 });
    const now = Date.UTC(2026, 7, 4, 12, 0, 0, 0);
    const task = await scheduler.schedule({
      name: 'failing-verify',
      cron: '0 * * * *',
      action: 'verify',
      payload: '',
      enabled: true,
    });
    await scheduler.update(task.id, { nextRunAt: new Date(now - 1000).toISOString() });

    // Simulate a failure by overriding verification commands with a failing command.
    const failingScheduler = new Scheduler({
      basePath: dir,
      maxConcurrency: 1,
      minIntervalMs: 0,
      verificationCommands: [['node', ['-e', 'process.exit(1)']]],
    });
    const result = await failingScheduler.tick(now);
    assert.equal(result.length, 1);
    assert.equal(result[0].ran, true);
    assert.ok(result[0].error);

    const state = await failingScheduler['loadState']();
    const updated = state.tasks.find((t) => t.id === task.id)!;
    assert.equal(updated.consecutiveFailures, 1);
    assert.ok(updated.jitterMs >= 60_000);
    assert.ok(updated.nextRunAt);
    assert.ok(new Date(updated.nextRunAt!).getTime() > new Date(now).getTime());
  });

  it('can run a task manually', async () => {
    const { scheduler } = makeScheduler();
    const task = await scheduler.schedule({
      name: 'manual',
      cron: '0 0 * * *',
      action: 'mission',
      payload: 'manual run',
      enabled: true,
    });
    const result = await scheduler.runTask(task.id);
    assert.equal(result.ran, true);
    assert.ok((result.output as { missionId: string }).missionId);
  });

  it('returns an error for a missing task', async () => {
    const { scheduler } = makeScheduler();
    const result = await scheduler.runTask('missing');
    assert.equal(result.ran, false);
    assert.ok(result.error?.includes('not found'));
  });
});
