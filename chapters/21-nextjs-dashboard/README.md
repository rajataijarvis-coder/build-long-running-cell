# Chapter 21: Next.js dashboard

> **Note:** In the course repository the files shown in this chapter already exist. This chapter explains how and why they are built. If you are following along from scratch, create the files as described.

## Learning goals

By the end of this chapter you will be able to:

1. Explain why a long-running cell needs a dedicated surface layer separate from the cell's HTTP API.
2. Design a Next.js application that proxies cell endpoints, adds UI affordances, and degrades gracefully when the cell is offline.
3. Implement a shared `CELL_URL` configuration and reusable API route patterns in `frontend/src/app/api/cell/`.
4. Understand how the dashboard page composes small, focused panels: `StatusPanel`, `ObservabilityPanel`, and `PlanPanel`.
5. Add the frontend build to the root verification pipeline so the dashboard cannot regress without CI noticing.
6. Run the dashboard API routes in isolation and verify the whole stack with `npm run verify` and `npm run build:frontend`.

## Why this matters

Up to this point the cell has been controlled through raw HTTP endpoints: `curl http://localhost:3456/status`, `POST /tick`, `POST /lead`, and so on. That is fine for development, but it is not how an operator should live with a long-running agent in production. A raw API demands that the human remembers every endpoint, every payload shape, and every side effect. Worse, it exposes no ambient awareness: the operator cannot glance at the system and know whether the cell is healthy, busy, or blocked.

A dashboard solves three problems at once:

- **Lowered operational friction.** Buttons and forms replace ad-hoc `curl` commands. Missions, budgets, and scheduled tasks become visible.
- **Discoverability.** A new teammate can open the dashboard and immediately see what the cell can do, what it is doing, and what has recently failed.
- **Graceful degradation.** The cell may restart, crash, or be deployed on a different host. The dashboard should continue to render and explain the outage, not just fail silently.

This chapter establishes the dashboard *architecture*: a Next.js frontend, a thin API proxy layer, a shared configuration convention, and a small set of core panels. Later chapters extend this surface for human approval, orchestration, evaluation, traces, and deployment. Keeping the architectural chapter short keeps it maintainable and makes the course easier to follow.

The production insight is that the cell and its surface should be separate deployables. The cell is a stateful, long-running process with a small HTTP API. The dashboard is a stateless Next.js app that can be deployed to Vercel, Netlify, or any static host, pointing at the cell through an environment variable. Keeping them separate means you can iterate on UI without restarting the cell, and you can upgrade the cell without touching the frontend.

## Recap: where we are

From [Chapter 13: Multi-loop coordination](../13-multi-loop/) the cell became a fleet that could run missions in parallel worktrees.

From [Chapter 14: Lead engineer cell](../14-lead-engineer/) the fleet gained an entry point: `LeadEngineer` decomposes a goal and runs the missions through a coordinator.

From [Chapter 15: Specialist cells](../15-specialist-cells/) the coordinator learned to dispatch mission-specific `Specialist` runners.

From [Chapter 16: Failure learning and retry](../16-failure-learning/) the cell began classifying failures and consulting them before retrying.

From [Chapter 17: Memory growth and summarisation](../17-memory-growth/) the cell learned to compress long memory sequences into summaries.

From [Chapter 18: Scheduling and backpressure](../18-scheduling/) the cell gained a `Scheduler` with cron evaluation and concurrency limits.

From [Chapter 19: Safety and guardrails](../19-safety-guardrails/) the cell added a `Guardrails` layer that blocks unsafe actions before they reach tools.

From [Chapter 20: Budget, cost, and observability](../20-budget-observability/) the cell added `BudgetTracker`, `Observability`, and `/budget` and `/metrics` HTTP endpoints.

This chapter adds the surface. The cell already knows its own state, budget, metrics, plans, missions, failures, summaries, schedule, and guardrails. The dashboard makes that state visible and actionable through a web UI.

## Architecture: browser → Next.js API route → cell server

The dashboard never calls the cell directly from the browser. Every request follows this path:

```
┌──────────────┐      ┌──────────────────────┐      ┌────────────────┐
│   Browser    │ ──▶  │ Next.js API route    │ ──▶  │  Cell server   │
│  localhost   │ ◀──  │  /api/cell/status    │ ◀──  │  localhost:3456│
│   :3000      │      │  /api/cell/tick      │      │                │
└──────────────┘      └──────────────────────┘      └────────────────┘
```

