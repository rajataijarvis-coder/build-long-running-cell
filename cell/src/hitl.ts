import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import type { Action, HITLStatus, HumanReview } from './types.js';

export interface HumanInTheLoopOptions {
  basePath: string;
  /**
   * Which tools always require approval, regardless of input.
   * By default only tools that the cell cannot undo easily.
   */
  requireApprovalForTools?: string[];
  /**
   * Substrings that, if present in an action input, force a review.
   */
  requireApprovalForInput?: string[];
  /**
   * If true, the final step of a mission that modifies protected files requires approval.
   */
  requireApprovalForProtectedFiles?: boolean;
  /** List of file patterns considered protected. */
  protectedPatterns?: string[];
}

export interface ReviewGateResult {
  ok: boolean;
  /** If ok is false, the review that was created. */
  review?: HumanReview;
  /** Human-readable reason. */
  reason?: string;
}

export class HumanInTheLoop {
  private readonly options: Required<HumanInTheLoopOptions>;
  private readonly statePath: string;

  constructor(options: HumanInTheLoopOptions) {
    this.options = {
      requireApprovalForTools: options.requireApprovalForTools ?? ['delete_file'],
      requireApprovalForInput: options.requireApprovalForInput ?? ['rm ', 'remove ', 'drop table', 'deploy', 'send email'],
      requireApprovalForProtectedFiles: options.requireApprovalForProtectedFiles ?? true,
      protectedPatterns: options.protectedPatterns ?? ['main.ts', 'package.json', 'README.md', '.env'],
      basePath: options.basePath,
    };
    this.statePath = join(this.options.basePath, 'state', 'reviews.json');
  }

  /**
   * Check whether an action needs approval. If it does, create a pending review
   * and return `ok: false`. If a pending review already exists for this mission/step,
   * return its status instead of creating a duplicate.
   */
  async check(action: Action, missionId: string, stepId: string): Promise<ReviewGateResult> {
    const state = await this.loadState();
    const existing = state.reviews.find((r) => r.missionId === missionId && r.stepId === stepId && r.status === 'pending');
    if (existing) {
      return { ok: false, review: existing, reason: `Pending review ${existing.id} exists` };
    }

    let ruleId: string | undefined;
    let reason: string | undefined;

    if (this.options.requireApprovalForTools.includes(action.tool)) {
      ruleId = 'tool-policy';
      reason = `Tool '${action.tool}' requires human approval.`;
    } else if (this.options.requireApprovalForInput.some((marker) => action.input.toLowerCase().includes(marker.toLowerCase()))) {
      ruleId = 'input-policy';
      reason = 'Input contains a protected keyword that requires approval.';
    } else if (this.options.requireApprovalForProtectedFiles && this.isProtectedFileAction(action) && this.isInsideWorkspace(action.input)) {
      ruleId = 'protected-file-policy';
      reason = 'Action may modify a protected file.';
    }

    if (!reason) {
      return { ok: true };
    }

    const review: HumanReview = {
      id: `review-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      missionId,
      stepId,
      status: 'pending',
      action: { tool: action.tool, input: action.input },
      reason,
      ruleId,
      requestedAt: new Date().toISOString(),
    };

    state.reviews.push(review);
    await this.saveState(state);
    return { ok: false, review, reason };
  }

  /**
   * Resolve a pending review with an operator verdict and optional feedback.
   */
  async resolve(reviewId: string, verdict: HITLStatus, feedback?: string): Promise<HumanReview | undefined> {
    const state = await this.loadState();
    const review = state.reviews.find((r) => r.id === reviewId);
    if (!review || review.status !== 'pending') return undefined;

    review.status = verdict;
    review.feedback = feedback;
    review.resolvedAt = new Date().toISOString();
    await this.saveState(state);
    return review;
  }

  /** Return all reviews, most recent first. */
  async list(): Promise<HumanReview[]> {
    const state = await this.loadState();
    return state.reviews.slice().reverse();
  }

  /** Return only pending reviews. */
  async pending(): Promise<HumanReview[]> {
    const state = await this.loadState();
    return state.reviews.filter((r) => r.status === 'pending').slice().reverse();
  }

  private matchesProtectedPattern(input: string): boolean {
    const lower = input.toLowerCase();
    return this.options.protectedPatterns.some((pattern) => lower.includes(pattern.toLowerCase()));
  }

  /** Return true if the action is a write/edit to a file path that matches a protected pattern. */
  private isProtectedFileAction(action: Action): boolean {
    const fileTools = ['write_file', 'edit_file', 'delete_file'];
    if (!fileTools.includes(action.tool)) return false;
    const path = action.input.split('\n')[0]?.trim() ?? '';
    return this.matchesProtectedPattern(path);
  }

  /** Return true if every part of the input path stays within the workspace. */
  private isInsideWorkspace(input: string): boolean {
    const parts = input.split(/\s+/);
    for (const part of parts) {
      const normalised = part.replace(/^\//, '');
      if (normalised.split('/').some((p) => p === '..' || p === '.')) {
        return false;
      }
    }
    return true;
  }

  private async loadState(): Promise<{ reviews: HumanReview[] }> {
    try {
      const raw = await fs.readFile(this.statePath, 'utf-8');
      const parsed = JSON.parse(raw) as { reviews?: HumanReview[] };
      return { reviews: parsed.reviews ?? [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { reviews: [] };
      }
      throw err;
    }
  }

  private async saveState(state: { reviews: HumanReview[] }): Promise<void> {
    await fs.mkdir(dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(state, null, 2), 'utf-8');
  }
}
