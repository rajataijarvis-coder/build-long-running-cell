import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { onShutdown } from './shutdown.js';

describe('onShutdown', () => {
  it('registers and unregisters SIGTERM/SIGINT handlers', () => {
    const beforeTerm = process.listenerCount('SIGTERM');
    const beforeInt = process.listenerCount('SIGINT');

    const server = createServer();
    const handle = onShutdown(server, { timeoutMs: 100 });

    assert.equal(process.listenerCount('SIGTERM'), beforeTerm + 1);
    assert.equal(process.listenerCount('SIGINT'), beforeInt + 1);

    handle.unsubscribe();

    assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
    assert.equal(process.listenerCount('SIGINT'), beforeInt);
  });

  it('stops timers and closes the server when shutdown is invoked', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));

    let timersStopped = false;
    let cleanupCalled = false;

    const handle = onShutdown(server, {
      timeoutMs: 100,
      stopTimers: () => {
        timersStopped = true;
      },
      onShutdown: async () => {
        cleanupCalled = true;
      },
    });

    // Calling shutdown will eventually call process.exit(0), which would end
    // the test runner. Override process.exit for this test so we can assert
    // the side effects.
    const originalExit = process.exit;
    let exitCode: number | undefined;
    (process as { exit: (code?: number) => never }).exit = ((code?: number) => {
      exitCode = code;
    }) as (code?: number) => never;

    await handle.shutdown('TEST');

    // Wait briefly for the server.close callback to run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(timersStopped, true);
    assert.equal(cleanupCalled, true);
    assert.equal(exitCode, 0);

    // Restore and clean up.
    (process as { exit: (code?: number) => never }).exit = originalExit;
    handle.unsubscribe();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
