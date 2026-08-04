import { startServer } from './server.js';
import { createDarkFactoryContext } from './factory.js';
import { onShutdown } from './shutdown.js';
import { CELL_VERSION } from './version.js';

const basePath = process.cwd();

const context = createDarkFactoryContext({
  basePath,
  verificationCommands: [
    ['npm', ['run', 'lint']],
    ['npm', ['run', 'build']],
    ['npm', ['test']],
  ],
});

const port = Number(process.env.PORT ?? '3456');
const server = startServer(context, port);

onShutdown(server, {
  onShutdown: () => context.cell.flush(),
  timeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS ?? '10000'),
});

console.log(`[cell ${CELL_VERSION}] dark-factory mode running on port ${port}`);
console.warn('⚠️  Dark factory mode: human approval gates are disabled. Verify budgets and guardrails are still active.');
