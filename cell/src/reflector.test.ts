import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Reflector } from './reflector.js';
import type { Observation, VerificationSummary } from './types.js';

function summary(passed: boolean): VerificationSummary {
  return {
    passed,
    results: [
      {
        passed,
        command: 'npm test',
        stdout: passed ? 'ok' : '',
        stderr: passed ? '' : 'failed',
        exitCode: passed ? 0 : 1,
      },
    ],
  };
}

function observation(success: boolean, note?: string): Observation {
  return { stepId: 's1', output: success ? 'ok' : 'bad', success, note };
}

describe('Reflector', () => {
  it('finishes when verification passes', () => {
    const reflector = new Reflector({ maxAttempts: 3 });
    const reflection = reflector.reflect(observation(true), summary(true), 1);
    assert.equal(reflection.verdict, 'finish');
    assert.equal(reflection.shouldRetry, false);
  });

  it('continues when verification fails and budget remains', () => {
    const reflector = new Reflector({ maxAttempts: 3 });
    const reflection = reflector.reflect(observation(false, 'timeout'), summary(false), 1);
    assert.equal(reflection.verdict, 'continue');
    assert.equal(reflection.shouldRetry, true);
  });

  it('escalates on the final attempt when verification still fails', () => {
    const reflector = new Reflector({ maxAttempts: 3 });
    const reflection = reflector.reflect(observation(false), summary(false), 3);
    assert.equal(reflection.verdict, 'escalate');
    assert.equal(reflection.shouldRetry, false);
  });

  it('escalates immediately when the action itself fails on the last attempt', () => {
    const reflector = new Reflector({ maxAttempts: 2 });
    const reflection = reflector.reflect(observation(false, 'tool crashed'), summary(false), 2);
    assert.equal(reflection.verdict, 'escalate');
    assert.match(reflection.note, /tool crashed/);
  });

  it('uses failure-kind overrides before budget checks', () => {
    const reflector = new Reflector({
      maxAttempts: 5,
      failureKinds: [
        { substring: 'ENOENT', verdict: 'escalate', reason: 'Missing file is not recoverable by retry' },
        { substring: 'timeout', verdict: 'continue', reason: 'Transient timeout should retry' },
      ],
    });
    const missingFile = reflector.reflect({ stepId: 's1', output: 'Error: ENOENT: no such file', success: false }, summary(false), 1);
    assert.equal(missingFile.verdict, 'escalate');
    assert.match(missingFile.note, /Missing file/);

    const timeout = reflector.reflect({ stepId: 's1', output: 'Connection timeout after 30s', success: false }, summary(false), 1);
    assert.equal(timeout.verdict, 'continue');
    assert.match(timeout.note, /Transient timeout/);
  });
});
