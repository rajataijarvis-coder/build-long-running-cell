import type { Review } from './types.js';
import type { LoopResult, LoopIteration } from './loop-engine.js';

export interface CheckerOptions {
  /**
   * Substrings that, if found in the final answer or any observation output,
   * cause the checker to demand a revision.
   */
  revisionTriggers?: string[];
  /**
   * Substrings that, if found, cause the checker to reject the proposal
   * outright rather than allowing a retry.
   */
  rejectionTriggers?: string[];
  /**
   * Minimum number of iterations the maker must produce before a proposal
   * can be approved. This stops trivial one-shot answers.
   */
  minIterations?: number;
}

/**
 * The checker is the critic in a maker/checker pair.
 *
 * It inspects the output of a maker loop and returns a structured review:
 * - `approve`: the proposal is good enough to accept.
 * - `revise`: the proposal has fixable problems; feed the feedback back to the maker.
 * - `reject`: the proposal has fundamental problems; escalate to a human.
 *
 * The checker is intentionally rule-based in this chapter, just like the
 * reasoner and reflector. The important part is the separation of concerns:
 * the maker optimises for making progress, the checker optimises for not
 * letting bad progress through.
 */
export class Checker {
  constructor(private readonly options: CheckerOptions = {}) {}

  review(missionId: string, result: LoopResult): Review {
    const stepId = result.iterations.at(-1)?.action.stepId ?? missionId;
    const finalAnswer = result.finalAnswer.toLowerCase();
    const allOutputs = result.iterations.map((i: LoopIteration) => `${i.observation.output} ${i.observation.note ?? ''}`).join(' ').toLowerCase();
    const text = `${finalAnswer} ${allOutputs}`;

    const rejections = this.options.rejectionTriggers ?? ['__FILE_NOT_FOUND__', 'Path escapes workspace', 'Unsafe shell command'];
    const revisions = this.options.revisionTriggers ?? ['__VERIFY_FAIL__', 'error', 'failed', 'exception'];

    const concerns: string[] = [];

    for (const trigger of rejections) {
      if (text.includes(trigger.toLowerCase())) {
        concerns.push(`Rejection trigger matched: "${trigger}"`);
      }
    }
    if (concerns.length > 0) {
      return {
        stepId,
        verdict: 'reject',
        feedback: `Proposal rejected because it contains unsafe or unrecoverable failures. Concerns: ${concerns.join('; ')}`,
        concerns,
      };
    }

    for (const trigger of revisions) {
      if (text.includes(trigger.toLowerCase())) {
        concerns.push(`Revision trigger matched: "${trigger}"`);
      }
    }

    const minIterations = this.options.minIterations ?? 1;
    if (result.iterations.length < minIterations) {
      concerns.push(`Maker produced only ${result.iterations.length} iteration(s); minimum is ${minIterations}.`);
    }

    if (!result.success) {
      concerns.push('Maker loop did not converge to a successful result.');
    }

    if (concerns.length > 0) {
      return {
        stepId,
        verdict: 'revise',
        feedback: `Proposal needs revision. Concerns: ${concerns.join('; ')}`,
        concerns,
      };
    }

    return {
      stepId,
      verdict: 'approve',
      feedback: `Proposal approved. ${result.iterations.length} iteration(s) produced a successful result.`,
    };
  }
}
