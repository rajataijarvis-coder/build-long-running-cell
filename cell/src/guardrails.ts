import type { Action, Tool } from './types.js';
import type { Observability } from './observability.js';

/**
 * A safety policy describes a rule, a detector that decides whether an action
 * matches the rule, and the result of applying the rule.
 */
export interface SafetyRule {
  id: string;
  name: string;
  /** detector id used to route the rule to the right detector. */
  detector: string;
  /** Verdict when the detector matches. */
  verdict: 'continue' | 'finish' | 'escalate';
  /** Reason returned to the reflector / reasoner so it can adjust. */
  reason: string;
}

export interface SafetyCheckResult {
  ok: boolean;
  rule?: SafetyRule;
  note: string;
}

export interface GuardrailOptions {
  /** Absolute workspace path the cell is allowed to read or write. */
  workspacePath: string;
  /** Shell commands that are allowed when no explicit allow-list is given. */
  defaultAllowList?: string[];
  /** Extra rules appended after the built-in rules. */
  customRules?: SafetyRule[];
  /** When true, destructive actions must be explicitly approved by name. */
  requireApprovalForDestructive?: boolean;
  /** Set of approved destructive action names / hashes. */
  approvedDestructive?: Set<string>;
  /** Optional observability collector to increment the guardrail-blocks counter. */
  observability?: Observability;
}

/**
 * A lightweight, deterministic guardrail system.
 *
 * It checks:
 * 1. Prompt-injection markers in tool input.
 * 2. Shell command safety (dangerous metacharacters and allow-list).
 * 3. File path traversal outside the workspace.
 * 4. Destructive filesystem operations (delete, rm, truncate, overwrite).
 * 5. Network egress (curl, wget, fetch) unless explicitly allowed.
 *
 * The system is intentionally rule-based and synchronous so it can run
 * before every actor invocation in a long-running cell without adding
 * latency or cost.
 */
export class Guardrails {
  private readonly options: GuardrailOptions;

  constructor(options: GuardrailOptions) {
    this.options = options;
  }

  /**
   * Run every detector against the proposed action. Returns the first
   * blocking rule, or an ok result if nothing blocks.
   */
  check(action: Action): SafetyCheckResult {
    const rules = this.rules();
    for (const rule of rules) {
      const matches = this.detector(rule.detector)(action);
      if (matches) {
        if (this.options.observability) {
          void this.options.observability.increment('guardrailBlocks');
        }
        return {
          ok: false,
          rule,
          note: `${rule.name}: ${rule.reason}`,
        };
      }
    }
    return { ok: true, note: 'Guardrails passed' };
  }

  private rules(): SafetyRule[] {
    return [
      {
        id: 'prompt-injection',
        name: 'Prompt injection marker',
        detector: 'promptInjection',
        verdict: 'escalate',
        reason: 'Input contains prompt-injection markers such as "ignore previous instructions".',
      },
      {
        id: 'shell-unsafe',
        name: 'Unsafe shell command',
        detector: 'shellUnsafe',
        verdict: 'escalate',
        reason: 'Shell command contains dangerous metacharacters or is not on the allow-list.',
      },
      {
        id: 'path-escape',
        name: 'Path traversal',
        detector: 'pathEscape',
        verdict: 'escalate',
        reason: 'File path escapes the workspace directory.',
      },
      {
        id: 'destructive-unapproved',
        name: 'Unapproved destructive action',
        detector: 'destructiveUnapproved',
        verdict: 'escalate',
        reason: 'Destructive action requires explicit approval before it can run.',
      },
      {
        id: 'network-egress',
        name: 'Network egress',
        detector: 'networkEgress',
        verdict: 'escalate',
        reason: 'Action attempts network egress which is not allowed by default.',
      },
      ...(this.options.customRules ?? []),
    ];
  }

  private detector(name: string): (action: Action) => boolean {
    switch (name) {
      case 'promptInjection':
        return this.promptInjection.bind(this);
      case 'shellUnsafe':
        return this.shellUnsafe.bind(this);
      case 'pathEscape':
        return this.pathEscape.bind(this);
      case 'destructiveUnapproved':
        return this.destructiveUnapproved.bind(this);
      case 'networkEgress':
        return this.networkEgress.bind(this);
      default:
        return () => false;
    }
  }

