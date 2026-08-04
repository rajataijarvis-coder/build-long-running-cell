import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FailureClassifier } from './failure.js';
import { FailureMemory, GitMemory } from './git-memory.js';

function makeMemory(): FailureMemory {
  const dir = mkdtempSync(join(tmpdir(), 'failure-test-'));
  return new FailureMemory(new GitMemory(dir));
}

describe('FailureClassifier', () => {
  it('classifies missing module as environment failure', () => {
    const classifier = new FailureClassifier();
    const result = classifier.classify('Error: module not found: foo');
    assert.equal(result.kind, 'env');
    assert.equal(result.recovery, 'escalate');
  });

  it('classifies timeout as retryable', () => {
    const classifier = new FailureClassifier();
    const result = classifier.classify('Shell command timed out after 30000ms');
    assert.equal(result.kind, 'timeout');
    assert.equal(result.recovery, 'retry');
  });

  it('classifies syntax error as escalation', () => {
    const classifier = new FailureClassifier();
    const result = classifier.classify('SyntaxError: Unexpected token');
    assert.equal(result.kind, 'code');
    assert.equal(result.recovery, 'escalate');
  });

  it('returns unknown for unrecognized text', () => {
    const classifier = new FailureClassifier();
    const result = classifier.classify('Something weird happened');
    assert.equal(result.kind, 'unknown');
    assert.equal(result.recovery, 'retry');
  });

  it('applies custom rules', () => {
    const classifier = new FailureClassifier({
      rules: [{ substring: 'CUSTOM', kind: 'custom', recovery: 'skip', reason: 'test' }],
    });
    const result = classifier.classify('A CUSTOM error');
    assert.equal(result.kind, 'custom');
    assert.equal(result.recovery, 'skip');
  });
});

describe('FailureMemory', () => {
  let memory: FailureMemory;

  beforeEach(() => {
    memory = makeMemory();
  });

  it('records and retrieves failures', async () => {
    await memory.record({
      id: 'f-1',
      missionId: 'm-1',
      kind: 'timeout',
      message: 'timed out',
      source: 'runner-0',
      timestamp: new Date().toISOString(),
      recovery: 'retry',
    });
    const recent = await memory.recent(10);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].kind, 'timeout');
  });

  it('filters failures by kind', async () => {
    await memory.record({ id: 'f-1', missionId: 'm-1', kind: 'timeout', message: 't', source: 'r', timestamp: new Date().toISOString(), recovery: 'retry' });
    await memory.record({ id: 'f-2', missionId: 'm-2', kind: 'env', message: 'e', source: 'r', timestamp: new Date().toISOString(), recovery: 'escalate' });
    const envFailures = await memory.byKind('env');
    assert.equal(envFailures.length, 1);
    assert.equal(envFailures[0].id, 'f-2');
  });

  it('tracks unresolved failures', async () => {
    await memory.record({ id: 'f-1', missionId: 'm-1', kind: 'timeout', message: 't', source: 'r', timestamp: new Date().toISOString(), recovery: 'retry' });
    assert.equal((await memory.unresolved()).length, 1);
    await memory.markResolved('f-1');
    assert.equal((await memory.unresolved()).length, 0);
  });
});
