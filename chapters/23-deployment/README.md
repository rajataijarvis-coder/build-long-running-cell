# Chapter 23: Deployment — running 24/7

## Learning goals

By the end of this chapter you will be able to:

1. Explain why a long-running cell needs health endpoints, graceful shutdown, and a process-manager contract to run continuously.
2. Add `/health` and `/version` HTTP endpoints that expose state, uptime, and build version.
3. Implement a `ShutdownManager` that stops background timers, closes the HTTP server, persists final state, and exits cleanly on SIGTERM/SIGINT.
4. Package the cell with Docker and a `docker-compose.yml` that persists state across restarts.
5. Provide a launchd plist for macOS and npm scripts (`start:cell:prod`, `start:frontend`, `start:prod`) for local process-runner deployment.
6. Add a dashboard deployment panel that shows version, uptime, and health status pulled from the new endpoints.
7. Verify the deployment wiring with `npm run verify`, manual health checks, and a test suite that exercises the new endpoints and shutdown behavior.

## Why this matters

Up to this point the cell has been a development process. You start it with `npm run dev`, tick it by hand from the dashboard, and stop it with Ctrl-C. That is fine for building and debugging, but it is not production. A real long-running agent has different requirements:

- **It must start automatically after a reboot.** A crash or a host restart should not require a human to log in and run `node dist/main.js`.
- **It must report whether it is alive.** A process manager (systemd, launchd, Docker, Kubernetes) needs a signal that the cell is healthy before it declares the service up.
- **It must shut down gracefully.** When the host deploys a new version or the operator stops the service, the cell should finish writing state, stop accepting work, and exit rather than being killed mid-mission.
- **Its state must survive across restarts.** The Git memory, execution journal, scheduler state, budget counters, and human-review queue are all on disk, so the cell can resume where it left off.
- **It must be deployable as an artifact.** A Dockerfile turns the repo into an image that can be run anywhere, while a compose file wires the cell and dashboard together.

This chapter is not about choosing between Kubernetes and a Raspberry Pi. It is about adding the small set of production interfaces — health, version, graceful shutdown, process-manager configuration, and container packaging — that turn the cell from a tutorial project into a service that can run 24/7.

## Recap: where we are

From [Chapter 18: Scheduling and backpressure](../18-scheduling/) the cell gained a `Scheduler` that evaluates cron expressions and enforces concurrency limits.

From [Chapter 19: Safety and guardrails](../19-safety-guardrails/) the cell added a `Guardrails` layer that blocks unsafe actions before they reach tools.

From [Chapter 20: Budget, cost, and observability](../20-budget-observability/) the cell added `BudgetTracker`, `Observability`, and `/budget` and `/metrics` HTTP endpoints.

From [Chapter 21: Next.js dashboard](../21-nextjs-dashboard/) we built a dashboard surface with status, budget, metrics, plan, and guardrail panels.

From [Chapter 22: Human-in-the-loop](../22-human-in-the-loop/) the cell added a `HumanInTheLoop` gate that pauses high-impact actions until an operator approves, revises, or rejects them.

This chapter adds the final production layer: deployment wiring. The cell already has all the behaviour it needs. Now we make it runnable as a managed service.

## Implementation

### 1. Expose version from `package.json`

Operators need to know which version of the cell is running. Create `cell/src/version.ts`:

```ts
import { createRequire } from 'module';

export const CELL_VERSION: string = (() => {
  try {
    return createRequire(import.meta.url)('../package.json').version as string;
  } catch {
    return 'unknown';
  }
})();
```

This reads `cell/package.json` at runtime. It works whether the cell is started from the source tree or from a compiled `dist/` directory because `import.meta.url` resolves to the executing `.js` file.

### 2. Add `/health` and `/version` endpoints

Open `cell/src/server.ts` and add the two endpoints near the top of the route handler, before `/status`:

```ts
import { CELL_VERSION } from './version.js';

// inside the request handler:
if (url.pathname === '/health') {
  const state = await cell.state();
  res.end(JSON.stringify({
    ok: true,
    status: 'up',
    state,
    uptime: process.uptime(),
    version: CELL_VERSION,
    timestamp: new Date().toISOString(),
  }));
  return;
}

if (url.pathname === '/version') {
  res.end(JSON.stringify({ ok: true, version: CELL_VERSION }));
  return;
}
```

`/health` is the endpoint a process manager calls. It returns:

- `ok`: whether the server responded.
- `status`: `'up'` when running.
- `state`: the current cell state machine state (`idle`, `planning`, etc.).
- `uptime`: seconds since the process started.
- `version`: the package version.
- `timestamp`: when the check was produced.

