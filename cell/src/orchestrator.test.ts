import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Orchestrator } from './orchestrator.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'cell-orchestrator-'));
}

describe('Orchestrator', () => {
  let basePath: string;

  beforeEach(() => {
    basePath = makeTmpDir();
  });

  afterEach(() => {
    rmSync(basePath, { recursive: true, force: true });
  });

  it('runs a goal and records an orchestration run', async () => {
    const orchestrator = new Orchestrator({
      basePath,
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
      maxConcurrency: 1,
      maxRetries: 1,
      maxSubMissions: 2,
      useSpecialists: false,
    });

    const run = await orchestrator.run('verify the project');
    assert.ok(run.id.startsWith('orch-'));
    assert.equal(run.goal, 'verify the project');
    assert.ok(run.status === 'done' || run.status === 'failed');

    const runs = await orchestrator.list();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, run.id);
  });

  it('lists runs most recent first', async () => {
    const orchestrator = new Orchestrator({
      basePath,
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
      useSpecialists: false,
    });

    const first = await orchestrator.run('first goal');
    const second = await orchestrator.run('second goal');
    const runs = await orchestrator.list();
    assert.equal(runs[0].id, second.id);
    assert.equal(runs[1].id, first.id);
  });
});
