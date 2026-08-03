import type { Plan, PlanStep, Action, Thought, ReasonerOptions, ToolRegistry, Observation } from './types.js';

/**
 * A deterministic reasoner that turns a plan and the history of observations
 * into the next concrete action. This is the ReAct core: reasoning about what
 * to do, then choosing a concrete tool call.
 *
 * In a production cell this is often an LLM prompt (ReAct style). Here we use
 * explicit rules so the reasoning is inspectable, deterministic, and cheap to
 * test. The interface is the same: given context, produce a Thought containing
 * the selected action.
 */
export class Reasoner {
  constructor(
    private readonly options: ReasonerOptions = {},
    private readonly registry?: ToolRegistry
  ) {}

  reason(
    plan: Plan,
    priorThought: Thought | undefined,
    priorObservation: Observation | undefined,
    context: string
  ): Thought {
    const stepNumber = priorThought ? this.stepIndexFromId(plan, priorThought.stepId) + 2 : 1;
    const step = this.selectStep(plan, stepNumber, priorObservation);
    const tool = this.pickTool(step, priorObservation);

    const thoughtText = this.formulateThought(step, priorObservation, context, tool);
    const action: Action = {
      stepId: step.id,
      tool,
      input: step.input ?? 'echo No-op',
    };

    return {
      stepId: step.id,
      text: thoughtText,
      action,
    };
  }

  private pickTool(step: PlanStep, priorObservation: Observation | undefined): string {
    // If the step already names a tool, use it. This is the explicit ReAct
    // contract: the planner (or a previous reasoner) declared an action.
    if (step.tool) {
      return step.tool;
    }

    // If the previous observation failed and we have a registry, look for a
    // tool whose description matches the failure note. This is the simplest
    // form of tool-aware recovery.
    if (priorObservation && !priorObservation.success && this.registry) {
      const lower = priorObservation.note?.toLowerCase() ?? priorObservation.output.toLowerCase();
      const matching = this.registry.tools.find((t) =>
        lower.includes(t.name.toLowerCase()) || t.description.toLowerCase().includes(lower.split(' ')[0])
      );
      if (matching) return matching.name;
    }

    // Default to the safe shell tool for commands that are not file-oriented.
    return 'shell';
  }

  private selectStep(
    plan: Plan,
    stepNumber: number,
    priorObservation: Observation | undefined
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
    priorObservation: Observation | undefined,
    context: string,
    tool: string
  ): string {
    const registryNote = this.registry
      ? `\nAvailable tools:\n${this.registry.descriptions()}`
      : '';
    const base = `Thought: ${step.description}. I will use ${tool}(${step.input ?? ''}).${registryNote}`;
    if (!priorObservation) return `${base}\nContext: ${context}`;
    return `${base}\nPrevious observation was ${priorObservation.success ? 'successful' : 'unsuccessful'}: ${priorObservation.note ?? priorObservation.output}.`;
  }

  private stepIndexFromId(plan: Plan, stepId: string): number {
    const index = plan.steps.findIndex((s) => s.id === stepId);
    return index === -1 ? -1 : index;
  }
}
