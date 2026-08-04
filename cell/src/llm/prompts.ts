import type { LLMMessage } from './types.js';
import type { Action, Observation, Plan, PlanStep, Thought } from '../types.js';
import type { DecomposedMission } from '../lead.js';

export function buildPlanningPrompt(goal: string, retrievalContext?: string): LLMMessage[] {
  return [
    {
      role: 'system',
      content: `You are a careful planning assistant. Given a goal and optional retrieved context, produce a short JSON plan. The plan must be an array of steps, each with an id, description, optional tool name, and optional input. Do not add extra commentary outside the JSON.`,
    },
    {
      role: 'user',
      content: retrievalContext
        ? `Goal: ${goal}\n\nRelevant context:\n${retrievalContext}\n\nReturn a JSON array of plan steps.`
        : `Goal: ${goal}\n\nReturn a JSON array of plan steps.`,
    },
  ];
}

export function parsePlanResponse(text: string): PlanStep[] {
  const cleaned = text.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed as PlanStep[];
  } catch {
    // Fall through to empty result.
  }
  return [];
}

export function buildReasoningPrompt(
  plan: Plan,
  priorThought: Thought | undefined,
  priorObservation: Observation | undefined,
  accumulatedTask: string,
  retrievalContext?: string
): LLMMessage[] {
  return [
    {
      role: 'system',
      content: `You are a careful reasoning assistant. Given a plan, the previous thought and observation, and retrieved context, decide the next action. Return a JSON object with "text": your reasoning, and "action": { "stepId": string, "tool": string, "input": string }. Do not add extra commentary outside the JSON.`,
    },
    {
      role: 'user',
      content: `Plan: ${JSON.stringify(plan)}\nPrevious thought: ${priorThought ? JSON.stringify(priorThought) : 'none'}\nPrevious observation: ${priorObservation ? JSON.stringify(priorObservation) : 'none'}\nAccumulated task context: ${accumulatedTask}${retrievalContext ? `\nRelevant context: ${retrievalContext}` : ''}`,
    },
  ];
}

export function parseReasoningResponse(text: string): { text: string; action: Action } | undefined {
  const cleaned = text.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed.action && parsed.text) {
      return { text: String(parsed.text), action: parsed.action as Action };
    }
  } catch {
    // Fall through to undefined.
  }
  return undefined;
}

export function buildDecompositionPrompt(goal: string): LLMMessage[] {
  return [
    {
      role: 'system',
      content: `You are a software architect. Given a high-level goal, decompose it into 1-4 parallel missions. Return a JSON array of missions, each with "id", "title", "description", and optional "dependsOn" array of ids. Keep missions small and testable. Do not add extra commentary outside the JSON.`,
    },
    {
      role: 'user',
      content: `Goal: ${goal}\n\nReturn a JSON array of missions.`,
    },
  ];
}

export function parseDecompositionResponse(text: string): DecomposedMission[] | undefined {
  const cleaned = text.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed as DecomposedMission[];
  } catch {
    // Fall through to undefined.
  }
  return undefined;
}
