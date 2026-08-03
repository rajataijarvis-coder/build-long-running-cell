import { spawn } from 'child_process';
import type { VerificationResult, VerificationSummary } from './types.js';

export interface VerifyOptions {
  /** Maximum time in milliseconds before the process is killed. */
  timeoutMs?: number;
  /** Maximum number of bytes to keep from stdout + stderr combined. */
  maxBuffer?: number;
}

/**
 * Run a single command and return a structured verification result.
 *
 * The result captures stdout, stderr, the exit code, and whether the
 * command succeeded. A missing executable or a process that exceeds the
 * timeout is reported as a failure with a clear diagnostic message.
 */
export async function verify(
  command: string,
  args: string[] = [],
  options: VerifyOptions = {}
): Promise<VerificationResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;

  return new Promise((resolve) => {
    const proc = spawn(command, args, { shell: false });
    let stdout = '';
    let stderr = '';
    let totalBytes = 0;
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      // Give the process a short grace period, then force kill.
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 1000);
    }, timeoutMs);

    function appendBuffer(buffer: string, chunk: string): string {
      const remaining = maxBuffer - totalBytes;
      if (remaining <= 0) return buffer;
      const take = chunk.slice(0, remaining);
      totalBytes += Buffer.byteLength(take, 'utf-8');
      return buffer + take;
    }

    proc.stdout.on('data', (data: Buffer) => {
      stdout = appendBuffer(stdout, data.toString('utf-8'));
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr = appendBuffer(stderr, data.toString('utf-8'));
    });

    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      if (killed) {
        resolve({
          passed: false,
          command: [command, ...args].join(' '),
          stdout,
          stderr: stderr || `Verification timed out after ${timeoutMs}ms`,
          exitCode: -1,
        });
        return;
      }
      resolve({
        passed: exitCode === 0,
        command: [command, ...args].join(' '),
        stdout,
        stderr,
        exitCode: exitCode ?? -1,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        passed: false,
        command: [command, ...args].join(' '),
        stdout,
        stderr: err.message,
        exitCode: -1,
      });
    });
  });
}

/**
 * Run a suite of verification commands in order and produce a summary.
 *
 * By default the suite stops at the first failing command so the cell
 * surfaces the closest root cause. Set `stopOnFailure` to false to collect
 * every result, which is useful when generating a report for a dashboard.
 */
export async function runVerificationSuite(
  commands: [string, string[]][],
  options: VerifyOptions & { stopOnFailure?: boolean } = {}
): Promise<VerificationSummary> {
  const { stopOnFailure = true, ...verifyOptions } = options;
  const results: VerificationResult[] = [];
  let passed = true;

  for (const [cmd, args] of commands) {
    const result = await verify(cmd, args, verifyOptions);
    results.push(result);
    if (!result.passed) {
      passed = false;
      if (stopOnFailure) break;
    }
  }

  return { passed, results };
}
