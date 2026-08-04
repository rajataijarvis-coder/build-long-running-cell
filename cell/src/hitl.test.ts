import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HumanInTheLoop } from './hitl.js';

describe('HumanInTheLoop', () => {
  let dir: string;
  let hitl: HumanInTheLoop;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hitl-test-'));
    hitl = new HumanInTheLoop({ basePath: dir });
  });

  it('allows a safe action without review', async () => {
    const result = await hitl.check(
      { stepId: 's1', tool: 'read_file', input: 'src/main.ts' },
      'm-1',
      's1'
    );
    assert.equal(result.ok, true);
    assert.equal((await hitl.pending()).length, 0);
  });

  it('requires approval for a protected tool', async () => {
    const result = await hitl.check(
      { stepId: 's1', tool: 'delete_file', input: 'tmp.txt' },
      'm-1',
      's1'
    );
    assert.equal(result.ok, false);
    assert.ok(result.review);
    assert.equal(result.review!.status, 'pending');
    assert.equal((await hitl.pending()).length, 1);
  });

  it('requires approval for input containing a protected keyword', async () => {
    const result = await hitl.check(
      { stepId: 's1', tool: 'shell', input: 'deploy production' },
      'm-1',
      's1'
    );
    assert.equal(result.ok, false);
    assert.equal(result.review!.ruleId, 'input-policy');
  });

  it('requires approval for edits to protected files', async () => {
    const result = await hitl.check(
      { stepId: 's1', tool: 'edit_file', input: 'README.md\nadd install instructions' },
      'm-1',
      's1'
    );
    assert.equal(result.ok, false);
    assert.equal(result.review!.ruleId, 'protected-file-policy');
  });

  it('returns the existing pending review if checked again', async () => {
    const first = await hitl.check(
      { stepId: 's1', tool: 'delete_file', input: 'tmp.txt' },
      'm-1',
      's1'
    );
    const second = await hitl.check(
      { stepId: 's1', tool: 'delete_file', input: 'tmp.txt' },
      'm-1',
      's1'
    );
    assert.equal(first.review!.id, second.review!.id);
    assert.equal((await hitl.pending()).length, 1);
  });

  it('resolves a pending review as approved', async () => {
    const result = await hitl.check(
      { stepId: 's1', tool: 'delete_file', input: 'tmp.txt' },
      'm-1',
      's1'
    );
    const resolved = await hitl.resolve(result.review!.id, 'approved', 'looks safe');
    assert.ok(resolved);
    assert.equal(resolved!.status, 'approved');
    assert.equal(resolved!.feedback, 'looks safe');
    assert.equal((await hitl.pending()).length, 0);
  });

  it('resolves a pending review as rejected', async () => {
    const result = await hitl.check(
      { stepId: 's1', tool: 'delete_file', input: 'tmp.txt' },
      'm-1',
      's1'
    );
    const resolved = await hitl.resolve(result.review!.id, 'rejected', 'do not delete that file');
    assert.ok(resolved);
    assert.equal(resolved!.status, 'rejected');
  });

  it('returns undefined when resolving a missing review', async () => {
    const resolved = await hitl.resolve('missing-id', 'approved');
    assert.equal(resolved, undefined);
  });

  it('lists reviews most recent first', async () => {
    await hitl.check({ stepId: 's1', tool: 'delete_file', input: 'a' }, 'm-1', 's1');
    await hitl.check({ stepId: 's2', tool: 'delete_file', input: 'b' }, 'm-2', 's2');
    const list = await hitl.list();
    assert.equal(list.length, 2);
    assert.ok(new Date(list[0].requestedAt).getTime() >= new Date(list[1].requestedAt).getTime());
  });
});
