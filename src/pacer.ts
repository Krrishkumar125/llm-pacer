import { randomUUID } from 'node:crypto';
import { classifyLlmError } from './classify.js';
import { PacerAbortError, PacerRequestTooLargeError, PacerTimeoutError } from './errors.js';
import { parseRateLimitHeaders, type HeaderSource, type RateLimitInfo } from './headers.js';
import { MemoryStore } from './stores/memory.js';
import { RedisStore, type RedisLike } from './stores/redis.js';
import type { LimitReason, PacerLimits, PacerStore, StoreConfig, StoreReply } from './types.js';

export interface PacerOptions {
  /** Budget name, e.g. "openai:gpt-4o-mini". Every process using the same name shares one budget. */
  name: string;
  limits: PacerLimits;
  /** ioredis or node-redis client. Omit (and omit store) for an in-process memory budget. */
  redis?: RedisLike;
  /** Custom store. Overrides `redis`. */
  store?: PacerStore;
  /** Key prefix in Redis. Default "llm-pacer:". */
  prefix?: string;
  /** Window for rpm and tpm in ms. Default 60000. */
  windowMs?: number;
  /** A lease that is never settled frees its concurrency slot after this long. Default 120000. */
  leaseTtlMs?: number;
  /** Default maximum time acquire() waits. Default 60000. */
  maxWaitMs?: number;
  /** Random extra wait (0..jitterMs) added to each sleep so waiters do not wake in lockstep. Default 50. */
  jitterMs?: number;
}

export interface AcquireOptions {
  /** Estimated tokens for this call (prompt + max output). Default 0. */
  tokens?: number;
  maxWaitMs?: number;
  signal?: AbortSignal;
}

export interface PacerStatus {
  requestsLeft: number;
  tokensLeft: number;
  dailyLeft: number;
  inflight: number;
  /** Ms until a provider-requested pause ends (0 if none). */
  pausedForMs: number;
}

export type TryAcquireResult =
  | { ok: true; lease: Lease }
  | { ok: false; retryAfterMs: number; reason: LimitReason | '' };

export interface RunOptions<T> extends AcquireOptions {
  /** Read real token usage from the result to correct the budget. */
  usage?: (result: T) => number | undefined | null;
  /** Read response headers from the result to sync with the provider. */
  headers?: (result: T) => HeaderSource | undefined | null;
  /** Retries after a rate-limit or overloaded error. Default 0. */
  retries?: number;
}

export class Lease {
  private done = false;
  constructor(
    private readonly pacer: Pacer,
    readonly id: string,
    readonly tokens: number,
  ) {}

  /** The call finished. Pass the real token usage to refund (or charge) the difference. */
  async settle(actualTokens?: number | null): Promise<void> {
    if (this.done) return;
    this.done = true;
    await this.pacer._settle(this, actualTokens ?? -1, false);
  }

  /** The call failed after it reached the provider. Frees the slot and keeps the estimate charged. */
  async release(): Promise<void> {
    return this.settle();
  }

