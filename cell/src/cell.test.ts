import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Cell } from './cell.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'cell-test-'));
}

describe('Cell', () => {
  let basePath: string;

  beforeEach(() => {
    basePath = makeTmpDir();
  });

  it('starts idle with no missions', async () => {
    const cell = new Cell({ basePath, verificationCommands: [], maxRetries: 3 });
    assert.equal(await cell.state(), 'idle');
    assert.equal(await cell.currentMission(), undefined);
  });

  it('queues a mission and transitions through phases', async () => {
    const cell = new Cell({ basePath, verificationCommands: [], maxRetries: 3 });
    await cell.queueMission('Hello world', 'Write a hello world function');

    await cell.tick(); // idle -> planning
    assert.equal(await cell.state(), 'planning');

    await cell.tick(); // planning -> executing
    assert.equal(await cell.state(), 'executing');

    await cell.tick(); // executing -> verifying
    assert.equal(await cell.state(), 'verifying');

    await cell.tick(); // verifying -> reviewing
    assert.equal(await cell.state(), 'reviewing');

    await cell.tick(); // reviewing -> idle
    assert.equal(await cell.state(), 'idle');

    const latest = await cell.resume();
    assert.equal(latest?.state, 'reviewing');
    assert.equal(latest?.result, 'success');
  });

  it('fails loop convergence and records failure', async () => {
    const cell = new Cell({
      basePath,
      verificationCommands: [['false', []]],
      maxRetries: 3,
    });
    await cell.queueMission('Bad mission', 'This will fail verification');

    await cell.tick(); // idle -> planning
    await cell.tick(); // planning -> executing
    try {
      await cell.tick(); // executing: loop fails after retries
    } catch {
      // expected
    }

    assert.equal(await cell.state(), 'executing');
    const latest = await cell.resume();
    assert.equal(latest?.state, 'executing');
    assert.equal(latest?.result, 'failure');
  });
});
