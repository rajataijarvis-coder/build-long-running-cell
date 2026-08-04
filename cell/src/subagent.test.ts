import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MakerSubAgent, CheckerSubAgent } from './subagent.js';
import type { LoopResult } from './loop-engine.js';

describe('MakerSubAgent', () => {
  it('produces an approved result when verification passes', async () => {
    const maker = new MakerSubAgent({
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
      maxIterations: 2,
    });
    const result = await maker.run('verify the project', { missionId: 'm1' });
    assert.equal(result.success, true);
    assert.ok(result.artifact);
    assert.ok(result.reasoning);
    assert.ok(result.loopResult);
  });

  it('produces a failed result when verification fails', async () => {
    const maker = new MakerSubAgent({
      verificationCommands: [['node', ['-e', 'process.exit(1)']]],
      maxIterations: 2,
    });
    const result = await maker.run('verify the project', { missionId: 'm1' });
    assert.equal(result.success, false);
  });
});

describe('CheckerSubAgent', () => {
  it('approves a passing maker result', async () => {
    const checker = new CheckerSubAgent();
    const result = await checker.run('', {
      missionId: 'm1',
      makerResult: {
        missionId: 'm1',
        iterations: [
          {
            step: 1,
            plan: { missionId: 'm1', goal: 'verify', steps: [], reasoning: 'test' },
            thought: undefined,
            action: { stepId: 's1', tool: 'verify', input: '' },
            observation: { stepId: 's1', output: '__VERIFY_PASS__', success: true },
            reflection: undefined,
            verification: { passed: true, results: [] },
            passed: true,
          },
        ],
        finalAnswer: '__VERIFY_PASS__',
        success: true,
      } as LoopResult,
    });
    assert.equal(result.success, true);
    assert.match(result.output, /approved/i);
  });

  it('rejects a result with unsafe markers', async () => {
    const checker = new CheckerSubAgent();
    const result = await checker.run('', {
      missionId: 'm1',
      makerResult: {
        missionId: 'm1',
        iterations: [],
        finalAnswer: 'Path escapes workspace',
        success: false,
      } as LoopResult,
    });
    assert.equal(result.success, false);
    assert.match(result.output, /rejected/i);
  });
});
