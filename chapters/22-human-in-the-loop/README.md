# Chapter 22: Human-in-the-loop

> **Note:** In the course repository the files shown in this chapter already exist. This chapter explains how and why they are built. If you are following along from scratch, create the files as described.

## Learning goals

By the end of this chapter you will be able to:

1. Explain why a fully autonomous long-running cell still needs explicit human approval gates for high-impact actions.
2. Design a durable `HumanReview` model that records a requested action, the human's verdict, and the reason so the decision survives restarts.
3. Implement a `HumanInTheLoop` gate that pauses the cell when a mission requires approval, and resumes only after a human responds.
4. Add `/reviews` HTTP endpoints so the dashboard can list pending reviews and submit verdicts.
5. Build a dashboard panel that shows pending reviews, lets an operator approve, revise, or reject them, and logs the outcome.
6. Wire the gate into the cell loop so approvals are required before destructive tool calls and before finalising a mission that modifies protected files.
7. Test the review lifecycle, dashboard wiring, and integration with `npm run verify`.

## Why this matters

Up to this point the cell has been progressively more independent. It plans, acts, reflects, coordinates specialists, schedules its own work, and guards against unsafe actions. Guardrails from Chapter 19 block dangerous commands automatically. Budgets from Chapter 20 stop the cell from spending infinite money. But there is still a class of risk that automation cannot eliminate: the **legitimate but high-stakes action**.

A long-running cell that edits your production codebase, merges pull requests, deploys services, or sends messages on your behalf should not do those things silently. Even when the action is technically safe, it may be:

- **Strategically wrong.** The cell implements a feature you no longer want.
- **Badly timed.** A deploy at 3am on a Friday is a risk you would not take.
- **Legal or compliance-sensitive.** Some changes require sign-off, audit trails, or a second pair of eyes.
- **Irreversible.** Once a branch is merged or a message is sent, undoing it is expensive or impossible.

A human-in-the-loop system is not a sign that the cell is weak. It is a sign that the cell is trustworthy enough to be allowed near consequential work. The gate makes the cell **stop and ask** when the impact is high, records the human's decision durably, and continues only on approval. Rejected actions become learning signals: the cell records the reason, updates the plan, and tries a different approach.

This chapter implements a small but complete review gate. It is rule-based and synchronous where possible, and it stores its state in `CellMemory` so a restart mid-review does not lose the question. The dashboard panel gives the operator a clear queue of pending decisions and the controls to resolve them.

## Recap: where we are

From [Chapter 19: Safety and guardrails](../19-safety-guardrails/) the cell added a `Guardrails` layer that blocks prompt injection, path traversal, network egress, and unapproved destructive commands.

From [Chapter 20: Budget, cost, and observability](../20-budget-observability/) the cell gained `BudgetTracker`, `Observability`, and `/budget` and `/metrics` endpoints that pause the cell when limits are reached.

From [Chapter 21: Next.js dashboard](../21-nextjs-dashboard/) we built a dashboard surface with status, budget, metrics, guardrail, schedule, memory, and lead-engineer panels.

This chapter adds the last missing production control: the ability for a human to hold the cell at a decision point until they explicitly approve, revise, or reject the proposed action.

## Implementation

### 1. Add the `HumanReview` type to durable memory

Open `cell/src/types.ts`. A human review is a first-class durable record. It stores the proposed action, why the gate paused, the operator's verdict, and the operator's feedback. We also add a `ReviewStatus` type and a flag on `CellMemory` so the cell can resume mid-review after a restart.

```ts
export type ReviewVerdict = 'approve' | 'revise' | 'reject';
export type ReviewStatus = 'pending' | 'approved' | 'revised' | 'rejected';

export interface HumanReview {
  id: string;
  missionId: string;
  stepId: string;
  status: ReviewStatus;
  /** The action the cell wants permission to perform. */
  action: {
    tool: string;
    input: string;
  };
  /** Why the gate decided a review was needed. */
  reason: string;
  /** ISO timestamp when the review was requested. */
  requestedAt: string;
  /** ISO timestamp when the operator responded, if they have. */
  resolvedAt?: string;
  /** Operator feedback. For `revise`, this tells the cell how to change its approach. */
  feedback?: string;
  /** Which rule or policy triggered the review. */
  ruleId?: string;
}
```

