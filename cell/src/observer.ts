import type { Action, Observation } from './types.js';

export interface ObserverOptions {
  /** Treat output containing this substring as a failure. */
  failureMarkers?: string[];
}

export class Observer {
  constructor(private readonly options: ObserverOptions = {}) {}

  observe(action: Action, output: string): Observation {
    const failureMarkers = this.options.failureMarkers ?? ['error', 'failed', 'exception'];
    const lower = output.toLowerCase();
    const hasFailureMarker = failureMarkers.some((marker) => lower.includes(marker.toLowerCase()));
    const empty = output.trim().length === 0;

    return {
      stepId: action.stepId,
      output,
      success: !hasFailureMarker && !empty,
      note: hasFailureMarker
        ? `Output contained failure marker: ${failureMarkers.find((m) => lower.includes(m.toLowerCase()))}`
        : empty
          ? 'Output was empty'
          : 'Observation recorded',
    };
  }
}
