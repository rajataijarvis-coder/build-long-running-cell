import { Cell } from './cell.js';
import { startServer } from './server.js';

const cell = new Cell({
  basePath: process.cwd(),
  verificationCommands: [
    ['npm', ['run', 'lint']],
    ['npm', ['run', 'build']],
    ['npm', ['test']],
  ],
  maxRetries: 3,
});

startServer(cell, 3456);

const autoTick = process.env.AUTO_TICK === 'true';
if (autoTick) {
  setInterval(() => { cell.tick().catch((err) => console.error('Tick failed', err)); }, 5000);
}
