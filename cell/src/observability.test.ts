import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Observability } from './observability.js';

function makeObs(options: Partial<ConstructorParameters<typeof Observability>[0]> = {}): { obs: Observability; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'obs-test-'));
  const obs = new Observability({ basePath: dir, ...options });
  return { obs, dir };
}

describe('Observability', () => {
  it('loads an empty metric snapshot', async () => {
    const { obs } = makeObs();
    const s = await obs.snapshot();
    assert.equal(s.ticks, 0);
    assert.equal(s.missionsCompleted, 0);
    assert.equal(s.guardrailBlocks, 0);
  });

  it('increments counters', async () => {
    const { obs } = makeObs();
    const s = await obs.increment('ticks', 'missionsCompleted', 'verificationsRun');
    assert.equal(s.ticks, 1);
    assert.equal(s.missionsCompleted, 1);
    assert.equal(s.verificationsRun, 1);
    assert.equal(s.leadRuns, 0);
  });

  it('sets a counter value', async () => {
    const { obs } = makeObs();
    await obs.increment('ticks');
    const s = await obs.set('memoryDocumentCount', 42);
    assert.equal(s.ticks, 1);
    assert.equal(s.memoryDocumentCount, 42);
  });

  it('reports healthy when failures do not dominate', async () => {
    const { obs } = makeObs();
    await obs.increment('missionsCompleted', 'missionsCompleted');
    await obs.increment('missionsFailed');
    const s = await obs.snapshot();
    assert.equal(obs.health(s), 'healthy');
  });

  it('reports degraded when failures exceed completions', async () => {
    const { obs } = makeObs();
    await obs.increment('missionsCompleted');
    await obs.increment('missionsFailed', 'missionsFailed');
    const s = await obs.snapshot();
    assert.equal(obs.health(s), 'degraded');
  });

  it('resets all counters', async () => {
    const { obs } = makeObs();
    await obs.increment('ticks', 'missionsCompleted', 'guardrailBlocks');
    const s = await obs.reset();
    assert.equal(s.ticks, 0);
    assert.equal(s.missionsCompleted, 0);
    assert.equal(s.guardrailBlocks, 0);
  });

  it('persists across instances', async () => {
    const { obs, dir } = makeObs();
    await obs.increment('ticks', 'ticks');
    const second = new Observability({ basePath: dir });
    const s = await second.snapshot();
    assert.equal(s.ticks, 2);
  });
});
