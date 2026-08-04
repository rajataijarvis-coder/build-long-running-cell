import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Checker } from './checker.js';
import type { LoopResult } from './loop-engine.js';

function makeResult(overrides: Partial<LoopResult> = {}): LoopResult {
  return {
    missionId: 'm1',
    iterations: overrides.iterations ?? [
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
    finalAnswer: overrides.finalAnswer ?? '__VERIFY_PASS__',
    success: overrides.success ?? true,
  } as LoopResult;
}

describe('Checker', () => {
  it('approves a passing result with enough iterations', () => {
    const checker = new Checker();
    const review = checker.review('m1', makeResult());
    assert.equal(review.verdict, 'approve');
  });

  it('rejects results containing unsafe markers', () => {
    const checker = new Checker();
    const review = checker.review('m1', makeResult({
      finalAnswer: 'Path escapes workspace',
      success: false,
    }));
    assert.equal(review.verdict, 'reject');
  });

  it('requests revision when verification failed', () => {
    const checker = new Checker();
    const review = checker.review('m1', makeResult({
      finalAnswer: '__VERIFY_FAIL__',
      success: false,
      iterations: [
        {
          step: 1,
          plan: { missionId: 'm1', goal: 'verify', steps: [], reasoning: 'test' },
          thought: undefined,
          action: { stepId: 's1', tool: 'verify', input: '' },
          observation: { stepId: 's1', output: '__VERIFY_FAIL__', success: false, note: 'lint failed' },
          reflection: undefined,
          verification: { passed: false, results: [] },
          passed: false,
        },
      ],
    }));
    assert.equal(review.verdict, 'revise');
    assert.match(review.feedback, /Revision trigger/);
  });

  it('demands more than one iteration when configured', () => {
    const checker = new Checker({ minIterations: 2 });
    const review = checker.review('m1', makeResult());
    assert.equal(review.verdict, 'revise');
    assert.match(review.feedback, /minimum is 2/);
  });
});
