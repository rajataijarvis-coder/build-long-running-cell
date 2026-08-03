import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ExecutionJournal } from './journal.js';

function makeBase(): string {
  return mkdtempSync(join(tmpdir(), 'journal-test-'));
}

describe('ExecutionJournal', () => {
  let basePath: string;
  let journal: ExecutionJournal;

  beforeEach(() => {
    basePath = makeBase();
    journal = new ExecutionJournal(basePath);
  });

  it('starts empty', async () => {
    const entries = await journal.readAll();
    assert.deepEqual(entries, []);
    assert.equal(await journal.latest(), undefined);
  });

  it('records a run and queries it by result', async () => {
    const run = await journal.start('mission-1', 'planning');
    await journal.finish(run.id, 'success', 'plan accepted');

    const successes = await journal.byResult('success');
    assert.equal(successes.length, 1);
    assert.equal(successes[0].id, run.id);
    assert.equal(successes[0].result, 'success');

    assert.deepEqual(await journal.byResult('failure'), []);
    assert.deepEqual(await journal.byResult('retry'), []);
  });

  it('isolates entries by mission', async () => {
    const runA = await journal.start('mission-a', 'executing');
    await journal.finish(runA.id, 'failure', 'tool error');

    const runB = await journal.start('mission-b', 'executing');
    await journal.finish(runB.id, 'success');

    assert.equal((await journal.forMission('mission-a')).length, 1);
    assert.equal((await journal.forMission('mission-b')).length, 1);
    assert.equal((await journal.byResult('failure')).length, 1);
    assert.equal((await journal.byResult('success')).length, 1);
  });

  it('returns the latest entry', async () => {
    await journal.start('mission-1', 'planning');
    const second = await journal.start('mission-1', 'executing');

    const latest = await journal.latest();
    assert.equal(latest?.id, second.id);
    assert.equal(latest?.state, 'executing');
  });

  it('rejects finish for an unknown run id', async () => {
    await assert.rejects(
      async () => journal.finish('does-not-exist', 'success'),
      /Run does-not-exist not found/
    );
  });

  it('is idempotent when finishing the same run twice', async () => {
    const run = await journal.start('mission-1', 'verifying');
    await journal.finish(run.id, 'success');
    await journal.finish(run.id, 'failure', 'should not overwrite');

    const entries = await journal.byResult('success');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].result, 'success');
    assert.equal(entries[0].notes.length, 0);
  });
});
