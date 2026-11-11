# llm-pacer

[![npm](https://img.shields.io/npm/v/llm-pacer.svg)](https://www.npmjs.com/package/llm-pacer) [![CI](https://github.com/Krrishkumar125/llm-pacer/actions/workflows/ci.yml/badge.svg)](https://github.com/Krrishkumar125/llm-pacer/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/llm-pacer.svg)](LICENSE)

**One shared rate budget for your LLM API calls, across every worker.**

Providers limit you on requests per minute (RPM), tokens per minute (TPM) and, in practice, on how many calls you have in flight. Those limits apply to your whole API key or org. Your code runs in many processes. If each process keeps its own counter, together they overshoot, collect 429s, and retry into the same wall.

`llm-pacer` keeps one budget in Redis that every process shares. Each call reserves its estimated tokens before it goes out and returns the unused part when the real usage comes back.

```bash
npm install llm-pacer ioredis   # or use redis instead of ioredis
```

```ts
import { Redis } from 'ioredis';
import { createPacer, estimateTokens } from 'llm-pacer';

const pacer = createPacer({
  name: 'openai:gpt-4o-mini',          // same name = same budget, in every process
  redis: new Redis(process.env.REDIS_URL),
  limits: { rpm: 500, tpm: 200_000, concurrency: 20 },
});

const reply = await pacer.run(
  () => openai.chat.completions.create({ model: 'gpt-4o-mini', messages, max_tokens: 300 }),
  {
    tokens: estimateTokens(messages, { maxOutputTokens: 300 }), // reserve before sending
    usage: (r) => r.usage?.total_tokens,                         // refund the difference after
    retries: 3,                                                  // only for rate limits / overload
  },
);
```

## Features

- **RPM, TPM, requests per day and concurrency in one atomic check.** A single Lua script checks and reserves every limit together, so a request rejected on tokens never eats a request slot.
- **Reserve, then settle.** Reserve the estimate up front. `settle(actualTokens)` refunds what you did not use, or charges the extra if the answer ran long.
- **Shared across processes and machines.** Any number of workers, servers or containers using the same `name` draw from one budget. Time comes from the Redis server clock, so clock skew between machines does not matter.
- **Waits instead of failing.** `acquire()` sleeps exactly as long as the budget needs to refill, with jitter so waiters don't all wake at once. It supports `maxWaitMs` and an `AbortSignal`.
- **429 pauses everyone.** When the provider returns a 429 with `retry-after`, `run()` pauses the whole budget, so the other workers wait too instead of piling on.
- **Rate limit vs. empty quota.** OpenAI sends HTTP 429 both for "slow down" and for "your credits are used up". `classifyLlmError()` tells them apart, and `run()` never retries an exhausted quota.
- **Syncs with provider headers.** `observe(headers)` reads `x-ratelimit-remaining-*` (OpenAI, Groq and other OpenAI-compatible APIs) and `anthropic-ratelimit-*`, and lowers the local budget when the provider says less is left (for example, when another service shares your key).
- **Crash-safe concurrency slots.** A worker that dies mid-call can't hold its slot forever: leases expire after `leaseTtlMs`.
- **BullMQ helper.** `paceJob()` puts a job that doesn't fit back in the queue through BullMQ's `worker.rateLimit()` and `RateLimitError`, so the wait doesn't use one of the job's attempts.
- **Works with ioredis and node-redis**, standalone or Redis Cluster (keys share one hash slot). The in-memory store needs no Redis at all, for tests and scripts.
- **No runtime dependencies.** TypeScript types included. ESM and CommonJS. Node 20+.

## Why not a normal rate limiter?

| | per-process limiter (p-limit, bottleneck local, a counter) | HTTP rate limiter (express-rate-limit, rate-limiter-flexible) | **llm-pacer** |
|---|---|---|---|
| Shared across processes | no | yes | yes |
| Counts tokens (variable cost) | no | points, fixed up front | reserve + settle with real usage |
| RPM + TPM + concurrency in one atomic step | no | separate limiters | yes |
| Waits for capacity (outgoing calls) | yes | built to reject incoming calls | yes |
| Reads provider rate-limit headers | no | no | yes |
| Tells a 429 rate limit from an empty quota | no | no | yes |

[bottleneck](https://github.com/SGrondin/bottleneck) has Redis clustering and weights, and it still gets about 15 million downloads a week, but its last release was in August 2019. Its open issues include Redis 7 errors in clustering mode ([#205](https://github.com/SGrondin/bottleneck/issues/205), [#219](https://github.com/SGrondin/bottleneck/issues/219)) and ["Is bottleneck still maintained?"](https://github.com/SGrondin/bottleneck/issues/207). BullMQ's built-in limiter counts jobs, not tokens. Weighted limits are an open request there ([#798](https://github.com/taskforcesh/bullmq/issues/798), [#3831](https://github.com/taskforcesh/bullmq/issues/3831)).

## See it

`npm run storm` runs a local simulation: 6 workers send 30 jobs of 1,000 tokens each to a fake provider that allows 10,000 tokens per 5 seconds and answers 429 with `retry-after-ms`. No real API is called.

```
mode    | seconds | provider calls | 429s | jobs failed
naive   |     7.2 |            102 |   78 | 6
shared  |    10.2 |             30 |    0 | 0
```

*naive* gives each worker its own limiter set to the provider limit, plus up to 6 retries. *shared* uses one llm-pacer budget. 10 seconds is the fastest any client can finish at that limit. The naive run is faster only because it gave up on 6 jobs. These numbers are from three identical runs on one machine. Run the script yourself and change the numbers at the top.

## API

### `createPacer(options)`

| option | default | |
|---|---|---|
| `name` | required | Budget name. Same name means same budget. |
| `limits` | required | `{ rpm?, tpm?, rpd?, concurrency? }`. Set at least one. |
| `redis` | none | ioredis or node-redis client. Without one, the budget is in-process memory. |
| `store` | none | Custom `PacerStore` (overrides `redis`). |
| `windowMs` | `60000` | Window for `rpm` and `tpm`. Use `1000` for per-second limits. |
| `leaseTtlMs` | `120000` | An unsettled lease frees its concurrency slot after this long. |
| `maxWaitMs` | `60000` | Default longest wait for `acquire()`. |
| `jitterMs` | `50` | Random extra sleep so waiters spread out. |
| `prefix` | `"llm-pacer:"` | Redis key prefix. |

### `pacer.acquire({ tokens?, maxWaitMs?, signal? }) → Promise<Lease>`

Waits until the call fits, then reserves it. Throws `PacerTimeoutError` (with `retryAfterMs` and `reason`) if it can't fit in time, `PacerAbortError` if the signal fires, and `PacerRequestTooLargeError` if `tokens` is larger than the whole `tpm`.

### `pacer.tryAcquire({ tokens? })`

One attempt, no waiting: `{ ok: true, lease }` or `{ ok: false, retryAfterMs, reason }`, where `reason` is `'rpm' | 'tpm' | 'rpd' | 'concurrency' | 'penalty'`.

### `Lease`

- `settle(actualTokens?)`: the call finished. Refunds or charges the difference from the estimate.
- `release()`: the call failed after reaching the provider. Frees the slot and keeps the estimate charged.
- `cancel()`: the call was never sent. Refunds the request and its tokens.

All three are idempotent. Only the first call counts.

### `pacer.run(fn, { tokens, usage?, headers?, retries?, maxWaitMs?, signal? })`

Does acquire → `fn()` → settle in one call. If `fn` throws a rate limit or overload error, the budget pauses for the provider's `retry-after` and the call retries up to `retries` times. Other errors, including an exhausted quota, are rethrown.

### `pacer.observe(headers)`, `pacer.pause(ms)`, `pacer.status()`, `pacer.reset()`

Sync with provider headers, pause the budget for every caller, read `{ requestsLeft, tokensLeft, dailyLeft, inflight, pausedForMs }`, or clear the state.

### Helpers

- `classifyLlmError(err)` → `{ kind: 'rate_limit' | 'quota_exhausted' | 'overloaded' | 'server' | 'other', status?, retryAfterMs?, retryable }`
- `parseRateLimitHeaders(headers)` for `Headers` objects or plain objects. Understands Go-style durations (`6m0s`, `20ms`), seconds and RFC 3339 dates.
- `estimateTokens(textOrMessages, { maxOutputTokens?, charsPerToken? })` is a deliberately rough chars/4 estimate. Pass an exact count if you have a tokenizer. Settling corrects the budget either way.

### BullMQ

```ts
import { Worker } from 'bullmq';
import { paceJob } from 'llm-pacer';

const worker = new Worker('llm', async (job) => {
  const lease = await paceJob(pacer, worker, { tokens: job.data.tokens }, Worker.RateLimitError);
  try {
    const out = await callModel(job.data);
    await lease.settle(out.usage.total_tokens);
    return out;
  } catch (err) {
    await lease.release();
    throw err;
  }
}, { connection, concurrency: 16 });
```

## How it works

Every operation is one `EVALSHA` of a single Lua script, so Redis applies it atomically. Each limit is a token bucket that refills continuously (`limit / window` per ms). `acquire` refills all buckets, checks every limit and only then deducts from all of them. Otherwise it returns the exact wait for the slowest limit. Concurrency is a sorted set of lease IDs scored by expiry. Two keys per budget, `llm-pacer:{name}:s` and `llm-pacer:{name}:l`, both with a TTL. The braces keep them in one Cluster slot.

## Limits and honest caveats

- Token estimates are estimates. A reply that runs longer than expected can push the bucket below zero, and later calls then wait until it refills. That is the intended, safe behaviour.
- Providers count in their own way (for example, OpenAI also counts `max_tokens` against TPM). Set `limits` a little under your dashboard numbers if you want headroom.
- The in-memory store does not coordinate across processes. Use Redis for that.
- There is no fairness across tenants. Give each tenant its own `name` (and a shared one on top) if you need that.

## Development

```bash
npm install
REDIS_URL=redis://127.0.0.1:6379 npm test   # Redis tests are skipped if Redis isn't reachable
npm run typecheck && npm run build
npm run storm
```

## License

MIT © Krrish Kumar
