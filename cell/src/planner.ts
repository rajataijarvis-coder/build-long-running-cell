import type { Plan, PlanStep } from './types.js';
import type { LLMProvider } from './llm/types.js';
import { buildPlanningPrompt, parsePlanResponse } from './llm/prompts.js';

export interface PlannerOptions {
  maxSteps?: number;
  llm?: LLMProvider;
}

export class Planner {
  constructor(private readonly options: PlannerOptions = {}) {}

  async plan(missionId: string, goal: string, retrievalContext?: string): Promise<Plan> {
    const maxSteps = this.options.maxSteps ?? 5;

    if (this.options.llm) {
      const prompt = buildPlanningPrompt(goal, retrievalContext);
      const response = await this.options.llm.complete({ messages: prompt, temperature: 0.2 });
      const llmSteps = parsePlanResponse(response.text);
      if (llmSteps.length > 0) {
        return {
          missionId,
          goal,
          steps: llmSteps.slice(0, maxSteps),
          reasoning: `LLM-generated plan from ${response.usage?.totalTokens ?? '?'} tokens.`,
        };
      }
      // Fall through to rule-based plan if the LLM did not return usable JSON.
    }

    const steps: PlanStep[] = [];
    const lower = `${goal} ${retrievalContext ?? ''}`.toLowerCase();

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

    if (steps.length === 0) {
      steps.push({ id: 'step-1', description: 'Understand the goal and report status', tool: 'shell', input: 'echo "Goal understood"' });
    }

    while (steps.length < maxSteps) {
      steps.push({ id: `step-${steps.length + 1}`, description: 'Review progress and decide next move', tool: 'shell', input: 'echo Review' });
    }

    return {
      missionId,
      goal,
      steps: steps.slice(0, maxSteps),
      reasoning: retrievalContext
        ? `Derived ${steps.length} steps from goal keywords and retrieved memory:\n${retrievalContext}`
        : `Derived ${steps.length} steps from goal keywords: ${goal}`,
    };
  }
}
