import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LoopEngine } from './loop-engine.js';

describe('LoopEngine', () => {
  it('succeeds immediately when verification passes', async () => {
    const engine = new LoopEngine([], [['true', []]], 3);
    const result = await engine.run('mission-1', 'Do something simple');
    assert.equal(result.success, true);
    assert.equal(result.iterations.length, 1);
    assert.equal(result.iterations[0].passed, true);
  });

  it('retries until maxIterations and reports failure', async () => {
    const engine = new LoopEngine([], [['false', []]], 3);
    const result = await engine.run('mission-2', 'This always fails');
    assert.equal(result.success, false);
    assert.equal(result.iterations.length, 3);
    assert.ok(result.iterations.every((i) => !i.passed));
  });

  it('uses tools when available', async () => {
    const engine = new LoopEngine(
      [{ name: 'echo', description: 'echo', execute: async (input) => `echo ${input}` }],
      [['true', []]],
      2
    );
    const result = await engine.run('mission-3', 'Echo back');
    assert.equal(result.success, true);
    assert.ok(result.finalAnswer.includes('echo'));
  });
});
