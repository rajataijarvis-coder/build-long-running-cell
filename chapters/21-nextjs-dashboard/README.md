# Chapter 21: Next.js dashboard

## Learning goals

By the end of this chapter you will be able to:

1. Explain why a long-running cell needs a dedicated surface layer separate from the cell's HTTP API.
2. Design a Next.js application that proxies cell endpoints, adds UI affordances, and degrades gracefully when the cell is offline.
3. Implement a shared `CELL_URL` configuration and reusable API route patterns in `frontend/src/app/api/cell/`.
4. Add a real dashboard panel that shows cell status, lets an operator tick the loop manually, and visualizes the most recent plan.
5. Add budget and metrics panels that consume the `/budget` and `/metrics` endpoints from Chapter 20 and display them as human-readable cards.
6. Run the frontend build as a first-class verification step so the dashboard cannot regress without CI noticing.
7. Test the dashboard API routes in isolation and verify the whole stack with `npm run verify` and `npm run build:frontend`.

## Why this matters

Up to this point the cell has been controlled through raw HTTP endpoints: `curl http://localhost:3456/status`, `POST /tick`, `POST /lead`, and so on. That is fine for development, but it is not how an operator should live with a long-running agent in production. A raw API demands that the human remembers every endpoint, every payload shape, and every side effect. Worse, it exposes no ambient awareness: the operator cannot glance at the system and know whether the cell is healthy, busy, or blocked.

A dashboard solves three problems at once:

- **Lowered operational friction.** Buttons and forms replace ad-hoc `curl` commands. Missions, budgets, and scheduled tasks become visible.
- **Discoverability.** A new teammate can open the dashboard and immediately see what the cell can do, what it is doing, and what has recently failed.
- **Graceful degradation.** The cell may restart, crash, or be deployed on a different host. The dashboard should continue to render and explain the outage, not just fail silently.

This chapter does not rebuild the entire UI for every feature the course has introduced. Instead it establishes the dashboard *architecture*: a Next.js frontend, a thin API proxy layer, a shared configuration convention, and a small set of core panels. Later chapters will extend this surface for human approval, deployment wiring, and the final capstone orchestration.

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

This chapter adds the surface. The cell already knows its own state, budget, metrics, plans, missions, failures, summaries, schedule, and guardrails. The dashboard makes all of that visible and actionable through a web UI.

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

### 4. Add a dashboard panel for status, tick, and plan

The `frontend/src/app/page.tsx` file already contains a large single-page dashboard with many sections. For this chapter we focus on making the *core* panels robust: status, tick, plan, budget, and metrics. The larger dashboard can stay, but we will add a dedicated `StatusPanel` component to keep `page.tsx` maintainable as the surface grows.

Create `frontend/src/components/StatusPanel.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';

interface Status {
  state: string;
  mission?: { id: string; title: string; status: string };
}

export default function StatusPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function fetchStatus() {
    try {
      const res = await fetch('/api/cell/status');
      const data = await res.json();
      setStatus(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      setStatus(null);
    }
  }

  async function tick() {
    try {
      const res = await fetch('/api/cell/tick', { method: 'POST' });
      const data = await res.json();
      setError(null);
      await fetchStatus();
      return data;
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 3000);
    return () => clearInterval(id);
  }, []);

  return (
    <section className="rounded-lg border border-slate-700 p-4 mb-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xl font-semibold">Cell Status</h2>
        <div className="flex gap-2">
          <button
            onClick={tick}
            className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 transition"
          >
            Tick
          </button>
          <button
            onClick={fetchStatus}
            className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 transition"
          >
            Refresh
          </button>
        </div>
      </div>
      {error ? (
        <div className="rounded bg-rose-900/30 text-rose-300 p-3 text-sm">
          The dashboard cannot reach the cell. Make sure the cell server is running on {process.env.CELL_URL ?? 'http://localhost:3456'}.
          <p className="mt-1 text-xs">{error}</p>
        </div>
      ) : status ? (
        <div className="space-y-1 text-sm">
          <p>
            State:{' '}
            <span className="font-mono text-emerald-400">{status.state}</span>
          </p>
          <p>
            Mission:{' '}
            {status.mission
              ? `${status.mission.title} (${status.mission.status})`
              : 'none'}
          </p>
        </div>
      ) : (
        <p className="text-slate-400 text-sm">Loading...</p>
      )}
    </section>
  );
}
```

Then import it into `frontend/src/app/page.tsx` near the top of the main content:

```tsx
import StatusPanel from '@/components/StatusPanel';

// ... inside the return:
<StatusPanel />
```

This small refactor demonstrates the architectural point: the page becomes a shell that composes panels, and each panel owns its data fetching and error state.

### 5. Add a budget and metrics panel

