import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Observer } from './observer.js';

describe('Observer', () => {
  it('marks clean output as successful', () => {
    const observer = new Observer();
    const observation = observer.observe({ stepId: 's1', tool: 'echo', input: 'hello' }, 'world');
    assert.equal(observation.success, true);
    assert.equal(observation.stepId, 's1');
  });

  it('marks output with failure markers as unsuccessful', () => {
    const observer = new Observer();
    const observation = observer.observe({ stepId: 's1', tool: 'shell', input: 'npm test' }, 'Test failed with 1 error');
    assert.equal(observation.success, false);
    assert.match(observation.note ?? '', /failure marker/);
  });

  it('marks empty output as unsuccessful', () => {
    const observer = new Observer();
    const observation = observer.observe({ stepId: 's1', tool: 'echo', input: '' }, '   ');
    assert.equal(observation.success, false);
    assert.match(observation.note ?? '', /empty/);
  });
});
