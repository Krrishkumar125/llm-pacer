/**
 * Reproducible demo: 6 workers share one provider token budget.
 *
 *   naive  - each worker has its own local limiter set to the provider limit
 *            and retries 429s on its own (honouring retry-after).
 *   shared - all workers use one llm-pacer budget in Redis.
 *
 * The "provider" is a local simulation (token bucket + 429 with
 * retry-after-ms, 150 ms latency). No real API is called.
 *
 *   REDIS_URL=redis://127.0.0.1:6379 npm run storm
 */
import { Redis } from 'ioredis';
import { createPacer, MemoryStore, type Pacer } from '../src/index.js';

const WINDOW_MS = 5_000;
const TPM = 10_000; // tokens per window at the provider
const WORKERS = 6;
const JOBS = 30;
const TOKENS = 1_000; // per job
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

class FakeProvider {
  private level = TPM;
  private ts = Date.now();
  calls = 0;
  rejected = 0;
  async complete(tokens: number) {
    this.calls++;
    const now = Date.now();
    this.level = Math.min(TPM, this.level + ((now - this.ts) * TPM) / WINDOW_MS);
    this.ts = now;
    if (this.level < tokens) {
      this.rejected++;
      const wait = Math.ceil(((tokens - this.level) * WINDOW_MS) / TPM);
      throw Object.assign(new Error('Rate limit reached'), { status: 429, headers: { 'retry-after-ms': String(wait) } });
    }
    this.level -= tokens;
    await new Promise((r) => setTimeout(r, 150));
    return { usage: { total_tokens: tokens } };
  }
}

async function drain(pacers: Pacer[], provider: FakeProvider) {
  const queue = Array.from({ length: JOBS }, (_, i) => i);
  let failed = 0;
  const t0 = Date.now();
  await Promise.all(
    pacers.map(async (pacer) => {
      while (queue.length) {
        queue.shift();
        try {
          await pacer.run(() => provider.complete(TOKENS), {
            tokens: TOKENS,
            retries: 6,
            maxWaitMs: 60_000,
            usage: (r) => r.usage.total_tokens,
          });
        } catch {
          failed++;
        }
      }
    }),
  );
  return { seconds: (Date.now() - t0) / 1000, calls: provider.calls, rejected: provider.rejected, failed };
}

async function main() {
  // naive: one private limiter per worker
  const naiveProvider = new FakeProvider();
  const naive = Array.from({ length: WORKERS }, (_, i) =>
    createPacer({ name: `w${i}`, store: new MemoryStore(), limits: { tpm: TPM }, windowMs: WINDOW_MS }),
  );
  const a = await drain(naive, naiveProvider);

  // shared: one budget in Redis
  const clients = Array.from({ length: WORKERS }, () => new Redis(REDIS_URL));
  const name = `storm-${Date.now()}`;
  const shared = clients.map((redis) => createPacer({ name, redis, limits: { tpm: TPM }, windowMs: WINDOW_MS }));
  const b = await drain(shared, new FakeProvider());
  await Promise.all(clients.map((c) => c.quit()));

  console.log(`${JOBS} jobs x ${TOKENS} tokens, ${WORKERS} workers, provider limit ${TPM} tokens / ${WINDOW_MS / 1000}s\n`);
  console.log('mode    | seconds | provider calls | 429s | jobs failed');
  for (const [mode, r] of [['naive ', a], ['shared', b]] as const) {
    console.log(`${mode}  | ${r.seconds.toFixed(1).padStart(7)} | ${String(r.calls).padStart(14)} | ${String(r.rejected).padStart(4)} | ${r.failed}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