Add `reviews` and `pendingReviewId` to `CellMemory`:

```ts
export interface CellMemory {
  // ... existing fields ...
  /** Pending and resolved human reviews. */
  reviews?: HumanReview[];
  /** If the cell is waiting on a review, this is the id of the pending review. */
  pendingReviewId?: string;
}
```

Because `GitMemory.load()` merges with `DEFAULT_MEMORY`, older memory files will simply return empty review lists until this feature is used.

### 2. Create the `HumanInTheLoop` gate

Create `cell/src/hitl.ts`. The gate decides when a proposed action needs human approval, records the review, and checks whether a pending review has been resolved.

```ts
import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import type { Action, HumanReview, Mission } from './types.js';

export interface HumanInTheLoopOptions {
  basePath: string;
  /**
   * Which tools always require approval, regardless of input.
   * By default only tools that the cell cannot undo easily.
   */
  requireApprovalForTools?: string[];
  /**
   * Substrings that, if present in an action input, force a review.
   */
  requireApprovalForInput?: string[];
  /**
   * If true, the final step of a mission that modifies protected files requires approval.
   */
  requireApprovalForProtectedFiles?: boolean;
  /** List of file patterns considered protected. */
  protectedPatterns?: string[];
}

export interface ReviewGateResult {
  ok: boolean;
  /** If ok is false, the review that was created. */
  review?: HumanReview;
  /** Human-readable reason. */
  reason?: string;
}

export class HumanInTheLoop {
  private readonly options: Required<HumanInTheLoopOptions>;
  private readonly statePath: string;

  constructor(options: HumanInTheLoopOptions) {
    this.options = {
      requireApprovalForTools: options.requireApprovalForTools ?? ['delete_file'],
      requireApprovalForInput: options.requireApprovalForInput ?? ['rm ', 'remove ', 'drop table', 'deploy', 'send email'],
      requireApprovalForProtectedFiles: options.requireApprovalForProtectedFiles ?? true,
      protectedPatterns: options.protectedPatterns ?? ['main.ts', 'package.json', 'README.md', '.env'],
      basePath: options.basePath,
    };
    this.statePath = join(this.options.basePath, 'state', 'reviews.json');
  }

  /**
   * Check whether an action needs approval. If it does, create a pending review
   * and return `ok: false`. If a pending review already exists for this mission,
   * return its status instead of creating a duplicate.
   */
  async check(action: Action, missionId: string, stepId: string): Promise<ReviewGateResult> {
    const state = await this.loadState();
    const existing = state.reviews.find((r) => r.missionId === missionId && r.stepId === stepId && r.status === 'pending');
    if (existing) {
      return { ok: false, review: existing, reason: `Pending review ${existing.id} exists` };
    }

    let ruleId: string | undefined;
    let reason: string | undefined;

    if (this.options.requireApprovalForTools.includes(action.tool)) {
      ruleId = 'tool-policy';
      reason = `Tool '${action.tool}' requires human approval.`;
    } else if (this.options.requireApprovalForInput.some((marker) => action.input.toLowerCase().includes(marker.toLowerCase()))) {
      ruleId = 'input-policy';
      reason = `Input contains a protected keyword that requires approval.`;
    } else if (this.options.requireApprovalForProtectedFiles && this.matchesProtectedPattern(action.input)) {
      ruleId = 'protected-file-policy';
      reason = `Action may modify a protected file.`;
    }

    if (!reason) {
      return { ok: true };
    }

    const review: HumanReview = {
      id: `review-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      missionId,
      stepId,
      status: 'pending',
      action: { tool: action.tool, input: action.input },
      reason,
      ruleId,
      requestedAt: new Date().toISOString(),
    };

    state.reviews.push(review);
    await this.saveState(state);
    return { ok: false, review, reason };
  }

  /**
   * Resolve a pending review with an operator verdict and optional feedback.
   */
  async resolve(reviewId: string, verdict: HumanReview['status'], feedback?: string): Promise<HumanReview | undefined> {
    const state = await this.loadState();
    const review = state.reviews.find((r) => r.id === reviewId);
    if (!review || review.status !== 'pending') return undefined;

    review.status = verdict;
    review.feedback = feedback;
    review.resolvedAt = new Date().toISOString();
    await this.saveState(state);
    return review;
  }

  /** Return all reviews, most recent first. */
  async list(): Promise<HumanReview[]> {
    const state = await this.loadState();
    return state.reviews.slice().reverse();
  }

  /** Return only pending reviews. */
  async pending(): Promise<HumanReview[]> {
    const state = await this.loadState();
    return state.reviews.filter((r) => r.status === 'pending').slice().reverse();
  }

  private matchesProtectedPattern(input: string): boolean {
    const lower = input.toLowerCase();
    return this.options.protectedPatterns.some((pattern) => lower.includes(pattern.toLowerCase()));
  }

  private async loadState(): Promise<{ reviews: HumanReview[] }> {
    try {
      const raw = await fs.readFile(this.statePath, 'utf-8');
      const parsed = JSON.parse(raw) as { reviews?: HumanReview[] };
      return { reviews: parsed.reviews ?? [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { reviews: [] };
      }
      throw err;
    }
  }

  private async saveState(state: { reviews: HumanReview[] }): Promise<void> {
    await fs.mkdir(dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(state, null, 2), 'utf-8');
  }
}
```

The gate is conservative. It treats `delete_file`, input containing `rm ` or `deploy`, and edits to protected files as review-worthy. The default policy is simple; production systems will want richer policies tied to roles, change windows, and audit requirements.

### 3. Wire the review gate into the cell loop

Open `cell/src/cell.ts`. Import the gate and add it to `CellConfig`:

```ts
import { HumanInTheLoop } from './hitl.js';

