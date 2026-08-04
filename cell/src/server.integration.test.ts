import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import { Cell } from './cell.js';
import { startServer, type ServerContext } from './server.js';
import { Guardrails } from './guardrails.js';
import { HumanInTheLoop } from './hitl.js';
import { BudgetTracker } from './budget.js';
import { Observability } from './observability.js';
import { MemoryStore } from './memory-store.js';
import { RetrievalEngine } from './retrieval.js';

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

/**
 * POST JSON to a URL and return the parsed response.
 */
async function postJson(url: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`POST ${url} failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * GET a URL and return the parsed response.
 */
async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`GET ${url} failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Build a ServerContext with shared services so we can prove the HTTP server
 * and the cell loop see the exact same guardrails / HITL state.
 */
function buildSharedContext(basePath: string): ServerContext {
  const budget = new BudgetTracker({ basePath });
  const observability = new Observability({ basePath });
  const guardrails = new Guardrails({
    workspacePath: basePath,
    defaultAllowList: ['npm', 'node', 'echo', 'ls'],
    requireApprovalForDestructive: true,
    approvedDestructive: new Set<string>(),
    observability,
  });
  const hitl = new HumanInTheLoop({
    basePath,
    requireApprovalForTools: ['shell'],
    requireApprovalForInput: [],
    requireApprovalForProtectedFiles: false,
    protectedPatterns: [],
  });
  const memoryStore = new MemoryStore({ basePath });
  const retrieval = new RetrievalEngine({ topK: 5 });

  const cell = new Cell({
    basePath,
    verificationCommands: [],
    maxRetries: 1,
    budget,
    observability,
    guardrailsInstance: guardrails,
    hitl,
    memoryStore,
    retrieval,
  });

  return {
    cell,
    basePath,
    budget,
    observability,
    guardrails,
    hitl,
    memoryStore,
    verificationCommands: [],
  };
}

describe('Server + Cell shared services', () => {
  let basePath: string;
  let context: ServerContext;
  let server: Server;
  let url: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    basePath = makeTmpDir();
    // Empty verification commands keep tests deterministic and fast.
    context = buildSharedContext(basePath);
    server = startServer(context, 0);
    const info = await listen(server);
    url = info.url;
    close = info.close;
  });

  afterEach(async () => {
    await close();
    await context.cell.flush();
    rmSync(basePath, { recursive: true, force: true });
  });

  it('shares guardrails approval between HTTP API and cell loop', async () => {
    // `npm run rm file.txt` is allowed by the allow-list and flagged as destructive.
    const destructiveAction = { tool: 'shell', input: 'npm run rm file.txt' };

    // Before approval, the cell's shared guardrails block the action.
    const before = context.guardrails.check({ stepId: 'test', ...destructiveAction });
    assert.equal(before.ok, false, 'expected guardrails to block unapproved destructive action');

    // Approve the action through the HTTP API.
    const approved = (await postJson(`${url}/guardrails/approve`, destructiveAction)) as { approved: string; ok: boolean };
    assert.equal(typeof approved.approved, 'string');
    assert.equal(approved.ok, true);

    // The same guardrails instance used by the cell loop now allows the action.
    const after = context.guardrails.check({ stepId: 'test', ...destructiveAction });
    assert.equal(after.ok, true, 'expected guardrails to allow the approved destructive action');
    assert.equal(after.note, 'Guardrails passed');
  });

  it('shares HITL reviews between HTTP API and cell loop', async () => {
    // Queue a mission whose plan contains a `shell` step. Because the HITL
    // instance requires approval for the `shell` tool, the executing tick will
    // pause and create a review.
    const queueResult = (await postJson(`${url}/missions`, {
      title: 'HITL shared review test',
      description: 'report current status',
    })) as { mission: { id: string } };
    const missionId = queueResult.mission.id;

    await postJson(`${url}/tick`, {}); // idle -> planning
    await postJson(`${url}/tick`, {}); // planning -> executing
    await postJson(`${url}/tick`, {}); // executing -> hits HITL gate -> paused

    // Confirm a pending review exists for the mission.
    const pendingBefore = (await getJson(`${url}/reviews/pending`)) as { reviews: Array<{ id: string; missionId: string; status: string }> };
    assert.ok(pendingBefore.reviews.length >= 1, `expected at least one pending review after tick, got ${pendingBefore.reviews.length}`);
    const reviewId = pendingBefore.reviews.find((r) => r.missionId === missionId)!.id;

    // Cell state should be paused, waiting for the review.
    let status = (await getJson(`${url}/status`)) as { state: string };
    assert.equal(status.state, 'paused');

    // Resolve the review through the HTTP API.
    const resolved = (await postJson(`${url}/reviews/resolve`, {
      reviewId,
      verdict: 'approved',
      feedback: 'approved via integration test',
    })) as { review: { id: string; status: string } };
    assert.equal(resolved.review.status, 'approved');

    // The cell's internal HITL instance sees the resolved review.
    const cellReviews = await context.hitl.list();
    const matching = cellReviews.find((r) => r.id === reviewId);
    assert.ok(matching, 'expected cell HITL to list the resolved review');
    assert.equal(matching!.status, 'approved');

    // Next tick resumes from the pending review and continues the mission.
    await postJson(`${url}/tick`, {});

    status = (await getJson(`${url}/status`)) as { state: string };
    assert.ok(
      status.state === 'idle' || status.state === 'executing' || status.state === 'verifying',
      `expected mission to resume, got ${status.state}`
    );

    const finalReviews = (await getJson(`${url}/reviews`)) as { reviews: Array<{ id: string; status: string }> };
    const finalReview = finalReviews.reviews.find((r) => r.id === reviewId);
    assert.equal(finalReview?.status, 'approved');
  });
});
