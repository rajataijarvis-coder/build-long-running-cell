import { Coordinator, type CoordinationResult } from './coordinator.js';
import type { Mission, Tool, LeadRun } from './types.js';
import type { Reasoner } from './reasoner.js';
import type { Reflector } from './reflector.js';
import { GitMemory } from './git-memory.js';

export interface LeadEngineerOptions {
  basePath: string;
  verificationCommands: [string, string[]][];
  maxConcurrency?: number;
  maxRetries?: number;
  maxSubMissions?: number;
  tools?: Tool[];
  reasoner?: Reasoner;
  reflector?: Reflector;
  /** Whether to run each decomposed mission through a specialist cell. */
  useSpecialists?: boolean;
  /** Optional durable memory for persisting lead-run summaries. */
  memory?: GitMemory;
}

export interface DecomposedMission {
  id: string;
  title: string;
  description: string;
  dependsOn?: string[];
}

export interface LeadResult {
  goal: string;
  missions: DecomposedMission[];
  coordination: CoordinationResult;
}

/**
 * The lead engineer cell decomposes a high-level goal into smaller missions,
 * assigns them to specialist runners, and coordinates their execution.
 *
 * In a production system the decomposition step would be performed by an LLM
 * or a human architect. This implementation uses a deterministic rule-based
 * decomposer so the behavior stays testable and cheap to run. The important
 * architectural property is the same: a single entry point turns one goal into
 * many parallel missions and hands them to the coordinator from Chapter 13.
 */
export class LeadEngineer {
  constructor(private readonly options: LeadEngineerOptions) {}

  /**
   * Decompose a high-level goal into concrete missions.
   *
   * The decomposer looks for keywords that indicate parallel work. For
   * example, a goal that mentions both "README" and "utility module" is split
   * into two missions: one to update documentation and one to add code. Goals
   * that do not match any pattern are returned as a single mission so the
   * coordinator still has something to execute.
   */
  decompose(goal: string): DecomposedMission[] {
    const lower = goal.toLowerCase();
    const missions: DecomposedMission[] = [];
    const max = this.options.maxSubMissions ?? 4;

    if (lower.includes('readme') || lower.includes('docs') || lower.includes('documentation')) {
      missions.push({
        id: `lead-docs-${Date.now()}`,
        title: 'Update documentation',
        description: 'Update README and project documentation to reflect the new changes.',
      });
    }

    if (lower.includes('module') || lower.includes('utility') || lower.includes('helper')) {
      missions.push({
        id: `lead-module-${Date.now() + 1}`,
        title: 'Add utility module',
        description: 'Create a focused utility module under src/ with tests and exports.',
        dependsOn: missions.length > 0 ? [missions[missions.length - 1].id] : undefined,
      });
    }

    if (lower.includes('test') || lower.includes('verify') || lower.includes('lint')) {
      missions.push({
        id: `lead-verify-${Date.now() + 2}`,
        title: 'Verify project',
        description: 'Run the full verification gate: lint, build, and tests.',
      });
    }

    if (lower.includes('api') || lower.includes('endpoint') || lower.includes('route')) {
      missions.push({
        id: `lead-api-${Date.now() + 3}`,
        title: 'Add API endpoint',
        description: 'Add a new HTTP endpoint and a frontend panel to expose the feature.',
      });
    }

    if (missions.length === 0) {
      missions.push({
        id: `lead-${Date.now()}`,
        title: goal,
        description: goal,
      });
    }

    return missions.slice(0, max);
  }

  /**
   * Run the lead engineer pipeline: decompose the goal, convert the
   * decomposed missions into full Mission objects, and coordinate them
   * through isolated worktrees.
   */
  async execute(goal: string): Promise<LeadResult> {
    const decomposed = this.decompose(goal);
    const now = new Date().toISOString();

    const missions: Mission[] = decomposed.map((m) => ({
      id: m.id,
      title: m.title,
      description: m.description,
      status: 'backlog',
      priority: 1,
      createdAt: now,
      updatedAt: now,
    }));

    const coordinator = new Coordinator({
      basePath: this.options.basePath,
      verificationCommands: this.options.verificationCommands,
      maxConcurrency: this.options.maxConcurrency ?? 2,
      maxRetries: this.options.maxRetries ?? 2,
      tools: this.options.tools,
      reasoner: this.options.reasoner,
      reflector: this.options.reflector,
      useSpecialists: this.options.useSpecialists ?? false,
    });

    const coordination = await coordinator.coordinate(missions);

    if (this.options.memory) {
      const run: LeadRun = {
        id: `lead-run-${Date.now()}`,
        goal,
        timestamp: now,
        missionIds: missions.map((m) => m.id),
        merged: coordination.merged,
        rejected: coordination.rejected.map((r) => `${r.missionId}: ${r.reason}`),
        failed: coordination.failed.map((f) => f.missionId),
      };
      await this.options.memory.recordLeadRun(run);
    }

    return {
      goal,
      missions: decomposed,
      coordination,
    };
  }
}
