import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryStore } from './memory-store.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'memory-store-test-'));
}

function writeMemory(basePath: string, memory: Record<string, unknown>): void {
  const dir = join(basePath, 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'memory.json'), JSON.stringify(memory, null, 2), 'utf-8');
}

function writeJournal(basePath: string, entries: unknown[]): void {
  const dir = join(basePath, 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'journal.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

describe('MemoryStore', () => {
  let basePath: string;

  beforeEach(() => {
    basePath = makeTmpDir();
    writeMemory(basePath, {
      currentState: 'idle',
      missions: [
        { id: 'm1', title: 'Fix timeout', description: 'Retry flaky tests', status: 'done', priority: 1, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T01:00:00Z' },
      ],
      progressLog: ['[2026-08-01T00:30:00Z] Started m1', '[2026-08-01T01:00:00Z] Finished m1'],
      decisions: [
        { id: 'd1', timestamp: '2026-08-01T00:45:00Z', context: 'Mission m1', choice: 'Increase timeout', reason: 'Tests were timing out under load' },
      ],
      proposals: [],
    });
    writeJournal(basePath, [
      { id: 'j1', missionId: 'm1', startedAt: '2026-08-01T00:30:00Z', finishedAt: '2026-08-01T00:31:00Z', state: 'executing', result: 'success', notes: [] },
    ]);
  });

  it('indexes missions, decisions, progress, and journal entries', async () => {
    const store = new MemoryStore({ basePath });
    const docs = await store.loadAll();
    assert.ok(docs.some((d) => d.kind === 'mission' && d.missionId === 'm1'));
    assert.ok(docs.some((d) => d.kind === 'decision' && d.text.includes('Increase timeout')));
    assert.ok(docs.some((d) => d.kind === 'journal' && d.missionId === 'm1'));
    assert.ok(docs.some((d) => d.kind === 'progress'));
  });

  it('filters documents by mission id', async () => {
    const store = new MemoryStore({ basePath });
    const docs = await store.loadForMission('m1');
    assert.ok(docs.every((d) => d.missionId === 'm1' || d.kind === 'progress'));
  });
});
