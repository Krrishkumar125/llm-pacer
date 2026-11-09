import { parseRateLimitHeaders, type HeaderSource } from './headers.js';

export type LlmErrorKind =
  /** Too many requests or tokens right now. Wait and retry. */
  | 'rate_limit'
  /** Billing quota or credits are used up. Retrying will not help. */
  | 'quota_exhausted'
  /** Provider is overloaded (e.g. Anthropic 529). Back off and retry. */
  | 'overloaded'
  /** 5xx from the provider. */
  | 'server'
  | 'other';

export interface LlmErrorInfo {
  kind: LlmErrorKind;
  status?: number;
  retryAfterMs?: number;
  retryable: boolean;
}

type Loose = Record<string, unknown> | undefined;

function pick(o: Loose, path: string[]): unknown {
  let cur: unknown = o;
  for (const p of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

const QUOTA = /insufficient_quota|exceeded your current quota|credit balance is too low|billing|out of credits/i;

/**
 * Tell a temporary rate limit apart from an exhausted quota (both arrive as
 * HTTP 429) and pull out how long to wait. Works with errors thrown by the
 * OpenAI and Anthropic SDKs, fetch-style errors and plain objects.
 */
export function classifyLlmError(err: unknown, now: number = Date.now()): LlmErrorInfo {
  const e = (err ?? {}) as Record<string, unknown>;
  const status = Number(e.status ?? e.statusCode ?? pick(e, ['response', 'status']) ?? NaN);
  const code = [e.code, e.type, pick(e, ['error', 'code']), pick(e, ['error', 'type']), pick(e, ['error', 'error', 'type'])]
    .filter((x) => typeof x === 'string')
    .join(' ');
  const message = `${code} ${typeof e.message === 'string' ? e.message : ''}`;
  const headers = (e.headers ?? pick(e, ['response', 'headers'])) as HeaderSource | undefined;
  const retryAfterMs = headers ? parseRateLimitHeaders(headers, now).retryAfterMs : undefined;
  const out = (kind: LlmErrorKind, retryable: boolean): LlmErrorInfo => {
    const info: LlmErrorInfo = { kind, retryable };
    if (Number.isFinite(status)) info.status = status;
    if (retryAfterMs !== undefined) info.retryAfterMs = retryAfterMs;
    return info;
  };
  if (QUOTA.test(message)) return out('quota_exhausted', false);
  if (status === 529 || /overloaded/i.test(code)) return out('overloaded', true);
  if (status === 429 || /rate_limit|RESOURCE_EXHAUSTED|too many requests/i.test(message)) return out('rate_limit', true);
  if (status >= 500 && status < 600) return out('server', true);
  return out('other', false);
}
