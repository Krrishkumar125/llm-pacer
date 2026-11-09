/**
 * BullMQ worker that never sends more than the budget allows. Jobs that do
 * not fit go back to the queue without using an attempt.
 */
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createPacer, paceJob } from '../src/index.js';

const connection = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { maxRetriesPerRequest: null });
const pacer = createPacer({ name: 'anthropic:claude-sonnet', redis: connection, limits: { rpm: 50, tpm: 40_000 } });

async function callModel(prompt: string): Promise<{ text: string; tokens: number }> {
  // Replace with your SDK call.
  return { text: `echo: ${prompt}`, tokens: 120 };
}

export const worker: Worker = new Worker(
  'summaries',
  async (job) => {
    const lease = await paceJob(pacer, worker, { tokens: job.data.estimatedTokens }, Worker.RateLimitError);
    try {
      const out = await callModel(job.data.prompt);
      await lease.settle(out.tokens);
      return out.text;
    } catch (err) {
      await lease.release();
      throw err;
    }
  },
  { connection, concurrency: 16 },
);
