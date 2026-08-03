import { spawn } from 'child_process';
import type { VerificationResult } from './types.js';

export async function verify(command: string, args: string[] = []): Promise<VerificationResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { shell: false });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    proc.on('close', (exitCode) => {
      resolve({
        passed: exitCode === 0,
        command: [command, ...args].join(' '),
        stdout,
        stderr,
        exitCode: exitCode ?? -1,
      });
    });
    proc.on('error', (err) => {
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

export async function runVerificationSuite(commands: [string, string[]][]): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  for (const [cmd, args] of commands) {
    const result = await verify(cmd, args);
    results.push(result);
    if (!result.passed) break;
  }
  return results;
}