export interface CellConfig {
  // ... existing fields ...
  /** Optional human-in-the-loop gate. If omitted, no actions require human approval. */
  hitl?: HumanInTheLoop;
}
```

In the constructor, create a default gate if none is supplied:

```ts
private hitl: HumanInTheLoop;

constructor(config: CellConfig) {
  // ... existing initialisation ...
  this.hitl = config.hitl ?? new HumanInTheLoop({ basePath: config.basePath });
}
```

The gate needs to inspect actions before they run. The cleanest place is inside `runPhase()` during the `executing` state, just before the inner loop starts. However, the inner loop's `LoopEngine` currently invokes tools directly. To avoid rewriting the whole loop engine, we add a new manual check point: when the cell enters the `executing` state, it will ask the gate whether the *first proposed action* is safe to run without a human. If it is not, the cell pauses and records `pendingReviewId`.

For this chapter we implement the gate at the phase level. Open `cell/src/cell.ts` and modify the `executing` case to inspect the planned first step before running the loop. Replace the existing `case 'executing':` block with:

```ts
case 'executing': {
  const plan = mem.currentPlan;
  if (plan && plan.steps.length > 0) {
    const firstStep = plan.steps[0];
    const gate = await this.hitl.check(
      { stepId: firstStep.id, tool: firstStep.tool ?? 'unknown', input: firstStep.input ?? '' },
      mission.id,
      firstStep.id
    );
    if (!gate.ok) {
      mem.currentState = 'paused';
      mem.pendingReviewId = gate.review!.id;
      await this.memory.save(mem);
      await this.memory.logProgress(`Paused for human review ${gate.review!.id}: ${gate.review!.reason}`);
      break;
    }
  }

  await this.runPhase(mission, 'executing', async () => {
    // ... existing executing logic ...
  });
  mem.currentPlan = undefined;
  mem.reasoningContext = undefined;
  mem.currentState = 'verifying';
  break;
}
```

Also update the `idle` case so that if a previously pending review has been approved or rejected, the cell resumes the correct next state. After the budget check at the top of `tick()`, add:

```ts
if (mem.pendingReviewId) {
  const review = (await this.hitl.list()).find((r) => r.id === mem.pendingReviewId);
  if (review) {
    if (review.status === 'approved') {
      mem.pendingReviewId = undefined;
      await this.memory.save(mem);
      await this.memory.logProgress(`Review ${review.id} approved; resuming mission ${mission?.id ?? 'unknown'}`);
    } else if (review.status === 'rejected' || review.status === 'revised') {
      mem.pendingReviewId = undefined;
      if (mission && mission.status === 'in_progress') {
        mission.status = 'failed';
        await this.observability.increment('missionsFailed');
      }
      mem.currentState = 'idle';
      mem.currentMissionId = undefined;
      mem.currentPlan = undefined;
      await this.memory.save(mem);
      await this.memory.logProgress(`Review ${review.id} ${review.status}: ${review.feedback ?? 'no feedback'}`);
      return;
    } else {
      // Still pending; do nothing this tick.
      return;
    }
  }
}
```

Now the cell:

- Pauses before running an action that needs human approval.
- Stores the pending review id in `CellMemory` so it survives restarts.
- Resumes when the operator approves the review.
- Fails the mission cleanly when the operator rejects or requests a revision.

### 4. Add HTTP endpoints for reviews

Open `cell/src/server.ts`. Import the gate:

```ts
import { HumanInTheLoop } from './hitl.js';
```

Add the endpoints after the `/guardrails` block:

```ts
if (url.pathname === '/reviews') {
  const hitl = new HumanInTheLoop({ basePath: process.cwd() });
  const status = url.searchParams.get('status') as HumanReview['status'] | null;
  let reviews = await hitl.list();
  if (status) {
    reviews = reviews.filter((r) => r.status === status);
  }
  res.end(JSON.stringify({ ok: true, reviews }));
  return;
}

