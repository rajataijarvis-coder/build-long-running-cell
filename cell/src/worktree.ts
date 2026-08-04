import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';

export interface WorktreeOptions {
  basePath: string;
  name: string;
  branch?: string;
}

export class Worktree {
  readonly path: string;
  readonly branch: string;

  constructor(public readonly basePath: string, public readonly name: string) {
    this.path = join(basePath, '.worktrees', name);
    this.branch = `loop-${name}`;
  }

  async create(fromRef = 'HEAD'): Promise<void> {
    await fs.mkdir(join(this.basePath, '.worktrees'), { recursive: true });
    // If a previous run left the branch attached to a worktree, reuse it.
    const existing = await this.hasWorktree();
    if (existing) {
      return;
    }
    try {
      await this.git('branch', '-f', this.branch, fromRef);
    } catch {
      // Branch may already exist and be checked out by a stale worktree.
    }
    await this.git('worktree', 'add', '-B', this.branch, this.path, this.branch);
  }

  private async hasWorktree(): Promise<boolean> {
    try {
      const list = await this.git('worktree', 'list', '--porcelain');
      return list.split('\n').some((line) => line.startsWith('worktree ') && line.includes(this.path));
    } catch {
      return false;
    }
  }

  async remove(): Promise<void> {
    try {
      await this.git('worktree', 'remove', '-f', this.path);
    } catch {
      // If removal failed, the worktree may already be gone or locked.
    }
    try {
      await this.git('branch', '-D', this.branch);
    } catch {
      // Branch may already be gone.
    }
  }

  async status(): Promise<{ clean: boolean; ahead?: number; behind?: number }> {
    const stdout = await this.gitInWorktree('status', '--porcelain=v1');
    const clean = stdout.trim().length === 0;
    return { clean };
  }

  async diffNameOnly(ref = 'HEAD'): Promise<string[]> {
    const stdout = await this.gitInWorktree('diff', '--name-only', ref);
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  private gitInWorktree(...args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd: this.path }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`git ${args.join(' ')} failed: ${stderr || err.message}`));
          return;
        }
        resolve(stdout);
      });
    });
  }

  private git(...args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd: this.basePath }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`git ${args.join(' ')} failed: ${stderr || err.message}`));
          return;
        }
        resolve(stdout);
      });
    });
  }
}
