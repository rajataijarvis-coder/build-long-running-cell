import type { Plan, Action, Observation, Tool, VerificationSummary } from './types.js';
import { Planner } from './planner.js';
import { Actor, ShellTool } from './actor.js';
import { Observer } from './observer.js';
import { runVerificationSuite } from './verify.js';

export interface LoopIteration {
  step: number;
  plan: Plan;
  action: Action;
  observation: Observation;
  verification: VerificationSummary;
  passed: boolean;
}

export interface LoopResult {
  missionId: string;
  iterations: LoopIteration[];
  finalAnswer: string;
  success: boolean;
}

/**
 * Composes Planner → Actor → Observer → Verifier into one reasoning loop.
 *
 * Each iteration produces a Plan, executes one Action, observes the result,
 * and runs the verification suite. If verification passes the loop succeeds.
 * Otherwise it retries with the previous context until maxIterations.
 */
export class LoopEngine {
  private planner: Planner;
  private actor: Actor;
  private observer: Observer;

  constructor(
    private readonly tools: Tool[],
    private readonly verificationCommands: [string, string[]][],
    private readonly maxIterations = 3,
    private readonly observerOptions?: import('./observer.js').ObserverOptions
  ) {
    this.planner = new Planner({ maxSteps: maxIterations });
    this.actor = new Actor([...tools, new ShellTool()]);
    this.observer = new Observer(observerOptions);
  }

  async run(missionId: string, task: string): Promise<LoopResult> {
    const iterations: LoopIteration[] = [];

    for (let step = 1; step <= this.maxIterations; step++) {
      const plan = await this.planner.plan(missionId, task);
      const action = this.selectAction(plan, step);
      const rawOutput = await this.actor.act(action);
      const observation = this.observer.observe(action, rawOutput);
      const verification = await runVerificationSuite(this.verificationCommands);
      const passed = verification.passed;

      iterations.push({ step, plan, action, observation, verification, passed });

      if (passed) {
        return {
          missionId,
          iterations,
          finalAnswer: observation.output,
          success: true,
        };
      }

      const failed = verification.results.find((r) => !r.passed);
      task += `\nAttempt ${step} failed: ${failed?.stderr ?? 'verification failed'}. Observation: ${observation.note ?? observation.output}`;
    }

    return {
      missionId,
      iterations,
      finalAnswer: iterations.at(-1)?.observation.output ?? '',
      success: false,
    };
  }

  private selectAction(plan: Plan, step: number): Action {
    const planStep = plan.steps[step - 1];
    if (!planStep) {
      return { stepId: `fallback-${step}`, tool: 'shell', input: 'echo Goal understood' };
    }
    return {
      stepId: planStep.id,
      tool: planStep.tool ?? 'shell',
      input: planStep.input ?? 'echo Goal understood',
    };
  }
}