Create `frontend/src/components/ObservabilityPanel.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';

interface BudgetState {
  tokenLimit: number;
  costLimit: number;
  elapsedMsLimit: number;
  currentTokens: number;
  currentCost: number;
  elapsedMs: number;
  currency: string;
  costPer1kTokens: number;
  lastUpdatedAt: string;
}

interface MetricState {
  timestamp: string;
  ticks: number;
  missionsCompleted: number;
  missionsFailed: number;
  leadRuns: number;
  scheduledTasksRun: number;
  guardrailBlocks: number;
  verificationsRun: number;
  memoryDocumentCount: number;
}

export default function ObservabilityPanel() {
  const [budget, setBudget] = useState<BudgetState | null>(null);
  const [metrics, setMetrics] = useState<{ health: string; metrics: MetricState } | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  const [tokenLimit, setTokenLimit] = useState('0');
  const [costLimit, setCostLimit] = useState('0');
  const [runtimeLimit, setRuntimeLimit] = useState('0');

  function log(message: string) {
    setLogs((l) => [...l, message]);
  }

  async function fetchBudget() {
    const res = await fetch('/api/cell/budget', { cache: 'no-store' });
    const data = await res.json();
    if (data.ok && data.budget) {
      setBudget(data.budget);
      setTokenLimit(String(data.budget.tokenLimit));
      setCostLimit(String(data.budget.costLimit));
      setRuntimeLimit(String(data.budget.elapsedMsLimit));
    }
  }

  async function fetchMetrics() {
    const res = await fetch('/api/cell/metrics', { cache: 'no-store' });
    const data = await res.json();
    if (data.ok) {
      setMetrics({ health: data.health, metrics: data.metrics });
      log(`Metrics loaded (health: ${data.health})`);
    } else {
      log(`Metrics fetch failed: ${data.error ?? 'unknown'}`);
    }
  }

  async function updateBudget() {
    log('Updating budget limits...');
    const res = await fetch('/api/cell/budget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tokenLimit: Number(tokenLimit),
        costLimit: Number(costLimit),
        elapsedMsLimit: Number(runtimeLimit),
      }),
    });
    const data = await res.json();
    if (data.ok) {
      setBudget(data.budget);
      log('Budget limits updated');
    } else {
      log(`Budget update failed: ${data.error ?? 'unknown'}`);
    }
  }

  async function resetBudget() {
    log('Resetting budget counters...');
    const res = await fetch('/api/cell/budget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: true }),
    });
    const data = await res.json();
    if (data.ok) {
      setBudget(data.budget);
      log('Budget counters reset');
    } else {
      log(`Budget reset failed: ${data.error ?? 'unknown'}`);
    }
  }

  async function resetMetrics() {
    log('Resetting metrics...');
    const res = await fetch('/api/cell/metrics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (data.ok) {
      setMetrics({ health: 'healthy', metrics: data.metrics });
      log('Metrics reset');
    } else {
      log(`Metrics reset failed: ${data.error ?? 'unknown'}`);
    }
  }

  useEffect(() => {
    fetchBudget();
    fetchMetrics();
    const id = setInterval(fetchMetrics, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <section className="rounded-lg border border-slate-700 p-4 mb-6">
      <h2 className="text-xl font-semibold mb-2">Budget, Cost & Observability</h2>
      <p className="text-sm text-slate-400 mb-3">
        Cap token use, estimated cost, and runtime. Observe health counters so you know when the cell is busy or failing.
      </p>

      <div className="grid grid-cols-3 gap-2 mb-3">
        <input
          value={tokenLimit}
          onChange={(e) => setTokenLimit(e.target.value)}
          placeholder="Token limit (0 = unlimited)"
          className="bg-slate-800 border border-slate-600 rounded px-2 py-1"
        />
        <input
          value={costLimit}
          onChange={(e) => setCostLimit(e.target.value)}
          placeholder="Cost limit (0 = unlimited)"
          className="bg-slate-800 border border-slate-600 rounded px-2 py-1"
        />
        <input
          value={runtimeLimit}
          onChange={(e) => setRuntimeLimit(e.target.value)}
          placeholder="Runtime ms limit (0 = unlimited)"
          className="bg-slate-800 border border-slate-600 rounded px-2 py-1"
        />
      </div>

      <div className="flex gap-2 mb-4 flex-wrap">
        <button onClick={updateBudget} className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 transition">
          Set Limits
        </button>
        <button onClick={resetBudget} className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 transition">
          Reset Counters
        </button>
        <button onClick={fetchMetrics} className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 transition">
          Load Metrics
        </button>
        <button onClick={resetMetrics} className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 transition">
          Reset Metrics
        </button>
      </div>

      {budget && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm mb-4">
          <div className="bg-slate-900 rounded p-2">
            <p className="text-slate-500">Tokens</p>
            <p className="font-mono">
              {budget.currentTokens.toLocaleString()} / {budget.tokenLimit > 0 ? budget.tokenLimit.toLocaleString() : '∞'}
            </p>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <p className="text-slate-500">Cost</p>
            <p className="font-mono">
              {budget.currentCost.toFixed(4)} / {budget.costLimit > 0 ? budget.costLimit.toFixed(4) : '∞'} {budget.currency}
            </p>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <p className="text-slate-500">Runtime</p>
            <p className="font-mono">
              {budget.elapsedMs.toLocaleString()} / {budget.elapsedMsLimit > 0 ? budget.elapsedMsLimit.toLocaleString() : '∞'} ms
            </p>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <p className="text-slate-500">Cost/1k tokens</p>
            <p className="font-mono">
              {budget.costPer1kTokens} {budget.currency}
            </p>
          </div>
        </div>
      )}

      {metrics && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
          <div className={`rounded p-2 ${metrics.health === 'healthy' ? 'bg-emerald-900/30 text-emerald-300' : 'bg-yellow-900/30 text-yellow-300'}`}>
            <p className="opacity-80">Health</p>
            <p className="font-semibold capitalize">{metrics.health}</p>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <p className="text-slate-500">Ticks</p>
            <p className="font-mono">{metrics.metrics.ticks}</p>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <p className="text-slate-500">Completed</p>
            <p className="font-mono text-emerald-400">{metrics.metrics.missionsCompleted}</p>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <p className="text-slate-500">Failed</p>
            <p className="font-mono text-rose-400">{metrics.metrics.missionsFailed}</p>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <p className="text-slate-500">Lead runs</p>
            <p className="font-mono">{metrics.metrics.leadRuns}</p>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <p className="text-slate-500">Scheduled</p>
            <p className="font-mono">{metrics.metrics.scheduledTasksRun}</p>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <p className="text-slate-500">Guardrail blocks</p>
            <p className="font-mono text-rose-400">{metrics.metrics.guardrailBlocks}</p>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <p className="text-slate-500">Verifications</p>
            <p className="font-mono">{metrics.metrics.verificationsRun}</p>
          </div>
        </div>
      )}

      <div className="mt-4 rounded-lg border border-slate-700 p-3">
        <h3 className="text-sm font-semibold mb-2">Event Log</h3>
        <ul className="space-y-1 font-mono text-xs text-slate-300 max-h-32 overflow-auto">
          {logs.length === 0 && <li>No events yet.</li>}
          {logs.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
```

