import type { AgentResult, SubAgent, Tool } from './types.js';
import { LoopEngine } from './loop-engine.js';
import { Checker } from './checker.js';

export interface MakerSubAgentOptions {
  tools?: Tool[];
  verificationCommands?: [string, string[]][];
  maxIterations?: number;
}

/**
 * A maker subagent runs the reasoning loop to produce a proposal.
 *
 * It is a thin wrapper around `LoopEngine`. Its job is to convert a task into
 * an artifact (usually a diff or file change) plus the reasoning that produced
 * it. The maker is optimistic: it tries to make progress until verification
 * passes or the iteration budget is exhausted.
 */
export class MakerSubAgent implements SubAgent {
  readonly name = 'maker';
  readonly role = 'maker' as const;
  private engine: LoopEngine;

  constructor(options: MakerSubAgentOptions = {}) {
    this.engine = new LoopEngine(
      options.tools ?? [],
      options.verificationCommands ?? [['node', ['-e', 'process.exit(0)']]],
      options.maxIterations ?? 3
    );
  }

  async run(input: string, context: Record<string, unknown>): Promise<AgentResult> {
    const missionId = String(context.missionId ?? 'maker-run');
    const result = await this.engine.run(missionId, input);

    // The artifact is the sequence of actions the maker took. A production
    // maker might produce a real git diff; here we capture the iteration
    // summary so the checker has something concrete to critique.
    const artifact = result.iterations
      .map((i) => `[${i.step}] ${i.thought?.text ?? 'no thought'} → ${i.action.tool}(${i.action.input}) → ${i.observation.output}`)
      .join('\n');

    return {
      success: result.success,
      output: result.finalAnswer,
      artifact,
      reasoning: `Proposed after ${result.iterations.length} iteration(s). Success=${result.success}.`,
      loopResult: result as unknown as Record<string, unknown>,
    };
  }
}

export interface CheckerSubAgentOptions {
  revisionTriggers?: string[];
  rejectionTriggers?: string[];
  minIterations?: number;
}

/**
 * A checker subagent reviews a maker's proposal.
 *
 * It is a thin wrapper around `Checker`. It receives the maker result (as
 * the `context`) and returns a structured review. The checker is pessimistic:
 * its job is to find reasons to send the proposal back for revision.
 */
export class CheckerSubAgent implements SubAgent {
  readonly name = 'checker';
  readonly role = 'checker' as const;
  private checker: Checker;

  constructor(options: CheckerSubAgentOptions = {}) {
    this.checker = new Checker(options);
  }

  async run(_input: string, context: Record<string, unknown>): Promise<AgentResult> {
    const result = context.makerResult as import('./loop-engine.js').LoopResult | undefined;
    if (!result) {
      return {
        success: false,
        output: 'No maker result supplied for review.',
      };
    }

    const review = this.checker.review(result.missionId, result);
    return {
      success: review.verdict === 'approve',
      output: review.feedback,
      reasoning: `Checker returned ${review.verdict}.`,
      artifact: JSON.stringify(review),
    };
  }
}
