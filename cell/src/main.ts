import { Cell } from './cell.js';
import { startServer } from './server.js';
import { BudgetTracker } from './budget.js';
import { Observability } from './observability.js';
import { Scheduler, startSchedulerLoop } from './scheduler.js';

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

startServer(cell, 3456, budget, observability);

const autoTick = process.env.AUTO_TICK === 'true';
if (autoTick) {
  setInterval(() => { cell.tick().catch((err) => console.error('Tick failed', err)); }, 5000);
}

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
  startSchedulerLoop(scheduler, 60_000, (results) => {
    if (results.length > 0) {
      console.log(`Scheduler tick produced ${results.length} result(s)`);
      for (const r of results) {
        console.log(`  ${r.taskId}: ran=${r.ran}${r.error ? ` error=${r.error}` : ''}`);
      }
    }
  });
}
