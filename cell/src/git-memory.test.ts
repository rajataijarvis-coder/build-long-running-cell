import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GitMemory } from './git-memory.js';

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
});
