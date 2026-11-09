export type HeaderSource =
  | { get(name: string): string | null | undefined }
  | Record<string, string | string[] | number | undefined | null>;

export interface RateLimitInfo {
  limitRequests?: number;
  limitTokens?: number;
  remainingRequests?: number;
  remainingTokens?: number;
  /** Milliseconds until the request budget is fully reset. */
  resetRequestsMs?: number;
  /** Milliseconds until the token budget is fully reset. */
  resetTokensMs?: number;
  /** Milliseconds the provider asked us to wait (retry-after-ms or retry-after). */
  retryAfterMs?: number;
}

function reader(h: HeaderSource): (name: string) => string | undefined {
  if (typeof (h as { get?: unknown }).get === 'function') {
    const g = h as { get(name: string): string | null | undefined };
    return (name) => g.get(name) ?? undefined;
  }
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    lower.set(k.toLowerCase(), Array.isArray(v) ? String(v[0]) : String(v));
  }
  return (name) => lower.get(name);
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/**
 * Parse a provider duration: Go-style ("6m0s", "1.5s", "20ms", "1h2m3s"),
 * plain seconds ("30"), or an absolute RFC 3339 / HTTP date.
 */
export function parseDurationMs(value: string | undefined, now: number = Date.now()): number | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (v === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let consumed = 0;
  for (const m of v.matchAll(re)) {
    total += Number(m[1]) * (UNIT_MS[m[2]!] ?? 0);
    consumed += m[0].length;
  }
  if (consumed === v.length && consumed > 0) return Math.round(total);
  const at = Date.parse(v);
  if (!Number.isNaN(at)) return Math.max(0, at - now);
  return undefined;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Read rate-limit headers from OpenAI-style (x-ratelimit-*, also used by Groq,
 * Together, Fireworks, OpenRouter and others) and Anthropic
 * (anthropic-ratelimit-*) responses.
 */
export function parseRateLimitHeaders(headers: HeaderSource, now: number = Date.now()): RateLimitInfo {
  const get = reader(headers);
  const first = (...names: string[]) => {
    for (const n of names) {
      const v = get(n);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const info: RateLimitInfo = {
    limitRequests: num(first('x-ratelimit-limit-requests', 'anthropic-ratelimit-requests-limit')),
    limitTokens: num(first('x-ratelimit-limit-tokens', 'anthropic-ratelimit-tokens-limit')),
    remainingRequests: num(first('x-ratelimit-remaining-requests', 'anthropic-ratelimit-requests-remaining')),
    remainingTokens: num(first('x-ratelimit-remaining-tokens', 'anthropic-ratelimit-tokens-remaining')),
    resetRequestsMs: parseDurationMs(first('x-ratelimit-reset-requests', 'anthropic-ratelimit-requests-reset'), now),
    resetTokensMs: parseDurationMs(first('x-ratelimit-reset-tokens', 'anthropic-ratelimit-tokens-reset'), now),
  };
  const retryMs = num(get('retry-after-ms'));
  info.retryAfterMs = retryMs !== undefined ? Math.round(retryMs) : parseDurationMs(get('retry-after'), now);
  for (const k of Object.keys(info) as Array<keyof RateLimitInfo>) if (info[k] === undefined) delete info[k];
  return info;
}
