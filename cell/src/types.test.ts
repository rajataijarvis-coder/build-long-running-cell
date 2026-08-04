import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Mission, CellMemory, CellState } from './types.js';

describe('types', () => {
  it('creates a Mission with required fields', () => {
    const mission: Mission = {
      id: 'mission-1',
      title: 'Hello world',
      description: 'Write a hello-world function',
      status: 'backlog',
      priority: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    assert.equal(mission.id, 'mission-1');
    assert.equal(mission.title, 'Hello world');
    assert.equal(mission.status, 'backlog');
  });

  it('initialises CellMemory with default idle state', () => {
    const memory: CellMemory = {
      currentState: 'idle' as CellState,
      missions: [],
      progressLog: [],
      decisions: [],
      proposals: [],
    };

    assert.equal(memory.currentState, 'idle');
    assert.deepEqual(memory.missions, []);
    assert.deepEqual(memory.progressLog, []);
    assert.deepEqual(memory.decisions, []);
    assert.deepEqual(memory.proposals, []);
    assert.equal(memory.currentMissionId, undefined);
  });
});
