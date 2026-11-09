import { createHash } from 'node:crypto';
import { PACER_LUA } from '../lua.js';
import type { PacerStore, StoreConfig, StoreOp, StoreReply } from '../types.js';

const SHA = createHash('sha1').update(PACER_LUA).digest('hex');

/** Anything shaped like an ioredis client. */
export interface IoRedisLike {
  evalsha(sha: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

/** Anything shaped like a node-redis (v4+) client. */
export interface NodeRedisLike {
  evalSha(sha: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export type RedisLike = IoRedisLike | NodeRedisLike;

function isNodeRedis(c: RedisLike): c is NodeRedisLike {
  return typeof (c as NodeRedisLike).evalSha === 'function';
}

function isNoScript(err: unknown): boolean {
  return err instanceof Error && /NOSCRIPT/i.test(err.message);
}

/**
 * Store that runs every operation as one atomic Lua call. Works with ioredis
 * and node-redis, standalone or Cluster (both keys share one hash slot).
 */
export class RedisStore implements PacerStore {
  constructor(private readonly client: RedisLike) {
    if (!client || (typeof (client as IoRedisLike).evalsha !== 'function' && !isNodeRedis(client))) {
      throw new TypeError('llm-pacer: expected an ioredis or node-redis client');
    }
  }

  async exec(key: string, cfg: StoreConfig, op: StoreOp, args: Array<string | number>): Promise<StoreReply> {
    const keys = [`${key}:s`, `${key}:l`];
    const argv = [op, cfg.rpm, cfg.tpm, cfg.rpd, cfg.concurrency, cfg.windowMs, ...args].map(String);
    const raw = (await this.run(keys, argv)) as unknown[];
    return {
      ok: Number(raw[0]) as StoreReply['ok'],
      waitMs: Number(raw[1]),
      requestsLeft: Number(raw[2]),
      tokensLeft: Number(raw[3]),
      dailyLeft: Number(raw[4]),
      inflight: Number(raw[5]),
      reason: String(raw[6] ?? '') as StoreReply['reason'],
    };
  }

  private async run(keys: string[], argv: string[]): Promise<unknown> {
    const c = this.client;
    if (isNodeRedis(c)) {
      try {
        return await c.evalSha(SHA, { keys, arguments: argv });
      } catch (err) {
        if (!isNoScript(err)) throw err;
        return c.eval(PACER_LUA, { keys, arguments: argv });
      }
    }
    try {
      return await c.evalsha(SHA, keys.length, ...keys, ...argv);
    } catch (err) {
      if (!isNoScript(err)) throw err;
      return c.eval(PACER_LUA, keys.length, ...keys, ...argv);
    }
  }
}
