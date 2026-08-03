import type { Plan, PlanStep } from './types.js';

export interface PlannerOptions {
  maxSteps?: number;
}

export class Planner {
  constructor(private readonly options: PlannerOptions = {}) {}

  async plan(missionId: string, goal: string): Promise<Plan> {
    const maxSteps = this.options.maxSteps ?? 5;
    const steps: PlanStep[] = [];

    // A lightweight rule-based planner. It looks for keywords in the goal
    // and emits a small ordered plan. In a real cell this would be an LLM
    // prompt; the important part is that the output is a typed Plan.
    const lower = goal.toLowerCase();

    if (lower.includes('verify') || lower.includes('test') || lower.includes('lint')) {
      steps.push({ id: 'step-1', description: 'Run the verification suite', tool: 'shell', input: 'npm run verify' });
    }

    if (lower.includes('read') || lower.includes('inspect') || lower.includes('check')) {
      steps.push({ id: 'step-2', description: 'Read the relevant file', tool: 'read_file', input: 'src/main.ts' });
    }

    if (lower.includes('edit') || lower.includes('fix') || lower.includes('patch')) {
      steps.push({ id: 'step-3', description: 'Edit the relevant file', tool: 'edit_file', input: 'src/main.ts\nOLD\nNEW' });
    }

    if (lower.includes('create') || lower.includes('new file') || lower.includes('write')) {
      steps.push({ id: 'step-4', description: 'Create or write the relevant file', tool: 'shell', input: 'echo Create file' });
    }

    // Always end with a review step if nothing else matched.
    if (steps.length === 0) {
      steps.push({ id: 'step-1', description: 'Understand the goal and report status', tool: 'shell', input: 'echo "Goal understood"' });
    }

    // Pad with no-op review steps up to maxSteps so the shape is consistent.
    while (steps.length < maxSteps) {
      steps.push({ id: `step-${steps.length + 1}`, description: 'Review progress and decide next move', tool: 'shell', input: 'echo Review' });
    }

    return {
      missionId,
      goal,
      steps: steps.slice(0, maxSteps),
      reasoning: `Derived ${steps.length} steps from goal keywords: ${goal}`,
    };
  }
}