Import the new panel into `frontend/src/app/page.tsx`:

```tsx
import ObservabilityPanel from '@/components/ObservabilityPanel';

// ... inside the return, after StatusPanel:
<ObservabilityPanel />
```

This panel directly consumes the endpoints built in Chapter 20. If the cell server is offline, the panel will show the last known state and log fetch failures, but the rest of the dashboard will continue to render.

### 6. Add a plan viewer panel

The existing `page.tsx` already fetches a plan when the user clicks "Show Plan." In this chapter we promote that into a reusable component so the dashboard can later render plans automatically whenever a mission is active.

Create `frontend/src/components/PlanPanel.tsx`:

```tsx
'use client';

import { useState } from 'react';

interface PlanStep {
  id: string;
  description: string;
  tool?: string;
  input?: string;
}

interface Plan {
  missionId: string;
  goal: string;
  steps: PlanStep[];
  reasoning: string;
}

interface Status {
  mission?: { id: string; title: string };
}

export default function PlanPanel({ status }: { status: { mission?: { id: string; title: string } } | null }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function fetchPlan() {
    if (!status?.mission) {
      setError('No active mission to plan for.');
      return;
    }
    setError(null);
    const res = await fetch('/api/cell/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        missionId: status.mission.id,
        goal: status.mission.title,
      }),
    });
    const data = await res.json();
    if (data.ok && data.plan) {
      setPlan(data.plan);
    } else {
      setError(data.error ?? 'Could not load plan');
      setPlan(null);
    }
  }

  return (
    <section className="rounded-lg border border-slate-700 p-4 mb-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xl font-semibold">Current Plan</h2>
        <button
          onClick={fetchPlan}
          className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 transition"
        >
          Show Plan
        </button>
      </div>
      {error && (
        <div className="rounded bg-rose-900/30 text-rose-300 p-3 text-sm mb-2">
          {error}
        </div>
      )}
      {plan ? (
        <div className="text-sm">
          <p className="text-slate-400 mb-2">{plan.reasoning}</p>
          <ol className="list-decimal list-inside space-y-1">
            {plan.steps.map((step) => (
              <li key={step.id}>
                {step.description}
                {step.tool && (
                  <span className="text-slate-400 ml-2">
                    ({step.tool}: {step.input})
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <p className="text-slate-400 text-sm">Click "Show Plan" to load the plan for the active mission.</p>
      )}
    </section>
  );
}
```

Import it into `frontend/src/app/page.tsx` and pass the current status:

```tsx
import PlanPanel from '@/components/PlanPanel';

// ... replace the inline plan section with:
<PlanPanel status={status} />
```

### 7. Add frontend build to the root verification pipeline

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

### 8. Add a dashboard route test

Create `frontend/src/lib/cell.test.ts`. The test verifies that `cellFetch` builds the right URL and that each API route returns a shape the dashboard expects. Because the test runs during the Next.js build process through TypeScript compilation, the most valuable test is a lightweight unit test on `cellFetch`.

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

### 9. Add a frontend dev script and a cell dev note

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

This file already exists in the repo; append the `CELL_URL` note to the end.

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

## Next chapter

- [Chapter 22: Human-in-the-loop](../22-human-in-the-loop/)
- [Back to TOC](../../docs/TOC.md)
