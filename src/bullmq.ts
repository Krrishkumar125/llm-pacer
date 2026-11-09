import type { Lease, Pacer } from './pacer.js';

/** The parts of a BullMQ Worker this helper uses. */
export interface RateLimitableWorker {
  rateLimit(ms: number): Promise<void>;
}

/**
 * Use inside a BullMQ processor. Returns a lease when the budget has room.
 * When it does not, it tells BullMQ to pause the worker for the right time
 * and throws BullMQ's RateLimitError, so the job goes back to the queue
 * without using up an attempt.
 *
 * ```ts
 * const worker = new Worker('llm', async (job) => {
 *   const lease = await paceJob(pacer, worker, { tokens: job.data.tokens }, Worker.RateLimitError);
 *   ...
 * });
 * ```
 */
export async function paceJob(
  pacer: Pacer,
  worker: RateLimitableWorker,
  req: { tokens?: number },
  rateLimitError: () => Error,
): Promise<Lease> {
  const r = await pacer.tryAcquire(req);
  if (r.ok) return r.lease;
  await worker.rateLimit(Math.max(1, r.retryAfterMs));
  throw rateLimitError();
}
