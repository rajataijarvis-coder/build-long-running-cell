import type { Server } from 'http';

export interface ShutdownOptions {
  /** Called first to stop background timers (auto-tick, scheduler loop, etc.). */
  stopTimers?: () => void;
  /** Called after the server closes so the cell can persist final state. */
  onShutdown?: () => Promise<void>;
  /** Maximum time to wait for cleanup before forcing exit. */
  timeoutMs?: number;
}

export interface ShutdownHandle {
  /** Remove the signal listeners. */
  unsubscribe: () => void;
  /** Trigger shutdown manually. Exposed for tests. */
  shutdown: (signal: string) => Promise<void>;
}

/**
 * Register graceful SIGTERM/SIGINT handlers for a long-running cell.
 *
 * When a process manager (systemd, launchd, Docker, Kubernetes) wants to stop
 * the service, it sends a signal. Instead of exiting immediately and dropping
 * an in-flight mission, we:
 *
 * 1. Stop accepting new HTTP connections.
 * 2. Stop background timers so no new work starts.
 * 3. Run optional cleanup (e.g. final memory save).
 * 4. Exit cleanly, with a hard timeout to avoid hanging forever.
 */
export function onShutdown(server: Server, options: ShutdownOptions = {}): ShutdownHandle {
  const timeoutMs = options.timeoutMs ?? 10_000;
  let shuttingDown = false;

  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully...`);

    // Stop timers first so a scheduled task cannot start during shutdown.
    options.stopTimers?.();

    // Force exit if graceful shutdown takes too long. Process managers like
    // systemd will send SIGKILL eventually, but we prefer to exit on our own
    // terms and leave a clear log.
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
