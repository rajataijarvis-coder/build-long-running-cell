import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemorySummariser, SummaryMemory } from './summary.js';
import { GitMemory } from './git-memory.js';
import type { CellMemory, FailureRecord, LeadRun, Mission } from './types.js';

function makeMemory(): { basePath: string; git: GitMemory; summary: SummaryMemory } {
  const dir = mkdtempSync(join(tmpdir(), 'summary-test-'));
  const git = new GitMemory(dir);
  const summary = new SummaryMemory(git, { maxSummaries: 10, retention: 'lru' });
  return { basePath: dir, git, summary };
}

function mission(id: string, title: string, status: Mission['status']): Mission {
  return {
    id,
    title,
    description: title,
    status,
    priority: 1,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T01:00:00Z',
  };
}

function leadRun(id: string, goal: string): LeadRun {
  return {
    id,
    goal,
    timestamp: new Date().toISOString(),
    missionIds: ['m-1'],
    merged: ['src/a.ts'],
    rejected: [],
    failed: [],
  };
}

function failure(id: string, kind: string, message: string): FailureRecord {
  return {
    id,
    missionId: 'm-1',
    kind,
    message,
    source: 'runner-0',
    timestamp: new Date().toISOString(),
    recovery: 'retry',
    resolved: false,
  };
}

describe('MemorySummariser', () => {
  it('does not emit summaries below the source threshold', async () => {
    const memory: CellMemory = {
      currentState: 'idle',
      missions: [mission('m-1', 'Fix timeout', 'done')],
      progressLog: [],
      decisions: [],
      proposals: [],
    };
    const summariser = new MemorySummariser({ minSources: 3 });
    const summaries = await summariser.summarise(memory, ['mission-history']);
    assert.equal(summaries.length, 0);
  });

  it('summarises mission history into status counts', async () => {
    const memory: CellMemory = {
      currentState: 'idle',
      missions: [
        mission('m-1', 'Fix timeout', 'done'),
        mission('m-2', 'Retry flaky tests', 'failed'),
        mission('m-3', 'Update README', 'done'),
      ],
      progressLog: [],
      decisions: [],
      proposals: [],
    };
    const summariser = new MemorySummariser({ minSources: 2 });
    const summaries = await summariser.summarise(memory, ['mission-history']);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].kind, 'mission-history');
    assert.ok(summaries[0].text.includes('3 mission'));
    assert.ok(summaries[0].text.includes('done:2'));
    assert.ok(summaries[0].text.includes('failed:1'));
  });

  it('summarises lead runs into merged/rejected/failed counts', async () => {
    const memory: CellMemory = {
      currentState: 'idle',
      missions: [],
      progressLog: [],
      decisions: [],
      proposals: [],
      leadRuns: [
        leadRun('lr-1', 'Add module and README'),
        leadRun('lr-2', 'Fix timeout and verify'),
        leadRun('lr-3', 'Add API endpoint'),
      ],
    };
    const summariser = new MemorySummariser({ minSources: 2 });
    const summaries = await summariser.summarise(memory, ['lead-runs']);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].kind, 'lead-runs');
    assert.ok(summaries[0].text.includes('3 decomposition'));
    assert.ok(summaries[0].text.includes('Merged 3 file'));
  });

  it('summarises failures by kind and unresolved count', async () => {
    const memory: CellMemory = {
      currentState: 'idle',
      missions: [],
      progressLog: [],
      decisions: [],
      proposals: [],
      failures: [
        failure('f-1', 'timeout', 'Shell command timed out'),
        failure('f-2', 'timeout', 'Verification timed out'),
        failure('f-3', 'env', 'module not found'),
      ],
    };
    const summariser = new MemorySummariser({ minSources: 2 });
    const summaries = await summariser.summarise(memory, ['failures']);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].kind, 'failures');
    assert.ok(summaries[0].text.includes('timeout:2'));
    assert.ok(summaries[0].text.includes('env:1'));
    assert.ok(summaries[0].text.includes('3 unresolved'));
  });

  it('produces an overall snapshot summary', async () => {
    const memory: CellMemory = {
      currentState: 'idle',
      missions: [mission('m-1', 'Fix timeout', 'done')],
      progressLog: [],
      decisions: [],
      proposals: [],
      leadRuns: [leadRun('lr-1', 'Add module')],
      failures: [failure('f-1', 'timeout', 'timed out')],
    };
    const summariser = new MemorySummariser({ minSources: 1 });
    const summaries = await summariser.summarise(memory, ['all']);
    const all = summaries.find((s) => s.kind === 'all');
    assert.ok(all);
    assert.ok(all!.text.includes('1 mission'));
    assert.ok(all!.text.includes('1 lead run'));
    assert.ok(all!.text.includes('1 failure record'));
  });
});

