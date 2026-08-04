import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LoopEngine } from './loop-engine.js';
import type { Thought, Observation } from './types.js';

describe('LoopEngine', () => {
  it('succeeds immediately when verification passes', async () => {
    const engine = new LoopEngine([], [['node', ['-e', 'process.exit(0)']]], 2);
    const result = await engine.run('mission-1', 'verify the project');
    assert.equal(result.success, true);
    assert.equal(result.iterations.length, 1);
    assert.equal(result.iterations[0].passed, true);
    assert.ok(result.iterations[0].plan.steps.length > 0);
  });

  it('retries until maxIterations and reports failure', async () => {
    const engine = new LoopEngine([], [['node', ['-e', 'process.exit(1)']]], 3);
    const result = await engine.run('mission-2', 'verify the project');
    assert.equal(result.success, false);
    assert.equal(result.iterations.length, 3);
    assert.ok(result.iterations.every((i) => !i.passed));
  });

  it('uses tools when available', async () => {
    const engine = new LoopEngine(
      [{ name: 'echo', description: 'echo', execute: async (input: string) => `echo ${input}` }],
      [['node', ['-e', 'process.exit(0)']]],
      2,
      { failureMarkers: [] }
    );
    const result = await engine.run('mission-3', 'Echo back');
    assert.equal(result.success, true);
    assert.equal(result.iterations[0].action.tool, 'shell');
    assert.ok(result.iterations[0].observation.output.length > 0);
  });

  it('invokes onCheckpoint after each non-finish iteration', async () => {
    const engine = new LoopEngine([], [['node', ['-e', 'process.exit(1)']]], 3);
    const checkpoints: Array<{
      priorThought?: Thought;
      priorObservation?: Observation;
      attempt: number;
      accumulatedTask: string;
    }> = [];

    const result = await engine.run('mission-4', 'verify the project', undefined, async (checkpoint) => {
      checkpoints.push(checkpoint);
    });

    assert.equal(result.success, false);
    // Three failed attempts; each produces a checkpoint before the next retry.
    assert.equal(checkpoints.length, 3);
    assert.equal(checkpoints[0].attempt, 1);
    assert.equal(checkpoints[1].attempt, 2);
    assert.equal(checkpoints[2].attempt, 3);
    assert.ok(checkpoints[2].accumulatedTask.includes('Attempt 2 failed'));
    assert.ok(checkpoints[2].priorThought);
    assert.ok(checkpoints[2].priorObservation);
  });

  it('resumes from a saved checkpoint without repeating earlier attempts', async () => {
    const engine = new LoopEngine([], [['node', ['-e', 'process.exit(1)']]], 3);
    const first = await engine.run('mission-5', 'verify the project');
    assert.equal(first.success, false);
    assert.equal(first.iterations.length, 3);

    const checkpoint = first.checkpoint;
    assert.ok(checkpoint);

    // Resume from the last checkpoint. The loop should start at attempt 4
    // (which is past maxIterations) and therefore return immediately.
    const second = await engine.run('mission-5', 'verify the project', checkpoint);
    assert.equal(second.success, false);
    assert.equal(second.iterations.length, 0);
    assert.equal(second.checkpoint?.attempt, 3);
  });
});