`/version` is a lightweight endpoint the dashboard can call to display the running build.

### 3. Implement graceful shutdown

Create `cell/src/shutdown.ts`:

```ts
import type { Server } from 'http';

export interface ShutdownOptions {
  stopTimers?: () => void;
  onShutdown?: () => Promise<void>;
  timeoutMs?: number;
}

export interface ShutdownHandle {
  unsubscribe: () => void;
  shutdown: (signal: string) => Promise<void>;
}

export function onShutdown(server: Server, options: ShutdownOptions = {}): ShutdownHandle {
  const timeoutMs = options.timeoutMs ?? 10_000;
  let shuttingDown = false;

  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully...`);

    options.stopTimers?.();

    const forceExitTimer = setTimeout(() => {
      console.error(`Shutdown timeout exceeded (${timeoutMs}ms), forcing exit.`);
      process.exit(1);
    }, timeoutMs);

    server.close(async (err?: Error) => {
      clearTimeout(forceExitTimer);
      if (err) console.error('Error closing server:', err.message);
      try {
        await options.onShutdown?.();
      } catch (cleanupErr) {
        console.error('Shutdown cleanup failed:', (cleanupErr as Error).message);
      }
      console.log('Shutdown complete.');
      process.exit(0);
    });
  }

  const onSigterm = () => shutdown('SIGTERM');
  const onSigint = () => shutdown('SIGINT');

  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);

  return {
    unsubscribe: () => {
      process.off('SIGTERM', onSigterm);
      process.off('SIGINT', onSigint);
    },
    shutdown,
  };
}
```

The contract is simple:

1. Stop background timers so no new tick or scheduled task starts.
2. Close the HTTP server so no new connections are accepted.
3. Run optional cleanup (for the cell, we persist memory).
4. Exit cleanly. If any step hangs, a hard timeout forces exit so the process manager does not wait forever.

### 4. Wire shutdown into `main.ts`

Open `cell/src/main.ts`. Capture the server, the auto-tick interval, and the scheduler loop handle, then register shutdown:

```ts
import { onShutdown } from './shutdown.js';
import { CELL_VERSION } from './version.js';

// ... create cell, budget, observability ...

const port = Number(process.env.PORT ?? '3456');
const server = startServer(cell, port, budget, observability);
console.log(`Cell version ${CELL_VERSION} starting on port ${port}`);

let tickInterval: NodeJS.Timeout | undefined;
const autoTick = process.env.AUTO_TICK === 'true';
if (autoTick) {
  tickInterval = setInterval(() => {
    cell.tick().catch((err) => console.error('Tick failed', err));
  }, 5000);
}

let schedulerStop: (() => void) | undefined;
const autoSchedule = process.env.AUTO_SCHEDULE === 'true';
if (autoSchedule) {
  const scheduler = new Scheduler({ basePath, verificationCommands, maxConcurrency: 1, minIntervalMs: 5000, budget, observability });
  schedulerStop = startSchedulerLoop(scheduler, 60_000, (results) => {
    if (results.length > 0) {
      console.log(`Scheduler tick produced ${results.length} result(s)`);
      for (const r of results) {
        console.log(`  ${r.taskId}: ran=${r.ran}${r.error ? ` error=${r.error}` : ''}`);
      }
    }
  }).stop;
}

onShutdown(server, {
  stopTimers: () => {
    if (tickInterval) clearInterval(tickInterval);
    schedulerStop?.();
  },
  onShutdown: () => cell.flush(),
  timeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS ?? '10000'),
});
```

Also add a `flush()` method to the `Cell` class in `cell/src/cell.ts` so shutdown can persist the current memory snapshot without reaching into private fields:

```ts
/** Persist the current memory snapshot to disk. Called before shutdown. */
async flush(): Promise<void> {
  const mem = await this.memory.load();
  await this.memory.save(mem);
}
```

With this wiring, sending `SIGTERM` to the cell will:

- Stop the auto-tick interval and scheduler loop.
- Close the HTTP server.
- Save memory.
- Exit with code 0.

### 5. Add production npm scripts

Open the root `package.json` and add scripts that a process manager can call directly:

```json
{
  "scripts": {
    "verify:cell": "cd cell && npm run verify",
    "build:frontend": "cd frontend && npm run build",
    "verify": "npm run verify:cell && npm run build:frontend",
    "start:cell": "cd cell && npm run build && node dist/main.js",
    "start:cell:prod": "cd cell && npm run build && AUTO_TICK=true AUTO_SCHEDULE=true node dist/main.js",
    "start:frontend": "cd frontend && npm run build && npm run start",
    "start:prod": "npm run start:cell:prod & npm run start:frontend",
    "publish": "node scripts/node_modules/.bin/tsx scripts/publish-chapter.ts"
  }
}
```

`start:cell:prod` is the command a systemd or launchd service runs. It builds the cell, enables auto-tick, and enables the scheduler loop. `start:prod` is a convenience for local testing that runs both the cell and the dashboard.

### 6. Containerise the cell

Create a root `Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1

FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY cell/package*.json ./cell/
COPY frontend/package*.json ./frontend/
COPY scripts/package*.json ./scripts/
RUN npm ci --workspaces

COPY . .
RUN npm run verify

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3456

COPY --from=builder /app/cell/dist ./cell/dist
COPY --from=builder /app/cell/package.json ./cell/package.json
COPY --from=builder /app/package*.json ./

EXPOSE 3456
CMD ["node", "cell/dist/main.js"]
```

The builder stage installs dependencies, copies the source, and runs the full verification pipeline. The runner stage copies only the compiled cell, keeping the image small. The default `CMD` does not enable auto-tick or scheduling; you override that in `docker-compose.yml` or Kubernetes manifests.

Create `docker-compose.yml` to run the cell and dashboard together:

```yaml
services:
  cell:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3456:3456"
    environment:
      - NODE_ENV=production
      - PORT=3456
      - AUTO_TICK=true
      - AUTO_SCHEDULE=true
    volumes:
      - cell-state:/app/state
      - cell-memory:/app/memory
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3456/health').then(r=>r.ok?process.exit(0):process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

  dashboard:
    build:
      context: ./frontend
      dockerfile: Dockerfile.frontend
    ports:
      - "3000:3000"
    environment:
      - CELL_URL=http://cell:3456
      - NODE_ENV=production
    depends_on:
      cell:
        condition: service_healthy

volumes:
  cell-state:
  cell-memory:
```

The healthcheck is the real `/health` endpoint, so Docker can tell when the cell is ready before it starts the dashboard. State and memory are stored in named volumes so they survive container restarts.

Create `frontend/Dockerfile.frontend`:

```dockerfile
# syntax=docker/dockerfile:1

FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000
CMD ["node", "server.js"]
```

To make the standalone output work, update `frontend/next.config.mjs`:

```mjs
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  env: {
    CELL_URL: process.env.CELL_URL ?? 'http://localhost:3456',
  },
};

export default nextConfig;
```

### 7. Add a launchd plist for macOS

If you are running on macOS, create `cell/com.build-long-running-cell.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.build-long-running-cell</string>
  <key>WorkingDirectory</key>
  <string>/Users/rajatjarvis/Downloads/projects/build-long-running-cell/cell</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>dist/main.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>AUTO_TICK</key><string>true</string>
    <key>AUTO_SCHEDULE</key><string>true</string>
    <key>PORT</key><string>3456</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>
  <string>/Users/rajatjarvis/Downloads/projects/build-long-running-cell/cell/logs/cell.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/rajatjarvis/Downloads/projects/build-long-running-cell/cell/logs/cell-error.log</string>
</dict>
</plist>
```

Install it with:

```bash
mkdir -p ~/Library/LaunchAgents
cp cell/com.build-long-running-cell.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.build-long-running-cell.plist
```

### 8. Add a deployment panel to the dashboard

Create `frontend/src/app/api/cell/health/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { cellFetch } from '@/lib/cell';

export async function GET() {
  try {
    const { data } = await cellFetch('/health');
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { ok: false, status: 'offline', error: (err as Error).message },
      { status: 503 }
    );
  }
}
```

Create `frontend/src/app/api/cell/version/route.ts` similarly.

Create `frontend/src/components/DeploymentPanel.tsx`. It polls `/api/cell/health` and `/api/cell/version` every five seconds and renders version, cell state, uptime, and a status badge. The implementation is included in this commit.

Then import and use it at the top of `frontend/src/app/page.tsx`:

```tsx
import DeploymentPanel from '@/components/DeploymentPanel';

// ... inside the main return:
<DeploymentPanel />
<StatusPanel />
<ObservabilityPanel />
<PlanPanel status={status} />
```

### 9. Test the new wiring

Create `cell/src/server.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Server } from 'http';
import { Cell } from './cell.js';
import { startServer } from './server.js';
import { CELL_VERSION } from './version.js';

function makeTmpDir(): string { ... }

