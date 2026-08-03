import type { Plan, PlanStep, Action, Thought, ReasonerOptions } from './types.js';

/**
 * A deterministic reasoner that turns a plan and the history of observations
 * into the next concrete action.
 *
 * In a production cell this is often an LLM prompt (ReAct style). Here we use
 * explicit rules so the reasoning is inspectable, deterministic, and cheap to
 * test. The interface is the same: given context, produce a Thought containing
 * the selected action.
 */
export class Reasoner {
  constructor(private readonly options: ReasonerOptions = {}) {}

  reason(
    plan: Plan,
    priorThought: Thought | undefined,
    priorObservation: import('./types.js').Observation | undefined,
    context: string
  ): Thought {
    const stepNumber = priorThought ? this.stepIndexFromId(plan, priorThought.stepId) + 2 : 1;
    const step = this.selectStep(plan, stepNumber, priorObservation);

    const thoughtText = this.formulateThought(step, priorObservation, context);
    const action: Action = {
      stepId: step.id,
      tool: step.tool ?? 'shell',
      input: step.input ?? 'echo No-op',
    };

    return {
      stepId: step.id,
      text: thoughtText,
      action,
    };
  }

  private selectStep(
    plan: Plan,
    stepNumber: number,
    priorObservation: import('./types.js').Observation | undefined
  ): PlanStep {
    // If the previous observation failed, retry the same step with a
    // clarified input so the cell does not blindly march forward.
    if (priorObservation && !priorObservation.success && priorObservation.stepId) {
      const failedStep = plan.steps.find((s) => s.id === priorObservation.stepId);
      if (failedStep) {
        return {
          ...failedStep,
          input: `${failedStep.input ?? ''} (retry after: ${priorObservation.note ?? 'failure'})`,
        };
      }
    }

    // Otherwise move to the next step in the plan, falling back to a review
    // step if we have moved past the end.
    return plan.steps[stepNumber - 1] ?? {
      id: `review-${stepNumber}`,
      description: 'Review progress and decide next move',
      tool: 'shell',
      input: 'echo Reviewing progress',
    };
  }

  private formulateThought(
    step: PlanStep,
    priorObservation: import('./types.js').Observation | undefined,
    context: string
  ): string {
    const base = `Thought: ${step.description}. I will use ${step.tool ?? 'shell'}(${step.input ?? ''}).`;
    if (!priorObservation) return `${base} Context: ${context}`;
    return `${base} Previous observation was ${priorObservation.success ? 'successful' : 'unsuccessful'}: ${priorObservation.note ?? priorObservation.output}.`;
  }

  private stepIndexFromId(plan: Plan, stepId: string): number {
    const index = plan.steps.findIndex((s) => s.id === stepId);
    return index === -1 ? -1 : index;
  }
}