if (url.pathname === '/reviews/pending') {
  const hitl = new HumanInTheLoop({ basePath: process.cwd() });
  const reviews = await hitl.pending();
  res.end(JSON.stringify({ ok: true, reviews }));
  return;
}

if (url.pathname === '/reviews/resolve' && req.method === 'POST') {
  const body = await readBody();
  const hitl = new HumanInTheLoop({ basePath: process.cwd() });
  const review = await hitl.resolve(
    String(body.reviewId ?? ''),
    body.verdict as HumanReview['status'],
    body.feedback !== undefined ? String(body.feedback) : undefined
  );
  if (!review) {
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'review not found or already resolved' }));
    return;
  }
  res.end(JSON.stringify({ ok: true, review }));
  return;
}
```

The dashboard can now list all reviews, filter by status, and resolve a pending review with a verdict and feedback.

### 5. Add a dashboard panel

Create `frontend/src/app/api/cell/reviews/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { cellFetch } from '@/lib/cell';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const params = new URLSearchParams();
    const status = searchParams.get('status');
    if (status) params.set('status', status);
    const { data } = await cellFetch(`/reviews?${params.toString()}`);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { data } = await cellFetch('/reviews/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
```

Create `frontend/src/app/api/cell/reviews/pending/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { cellFetch } from '@/lib/cell';

export async function GET() {
  try {
    const { data } = await cellFetch('/reviews/pending');
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
```

Open `frontend/src/app/page.tsx`. Add the `HumanReview` interface near the top:

```ts
interface HumanReview {
  id: string;
  missionId: string;
  stepId: string;
  status: 'pending' | 'approved' | 'revised' | 'rejected';
  action: { tool: string; input: string };
  reason: string;
  requestedAt: string;
  resolvedAt?: string;
  feedback?: string;
  ruleId?: string;
}
```

Add state inside `Home`:

```ts
const [reviews, setReviews] = useState<HumanReview[]>([]);
const [reviewFilter, setReviewFilter] = useState('pending');
const [reviewFeedback, setReviewFeedback] = useState<Record<string, string>>({});
```

Add handlers:

```ts
async function fetchReviews(status?: string) {
  const params = status ? `?status=${status}` : '';
  const res = await fetch(`/api/cell/reviews${params}`, { cache: 'no-store' });
  const data = await res.json();
  if (data.ok && data.reviews) {
    setReviews(data.reviews);
    const pendingCount = data.reviews.filter((r: HumanReview) => r.status === 'pending').length;
    setLogs((l) => [...l, `Loaded ${data.reviews.length} review(s), ${pendingCount} pending`]);
  } else {
    setLogs((l) => [...l, `Review fetch failed: ${data.error ?? 'unknown'}`]);
  }
}

async function resolveReview(reviewId: string, verdict: HumanReview['status']) {
  setLogs((l) => [...l, `Resolving review ${reviewId} as ${verdict}...`]);
  const res = await fetch('/api/cell/reviews', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reviewId,
      verdict,
      feedback: reviewFeedback[reviewId] ?? '',
    }),
  });
  const data = await res.json();
  if (data.ok) {
    setLogs((l) => [...l, `Review ${reviewId} resolved as ${verdict}`]);
    await fetchReviews(reviewFilter);
    await fetchStatus();
  } else {
    setLogs((l) => [...l, `Review resolution failed: ${data.error ?? 'unknown'}`]);
  }
}
```

Load pending reviews on mount and refresh them on the same interval as status:

```ts
useEffect(() => {
  fetchStatus();
  fetchReviews('pending');
  const id = setInterval(() => {
    fetchStatus();
    fetchReviews('pending');
  }, 3000);
  return () => clearInterval(id);
}, []);
```

Render the panel above the Event Log:

```tsx
<section className="rounded-lg border border-slate-700 p-4 mb-6">
  <h2 className="text-xl font-semibold mb-2">Human-in-the-Loop Reviews</h2>
  <p className="text-sm text-slate-400 mb-3">
    Approve, revise, or reject high-impact actions before the cell executes them.
  </p>

  <div className="flex gap-2 mb-3">
    <select
      value={reviewFilter}
      onChange={(e) => {
        setReviewFilter(e.target.value);
        fetchReviews(e.target.value);
      }}
      className="bg-slate-800 border border-slate-600 rounded px-2 py-1"
    >
      <option value="">all</option>
      <option value="pending">pending</option>
      <option value="approved">approved</option>
      <option value="revised">revised</option>
      <option value="rejected">rejected</option>
    </select>
    <button onClick={() => fetchReviews(reviewFilter)} className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 transition">
      Load Reviews
    </button>
  </div>

  {reviews.length > 0 ? (
    <div className="bg-slate-900 rounded p-3 text-sm space-y-3 max-h-72 overflow-auto">
      {reviews.map((r) => (
        <div key={r.id} className="border-b border-slate-800 last:border-0 pb-3 last:pb-0">
          <div className="flex justify-between items-start">
            <p className="text-amber-400 font-mono">{r.id}</p>
            <span className={`text-xs px-2 py-0.5 rounded ${
              r.status === 'pending'
                ? 'bg-yellow-900/30 text-yellow-300'
                : r.status === 'approved'
                ? 'bg-emerald-900/30 text-emerald-300'
                : 'bg-rose-900/30 text-rose-300'
            }`}>
              {r.status}
            </span>
          </div>
          <p className="text-slate-300 mt-1">{r.reason}</p>
          <p className="text-slate-500 text-xs">tool: {r.action.tool}</p>
          <p className="text-slate-500 text-xs whitespace-pre-wrap">{r.action.input}</p>
          <p className="text-slate-500 text-xs mt-1">
            requested {new Date(r.requestedAt).toLocaleString()}
            {r.resolvedAt && ` · resolved ${new Date(r.resolvedAt).toLocaleString()}`}
          </p>

          {r.status === 'pending' && (
            <div className="mt-2 space-y-2">
              <input
                value={reviewFeedback[r.id] ?? ''}
                onChange={(e) => setReviewFeedback((f) => ({ ...f, [r.id]: e.target.value }))}
                placeholder="Feedback (required for revise)"
                className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => resolveReview(r.id, 'approve')}
                  className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-xs"
                >
                  Approve
                </button>
                <button
                  onClick={() => resolveReview(r.id, 'revise')}
                  className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-xs"
                >
                  Revise
                </button>
                <button
                  onClick={() => resolveReview(r.id, 'reject')}
                  className="px-3 py-1 rounded bg-rose-600 hover:bg-rose-500 text-xs"
                >
                  Reject
                </button>
              </div>
            </div>
          )}

          {r.feedback && (
            <p className="text-slate-400 text-xs mt-1">feedback: {r.feedback}</p>
          )}
        </div>
      ))}
    </div>
  ) : (
    <p className="text-slate-500 text-sm">No reviews match the selected filter.</p>
  )}
