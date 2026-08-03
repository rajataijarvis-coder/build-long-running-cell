import type { Action, Tool } from './types.js';
import { spawn } from 'child_process';

export class Actor {
  constructor(private readonly tools: Tool[]) {}

  async act(action: Action): Promise<string> {
    const tool = this.tools.find((t) => t.name === action.tool);
    if (!tool) {
      throw new Error(`Tool "${action.tool}" not found. Registered tools: ${this.tools.map((t) => t.name).join(', ')}`);
    }
    return tool.execute(action.input);
  }
}

/**
 * A safe shell tool. It runs the given command with `spawn`, captures stdout,
 * and refuses to run commands that contain dangerous metacharacters.
 * This is the only tool in this chapter that touches the host filesystem.
 */
export class ShellTool implements Tool {
  name = 'shell';
  description = 'Run a safe shell command and return stdout';

  private readonly allowList: string[];
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;

  constructor(options: { allowList?: string[]; timeoutMs?: number; maxBuffer?: number } = {}) {
    this.allowList = options.allowList ?? [];
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxBuffer = options.maxBuffer ?? 1024 * 1024;
  }

  async execute(input: string): Promise<string> {
    const trimmed = input.trim();
    this.assertSafe(trimmed);

    return new Promise((resolve, reject) => {
      const parts = trimmed.split(/\s+/);
      const command = parts[0];
      const args = parts.slice(1);
      const proc = spawn(command, args, { shell: false });

      let stdout = '';
      let stderr = '';
      let totalBytes = 0;
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 1000);
      }, this.timeoutMs);

      const append = (buffer: string, chunk: string): string => {
        const remaining = this.maxBuffer - totalBytes;
        if (remaining <= 0) return buffer;
        const take = chunk.slice(0, remaining);
        totalBytes += Buffer.byteLength(take, 'utf-8');
        return buffer + take;
      };

      proc.stdout.on('data', (data: Buffer) => {
        stdout = append(stdout, data.toString('utf-8'));
      });
      proc.stderr.on('data', (data: Buffer) => {
        stderr = append(stderr, data.toString('utf-8'));
      });

      proc.on('close', (exitCode) => {
        clearTimeout(timer);
        if (killed) {
          reject(new Error(`Shell command timed out after ${this.timeoutMs}ms: ${trimmed}`));
          return;
        }
        if (exitCode !== 0) {
          reject(new Error(`Shell command failed (${exitCode}): ${trimmed}\n${stderr || stdout}`));
          return;
        }
        resolve(stdout.trim());
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to spawn "${command}": ${err.message}`));
      });
    });
  }

  private assertSafe(command: string): void {
    const dangerous = /[;&|`$(){}[\]\\*?<>~]/;
    if (dangerous.test(command)) {
      throw new Error(`Unsafe shell command rejected: ${command}`);
    }
    if (this.allowList.length > 0) {
      const base = command.split(/\s+/)[0];
      if (!this.allowList.includes(base)) {
        throw new Error(`Command "${base}" is not in the shell tool allow-list.`);
      }
    }
  }
}
