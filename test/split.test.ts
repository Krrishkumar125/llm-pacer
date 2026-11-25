import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import {
  classifyLlmError,
  createPacer,
  MemoryStore,
  parseRateLimitHeaders,
  PacerRequestTooLargeError,
  readUsage,
} from '../src/index.js';
import { REDIS_URL, redisAvailable, uniq } from './helpers.js';

function clocked(limits: Parameters<typeof createPacer>[0]['limits']) {
  let t = 1_000_000;
  const store = new MemoryStore(() => t);
  const pacer = createPacer({ name: 'split', limits, store, jitterMs: 0 });
  return { pacer, tick: (ms: number) => (t += ms) };
}

describe('input and output token buckets', () => {
  it('limits input and output separately', async () => {
    const { pacer } = clocked({ itpm: 1000, otpm: 200 });
    expect((await pacer.tryAcquire({ inputTokens: 900, outputTokens: 100 })).ok).toBe(true);
    const out = await pacer.tryAcquire({ inputTokens: 50, outputTokens: 150 });
    expect(out).toEqual({ ok: false, retryAfterMs: 15_000, reason: 'otpm' });
    const inp = await pacer.tryAcquire({ inputTokens: 300, outputTokens: 10 });
    expect(inp).toMatchObject({ ok: false, reason: 'itpm' });
    expect((await pacer.tryAcquire({ inputTokens: 100, outputTokens: 100 })).ok).toBe(true);
  });

  it('refunds the output reservation the model did not use', async () => {
    const { pacer } = clocked({ otpm: 1000 });
    const lease = await pacer.acquire({ outputTokens: 800 });
    expect((await pacer.status()).outputTokensLeft).toBe(200);
    await lease.settle({ input: 0, output: 120 });
    expect((await pacer.status()).outputTokensLeft).toBe(880);
  });

  it('cache reads cost nothing against itpm', async () => {
    const { pacer } = clocked({ itpm: 10_000 });
    const anthropic = {
      usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 9000, output_tokens: 300 },
    };
    const result = await pacer.run(async () => anthropic, { inputTokens: 9040, usage: readUsage });
    expect(result).toBe(anthropic);
    expect((await pacer.status()).inputTokensLeft).toBe(9960);
  });

  it('a plain number settles tpm and keeps the split estimates', async () => {
    const { pacer } = clocked({ tpm: 1000, itpm: 500 });
    const lease = await pacer.acquire({ tokens: 400, inputTokens: 300 });
    await lease.settle(100);
    const s = await pacer.status();
    expect(s.tokensLeft).toBe(900);
    expect(s.inputTokensLeft).toBe(200);
  });

  it('cancel refunds every bucket', async () => {
    const { pacer } = clocked({ itpm: 500, otpm: 500 });
    const lease = await pacer.acquire({ inputTokens: 400, outputTokens: 300 });
    await lease.cancel();
    expect(await pacer.status()).toMatchObject({ inputTokensLeft: 500, outputTokensLeft: 500 });
  });

  it('charges `tokens` to itpm when only itpm is set', async () => {
    const { pacer } = clocked({ itpm: 500 });
    await pacer.acquire({ tokens: 450 });
    expect((await pacer.status()).inputTokensLeft).toBe(50);
  });

  it('rejects a request larger than the input or output budget', async () => {
    const { pacer } = clocked({ itpm: 100, otpm: 100 });
    await expect(pacer.tryAcquire({ inputTokens: 101 })).rejects.toMatchObject({ limit: 'itpm', tpm: 100 });
    await expect(pacer.tryAcquire({ outputTokens: 101 })).rejects.toBeInstanceOf(PacerRequestTooLargeError);
  });

  it('observe follows the Anthropic input and output headers down', async () => {
    const { pacer } = clocked({ itpm: 1000, otpm: 1000 });
    await pacer.observe({
      'anthropic-ratelimit-input-tokens-remaining': '300',
      'anthropic-ratelimit-output-tokens-remaining': '5000',
    });
    expect(await pacer.status()).toMatchObject({ inputTokensLeft: 300, outputTokensLeft: 1000 });
  });

  it('run() syncs with the headers on a 429 before pausing', async () => {
    const { pacer } = clocked({ itpm: 1000 });
    const err = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: { 'anthropic-ratelimit-input-tokens-remaining': '0', 'retry-after': '2' },
    });
    await expect(pacer.run(async () => Promise.reject(err))).rejects.toBe(err);
    expect(await pacer.status()).toMatchObject({ inputTokensLeft: 0, pausedForMs: 2000 });
  });

  it('validates the new limits', () => {
    expect(() => createPacer({ name: 'x', limits: { otpm: -1 } })).toThrow(/otpm/);
    expect(() => createPacer({ name: 'x', limits: { itpm: 10 } })).not.toThrow();
  });
});

