import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import type { Tool, ToolRegistry } from './types.js';
import { spawn } from 'child_process';

/**
 * A safe shell tool. It runs the given command with `spawn`, captures stdout,
 * and refuses to run commands that contain dangerous metacharacters.
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

/**
 * Read a file from the cell workspace and return its contents as text.
 */
export class ReadFileTool implements Tool {
  name = 'read_file';
  description = 'Read a file from the workspace. Input: relative path.';

  constructor(private readonly basePath: string) {}

  async execute(input: string): Promise<string> {
    const safe = this.sanitise(input);
    const absolute = resolve(join(this.basePath, safe));
    if (!absolute.startsWith(resolve(this.basePath))) {
      throw new Error('Path escapes workspace');
    }
    if (!existsSync(absolute)) {
      return `__FILE_NOT_FOUND__ ${safe}`;
    }
    return readFile(absolute, 'utf-8');
  }

  private sanitise(input: string): string {
    const trimmed = input.trim().replace(/^\//, '');
    if (trimmed.split('/').some((part) => part === '..' || part === '.')) {
      throw new Error('Path escapes workspace');
    }
    return trimmed;
  }
}

/**
 * Edit a file in the cell workspace by replacing one literal string with another.
 */
export class EditFileTool implements Tool {
  name = 'edit_file';
  description = 'Edit a file in the workspace. Input: "path\nOLD\nNEW".';

  constructor(private readonly basePath: string) {}

  async execute(input: string): Promise<string> {
    const lines = input.split('\n');
    const path = lines[0]?.trim() ?? '';
    const oldText = lines[1] ?? '';
    const newText = lines.slice(2).join('\n');

    const safe = this.sanitise(path);
    const absolute = resolve(join(this.basePath, safe));
    if (!absolute.startsWith(resolve(this.basePath))) {
      throw new Error('Path escapes workspace');
    }
    if (!existsSync(absolute)) {
      throw new Error(`File not found: ${safe}`);
    }

    const content = await readFile(absolute, 'utf-8');
    if (!content.includes(oldText)) {
      throw new Error('Old text not found in file');
    }
    const updated = content.replace(oldText, newText);
    await writeFile(absolute, updated, 'utf-8');
    return `__EDIT_OK__ ${safe}`;
  }

  private sanitise(input: string): string {
    const trimmed = input.trim().replace(/^\//, '');
    if (trimmed.split('/').some((part) => part === '..' || part === '.')) {
      throw new Error('Path escapes workspace');
    }
    return trimmed;
  }
}

/**
 * Run the project verification suite and return a structured summary string.
 */
export class VerifyTool implements Tool {
  name = 'verify';
  description = 'Run the verification gate (lint, build, test) and return the result.';

  private readonly commands: [string, string[]][];

  constructor(commands?: [string, string[]][]) {
    this.commands = commands ?? [
      ['npm', ['run', 'lint']],
      ['npm', ['run', 'build']],
      ['npm', ['test']],
    ];
  }

  async execute(): Promise<string> {
    const results: string[] = [];
    for (const [cmd, args] of this.commands) {
      const proc = spawn(cmd, args, { shell: false });
      let stdout = '';
      let stderr = '';
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 1000);
      }, 60_000);
      await new Promise<void>((resolve) => {
        proc.stdout.on('data', (d) => { stdout += d.toString('utf-8'); });
        proc.stderr.on('data', (d) => { stderr += d.toString('utf-8'); });
        proc.on('close', (code) => {
          clearTimeout(timer);
          results.push(`${cmd} ${args.join(' ')}: ${killed ? 'TIMEOUT' : code === 0 ? 'PASS' : 'FAIL'}\n${stderr || stdout}`);
          resolve();
        });
        proc.on('error', (err) => {
          clearTimeout(timer);
          results.push(`${cmd} ${args.join(' ')}: ERROR ${err.message}`);
          resolve();
        });
      });
    }
    const allPass = results.every((r) => r.includes(': PASS'));
    return `__VERIFY_${allPass ? 'PASS' : 'FAIL'}__\n${results.join('\n---\n')}`;
  }
}

/**
 * A lightweight registry that lets the reasoner/planner discover tools by
 * name and render a prompt-style description block.
 */
export class ToolRegistryImpl implements ToolRegistry {
  constructor(public readonly tools: Tool[] = []) {}

  byName(name: string): Tool | undefined {
    return this.tools.find((t) => t.name === name);
  }

  descriptions(): string {
    return this.tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
  }
}
