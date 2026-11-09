import { Redis } from 'ioredis';

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

export async function redisAvailable(): Promise<boolean> {
  const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  try {
    await r.connect();
    await r.ping();
    return true;
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}

export const uniq = (p: string) => `${p}-${Math.random().toString(36).slice(2, 10)}`;
