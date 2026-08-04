import { CellRunner, type RunnerResult } from './runner.js';
import { FailureMemory } from './git-memory.js';
import type { Mission, Tool } from './types.js';
import type { Reasoner } from './reasoner.js';
import type { Reflector } from './reflector.js';

/**
 * The kind of specialist cell determines which default tools and verification
 * gate the runner receives. Kinds are deliberately high-level so the lead
 * engineer can reason about "who should do this work" without knowing the
 * exact tool implementation.
 */
export type SpecialistKind = 'coder' | 'docs' | 'tester' | 'api' | 'reviewer';

export interface SpecialistOptions {
  kind: SpecialistKind;
  name: string;
  basePath: string;
  /** Optional override of the default verification gate for this kind. */
  verificationCommands?: [string, string[]][];
  /** Optional override of the default tool set for this kind. */
  tools?: Tool[];
  maxRetries?: number;
  reasoner?: Reasoner;
  reflector?: Reflector;
  /** Optional failure memory for recording classified failures. */
  failureMemory?: FailureMemory;
}

export interface SpecialistProfile {
  kind: SpecialistKind;
  description: string;
  /** Verification gate tuned for this specialist. */
  verificationCommands: [string, string[]][];
  /** Extra tools beyond the runner's default read/edit/verify set. */
  extraTools: Tool[];
}

/**
 * A specialist cell is a configured `CellRunner` wrapper.
 *
 * The specialist does not implement new execution logic. Instead it decides:
 * - which verification gate is relevant for the mission kind,
 * - which extra tools the runner should have access to,
 * - how verbose retry policy should be.
 *
 * This keeps the execution engine (`CellRunner`) single-purpose while still
 * letting the fleet specialise per mission.
 */
export class Specialist {
  private runner: CellRunner;
  private kind: SpecialistKind;

  constructor(private readonly options: SpecialistOptions) {
    const profile = Specialist.profile(options.kind);
    this.kind = options.kind;
    this.runner = new CellRunner({
      name: options.name,
      basePath: options.basePath,
      verificationCommands: options.verificationCommands ?? profile.verificationCommands,
      maxRetries: options.maxRetries,
      tools: [...(options.tools ?? []), ...profile.extraTools],
      reasoner: options.reasoner,
      reflector: options.reflector,
      failureMemory: options.failureMemory,
    });
  }

  /**
   * Return the default profile for a specialist kind. Profiles can be
   * extended later without changing the `CellRunner` contract.
   */
  static profile(kind: SpecialistKind): SpecialistProfile {
    const baseVerify: [string, string[]] = ['node', ['-e', 'process.exit(0)']];

    switch (kind) {
      case 'docs':
        return {
          kind,
          description: 'Documentation specialist: updates README and markdown files.',
          verificationCommands: [
            ['node', ['-e', "require('fs').existsSync('README.md') || process.exit(1)"]],
          ],
          extraTools: [],
        };
      case 'tester':
        return {
          kind,
          description: 'Testing specialist: adds and runs tests for the changed code.',
          verificationCommands: [
            ['npm', ['test']],
          ],
          extraTools: [],
        };
      case 'api':
        return {
          kind,
          description: 'API specialist: adds HTTP endpoints and frontend panels.',
          verificationCommands: [
            ['npm', ['run', 'build']],
            ['node', ['-e', "require('fs').existsSync('package.json') || process.exit(1)"]],
          ],
          extraTools: [],
        };
      case 'reviewer':
        return {
          kind,
          description: 'Review specialist: reads changes and reports on quality and conflicts.',
          verificationCommands: [baseVerify],
          extraTools: [],
        };
      case 'coder':
      default:
        return {
          kind,
          description: 'Coding specialist: implements focused modules with tests.',
          verificationCommands: [
            ['npm', ['run', 'lint']],
            ['npm', ['run', 'build']],
            ['npm', ['test']],
          ],
          extraTools: [],
        };
    }
  }

  get kindName(): SpecialistKind {
    return this.kind;
  }

  async run(mission: Mission): Promise<RunnerResult> {
    return this.runner.run(mission);
  }

  async remove(): Promise<void> {
    await this.runner.remove();
  }
}

/**
 * Map a free-text mission title to a specialist kind.
 *
 * The heuristic is intentionally simple: the lead engineer already broke the
 * goal down by keyword, so titles contain strong hints. A more advanced system
 * could use an LLM or embedding classifier; this function keeps the decision
 * deterministic and testable.
 */
export function kindForMission(title: string): SpecialistKind {
  const lower = title.toLowerCase();
  if (lower.includes('readme') || lower.includes('doc')) return 'docs';
  if (lower.includes('test') || lower.includes('verify')) return 'tester';
  if (lower.includes('api') || lower.includes('endpoint') || lower.includes('route')) return 'api';
  if (lower.includes('review') || lower.includes('check')) return 'reviewer';
  return 'coder';
}
