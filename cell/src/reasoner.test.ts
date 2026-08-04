import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Reasoner } from './reasoner.js';
import type { Plan, Observation } from './types.js';

function makePlan(goal: string): Plan {
  return {
    missionId: 'm1',
    goal,
    reasoning: 'test plan',
    steps: [
      { id: 's1', description: 'Run tests', tool: 'shell', input: 'npm test' },
      { id: 's2', description: 'Review output', tool: 'shell', input: 'echo done' },
    ],
  };
}

describe('Reasoner', () => {
  it('picks the first plan step on the first call', () => {
    const reasoner = new Reasoner();
    const thought = reasoner.reason(makePlan('verify'), undefined, undefined, 'verify the code');
    assert.equal(thought.stepId, 's1');
    assert.equal(thought.action.tool, 'shell');
    assert.equal(thought.action.input, 'npm test');
    assert.match(thought.text, /Run tests/);
  });

  it('advances to the next step after a successful observation', () => {
    const reasoner = new Reasoner();
    const plan = makePlan('verify');
    const first = reasoner.reason(plan, undefined, undefined, 'verify');
    const observation: Observation = {
      stepId: first.stepId,
      output: 'all green',
      success: true,
    };
    const second = reasoner.reason(plan, first, observation, 'verify');
    assert.equal(second.stepId, 's2');
    assert.equal(second.action.input, 'echo done');
  });

  it('retries the same step after a failed observation', () => {
    const reasoner = new Reasoner();
    const plan = makePlan('verify');
    const first = reasoner.reason(plan, undefined, undefined, 'verify');
    const observation: Observation = {
      stepId: first.stepId,
      output: 'error',
      success: false,
      note: 'lint failed',
    };
    const retry = reasoner.reason(plan, first, observation, 'verify');
    assert.equal(retry.stepId, 's1');
    assert.match(retry.action.input, /retry after/);
  });

  it('skips a step that has already succeeded', () => {
    const reasoner = new Reasoner();
    const plan = makePlan('verify');
    const first = reasoner.reason(plan, undefined, undefined, 'verify');
    const okObservation: Observation = {
      stepId: first.stepId,
      output: 'all green',
      success: true,
    };
    // Re-passing the same completed observation should not return s1 again.
    const retry = reasoner.reason(plan, first, okObservation, 'verify');
    assert.notEqual(retry.stepId, 's1');
  });
});