  approve(action: Action): string {
    const key = `${action.tool}:${action.input}`;
    this.options.approvedDestructive = this.options.approvedDestructive ?? new Set<string>();
    this.options.approvedDestructive.add(key);
    return key;
  }

  private promptInjection(action: Action): boolean {
    const input = action.input.toLowerCase();
    const markers = [
      'ignore previous instructions',
      'ignore all previous',
      'disregard your',
      'you are now',
      'new instructions:',
      'system prompt',
      'developer mode',
      'jailbreak',
    ];
    return markers.some((m) => input.includes(m));
  }

  private shellUnsafe(action: Action): boolean {
    if (action.tool !== 'shell') return false;
    const input = action.input.trim();
    const dangerous = /[;|`$(){}[\]\\*?<>~]/;
    if (dangerous.test(input)) return true;
    const allowList = this.options.defaultAllowList;
    if (allowList && allowList.length > 0) {
      const base = input.split(/\s+/)[0];
      if (!allowList.includes(base)) return true;
    }
    return false;
  }

  private pathEscape(action: Action): boolean {
    if (!['read_file', 'edit_file', 'write_file'].includes(action.tool)) return false;
    const firstLine = action.input.split('\n')[0]?.trim() ?? '';
    const normalised = firstLine.replace(/^\//, '');
    if (normalised.split('/').some((part) => part === '..' || part === '.')) return true;
    const absolute = new URL(`file://${this.options.workspacePath.replace(/\\/g, '/')}/${normalised}`).pathname;
    const workspace = new URL(`file://${this.options.workspacePath.replace(/\\/g, '/')}/`).pathname;
    return !absolute.startsWith(workspace);
  }

  private destructiveUnapproved(action: Action): boolean {
    if (!this.options.requireApprovalForDestructive) return false;
    const destructive = ['rm', 'remove', 'delete', 'truncate', 'shred', 'mv', 'cp', 'overwrite'];
    const input = action.input.toLowerCase();
    const isDestructive = destructive.some((d) => input.includes(d)) || action.tool === 'delete_file';
    if (!isDestructive) return false;
    const approvalKey = `${action.tool}:${action.input}`;
    return !this.options.approvedDestructive?.has(approvalKey);
  }

  private networkEgress(action: Action): boolean {
    if (action.tool === 'shell') {
      const input = action.input.trim().toLowerCase();
      return /\b(curl|wget|nc|netcat|python -m http|node -e.*http|fetch\()/.test(input);
    }
    if (action.tool === 'fetch' || action.tool === 'http_request') return true;
    return false;
  }
}

/**
 * A thin wrapper around an existing tool that runs guardrails before the
 * underlying tool executes. If guardrails fail, the wrapper throws a clear
 * error so the observer records it as an unsafe observation.
 */
export class GuardedTool implements Tool {
  name: string;
  description: string;

  constructor(
    private readonly tool: Tool,
    private readonly guardrails: Guardrails
  ) {
    this.name = tool.name;
    this.description = tool.description;
  }

  async execute(input: string): Promise<string> {
    const result = this.guardrails.check({ stepId: 'guarded', tool: this.name, input });
    if (!result.ok) {
      throw new Error(`Guardrails blocked ${this.name}: ${result.note}`);
    }
    return this.tool.execute(input);
  }
}

/**
 * Wrap every tool in a registry with guardrails.
 */
export function guardTools(tools: Tool[], guardrails: Guardrails): Tool[] {
  return tools.map((t) => new GuardedTool(t, guardrails));
}

/**
 * Simple utility: hash a string for approval keys. Not cryptographic; just
 * a stable short identifier.
 */
export function hashAction(action: Action): string {
  let hash = 0;
  const text = `${action.tool}:${action.input}`;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return `${action.tool}:${Math.abs(hash).toString(16)}`;
}
