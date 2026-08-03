import { runVerificationSuite } from './verify.js';
import type { VerificationResult } from './types.js';

export interface Tool {
  name: string;
  description: string;
  execute: (input: string) => Promise<string>;
}

export interface LoopIteration {
  step: number;
  thought: string;
  action: string;
  observation: string;
  reflection: string;
  verification: VerificationResult[];
  passed: boolean;
}

export interface LoopResult {
  missionId: string;
  iterations: LoopIteration[];
  finalAnswer: string;
  success: boolean;
}

/**
 * A lightweight reasoning-loop engine.
 *
 * Each mission is decomposed into plan → act → observe → reflect → verify.
 * If verification fails, the loop reflects again and retries with a new plan,
 * up to maxIterations.
 */
export class LoopEngine {
  constructor(
    private readonly tools: Tool[],
    private readonly verificationCommands: [string, string[]][],
    private readonly maxIterations = 3
  ) {}

  async run(missionId: string, task: string): Promise<LoopResult> {
    const iterations: LoopIteration[] = [];
    let context = `Task: ${task}`;

    for (let step = 1; step <= this.maxIterations; step++) {
      const thought = this.plan(context);
      const action = this.chooseAction(thought);
      const observation = await this.act(action);
      const reflection = this.reflect(observation, step === this.maxIterations);
      const verification = await runVerificationSuite(this.verificationCommands);
      const passed = verification.every((r) => r.passed);

      iterations.push({ step, thought, action, observation, reflection, verification, passed });

      if (passed) {
        return {
          missionId,
          iterations,
          finalAnswer: observation,
          success: true,
        };
      }

      const failed = verification.find((r) => !r.passed);
      context += `\nAttempt ${step} failed: ${failed?.stderr ?? 'verification failed'}. Reflection: ${reflection}`;
    }

    return {
      missionId,
      iterations,
      finalAnswer: iterations.at(-1)?.observation ?? '',
      success: false,
    };
  }

  private plan(context: string): string {
    return `Plan: break the task into small verifiable steps. Context: ${context}`;
  }

  private chooseAction(thought: string): string {
    const available = this.tools.map((t) => t.name).join(', ') || 'none';
    return `Action: use the best available tool (${available}) based on: ${thought}`;
  }

  private async act(action: string): Promise<string> {
    // In a real cell this would call an LLM or a tool. We simulate deterministic behavior
    // by trying each registered tool and returning the first non-empty result.
    for (const tool of this.tools) {
      const result = await tool.execute(action);
      if (result) return `Tool ${tool.name}: ${result}`;
    }
    return 'No tool produced output';
  }

  private reflect(observation: string, isLastAttempt: boolean): string {
    if (isLastAttempt) {
      return `Reflection: exhausted retries. Last observation: ${observation}`;
    }
    return `Reflection: ${observation} did not pass verification; adjust the plan and retry.`;
  }
}
