import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { Coordinator } from './coordinator.js';
import { FailureMemory, GitMemory } from './git-memory.js';
import type { Mission } from './types.js';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coord-failure-test-'));
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

function mission(title: string, id: string): Mission {
  return {
    id,
    title,
    description: title,
    status: 'backlog',
    priority: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('Coordinator failure learning', () => {
  let repo: string;
  let failureMemory: FailureMemory;

  beforeEach(() => {
    repo = makeRepo();
    failureMemory = new FailureMemory(new GitMemory(repo));
  });

  it('escalates a mission that matches a known unrecoverable failure', async () => {
    await failureMemory.record({
      id: 'f-1',
      missionId: 'm-1',
      kind: 'env',
      message: 'module not found',
      source: 'runner-0',
      timestamp: new Date().toISOString(),
      recovery: 'escalate',
    });

    const coordinator = new Coordinator({
      basePath: repo,
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
      maxConcurrency: 1,
      maxRetries: 1,
      failureMemory,
    });

    const result = await coordinator.coordinate([mission('Add env module', 'm-1')]);

    assert.equal(result.results.length, 0);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].error, /Known unrecoverable failure pattern/);
  });
});
