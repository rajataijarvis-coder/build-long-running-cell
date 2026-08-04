import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { Worktree } from './worktree.js';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coord-test-'));
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('Worktree', () => {
  let repo: string;
  let worktree: Worktree;

  beforeEach(() => {
    repo = makeRepo();
    worktree = new Worktree(repo, 'test-loop');
  });

  afterEach(async () => {
    await worktree.remove();
  });

  it('creates a new worktree directory', async () => {
    await worktree.create();
    assert.ok(existsSync(worktree.path));
    assert.ok(existsSync(join(worktree.path, 'README.md')));
  });

  it('reports clean status when no files change', async () => {
    await worktree.create();
    const status = await worktree.status();
    assert.equal(status.clean, true);
  });

  it('lists changed files after an edit', async () => {
    await worktree.create();
    writeFileSync(join(worktree.path, 'README.md'), '# hello\n\nedit', 'utf-8');
    const files = await worktree.diffNameOnly('HEAD');
    assert.deepEqual(files, ['README.md']);
  });
});
