export interface PacerLimits {
  /** Requests allowed per window (default window: one minute). */
  rpm?: number;
  /** Tokens allowed per window (prompt + completion). */
  tpm?: number;
  /**
   * Input tokens allowed per window (Anthropic ITPM, Gemini TPM). Count what the provider counts:
   * for Anthropic that is uncached input plus cache writes; cache reads are free.
   */
  itpm?: number;
  /** Output tokens allowed per window (Anthropic OTPM). */
  otpm?: number;
  /** Requests allowed per day. */
  rpd?: number;
  /** Maximum calls in flight at once across every process. */
  concurrency?: number;
}

export type StoreOp = 'acquire' | 'settle' | 'observe' | 'penalize' | 'peek' | 'reset';

export interface StoreConfig {
  rpm: number;
  tpm: number;
  rpd: number;
  concurrency: number;
  windowMs: number;
  itpm: number;
  otpm: number;
}

export interface StoreReply {
  /** 1 = done, 0 = must wait, -1 = request can never fit. */
  ok: 1 | 0 | -1;
  waitMs: number;
  requestsLeft: number;
  tokensLeft: number;
  dailyLeft: number;
  inflight: number;
  reason: LimitReason | '';
  inputTokensLeft: number;
  outputTokensLeft: number;
}

export type LimitReason = 'rpm' | 'tpm' | 'itpm' | 'otpm' | 'rpd' | 'concurrency' | 'penalty' | 'too_large';

/** A backend that applies pacer operations atomically. */
export interface PacerStore {
  exec(key: string, cfg: StoreConfig, op: StoreOp, args: Array<string | number>): Promise<StoreReply>;
}
