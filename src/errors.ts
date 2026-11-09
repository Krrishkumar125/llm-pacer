import type { LimitReason } from './types.js';

/** acquire() could not get capacity within maxWaitMs. */
export class PacerTimeoutError extends Error {
  readonly code = 'PACER_TIMEOUT';
  constructor(
    readonly retryAfterMs: number,
    readonly reason: LimitReason | '',
  ) {
    super(`llm-pacer: no capacity within the wait limit (limited by ${reason || 'unknown'}; retry in ~${retryAfterMs} ms)`);
    this.name = 'PacerTimeoutError';
  }
}

/** The request needs more tokens than the whole per-window budget. */
export class PacerRequestTooLargeError extends Error {
  readonly code = 'PACER_TOO_LARGE';
  constructor(
    readonly tokens: number,
    readonly tpm: number,
  ) {
    super(`llm-pacer: request needs ${tokens} tokens but the budget is ${tpm} per window; it can never be admitted`);
    this.name = 'PacerRequestTooLargeError';
  }
}

/** acquire() was cancelled through its AbortSignal. */
export class PacerAbortError extends Error {
  readonly code = 'PACER_ABORTED';
  constructor() {
    super('llm-pacer: acquire aborted');
    this.name = 'PacerAbortError';
  }
}