  /** The call was never sent. Refunds the request and all of its tokens. */
  async cancel(): Promise<void> {
    if (this.done) return;
    this.done = true;
    await this.pacer._settle(this, 0, true);
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new PacerAbortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new PacerAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

function positive(name: string, v: number | undefined): number {
  if (v === undefined) return 0;
  if (!Number.isFinite(v) || v <= 0) throw new RangeError(`llm-pacer: limits.${name} must be a positive number`);
  return v;
}

export class Pacer {
  readonly name: string;
  private readonly store: PacerStore;
  private readonly key: string;
  private readonly cfg: StoreConfig;
  private readonly leaseTtlMs: number;
  private readonly maxWaitMs: number;
  private readonly jitterMs: number;

  constructor(opts: PacerOptions) {
    if (!opts?.name) throw new TypeError('llm-pacer: name is required');
    const l = opts.limits ?? {};
    this.cfg = {
      rpm: positive('rpm', l.rpm),
      tpm: positive('tpm', l.tpm),
      rpd: positive('rpd', l.rpd),
      concurrency: positive('concurrency', l.concurrency),
      windowMs: opts.windowMs ?? 60_000,
    };
    if (!this.cfg.rpm && !this.cfg.tpm && !this.cfg.rpd && !this.cfg.concurrency) {
      throw new RangeError('llm-pacer: set at least one of limits.rpm, tpm, rpd or concurrency');
    }
    this.name = opts.name;
    this.store = opts.store ?? (opts.redis ? new RedisStore(opts.redis) : new MemoryStore());
    // The braces are a Redis Cluster hash tag: both keys land in one slot.
    this.key = `${opts.prefix ?? 'llm-pacer:'}{${opts.name}}`;
    this.leaseTtlMs = opts.leaseTtlMs ?? 120_000;
    this.maxWaitMs = opts.maxWaitMs ?? 60_000;
    this.jitterMs = opts.jitterMs ?? 50;
  }

  /** Try once. Never waits. */
  async tryAcquire(opts: Omit<AcquireOptions, 'maxWaitMs' | 'signal'> = {}): Promise<TryAcquireResult> {
    const tokens = Math.max(0, Math.ceil(opts.tokens ?? 0));
    const id = randomUUID();
    const r = await this.store.exec(this.key, this.cfg, 'acquire', [tokens, id, this.leaseTtlMs]);
    if (r.ok === -1) throw new PacerRequestTooLargeError(tokens, this.cfg.tpm);
    if (r.ok === 1) return { ok: true, lease: new Lease(this, id, tokens) };
    return { ok: false, retryAfterMs: r.waitMs, reason: r.reason };
  }

  /** Wait until the budget admits this call, then return a lease. */
  async acquire(opts: AcquireOptions = {}): Promise<Lease> {
    const maxWait = opts.maxWaitMs ?? this.maxWaitMs;
    const deadline = Date.now() + maxWait;
    for (;;) {
      if (opts.signal?.aborted) throw new PacerAbortError();
      const r = await this.tryAcquire(opts);
      if (r.ok) return r.lease;
      const left = deadline - Date.now();
      if (r.retryAfterMs > left) throw new PacerTimeoutError(r.retryAfterMs, r.reason);
      const jitter = this.jitterMs > 0 ? Math.random() * this.jitterMs : 0;
      await sleep(Math.min(left, r.retryAfterMs + jitter), opts.signal);
    }
  }

  /**
   * acquire → fn → settle, in one call. On a provider rate limit the whole
   * budget pauses for the provider's retry-after, so other workers stop too.
   */
  async run<T>(fn: () => Promise<T>, opts: RunOptions<T> = {}): Promise<T> {
    let attempt = 0;
    for (;;) {
      const lease = await this.acquire(opts);
      let result: T;
      try {
        result = await fn();
      } catch (err) {
        await lease.release();
        const info = classifyLlmError(err);
        if (info.kind === 'rate_limit' || info.kind === 'overloaded') {
          await this.pause(info.retryAfterMs ?? 1000 * 2 ** attempt);
          if (attempt < (opts.retries ?? 0)) {
            attempt++;
            continue;
          }
        }
        throw err;
      }
      const headers = opts.headers?.(result);
      if (headers) await this.observe(headers);
      await lease.settle(opts.usage?.(result) ?? undefined);
      return result;
    }
  }

  /**
   * Sync with the provider's own count. Lowers the local budget when the
   * provider reports fewer requests or tokens left (e.g. another service uses
   * the same API key). Never raises it.
   */
  async observe(headers: HeaderSource | RateLimitInfo): Promise<RateLimitInfo> {
    const info = isInfo(headers) ? headers : parseRateLimitHeaders(headers);
    if (info.remainingRequests !== undefined || info.remainingTokens !== undefined) {
      await this.store.exec(this.key, this.cfg, 'observe', [info.remainingRequests ?? -1, info.remainingTokens ?? -1]);
    }
    return info;
  }

  /** Pause every caller of this budget for `ms` (e.g. after a 429 with retry-after). */
  async pause(ms: number): Promise<void> {
    if (ms > 0) await this.store.exec(this.key, this.cfg, 'penalize', [Math.ceil(ms)]);
  }

  async status(): Promise<PacerStatus> {
    return toStatus(await this.store.exec(this.key, this.cfg, 'peek', []));
  }

  /** Forget all state for this budget (refills it to full). */
  async reset(): Promise<void> {
    await this.store.exec(this.key, this.cfg, 'reset', []);
  }

  /** @internal */
  async _settle(lease: Lease, actual: number, refundRequest: boolean): Promise<void> {
    await this.store.exec(this.key, this.cfg, 'settle', [lease.id, lease.tokens, actual, refundRequest ? 1 : 0]);
  }
}

function isInfo(h: unknown): h is RateLimitInfo {
  if (!h || typeof h !== 'object' || typeof (h as { get?: unknown }).get === 'function') return false;
  const keys = Object.keys(h);
  return keys.length > 0 && keys.every((k) => /^(limit|remaining|reset|retry)[A-Z]/.test(k));
}

function toStatus(r: StoreReply): PacerStatus {
  return {
    requestsLeft: r.requestsLeft,
    tokensLeft: r.tokensLeft,
    dailyLeft: r.dailyLeft,
    inflight: r.inflight,
    pausedForMs: r.waitMs,
  };
}

export function createPacer(opts: PacerOptions): Pacer {
  return new Pacer(opts);
}