</section>
```

This panel shows the queue of pending reviews, lets the operator provide feedback, and updates the cell status automatically after a verdict is submitted.

### 6. Add tests for the review gate

Create `cell/src/hitl.test.ts`:

```ts
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
```

These tests cover the gate policies, review persistence, idempotency, and resolution.

### 7. Add a dashboard route test

Create `frontend/src/app/api/cell/reviews/route.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert';
import { GET } from './route';

test('reviews route returns an object with a reviews field', async () => {
  const res = await GET(new Request('http://localhost:3000/api/cell/reviews?status=pending'));
  const data = await res.json();
  assert.ok(typeof data === 'object');
  assert.ok('reviews' in data);
});
```

This test assumes the cell server is not running, so it asserts that the route degrades to an empty/offline response rather than crashing the build.

## Verification

Run the full verification suite from the repository root:

```bash
cd /Users/rajatjarvis/Downloads/projects/build-long-running-cell
npm run verify
```

This will:

1. Lint and build the cell.
2. Run the cell test suite, including the new `HumanInTheLoop` tests.
3. Build the Next.js frontend, which type-checks the new `HumanReview` panel and API routes.

You should see the new test suite pass:

```text
▶ HumanInTheLoop
  ✔ allows a safe action without review
  ✔ requires approval for a protected tool
  ✔ requires approval for input containing a protected keyword
  ✔ requires approval for edits to protected files
  ✔ returns the existing pending review if checked again
  ✔ resolves a pending review as approved
  ✔ resolves a pending review as rejected
  ✔ returns undefined when resolving a missing review
  ✔ lists reviews most recent first
