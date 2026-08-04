import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { CellRunner } from './runner.js';
import type { Mission } from './types.js';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'));
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'main.ts'), 'export const value = 1;\n', 'utf-8');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('CellRunner', () => {
  let repo: string;
  let runner: CellRunner;

  beforeEach(() => {
    repo = makeRepo();
    runner = new CellRunner({
      name: 'test',
      basePath: repo,
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
      maxRetries: 1,
    });
  });

  afterEach(async () => {
    await runner.remove();
  });

  it('runs a mission to completion inside a worktree', async () => {
    const mission: Mission = {
      id: 'm1',
      title: 'Verify project',
      description: 'verify the project',
      status: 'backlog',
      priority: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await runner.run(mission);
    assert.equal(result.success, true);
    assert.equal(result.missionId, mission.id);
  });

  it('removes its worktree after reporting results', async () => {
    const mission: Mission = {
      id: 'm2',
      title: 'Verify project',
      description: 'verify the project',
      status: 'backlog',
      priority: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await runner.run(mission);
    await runner.remove();
    assert.equal(existsSync(join(runner['worktree'].path, 'src', 'main.ts')), false);
  });
});
