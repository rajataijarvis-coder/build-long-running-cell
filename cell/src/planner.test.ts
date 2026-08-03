import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Planner } from './planner.js';

describe('Planner', () => {
  it('creates a verification-heavy plan when the goal mentions tests', async () => {
    const planner = new Planner({ maxSteps: 3 });
    const plan = await planner.plan('mission-1', 'Verify the project with lint and tests');
    assert.equal(plan.missionId, 'mission-1');
    assert.ok(plan.steps.length > 0);
    assert.equal(plan.steps[0].tool, 'shell');
    assert.match(plan.steps[0].input ?? '', /npm run verify/);
  });

  it('creates an inspection plan when the goal mentions reading files', async () => {
    const planner = new Planner({ maxSteps: 3 });
    const plan = await planner.plan('mission-2', 'Inspect the journal and state files');
    assert.ok(plan.steps.some((s) => (s.input ?? '').includes('Read state')));
  });

  it('caps steps at maxSteps', async () => {
    const planner = new Planner({ maxSteps: 2 });
    const plan = await planner.plan('mission-3', 'Do many things including verify, create, read, inspect');
    assert.equal(plan.steps.length, 2);
  });
});
