import { Cell } from './cell.js';
import { startServer } from './server.js';
import { BudgetTracker } from './budget.js';
import { Observability } from './observability.js';
import { Scheduler, startSchedulerLoop } from './scheduler.js';
import { onShutdown } from './shutdown.js';
import { CELL_VERSION } from './version.js';

const basePath = process.cwd();
const verificationCommands: [string, string[]][] = [
  ['npm', ['run', 'lint']],
  ['npm', ['run', 'build']],
  ['npm', ['test']],
];

const budget = new BudgetTracker({
  basePath,
  tokenLimit: Number(process.env.CELL_TOKEN_LIMIT ?? '0'),
  costLimit: Number(process.env.CELL_COST_LIMIT ?? '0'),
  elapsedMsLimit: Number(process.env.CELL_RUNTIME_LIMIT_MS ?? '0'),
  costPer1kTokens: Number(process.env.CELL_COST_PER_1K_TOKENS ?? '0.002'),
});

const observability = new Observability({ basePath });

const cell = new Cell({
  basePath,
  verificationCommands,
  maxRetries: 3,
  budget,
  observability,
});

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
  const scheduler = new Scheduler({
    basePath,
    verificationCommands,
    maxConcurrency: 1,
    minIntervalMs: 5000,
    budget,
    observability,
  });
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
