import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import { Cell } from './cell.js';
import { startServer } from './server.js';
import { Guardrails } from './guardrails.js';
import { HumanInTheLoop } from './hitl.js';
import { MemoryStore } from './memory-store.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'cell-server-integration-'));
}

async function listen(server: Server): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 3456;
      resolve({
        url: `http://localhost:${port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

describe('Server + Cell shared services', () => {
  let basePath: string;
  let guardrails: Guardrails;
  let hitl: HumanInTheLoop;
  let memoryStore: MemoryStore;
  let cell: Cell;
  let server: Server;
  let url: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    basePath = makeTmpDir();
    guardrails = new Guardrails({
      workspacePath: basePath,
      defaultAllowList: ['echo'],
      requireApprovalForDestructive: true,
      approvedDestructive: new Set<string>(),
    });
    hitl = new HumanInTheLoop({
      basePath,
      requireApprovalForTools: ['delete_file'],
      requireApprovalForInput: ['rm '],
    });
    memoryStore = new MemoryStore({ basePath });

    cell = new Cell({
      basePath,
      verificationCommands: [],
      maxRetries: 1,
      guardrailsInstance: guardrails,
      hitl,
      memoryStore,
    });

    server = startServer(
      {
        cell,
        basePath,
        budget: cell['budget'],
        observability: cell['observability'],
        guardrails,
        hitl,
        memoryStore,
        verificationCommands: [],
      },
      0
    );
    const info = await listen(server);
    url = info.url;
    close = info.close;
  });

  afterEach(async () => {
    await close();
  });

  it('shares guardrails approval between HTTP API and cell loop', async () => {
    // Use an action that is allowed by the shell allow-list but destructive,
    // so the only blocker is the destructive-approval rule.
    const action = { tool: 'shell', input: 'rm important.txt' };

    // Configure shared guardrails to allow the command base so only the
    // destructive-approval rule can block it.
    guardrails = new Guardrails({
      workspacePath: basePath,
      defaultAllowList: ['rm', 'echo'],
      requireApprovalForDestructive: true,
      approvedDestructive: new Set<string>(),
    });

    // Recreate the cell and server with the reconfigured shared guardrails.
    await close();
    cell = new Cell({
      basePath,
      verificationCommands: [],
      maxRetries: 1,
      guardrailsInstance: guardrails,
      hitl,
      memoryStore,
    });
    server = startServer(
      {
        cell,
        basePath,
        budget: cell['budget'],
        observability: cell['observability'],
        guardrails,
        hitl,
        memoryStore,
        verificationCommands: [],
      },
      0
    );
    const info = await listen(server);
    url = info.url;
    close = info.close;

    // Before approval the shared guardrails reject the action.
    let check = await fetch(`${url}/guardrails/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    });
    let checkBody = (await check.json()) as { ok: boolean };
    assert.equal(checkBody.ok, false, 'action should start unapproved');

    // Approve via the HTTP endpoint.
    const approve = await fetch(`${url}/guardrails/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    });
    const approveBody = (await approve.json()) as { approved: string; ok: boolean };
    assert.ok(approveBody.approved, 'approve endpoint should return a hash');
    assert.equal(approveBody.ok, true, 'approve endpoint should report guardrails pass after approval');

    // The same guardrails instance is used by the cell, so a local check now passes.
    const localCheck = guardrails.check({ stepId: 'test', tool: action.tool, input: action.input });
    assert.equal(localCheck.ok, true, 'cell should see the approved destructive action');

    // And the HTTP endpoint still agrees.
    check = await fetch(`${url}/guardrails/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    });
    checkBody = (await check.json()) as { ok: boolean };
    assert.equal(checkBody.ok, true, 'HTTP should still agree after approval');
  });

  it('shares HITL reviews between HTTP API and cell loop', async () => {
    const mission = await cell.queueMission('test mission', 'test description');

    // Put the mission into a paused state as if a real execution had asked
    // HITL to review its first step. This requires a matching plan and
    // pendingReviewId in memory, not just a review record.
    const mem = await cell['memory'].load();
    mission.status = 'in_progress';
    mem.currentMissionId = mission.id;
    mem.currentState = 'paused';
    mem.currentPlan = {
      missionId: mission.id,
      goal: mission.description,
      reasoning: 'test plan',
      steps: [
        {
          id: 'step-1',
          description: 'delete something',
          tool: 'delete_file',
          input: 'something.ts',
        },
      ],
    };

    // Ask the shared HITL to review the planned action for the mission.
    const gate = await hitl.check(
      { stepId: 'step-1', tool: 'delete_file', input: 'something.ts' },
      mission.id,
      'step-1'
    );
    assert.equal(gate.ok, false);
    const reviewId = gate.review!.id;
    mem.pendingReviewId = reviewId;

    // Mutate the mission in the same memory snapshot so save captures it.
    const missionInMem = mem.missions.find((m) => m.id === mission.id)!;
    missionInMem.status = 'in_progress';

    await cell['memory'].save(mem);

    // The HTTP /reviews endpoint sees the pending review.
    const list = await (await fetch(`${url}/reviews`)).json() as { reviews: { id: string; status: string }[] };
    assert.ok(list.reviews.some((r) => r.id === reviewId && r.status === 'pending'));

    // Resolve via the HTTP endpoint.
    const resolve = await fetch(`${url}/reviews/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewId, verdict: 'approved', feedback: 'go ahead' }),
    });
    const resolveBody = await resolve.json() as { ok: boolean; review: { status: string } };
    assert.equal(resolveBody.ok, true);
    assert.equal(resolveBody.review.status, 'approved');

    // A local call to hitl.list() sees the same resolution.
    const localReviews = await hitl.list();
    const localReview = localReviews.find((r) => r.id === reviewId);
    assert.equal(localReview?.status, 'approved', 'cell loop should see resolved review');
    assert.equal(localReview?.feedback, 'go ahead');

    // Re-load memory and confirm the review is the one we stored.
    const reloaded = await cell['memory'].load();
    assert.equal(reloaded.pendingReviewId, reviewId);
    assert.equal(reloaded.currentMissionId, mission.id);
    assert.equal(reloaded.currentState, 'paused');
    assert.equal(reloaded.missions.find((m) => m.id === mission.id)?.status, 'in_progress');

    // tick() resumes the mission when the pending review is approved.
    // Note: the Cell tick() may re-pause if executing the plan step hits
    // another HITL gate; we only assert the pending review is cleared and the
    // mission is still alive, which proves the resolved review propagated.
    await cell.tick();

    const afterTick = await cell['memory'].load();
    assert.equal(afterTick.pendingReviewId, undefined, 'tick should clear the now-resolved review');
    const missionAfterTick = afterTick.missions.find((m) => m.id === mission.id);
    assert.equal(missionAfterTick?.status, 'in_progress', 'mission should still be alive');
  });
});
