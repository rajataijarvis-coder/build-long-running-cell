import type { Plan, Thought, Observation, Tool, ToolRegistry, VerificationSummary, Reflection } from './types.js';
import { Planner } from './planner.js';
import { Actor } from './actor.js';
import { Observer } from './observer.js';
import { Reasoner } from './reasoner.js';
import { Reflector } from './reflector.js';
import { runVerificationSuite } from './verify.js';
import { ShellTool, ToolRegistryImpl } from './tools.js';

export interface LoopIteration {
  step: number;
  plan: Plan;
  thought?: Thought;
  action: import('./types.js').Action;
  observation: Observation;
  reflection?: Reflection;
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
 * Composes Planner → Reasoner → Actor → Observer → Reflector → Verifier into
 * one reasoning loop.
 *
 * Each iteration produces a Plan, reasons about the next action, executes it,
 * observes the result, reflects on whether to continue, and runs verification.
 * If verification passes the loop succeeds; otherwise it retries with the
 * accumulated context until the budget is exhausted.
 */
export class LoopEngine {
  private planner: Planner;
  private actor: Actor;
  private observer: Observer;
  private reasoner: Reasoner;
  private reflector: Reflector;
  private registry: ToolRegistry;

  constructor(
    private readonly tools: Tool[],
    private readonly verificationCommands: [string, string[]][],
    private readonly maxIterations = 3,
    private readonly observerOptions?: import('./observer.js').ObserverOptions,
    reasoner?: Reasoner,
    reflector?: Reflector,
    registry?: ToolRegistry
  ) {
    this.registry = registry ?? new ToolRegistryImpl([...tools, new ShellTool()]);
    this.planner = new Planner({ maxSteps: maxIterations });
    this.actor = new Actor(this.registry);
    this.observer = new Observer(observerOptions);
    this.reasoner = reasoner ?? new Reasoner({ maxSteps: maxIterations }, this.registry);
    this.reflector = reflector ?? new Reflector({ maxAttempts: maxIterations });
  }

  /**
   * Run the reasoning loop. If a checkpoint is supplied the loop resumes
   * from the saved prior thought and observation so a cell restart does not
   * lose its place mid-mission. The checkpoint also carries the accumulated
   * task context so retries continue with the same growing prompt.
   *
   * The optional `onCheckpoint` callback is invoked after every non-finish
   * iteration with the latest reasoning context. This lets the durable outer
   * cell save the inner loop's state after each attempt, so a crash during a
   * long retry sequence resumes from the exact thought that was in progress
   * rather than restarting the entire executing phase.
   */
  async run(
    missionId: string,
    task: string,
    checkpoint?: {
      priorThought?: Thought;
      priorObservation?: Observation;
      attempt: number;
      accumulatedTask?: string;
    },
    onCheckpoint?: (checkpoint: {
      priorThought?: Thought;
      priorObservation?: Observation;
      attempt: number;
      accumulatedTask: string;
    }) => Promise<void> | void,
    retrievalContext?: string
  ): Promise<
    LoopResult & {
      checkpoint?: {
        priorThought?: Thought;
        priorObservation?: Observation;
        attempt: number;
        accumulatedTask: string;
      };
    }
  > {
    const iterations: LoopIteration[] = [];
    let priorThought: Thought | undefined = checkpoint?.priorThought;
    let priorObservation: Observation | undefined = checkpoint?.priorObservation;
    let attempt = checkpoint?.attempt ?? 0;
    let accumulatedTask = checkpoint?.accumulatedTask ?? task;

    for (let step = attempt + 1; step <= this.maxIterations; step++) {
      attempt = step;
      const plan = await this.planner.plan(missionId, accumulatedTask, retrievalContext);
      const thought = this.reasoner.reason(plan, priorThought, priorObservation, accumulatedTask, retrievalContext);
      const action = thought.action;
      const rawOutput = await this.actor.act(action);
      const observation = this.observer.observe(action, rawOutput);
      const verification = await runVerificationSuite(this.verificationCommands);
      const reflection = this.reflector.reflect(observation, verification, step);
      const passed = verification.passed && reflection.verdict !== 'escalate';

      iterations.push({ step, plan, thought, action, observation, reflection, verification, passed });

      if (verification.passed && reflection.verdict === 'finish') {
        return {
          missionId,
          iterations,
          finalAnswer: observation.output,
          success: true,
        };
      }

      // Persist the inner-loop checkpoint after every non-finish iteration.
      // The callback lets the outer cell save reasoningContext to durable
      // memory so a restart can resume mid-mission.
      const currentCheckpoint = {
        priorThought: thought,
        priorObservation: observation,
        attempt: step,
        accumulatedTask,
      };
      if (onCheckpoint) {
        await onCheckpoint(currentCheckpoint);
      }

      if (reflection.verdict === 'escalate') {
        return {
          missionId,
          iterations,
          finalAnswer: observation.output,
          success: false,
          checkpoint: currentCheckpoint,
        };
      }

      // Build richer context for the next attempt.
      const failed = verification.results.find((r) => !r.passed);
      accumulatedTask += `\nAttempt ${step} failed: ${failed?.stderr ?? 'verification failed'}. Observation: ${observation.note ?? observation.output}. Reflection: ${reflection.note}`;
      priorThought = thought;
      priorObservation = observation;
    }

    return {
      missionId,
      iterations,
      finalAnswer: iterations.at(-1)?.observation.output ?? '',
      success: false,
      checkpoint: { priorThought, priorObservation, attempt, accumulatedTask },
    };
  }
}
