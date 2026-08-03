import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LoopEngine } from './loop-engine.js';

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
});
