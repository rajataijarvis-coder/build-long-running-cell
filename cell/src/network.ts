import type { SubAgent, Review, Proposal } from './types.js';
import type { LoopResult } from './loop-engine.js';

export interface CellNetworkResult {
  missionId: string;
  task: string;
  approved: boolean;
  rounds: number;
  finalProposal?: Proposal;
  finalReview?: Review;
  error?: string;
}

export interface CellNetworkOptions {
  maker: SubAgent;
  checker: SubAgent;
  /** Maximum maker/checker rounds before the network gives up. */
  maxRounds?: number;
}

/**
 * A cell network wires a maker subagent and a checker subagent into a loop.
 *
 * The maker proposes. The checker reviews. If the checker says `revise`, the
 * maker runs again with the checker's feedback appended to the task. If the
 * checker says `reject`, the network stops and reports failure. If the checker
 * says `approve`, the network stops and records the approved proposal.
 *
 * This is the simplest multi-cell coordination pattern. It keeps the maker
 * and checker decoupled: they only agree on the `SubAgent` interface and the
 * shape of the `AgentResult`.
 */
export class CellNetwork {
  private maker: SubAgent;
  private checker: SubAgent;
  private maxRounds: number;

  constructor(options: CellNetworkOptions) {
    if (options.maker.role !== 'maker') {
      throw new Error(`Expected a maker subagent but got ${options.maker.name} (${options.maker.role})`);
    }
    if (options.checker.role !== 'checker') {
      throw new Error(`Expected a checker subagent but got ${options.checker.name} (${options.checker.role})`);
    }
    this.maker = options.maker;
    this.checker = options.checker;
    this.maxRounds = options.maxRounds ?? 3;
  }

  async run(missionId: string, task: string): Promise<CellNetworkResult> {
    let currentTask = task;

    for (let round = 1; round <= this.maxRounds; round++) {
      const makerResult = await this.maker.run(currentTask, { missionId, round });
      const result = (makerResult.loopResult ?? makerResult) as unknown as LoopResult;

      const checkerResult = await this.checker.run('', {
        missionId,
        round,
        makerResult: result,
      });

      let review: Review | undefined;
      try {
        review = checkerResult.artifact ? JSON.parse(checkerResult.artifact) as Review : undefined;
      } catch {
        review = {
          stepId: missionId,
          verdict: 'reject',
          feedback: `Checker returned unparseable review: ${checkerResult.output}`,
        };
      }

      if (!review) {
        review = {
          stepId: missionId,
          verdict: 'reject',
          feedback: 'Checker returned an empty review.',
        };
      }

      if (review.verdict === 'approve') {
        const proposal = this.toProposal(missionId, result, review);
        return {
          missionId,
          task,
          approved: true,
          rounds: round,
          finalProposal: proposal,
          finalReview: review,
        };
      }

      if (review.verdict === 'reject' || round === this.maxRounds) {
        return {
          missionId,
          task,
          approved: false,
          rounds: round,
          finalReview: review,
          error: review.feedback ?? `Failed to converge after ${round} round(s).`,
        };
      }

      // Checker wants a revision. Feed the feedback back to the maker.
      currentTask = `${task}\nRevision round ${round}: ${review.feedback}`;
    }

    return {
      missionId,
      task,
      approved: false,
      rounds: this.maxRounds,
      error: 'Exhausted all maker/checker rounds without approval.',
    };
  }

  private toProposal(missionId: string, result: LoopResult, review: Review): Proposal {
    const stepId = result.iterations.at(-1)?.action.stepId ?? missionId;
    const now = new Date().toISOString();
    return {
      id: `proposal-${Date.now()}`,
      missionId,
      stepId,
      artifact: result.finalAnswer,
      reasoning: `Approved after ${result.iterations.length} maker iteration(s) and review: ${review.feedback}`,
      status: 'approved',
      reviews: [review],
      createdAt: now,
      updatedAt: now,
    };
  }
}
