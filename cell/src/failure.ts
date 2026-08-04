export interface ClassifiedFailure {
  kind: string;
  recovery: 'retry' | 'retry-different-specialist' | 'escalate' | 'skip';
  reason: string;
}

export interface FailureClassifierOptions {
  /** Additional rules appended after the built-in defaults. */
  rules?: Array<{
    substring: string;
    kind: string;
    recovery: ClassifiedFailure['recovery'];
    reason: string;
  }>;
}

export class FailureClassifier {
  private rules: NonNullable<FailureClassifierOptions['rules']>;

  constructor(private readonly options: FailureClassifierOptions = {}) {
    this.rules = [
      { substring: 'ENOENT', kind: 'env', recovery: 'escalate', reason: 'Missing file or dependency in the environment.' },
      { substring: 'EACCES', kind: 'env', recovery: 'escalate', reason: 'Permission denied; environment configuration issue.' },
      { substring: 'module not found', kind: 'env', recovery: 'escalate', reason: 'Missing module; cannot be fixed by retrying.' },
      { substring: 'timed out', kind: 'timeout', recovery: 'retry', reason: 'Transient timeout; may succeed on retry.' },
      { substring: 'TIMEOUT', kind: 'timeout', recovery: 'retry', reason: 'Verification timed out; retry may succeed.' },
      { substring: 'merge conflict', kind: 'conflict', recovery: 'retry-different-specialist', reason: 'Parallel work collided; try a different decomposition.' },
      { substring: 'Conflicts with earlier merged work', kind: 'conflict', recovery: 'retry-different-specialist', reason: 'Coordinator rejected due to overlap.' },
      { substring: 'Old text not found', kind: 'edit', recovery: 'retry', reason: 'Edit target changed; may succeed after refresh.' },
      { substring: 'SyntaxError', kind: 'code', recovery: 'escalate', reason: 'Code produced by the agent is invalid.' },
      { substring: 'Type error', kind: 'code', recovery: 'escalate', reason: 'Type check failed; code is semantically wrong.' },
      { substring: 'test failed', kind: 'test', recovery: 'escalate', reason: 'Tests fail; needs human review or new implementation.' },
      { substring: 'verification failed', kind: 'verify', recovery: 'retry', reason: 'Verification gate failed; may be transient.' },
      ...(options.rules ?? []),
    ];
  }

  classify(text: string, source = 'cell'): ClassifiedFailure {
    const lower = text.toLowerCase();
    for (const rule of this.rules) {
      if (lower.includes(rule.substring.toLowerCase())) {
        return { kind: rule.kind, recovery: rule.recovery, reason: rule.reason };
      }
    }
    return {
      kind: 'unknown',
      recovery: 'retry',
      reason: `No specific pattern matched in ${source}; retry once and escalate if it repeats.`,
    };
  }
}
