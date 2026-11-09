import { describe, expect, it } from 'vitest';
import { classifyLlmError, estimateTokens, parseDurationMs, parseRateLimitHeaders } from '../src/index.js';

describe('parseDurationMs', () => {
  it.each([
    ['6m0s', 360_000],
    ['1s', 1000],
    ['20ms', 20],
    ['1.5s', 1500],
    ['1h2m3s', 3_723_000],
    ['30', 30_000],
    ['', undefined],
    ['soon', undefined],
  ])('%s -> %s', (input, ms) => expect(parseDurationMs(input)).toBe(ms));

  it('reads absolute dates relative to now', () => {
    const now = Date.parse('2026-11-09T10:00:00Z');
    expect(parseDurationMs('2026-11-09T10:00:30Z', now)).toBe(30_000);
  });
});

describe('parseRateLimitHeaders', () => {
  it('reads OpenAI-style headers (plain object)', () => {
    expect(
      parseRateLimitHeaders({
        'x-ratelimit-limit-requests': '500',
        'x-ratelimit-limit-tokens': '200000',
        'x-ratelimit-remaining-requests': '499',
        'X-RateLimit-Remaining-Tokens': '199250',
        'x-ratelimit-reset-requests': '120ms',
        'x-ratelimit-reset-tokens': '225ms',
      }),
    ).toEqual({
      limitRequests: 500,
      limitTokens: 200_000,
      remainingRequests: 499,
      remainingTokens: 199_250,
      resetRequestsMs: 120,
      resetTokensMs: 225,
    });
  });

  it('reads Anthropic headers (fetch Headers)', () => {
    const now = Date.parse('2026-11-09T10:00:00Z');
    const h = new Headers({
      'anthropic-ratelimit-requests-limit': '50',
      'anthropic-ratelimit-requests-remaining': '49',
      'anthropic-ratelimit-requests-reset': '2026-11-09T10:00:01Z',
      'anthropic-ratelimit-tokens-remaining': '39000',
      'retry-after': '7',
    });
    expect(parseRateLimitHeaders(h, now)).toEqual({
      limitRequests: 50,
      remainingRequests: 49,
      resetRequestsMs: 1000,
      remainingTokens: 39_000,
      retryAfterMs: 7000,
    });
  });

  it('prefers retry-after-ms over retry-after', () => {
    expect(parseRateLimitHeaders({ 'retry-after-ms': '1234', 'retry-after': '9' }).retryAfterMs).toBe(1234);
  });
});

describe('classifyLlmError', () => {
  it('a 429 for exhausted billing quota is not retryable', () => {
    const err = Object.assign(new Error('You exceeded your current quota, please check your plan and billing details.'), {
      status: 429,
      code: 'insufficient_quota',
    });
    expect(classifyLlmError(err)).toEqual({ kind: 'quota_exhausted', status: 429, retryable: false });
  });

  it('a 429 rate limit is retryable and carries retry-after', () => {
    const err = Object.assign(new Error('Rate limit reached for gpt-4o-mini'), {
      status: 429,
      code: 'rate_limit_exceeded',
      headers: new Headers({ 'retry-after-ms': '850' }),
    });
    expect(classifyLlmError(err)).toEqual({ kind: 'rate_limit', status: 429, retryAfterMs: 850, retryable: true });
  });

  it('Anthropic 529 is overloaded', () => {
    const err = { status: 529, error: { type: 'error', error: { type: 'overloaded_error' } } };
    expect(classifyLlmError(err).kind).toBe('overloaded');
  });

  it('5xx is a server error, 400 is other', () => {
    expect(classifyLlmError({ status: 503 }).kind).toBe('server');
    expect(classifyLlmError({ status: 400 })).toEqual({ kind: 'other', status: 400, retryable: false });
    expect(classifyLlmError(undefined).kind).toBe('other');
  });
});

describe('estimateTokens', () => {
  it('uses chars/4 and adds max output', () => {
    expect(estimateTokens('a'.repeat(400), { maxOutputTokens: 50 })).toBe(150);
  });
  it('handles chat messages with string and part content', () => {
    const n = estimateTokens([
      { role: 'system', content: 'a'.repeat(40) },
      { role: 'user', content: [{ type: 'text', text: 'b'.repeat(40) }] },
    ]);
    expect(n).toBe(20 + 2 * 4 + 3);
  });
});
