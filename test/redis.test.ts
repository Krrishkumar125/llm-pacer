import { Redis } from 'ioredis';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPacer, PacerAbortError, PacerTimeoutError } from '../src/index.js';
import { REDIS_URL, redisAvailable, uniq } from './helpers.js';

const up = await redisAvailable();
if (!up) console.warn(`Redis not reachable at ${REDIS_URL}; skipping Redis tests. Set REDIS_URL to run them.`);

describe.skipIf(!up)('redis store', () => {
  let redis: Redis;
  const extra: Redis[] = [];
  beforeAll(() => {
    redis = new Redis(REDIS_URL);
  });
  afterAll(async () => {
    await redis.quit();
    await Promise.all(extra.map((r) => r.quit()));
  });

  it('never admits more than the budget across many clients at once', async () => {
    const name = uniq('burst');
    const clients = Array.from({ length: 5 }, () => new Redis(REDIS_URL));
    extra.push(...clients);
    // 20 requests per 10 s: refill is 2/s, so a sub-second burst admits ~20.
    const pacers = clients.map((c) => createPacer({ name, redis: c, limits: { rpm: 20 }, windowMs: 10_000 }));
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) => pacers[i % pacers.length]!.tryAcquire()),
    );
    const elapsed = Date.now() - started;
    const admitted = results.filter((r) => r.ok).length;
    expect(admitted).toBeGreaterThanOrEqual(20);
    expect(admitted).toBeLessThanOrEqual(20 + Math.ceil((elapsed / 1000) * 2));
  });

  it('acquire waits for the refill and then succeeds', async () => {
    const pacer = createPacer({ name: uniq('wait'), redis, limits: { rpm: 5 }, windowMs: 1000 });
    for (let i = 0; i < 5; i++) await pacer.acquire();
    const t0 = Date.now();
    await pacer.acquire();
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(150);
    expect(waited).toBeLessThan(1000);
  });

  it('acquire throws PacerTimeoutError when the wait is longer than maxWaitMs', async () => {
    const pacer = createPacer({ name: uniq('timeout'), redis, limits: { rpm: 1 }, windowMs: 60_000 });
    await pacer.acquire();
    const err = await pacer.acquire({ maxWaitMs: 100 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PacerTimeoutError);
    expect((err as PacerTimeoutError).reason).toBe('rpm');
  });

  it('acquire can be aborted', async () => {
    const pacer = createPacer({ name: uniq('abort'), redis, limits: { rpm: 1 }, windowMs: 5000 });
    await pacer.acquire();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expect(pacer.acquire({ signal: ac.signal })).rejects.toBeInstanceOf(PacerAbortError);
  });

  it('shares concurrency slots and token refunds across clients', async () => {
    const name = uniq('conc');
    const other = new Redis(REDIS_URL);
    extra.push(other);
    const a = createPacer({ name, redis, limits: { concurrency: 1, tpm: 1000 } });
    const b = createPacer({ name, redis: other, limits: { concurrency: 1, tpm: 1000 } });
    const lease = await a.acquire({ tokens: 900 });
    expect((await b.tryAcquire({ tokens: 50 })).ok).toBe(false);
    await lease.settle(100);
    const s = await b.status();
    expect(s.inflight).toBe(0);
    expect(s.tokensLeft).toBeGreaterThanOrEqual(900);
    expect((await b.tryAcquire({ tokens: 850 })).ok).toBe(true);
  });

  it('run() pauses the whole budget on a 429 and retries after retry-after', async () => {
    const name = uniq('run');
    const pacer = createPacer({ name, redis, limits: { rpm: 100 } });
    const peer = createPacer({ name, redis, limits: { rpm: 100 } });
    let calls = 0;
    const t0 = Date.now();
    const out = await pacer.run(
      async () => {
        calls++;
        if (calls === 1) {
          // While paused, other workers sharing the budget must wait too.
          throw Object.assign(new Error('Rate limit reached'), { status: 429, headers: { 'retry-after-ms': '300' } });
        }
        return { usage: { total_tokens: 10 } };
      },
      { retries: 1, usage: (r) => r.usage.total_tokens },
    );
    expect(out.usage.total_tokens).toBe(10);
    expect(calls).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
    expect((await peer.status()).pausedForMs).toBe(0);
  });

  it('run() does not retry an exhausted quota', async () => {
    const pacer = createPacer({ name: uniq('quota'), redis, limits: { rpm: 100 } });
    let calls = 0;
    await expect(
      pacer.run(
        async () => {
          calls++;
          throw Object.assign(new Error('insufficient_quota'), { status: 429, code: 'insufficient_quota' });
        },
        { retries: 3 },
      ),
    ).rejects.toThrow(/insufficient_quota/);
    expect(calls).toBe(1);
  });

  it('works with node-redis and reloads the script after SCRIPT FLUSH', async () => {
    const client = createClient({ url: REDIS_URL });
    await client.connect();
    try {
      const pacer = createPacer({ name: uniq('node-redis'), redis: client, limits: { rpm: 2 } });
      await client.scriptFlush();
      expect((await pacer.tryAcquire()).ok).toBe(true);
      expect((await pacer.tryAcquire()).ok).toBe(true);
      expect((await pacer.tryAcquire()).ok).toBe(false);
    } finally {
      await client.quit();
    }
  });

  it('keeps both keys in one Cluster hash slot and sets a TTL', async () => {
    const name = uniq('keys');
    const pacer = createPacer({ name, redis, limits: { rpm: 10, concurrency: 2 } });
    await pacer.acquire();
    const keys = (await redis.keys(`llm-pacer:{${name}}:*`)).sort();
    expect(keys).toEqual([`llm-pacer:{${name}}:l`, `llm-pacer:{${name}}:s`]);
    for (const k of keys) expect(await redis.pttl(k)).toBeGreaterThan(0);
  });
});
