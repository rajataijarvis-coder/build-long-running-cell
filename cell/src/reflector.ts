import type { Observation, Reflection, VerificationSummary, ReflectorOptions } from './types.js';

/**
 * The reflector decides what to do after an observation.
 *
 * It is the smallest possible critic: it looks at the verification summary
 * (the real ground truth), the observation produced by the actor, and the
 * remaining budget, then returns a verdict.
 *
 * - finish: verification passed, the loop can stop.
 * - continue: verification failed but attempts remain and the failure looks
 *             recoverable; retry with adjusted context.
 * - escalate: verification failed and we are out of budget, or the failure is
 *             unrecoverable (e.g. the tool itself could not run).
 */
export class Reflector {
  constructor(private readonly options: ReflectorOptions = {}) {}

  reflect(
    observation: Observation,
    verification: VerificationSummary,
    attempt: number
  ): Reflection {
    const maxAttempts = this.options.maxAttempts ?? 3;
    const stepId = observation.stepId;
    const text = `${observation.output} ${observation.note ?? ''}`;

    // A failure-kind override lets the cell treat different failure modes
    // differently. For example, a missing file (ENOENT) is unlikely to be
    // fixed by retrying the same command, while a timeout may be transient.
    const kinds = this.options.failureKinds ?? [];
    for (const kind of kinds) {
      if (text.toLowerCase().includes(kind.substring.toLowerCase())) {
        return {
          stepId,
          verdict: kind.verdict,
          note: `${kind.reason} (matched "${kind.substring}")`,
          shouldRetry: kind.verdict === 'continue',
        };
      }
    }

    if (verification.passed) {
      return {
        stepId,
        verdict: 'finish',
        note: 'Verification passed. No need to retry.',
        shouldRetry: false,
      };
    }

    // If the observation itself says the action failed (e.g. empty output or
    // a failure marker), and we are on the last attempt, escalate rather than
    // retrying blindly.
    if (!observation.success && attempt >= maxAttempts) {
      return {
        stepId,
        verdict: 'escalate',
        note: `Action failed and budget exhausted (${attempt}/${maxAttempts}): ${observation.note ?? observation.output}`,
        shouldRetry: false,
      };
    }

    if (attempt >= maxAttempts) {
      return {
        stepId,
        verdict: 'escalate',
        note: `Verification failed after ${attempt} attempts. Escalating to human.`,
        shouldRetry: false,
      };
    }

    return {
      stepId,
      verdict: 'continue',
      note: `Verification failed; retrying (${attempt}/${maxAttempts}). Observation: ${observation.note ?? observation.output}`,
      shouldRetry: true,
    };
  }
}
