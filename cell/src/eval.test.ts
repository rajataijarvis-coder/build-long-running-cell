import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EvaluationHarness } from './eval.js';
import { GitMemory } from './git-memory.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'cell-eval-'));
}

describe('EvaluationHarness', () => {
  let basePath: string;

  beforeEach(() => {
    basePath = makeTmpDir();
  });

  afterEach(() => {
    rmSync(basePath, { recursive: true, force: true });
  });

  it('records an eval run with default tasks', async () => {
    const harness = new EvaluationHarness({
      basePath,
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
    });

    const run = await harness.run();

    assert.ok(run.id.startsWith('eval-'));
    assert.equal(run.tasks.length, 4);
    assert.equal(run.summary.total, 4);
    assert.equal(run.status, 'done');
    assert.ok(run.summary.score > 0);
  });

  it('runs a subset of tasks when taskIds are provided', async () => {
    const harness = new EvaluationHarness({
      basePath,
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
    });

    const run = await harness.run(['orchestration-recall']);

    assert.equal(run.tasks.length, 1);
    assert.equal(run.tasks[0].taskId, 'orchestration-recall');
    assert.equal(run.status, 'done');
  });

  it('lists runs most recent first', async () => {
    const harness = new EvaluationHarness({
      basePath,
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
    });

    const first = await harness.run(['orchestration-recall']);
    const second = await harness.run(['orchestration-recall']);
    const runs = await harness.list();

    assert.equal(runs.length, 2);
    assert.equal(runs[0].id, second.id);
    assert.equal(runs[1].id, first.id);
  });

  it('reports a failing verification task correctly', async () => {
    const harness = new EvaluationHarness({
      basePath,
      verificationCommands: [['node', ['-e', 'process.exit(1)']]],
    });

    const run = await harness.run(['verify-project']);

    assert.equal(run.status, 'failed');
    assert.equal(run.summary.passed, 0);
    assert.equal(run.summary.failed, 1);
    assert.equal(run.tasks[0].score, 0);
  });

  it('scores verification traces for regressions and flakiness', async () => {
    const memory = new GitMemory(basePath);
    const cell = await memory.load();
    cell.verificationTraces = [
      {
        missionId: 'mission-a',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        entries: [
          { attempt: 1, passed: true, timestamp: new Date().toISOString() },
          { attempt: 2, passed: true, timestamp: new Date().toISOString() },
        ],
      },
      {
        missionId: 'mission-b',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        entries: [
          { attempt: 1, passed: true, timestamp: new Date().toISOString() },
          { attempt: 2, passed: false, timestamp: new Date().toISOString() },
        ],
      },
    ];
    await memory.save(cell);

    const harness = new EvaluationHarness({
      basePath,
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
    });

    const run = await harness.run(['verification-traces']);
    const task = run.tasks.find((t) => t.taskId === 'verification-traces')!;

    assert.equal(task.status, 'failed');
    assert.equal(task.score, 0.75);
    assert.ok(task.detail?.includes('1 regression'));
  });
});