describe('readUsage', () => {
  it('reads Anthropic usage, excluding cache reads', () => {
    expect(
      readUsage({ usage: { input_tokens: 12, cache_creation_input_tokens: 2000, cache_read_input_tokens: 50_000, output_tokens: 90 } }),
    ).toEqual({ input: 2012, output: 90, total: 2102 });
  });
  it('reads OpenAI Chat Completions and Responses usage', () => {
    expect(readUsage({ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })).toEqual({
      input: 100,
      output: 20,
      total: 120,
    });
    expect(readUsage({ usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 80 } } })).toEqual({
      input: 100,
      output: 20,
      total: 120,
    });
  });
  it('reads Gemini usageMetadata, thinking tokens as output', () => {
    expect(
      readUsage({ usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 40, thoughtsTokenCount: 60, totalTokenCount: 600 } }),
    ).toEqual({ input: 500, output: 100, total: 600 });
  });
  it('reads Vercel AI SDK usage (5+ and 4) and unwraps withResponse()', () => {
    expect(readUsage({ totalUsage: { inputTokens: 70, outputTokens: 30, totalTokens: 100 }, usage: { inputTokens: 1 } })).toEqual({
      input: 70,
      output: 30,
      total: 100,
    });
    expect(readUsage({ usage: { promptTokens: 7, completionTokens: 3 } })).toEqual({ input: 7, output: 3, total: 10 });
    expect(readUsage({ data: { usage: { prompt_tokens: 5, completion_tokens: 1 } }, response: {} })).toEqual({
      input: 5,
      output: 1,
      total: 6,
    });
  });
  it('returns undefined for anything else', () => {
    expect(readUsage(null)).toBeUndefined();
    expect(readUsage('text')).toBeUndefined();
    expect(readUsage({ usage: {} })).toBeUndefined();
  });
});

describe('Gemini errors', () => {
  const body = {
    error: {
      code: 429,
      message: 'You exceeded your current quota, please check your plan and billing details.',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '57s' },
      ],
    },
  };

  it('treats a 429 with a retryDelay as a rate limit (@google/genai message shape)', () => {
    const err = Object.assign(new Error(`got status: 429 Too Many Requests. ${JSON.stringify(body)}`), { status: 429 });
    expect(classifyLlmError(err)).toEqual({ kind: 'rate_limit', status: 429, retryAfterMs: 57_000, retryable: true });
  });

  it('reads errorDetails (@google/generative-ai shape)', () => {
    const err = Object.assign(new Error('[429 Too Many Requests] You exceeded your current quota'), {
      status: 429,
      errorDetails: body.error.details,
    });
    expect(classifyLlmError(err)).toMatchObject({ kind: 'rate_limit', retryAfterMs: 57_000 });
  });

  it('reads a plain REST error body', () => {
    expect(classifyLlmError(body)).toMatchObject({ kind: 'rate_limit', retryAfterMs: 57_000 });
  });

  it('still reports an OpenAI insufficient_quota as exhausted', () => {
    expect(classifyLlmError({ status: 429, code: 'insufficient_quota' }).kind).toBe('quota_exhausted');
  });
});

describe('Anthropic input and output headers', () => {
  it('parses them', () => {
    const info = parseRateLimitHeaders(
      {
        'anthropic-ratelimit-input-tokens-limit': '40000',
        'anthropic-ratelimit-input-tokens-remaining': '39000',
        'anthropic-ratelimit-input-tokens-reset': '2026-01-01T00:00:01Z',
        'anthropic-ratelimit-output-tokens-limit': '8000',
        'anthropic-ratelimit-output-tokens-remaining': '7900',
      },
      Date.parse('2026-01-01T00:00:00Z'),
    );
    expect(info).toEqual({
      limitInputTokens: 40000,
      remainingInputTokens: 39000,
      resetInputTokensMs: 1000,
      limitOutputTokens: 8000,
      remainingOutputTokens: 7900,
    });
  });
});

const up = await redisAvailable();
describe.skipIf(!up)('input and output buckets on redis', () => {
  const redis = up ? new Redis(REDIS_URL) : (undefined as unknown as Redis);
  afterAll(async () => {
    await redis?.quit();
  });

  it('behaves like the memory store', async () => {
    const pacer = createPacer({ name: uniq('split'), redis, limits: { itpm: 1000, otpm: 200 }, jitterMs: 0 });
    const lease = await pacer.acquire({ inputTokens: 900, outputTokens: 150 });
    expect(await pacer.tryAcquire({ inputTokens: 10, outputTokens: 100 })).toMatchObject({ ok: false, reason: 'otpm' });
    await lease.settle({ input: 100, output: 20 });
    const s = await pacer.status();
    expect(s.inputTokensLeft).toBeGreaterThanOrEqual(900);
    expect(s.outputTokensLeft).toBeGreaterThanOrEqual(180);
    await expect(pacer.tryAcquire({ inputTokens: 2000 })).rejects.toMatchObject({ limit: 'itpm' });
  });

  it('reads state written by 0.1.x (no input or output fields) as full buckets', async () => {
    const name = uniq('old');
    await redis.hset(`llm-pacer:{${name}}:s`, 'r', '5', 't', '100', 'd', '0', 'ts', String(Date.now()), 'blk', '0');
    const pacer = createPacer({ name, redis, limits: { rpm: 10, itpm: 500 } });
    expect(await pacer.status()).toMatchObject({ inputTokensLeft: 500 });
  });
});