```

You can also exercise the feature manually while the cell server is running:

```bash
cd cell
npm run build
node dist/main.js &

# Queue a mission that will need approval (edits README.md)
curl -X POST http://localhost:3456/missions \
  -H 'Content-Type: application/json' \
  -d '{"title":"readme-update","description":"Update the README with a new section"}'

# Tick the cell; it should pause with a pending review
curl -X POST http://localhost:3456/tick
curl http://localhost:3456/status
curl http://localhost:3456/reviews/pending

# Approve the review (replace REVIEW_ID with the id from the previous call)
curl -X POST http://localhost:3456/reviews/resolve \
  -H 'Content-Type: application/json' \
  -d '{"reviewId":"REVIEW_ID","verdict":"approved","feedback":"go ahead"}'

# Tick again and observe the cell resume
curl -X POST http://localhost:3456/tick
curl http://localhost:3456/status
```

To test rejection, queue another mission, resolve the pending review as `rejected`, and confirm the mission moves to `failed` and the cell returns to `idle`.

## Practical exercises

1. **Add a review policy configuration endpoint.** Add a `POST /reviews/policy` endpoint that updates the `HumanInTheLoop` options (protected tools, protected keywords, protected file patterns) at runtime. Persist the policy to `state/hitl-policy.json` and reload it on server start. Add a dashboard section that displays the current policy and lets an operator add or remove protected keywords.

2. **Require approval before finalising a lead-engineer merge.** Extend the coordinator so that when it is about to merge a branch back into the main worktree, it creates a human review with `ruleId: 'merge-gate'`. Only proceed with the merge after the review is `approved`. Rejected merges should record a failure and keep the missions in the rejected list.

3. **Build an audit log exporter.** Add a `GET /reviews/export` endpoint that returns all resolved reviews in a stable JSON format with `requestedAt`, `resolvedAt`, `verdict`, `ruleId`, and `feedback`. Create a small script `cell/scripts/export-reviews.ts` that writes the export to `state/reviews-audit.jsonl`, one review per line, suitable for ingestion by an external audit system.

## Next chapter

With human approval gates in place, the cell can pause before high-stakes actions and wait for explicit operator consent. In [Chapter 23: Deployment: running 24/7](../23-deployment/) we will wire the cell, scheduler, and dashboard so they can run continuously as a deployed service rather than as a local development process.

See the full course index in the [TOC](../../docs/TOC.md).