This design avoids three common problems:

1. **CORS.** The browser does not talk to the cell, so the cell does not need to serve permissive CORS headers.
2. **Exposure.** The cell's host and port are never visible in client code.
3. **Offline state.** If the cell is unreachable, the Next.js route catches the error and returns a friendly offline payload instead of a browser-level network failure.

The route layer lives in `frontend/src/app/api/cell/`. A shared helper in `frontend/src/lib/cell.ts` centralises the cell URL and fetch logic so every route behaves consistently.

## Implementation

### 1. Create the dashboard directory and install Next.js

The course repo already contains a `frontend` workspace. If you are following along from scratch, you would create it with:

```bash
cd /Users/rajatjarvis/Downloads/projects/build-long-running-cell
npx create-next-app@14.2.5 frontend --typescript --tailwind --eslint --app --src-dir --no-import-alias
```

The important files are already in place:

```
frontend/
  next.config.mjs
  package.json
  postcss.config.mjs
  tailwind.config.ts
  tsconfig.json
  src/
    app/
      layout.tsx
      page.tsx
      globals.css
      api/cell/
        status/route.ts
        tick/route.ts
        plan/route.ts
        lead/route.ts
        budget/route.ts
        metrics/route.ts
        ...
```

The dashboard is a Next.js 14 App Router application. It uses Tailwind for styling, React server components where possible, and client components only for interactivity.

### 2. Share the cell URL across API routes

Every API route under `frontend/src/app/api/cell/` needs to know where the cell server lives. Hard-coding `localhost:3456` in each file is brittle. Instead, create a small shared module.

Create `frontend/src/lib/cell.ts`:

```ts
export const CELL_URL = process.env.CELL_URL ?? 'http://localhost:3456';

export async function cellFetch(path: string, init?: RequestInit) {
  const url = `${CELL_URL}${path}`;
  const res = await fetch(url, { ...init, cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}
```

Now update `frontend/src/app/api/cell/status/route.ts` to use the helper:

```ts
import { NextResponse } from 'next/server';
import { cellFetch } from '@/lib/cell';

export async function GET() {
  try {
    const { data } = await cellFetch('/status');
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { state: 'offline', error: (err as Error).message },
      { status: 503 }
    );
  }
}
```

Do the same for `frontend/src/app/api/cell/budget/route.ts`. It needs both `GET` and `POST`, and the `POST` must forward the request body:

```ts
import { NextResponse } from 'next/server';
import { cellFetch } from '@/lib/cell';

export async function GET() {
  try {
    const { data } = await cellFetch('/budget');
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { data } = await cellFetch('/budget', {
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

And `frontend/src/app/api/cell/metrics/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { cellFetch } from '@/lib/cell';