describe('SummaryMemory', () => {
  let base: ReturnType<typeof makeMemory>;

  beforeEach(() => {
    base = makeMemory();
  });

  it('records a summary and lists it', async () => {
    const summary = {
      id: 's-1',
      kind: 'all' as const,
      timestamp: new Date().toISOString(),
      text: 'Snapshot of cell memory.',
      sourceIds: ['m-1'],
      sourceCount: 1,
      keywords: ['snapshot'],
      metadata: {},
    };
    await base.summary.append([summary]);
    const list = await base.summary.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 's-1');
  });

  it('prunes using LRU retention', async () => {
    for (let i = 0; i < 12; i++) {
      const summary = {
        id: `s-${i}`,
        kind: 'all' as const,
        timestamp: new Date(Date.now() + i).toISOString(),
        text: `Snapshot ${i}.`,
        sourceIds: [`m-${i}`],
        sourceCount: 1,
        keywords: [`snapshot${i}`],
        metadata: {},
      };
      await base.summary.append([summary]);
    }
    const list = await base.summary.list();
    assert.equal(list.length, 10);
    assert.ok(list.some((s) => s.id === 's-11'));
    assert.ok(!list.some((s) => s.id === 's-0'));
  });

  it('searches summaries by text and keywords', async () => {
    await base.summary.append([
      {
        id: 's-timeout',
        kind: 'failures' as const,
        timestamp: new Date().toISOString(),
        text: 'Many timeout failures under load.',
        sourceIds: ['f-1', 'f-2'],
        sourceCount: 2,
        keywords: ['timeout', 'load'],
        metadata: {},
      },
      {
        id: 's-env',
        kind: 'failures' as const,
        timestamp: new Date().toISOString(),
        text: 'Environment module not found.',
        sourceIds: ['f-3'],
        sourceCount: 1,
        keywords: ['env'],
        metadata: {},
      },
    ]);
    const results = await base.summary.search('timeout');
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 's-timeout');
  });

  it('filters summaries by kind', async () => {
    await base.summary.append([
      {
        id: 's-1',
        kind: 'lead-runs' as const,
        timestamp: new Date().toISOString(),
        text: 'Lead run summary.',
        sourceIds: ['lr-1'],
        sourceCount: 1,
        keywords: [],
        metadata: {},
      },
      {
        id: 's-2',
        kind: 'failures' as const,
        timestamp: new Date().toISOString(),
        text: 'Failure summary.',
        sourceIds: ['f-1'],
        sourceCount: 1,
        keywords: [],
        metadata: {},
      },
    ]);
    const failures = await base.summary.byKind('failures');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].id, 's-2');
  });

  it('removes a summary by id', async () => {
    await base.summary.append([
      {
        id: 's-1',
        kind: 'all' as const,
        timestamp: new Date().toISOString(),
        text: 'Keep.',
        sourceIds: [],
        sourceCount: 0,
        keywords: [],
        metadata: {},
      },
      {
        id: 's-2',
        kind: 'all' as const,
        timestamp: new Date().toISOString(),
        text: 'Remove.',
        sourceIds: [],
        sourceCount: 0,
        keywords: [],
        metadata: {},
      },
    ]);
    const removed = await base.summary.remove('s-2');
    assert.equal(removed, true);
    const list = await base.summary.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 's-1');
  });
});
