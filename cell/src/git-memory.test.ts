import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import { GitMemory } from './git-memory.js';

function commitCount(base: string): number {
  try {
    const out = execSync('git rev-list --count HEAD', {
      cwd: join(base, 'state'),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return Number(out.trim());
  } catch {
    return 0;
  }
}

describe('GitMemory', () => {
  it('loads default memory when no file exists', async () => {
    const base = mkdtempSync(join(tmpdir(), 'gitmem-test-'));
    const mem = new GitMemory(base);
    const loaded = await mem.load();
    assert.equal(loaded.currentState, 'idle');
    assert.deepEqual(loaded.missions, []);
  });

  it('adds missions and logs progress', async () => {
    const base = mkdtempSync(join(tmpdir(), 'gitmem-test-'));
    const mem = new GitMemory(base);
    const mission = await mem.addMission('Mission one', 'Do the first thing');
    assert.equal(mission.title, 'Mission one');

    await mem.logProgress('Started');
    const loaded = await mem.load();
    assert.equal(loaded.missions.length, 1);
    assert.ok(loaded.progressLog.some((l) => l.includes('Started')));
  });

  it('initialises state/ as a git repository on first save', async () => {
    const base = mkdtempSync(join(tmpdir(), 'gitmem-test-'));
    const mem = new GitMemory(base);
    await mem.addMission('Git init test', 'Trigger first commit');

    const gitDir = execSync('git rev-parse --git-dir', {
      cwd: join(base, 'state'),
      encoding: 'utf-8',
    }).trim();
    assert.ok(gitDir.length > 0);
  });

  it('commits every meaningful state change', async () => {
    const base = mkdtempSync(join(tmpdir(), 'gitmem-test-'));
    const mem = new GitMemory(base);
    const before = commitCount(base);

    await mem.addMission('First', 'one');
    const after1 = commitCount(base);
    assert.equal(after1, before + 1);

    await mem.logProgress('second');
    const after2 = commitCount(base);
    assert.equal(after2, after1 + 1);
  });

  it('recovers the latest committed state after a simulated crash', async () => {
    const base = mkdtempSync(join(tmpdir(), 'gitmem-test-'));
    const mem = new GitMemory(base);
    await mem.addMission('Crash test', 'Survive a restart');

    // Simulate a crash that corrupts the current memory.json
    const path = join(base, 'state', 'memory.json');
    await (await import('fs')).promises.writeFile(path, 'not-json', 'utf-8');

    // Recovery is not automatic yet, but the git history contains the good state.
    const lastGood = execSync('git show HEAD:memory.json', {
      cwd: join(base, 'state'),
      encoding: 'utf-8',
    });
    const parsed = JSON.parse(lastGood);
    assert.equal(parsed.missions.length, 1);
    assert.equal(parsed.missions[0].title, 'Crash test');
  });
});