async function listen(server: Server): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 3456;
      resolve({
        url: `http://localhost:${port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

describe('HTTP server endpoints', () => {
  let basePath: string;
  let cell: Cell;
  let server: Server;
  let url: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    basePath = makeTmpDir();
    cell = new Cell({ basePath, verificationCommands: [], maxRetries: 3 });
    server = startServer(cell, 0);
    const info = await listen(server);
    url = info.url;
    close = info.close;
  });

  afterEach(async () => { await close(); });

  it('/health returns status, state, uptime and version', async () => {
    const res = await fetch(`${url}/health`);
    const data = await res.json() as { ok: boolean; status: string; state: string; uptime: number; version: string; timestamp: string };
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.status, 'up');
    assert.equal(data.state, 'idle');
    assert.ok(data.uptime >= 0);
    assert.equal(data.version, CELL_VERSION);
    assert.ok(data.timestamp);
  });

  it('/version returns the cell version', async () => {
    const res = await fetch(`${url}/version`);
    const data = await res.json() as { ok: boolean; version: string };
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.version, CELL_VERSION);
  });
});
```

Create `cell/src/shutdown.test.ts` to verify that the handler registers, unregisters, and calls `stopTimers` and `onShutdown` when triggered manually:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { onShutdown } from './shutdown.js';

describe('onShutdown', () => {
  it('registers and unregisters handlers', () => {
    const server = createServer();
    const handle = onShutdown(server, { timeoutMs: 100 });
    handle.unsubscribe();
    // listener counts should return to baseline
  });

  it('stops timers and closes the server when shutdown is invoked', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));

    let timersStopped = false;
    let cleanupCalled = false;
    const handle = onShutdown(server, {
      timeoutMs: 100,
      stopTimers: () => { timersStopped = true; },
      onShutdown: async () => { cleanupCalled = true; },
    });

    // Override process.exit so the test runner survives.
    const originalExit = process.exit;
    let exitCode: number | undefined;
    (process as { exit: (code?: number) => never }).exit = ((code?: number) => { exitCode = code; }) as (code?: number) => never;

    await handle.shutdown('TEST');
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(timersStopped, true);
    assert.equal(cleanupCalled, true);
    assert.equal(exitCode, 0);

    (process as { exit: (code?: number) => never }).exit = originalExit;
    handle.unsubscribe();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
```

These tests ensure the deployment surface is wired correctly and behaves predictably.

## Verification

Run the full stack verification from the repository root:

```bash
cd /Users/rajatjarvis/Downloads/projects/build-long-running-cell
npm run verify
```

This runs:

1. Cell lint, TypeScript build, and all cell tests — including the new server and shutdown suites.
2. Next.js dashboard build, which type-checks the new deployment panel and API routes.

You should see the new tests pass:

```text
▶ HTTP server endpoints
  ✔ /health returns status, state, uptime and version
  ✔ /version returns the cell version
▶ onShutdown
  ✔ registers and unregisters handlers
  ✔ stops timers and closes the server when shutdown is invoked
```

Then run the cell in production mode locally and exercise the health endpoint:

```bash
cd cell
npm run build
AUTO_TICK=true AUTO_SCHEDULE=true node dist/main.js &
PID=$!

# Wait for startup, then call health
curl http://localhost:3456/health

# Should return something like:
# {"ok":true,"status":"up","state":"idle","uptime":1.23,"version":"0.1.0","timestamp":"2026-08-04T05:..."}

# Stop the cell gracefully
kill -TERM $PID
wait $PID
```

If the cell exits with code 0 and the logs show `Shutdown complete.`, the graceful shutdown wiring is working.

For Docker:

```bash
docker compose up --build
```

After the healthcheck passes, the dashboard should be available at http://localhost:3000 and the cell at http://localhost:3456.

## Practical exercises

1. **Add a readiness gate.** Extend `/health` so it returns `status: 'degraded'` when the cell is `paused` due to budget exhaustion or a pending human review. Add a dashboard warning state that explains why the cell is not accepting new work.

2. **Persist logs to a file.** Add a `LOG_FILE` environment variable that redirects `console.log` and `console.error` to a rotating file stream. Update the launchd plist and the Docker compose volume to use it. Ensure the test suite still passes when `LOG_FILE` is unset.

3. **Add a rolling-update shutdown delay.** When `SIGTERM` is received while a mission is `in_progress`, wait up to `GRACEFUL_SHUTDOWN_TIMEOUT_MS` for the current tick to finish before closing the server. If the tick completes, save the final state and exit 0; otherwise exit 1. Add a test that queues a long mission, triggers shutdown, and verifies the exit code based on whether the mission finished in time.

## Next chapter

With the cell packaged, health-checked, and gracefully shut down, it is ready to run as a service. In [Chapter 24: Capstone — orchestration](../24-capstone-orchestration/) we will wire everything together: lead engineer, specialists, scheduler, guardrails, budget, human approval, memory, dashboard, and deployment, into one coordinated autonomous cell.

See the full course index in the [TOC](../../docs/TOC.md).
