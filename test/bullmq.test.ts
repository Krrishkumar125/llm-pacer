import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { createPacer, paceJob } from '../src/index.js';
import { REDIS_URL, redisAvailable, uniq } from './helpers.js';

const up = await redisAvailable();

describe.skipIf(!up)('BullMQ integration', () => {
  const conns: Redis[] = [];
  const conn = () => {
    const c = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    conns.push(c);
    return c;
  };
  afterAll(async () => {
    await Promise.all(conns.map((c) => c.quit()));
  });

  it('paces jobs to the budget without failing or burning attempts', async () => {
    const qname = uniq('q');
    const pacer = createPacer({ name: uniq('bull'), redis: conn(), limits: { rpm: 4 }, windowMs: 1000 });
    const queue = new Queue(qname, { connection: conn() });
    const starts: number[] = [];
    let failed = 0;
    const worker: Worker = new Worker(
      qname,
      async (job: Job) => {
        const lease = await paceJob(pacer, worker, { tokens: 0 }, Worker.RateLimitError);
        starts.push(Date.now());
        await lease.settle();
        return job.id;
      },
      { connection: conn(), concurrency: 8 },
    );
    worker.on('failed', () => failed++);
    const done = new Promise<void>((resolve) => {
      let n = 0;
      worker.on('completed', () => {
        if (++n === 10) resolve();
      });
    });
    await queue.addBulk(Array.from({ length: 10 }, (_, i) => ({ name: 'call', data: { i }, opts: { attempts: 1 } })));
    await done;
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();

    expect(failed).toBe(0);
    expect(starts).toHaveLength(10);
    // 4 per second with a full bucket of 4 at start: 10 jobs need at least ~1.5 s.
    const span = Math.max(...starts) - Math.min(...starts);
    expect(span).toBeGreaterThanOrEqual(1300);
    // No 1-second window ever saw more than 4 + 4 starts (bucket + refill).
    for (const s of starts) expect(starts.filter((x) => x >= s && x < s + 1000).length).toBeLessThanOrEqual(8);
  });
});