export async function GET() {
  try {
    const { data } = await cellFetch('/metrics');
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { data } = await cellFetch('/metrics', {
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

This pattern is the contract between the dashboard and the cell: the dashboard never calls the cell directly from the browser. It calls a Next.js API route, which calls the cell. This avoids CORS issues, hides the cell host from the browser, and lets the dashboard surface a friendly offline state if the cell is unreachable.

### 3. Add a `CELL_URL` note to `next.config.mjs`

Open `frontend/next.config.mjs` and add an environment section so the deploy target is explicit:

```mjs
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    CELL_URL: process.env.CELL_URL ?? 'http://localhost:3456',
  },
};

export default nextConfig;
```

This does not change runtime behavior, but it documents the deployment contract: the dashboard must be told where the cell lives.

### 4. The dashboard page composes panels

The main page, `frontend/src/app/page.tsx`, is intentionally a thin shell. It imports focused components from `frontend/src/components/` and renders them in order:

- `StatusPanel` — shows cell state and lets the operator tick the loop.
- `ObservabilityPanel` — shows budget and metrics from Chapter 20.
- `PlanPanel` — displays the current plan for the active mission.
- `DeploymentPanel` — shows health, version, and uptime from Chapter 23.
- `OrchestratorPanel`, `EvalPanel`, `TracePanel` — added in later chapters.

Each panel owns its own data fetching and error state. Keeping the page as a shell means the dashboard can grow without `page.tsx` becoming unmaintainable. It also matches how production dashboards are usually built: one page file that composes many independent widgets.

### 5. StatusPanel: the minimal first panel

`frontend/src/components/StatusPanel.tsx` is the simplest useful panel. It polls `/api/cell/status`, renders the current state, and provides a **Tick** button that posts to `/api/cell/tick`.

The pattern it demonstrates is the one every other panel follows:

1. Fetch from a Next.js API route on mount and on a short interval.
2. Render a clear offline state if the cell is unreachable.
3. Keep the component small enough that a reader can understand it in one screen.

Open the file in the repo to see the full implementation. The important architectural point is not the exact JSX; it is that the panel does not know the cell URL — that lives in `cellFetch`.

### 6. ObservabilityPanel: budget and metrics

`frontend/src/components/ObservabilityPanel.tsx` consumes the `/budget` and `/metrics` endpoints from Chapter 20. It renders budget cards, health counters, and a small event log.

The code in the repo is the reference implementation. When reading it, notice:

- Inputs for token, cost, and runtime limits POST to `/api/cell/budget`.
- Reset buttons POST an empty body or `{ reset: true }` to the same endpoint.
- Metrics are polled on a separate interval from status, because they update at different rates.

Because the panel is a separate component, a reader who only cares about budgets can study it without wading through unrelated dashboard code.

### 7. PlanPanel: current plan for the active mission

`frontend/src/components/PlanPanel.tsx` fetches a plan from `/api/cell/plan` when the operator clicks **Show Plan**. It takes the current status as a prop so it can refuse to plan when no mission is active.

The reference implementation lives in the repo. The architectural point is that planning is *explicit* in the UI: the dashboard does not automatically spam the planner on every render. The operator decides when to ask for a plan.

### 8. Add frontend build to the root verification pipeline

Until now the root `package.json` only verifies the cell. The dashboard must now be treated as a first-class citizen. Open `/Users/rajatjarvis/Downloads/projects/build-long-running-cell/package.json`:

```json
{
  "name": "build-long-running-cell",
  "version": "0.1.0",
  "private": true,
  "workspaces": ["cell", "frontend", "scripts"],
  "scripts": {
    "verify:cell": "cd cell && npm run verify",
    "build:frontend": "cd frontend && npm run build",
    "verify": "npm run verify:cell && npm run build:frontend",
    "publish": "node scripts/node_modules/.bin/tsx scripts/publish-chapter.ts"
  }
}
```

This is a small but important change. From now on, a broken import in the dashboard or a TypeScript error in a new panel will fail CI. The dashboard cannot drift out of sync with the cell.

### 9. Add a dashboard route test

Create `frontend/src/lib/cell.test.ts`. The test verifies that `CELL_URL` has a sensible default and that the helper builds an HTTP URL. Because the test runs during the Next.js build process through TypeScript compilation, the most valuable test is a lightweight unit test on the shared config.

```ts
import assert from 'node:assert';
import test from 'node:test';
import { CELL_URL } from './cell';

test('CELL_URL has a default value', () => {
  assert.ok(CELL_URL.length > 0, 'CELL_URL should not be empty');
  assert.ok(CELL_URL.startsWith('http'), 'CELL_URL should be an HTTP URL');
});
```

The real integration tests are the API route smoke tests in `frontend/src/app/api/cell/status/route.test.ts` and similar. For this chapter, add a minimal smoke test for the status route:

```ts
import test from 'node:test';
import assert from 'node:assert';
import { GET } from './route';

test('status route returns an object with a state field', async () => {
  const res = await GET();
  const data = await res.json();
  assert.ok(typeof data === 'object');
  assert.ok('state' in data);
});
```

These tests assume the cell server is not running, so they assert that the route still returns a valid object (in this case `{ state: 'offline', error: ... }`). The important property is that the dashboard degrades rather than crashes.

### 10. Add a frontend dev script and a cell dev note

The dashboard needs the cell server running to be fully interactive. Add a small note to `frontend/README.md` (create it if it does not exist):

```md
# Cell Dashboard

This is the Next.js surface for the long-running cell.

## Development

1. Start the cell server:
   ```bash
   cd ../cell
   npm run build
   npm run dev
   ```
2. In a separate terminal, start the dashboard:
   ```bash
   npm run dev
   ```
3. Open http://localhost:3000.

The dashboard reads `CELL_URL` from the environment to locate the cell server.
Set it when deploying to production, e.g.:

```bash
CELL_URL=https://cell.example.com npm run build
```
```

This file already exists in the repo; append the `CELL_URL` note to the end if it is not already there.

## Verification

Run the full stack verification from the repository root:

```bash
cd /Users/rajatjarvis/Downloads/projects/build-long-running-cell
npm run verify
```

This will:

1. Lint the cell with ESLint.
2. Build the cell with TypeScript.
3. Run the cell test suite with `node --test`.
4. Build the Next.js frontend, which type-checks the dashboard and panels.

You can also run the frontend build in isolation:

```bash
npm run build:frontend
```

If the cell server is not running, the dashboard pages will show offline states but will still build and render. To test the live dashboard, start the cell server in one terminal:

```bash
cd cell
npm run build && node dist/main.js server
```

Then start the dashboard in another:

```bash
cd frontend
npm run dev
```

Open http://localhost:3000 and verify that:

- The status panel shows `idle` or the current cell state.
- Clicking "Tick" increments the tick counter in the metrics panel after a few seconds.
- Setting a budget limit and clicking "Set Limits" updates the budget card.
- Clicking "Show Plan" with an active mission displays the current plan.

## Practical exercises

1. **Add a missions queue panel.** Create a `MissionsPanel` component that `POST`s to `/api/cell/missions` to queue a new mission and then polls `/api/cell/status` until the mission moves from `backlog` to `in_progress` or `done`. Display the mission title and status in a list.

2. **Wire the lead-engineer panel to specialists.** The existing dashboard already has a lead-engineer form. Extend it with a checkbox for `useSpecialists`. When checked, the request body includes `useSpecialists: true`, and the result panel shows which specialist kind ran each mission based on the `coordination.results[].name` field.

3. **Add an environment indicator.** Add a small footer to the layout that displays the current `CELL_URL` and the dashboard build timestamp. This makes it immediately obvious in screenshots or support requests which cell instance the dashboard is pointing at.

## Dashboard panels reference

The dashboard is built from small, focused panels. Each one is self-contained and can be read independently:

| Panel | File | What it shows | Added in |
|-------|------|---------------|----------|
| Cell Status | `frontend/src/components/StatusPanel.tsx` | State, active mission, tick/refresh buttons | Chapter 21 |
| Budget & Metrics | `frontend/src/components/ObservabilityPanel.tsx` | Budget limits, counters, health | Chapter 21 |
| Current Plan | `frontend/src/components/PlanPanel.tsx` | Planned steps for active mission | Chapter 21 |
| Safety & Guardrails | inline in `frontend/src/app/page.tsx` | Guardrail check form and results | Chapter 19 |
| Human-in-the-Loop | inline in `frontend/src/app/page.tsx` | Pending and resolved reviews | Chapter 22 |
| Lead Engineer | inline in `frontend/src/app/page.tsx` | Goal decomposition and coordination | Chapter 14 |
| Failure Learning | inline in `frontend/src/app/page.tsx` | Recent classified failures | Chapter 16 |
| Memory & Summaries | inline in `frontend/src/app/page.tsx` | Retrieval, summary generation | Chapters 12, 17 |
| Scheduling | inline in `frontend/src/app/page.tsx` | Cron tasks and backpressure | Chapter 18 |
| Deployment & Uptime | `frontend/src/components/DeploymentPanel.tsx` | Health, version, uptime | Chapter 23 |
| Capstone Orchestrator | `frontend/src/components/OrchestratorPanel.tsx` | End-to-end goal orchestration | Chapter 24 |
| Evaluation Harness | `frontend/src/components/EvalPanel.tsx` | Benchmark runs and scores | Chapter 25 |
| Verification Traces | `frontend/src/components/TracePanel.tsx` | Per-mission verification history | Chapter 26 |

Because each panel lives in its own file or isolated section of `page.tsx`, the dashboard can be extended without rewriting existing code.

## Next chapter

- [Chapter 22: Human-in-the-loop](../22-human-in-the-loop/)
- [Back to TOC](../../docs/TOC.md)
