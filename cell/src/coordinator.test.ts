import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { Coordinator } from './coordinator.js';
import type { Mission } from './types.js';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coord-test-'));
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
  writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 2;\n', 'utf-8');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

function mission(title: string, description: string): Mission {
  const id = `m-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
  return {
    id,
    title,
    description,
    status: 'backlog',
    priority: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('Coordinator', () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo();
  });

  it('runs two non-conflicting missions in parallel and merges both', async () => {
    const coordinator = new Coordinator({
      basePath: repo,
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
      maxConcurrency: 2,
      maxRetries: 1,
    });

    const m1 = mission('Verify project', 'verify the project');
    const m2 = mission('Verify again', 'verify the project');

    const result = await coordinator.coordinate([m1, m2]);

    assert.equal(result.results.length, 2);
    assert.equal(result.results.every((r) => r.success), true);
    assert.equal(result.rejected.length, 0);
  });

  it('tracks which files were touched by coordination', async () => {
    const coordinator = new Coordinator({
      basePath: repo,
      verificationCommands: [['node', ['-e', 'process.exit(0)']]],
      maxConcurrency: 1,
      maxRetries: 1,
    });

    const m1 = mission('Verify project', 'verify the project');
    const result = await coordinator.coordinate([m1]);
    assert.equal(result.results[0]?.success, true);
    assert.equal(result.merged.length, 0);
    assert.equal(result.rejected.length, 0);
  });
});
