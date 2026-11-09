---
title: "Building a distributed tokens-per-minute limiter for LLM APIs with one Redis Lua script"
subtitle: "Token buckets, reserve-and-settle leases, crash-safe concurrency slots, and why a 429 isn't always a rate limit"
tags: nodejs, typescript, redis, llm, backend
canonical: DEVTO_URL_AFTER_POSTING
---

LLM APIs limit you on several things at once, and those limits belong to your API key, not to any one process. This post is a deep dive into a small library, [llm-pacer](https://github.com/Krrishkumar125/llm-pacer), that gives every process one shared budget. It covers the design choices, the Lua script at its core, and the edge cases that took the most thought.

## 1. The shape of the problem

A typical setup is several Node.js workers (BullMQ, a cluster, a few containers) all calling the same model with the same key. The provider enforces:

- **RPM**: requests per minute
- **TPM**: tokens per minute (prompt plus completion; OpenAI also counts the `max_tokens` you request)
- sometimes **RPD**, requests per day, on lower tiers and free plans
- and in practice, a sensible cap on **calls in flight**

It reports state back in headers: OpenAI-style `x-ratelimit-remaining-requests` / `-tokens` and `x-ratelimit-reset-*` (durations like `6m0s` or `20ms`), Anthropic's `anthropic-ratelimit-*-remaining` / `-reset` (RFC 3339 timestamps), and `retry-after` / `retry-after-ms` on a 429.

A per-process limiter can't see what the other processes are doing. If you divide the limit by the number of workers, you waste capacity whenever some workers are idle. If you don't divide it, you overshoot. The [r/LLMDevs thread on parallel calls under rate limits](https://www.reddit.com/r/LLMDevs/comments/1u3rox1/how_do_you_handle_true_parallelism_with_llm_calls/) reaches the same conclusions: use a token bucket rather than fixed intervals, respect `Retry-After`, track all the limits at once, and weight by tokens, adjusting once the real usage comes back.

## 2. Existing tools, and why I didn't reach for them

- **bottleneck** gets about 15M downloads a week and supports Redis clustering and weights, but its [last release was v2.19.5 in August 2019](https://www.npmjs.com/package/bottleneck). Open issues include `ERR SETTINGS_KEY_NOT_FOUND` with Redis 7 ([#205](https://github.com/SGrondin/bottleneck/issues/205), [#219](https://github.com/SGrondin/bottleneck/issues/219)).
- **BullMQ** has a solid job-count limiter, but weighted or points-based limits are open requests ([#798](https://github.com/taskforcesh/bullmq/issues/798) since 2021, [#3831](https://github.com/taskforcesh/bullmq/issues/3831) in 2026, which names AI model APIs).
- **rate-limiter-flexible**, **@upstash/ratelimit** and **express-rate-limit** are well maintained and great at rejecting *incoming* requests. Pacing *outgoing* calls with a cost you only learn afterwards is a different problem.
- **@aid-on/llm-throttle** models RPM + TPM with post-adjustment, but it runs in memory inside one process.

## 3. Data model

Each budget has a `name` (for example `openai:gpt-4o-mini`) and two Redis keys:

```
llm-pacer:{openai:gpt-4o-mini}:s   HASH  r, t, d (bucket levels), ts (last update ms), blk (paused until ms)
llm-pacer:{openai:gpt-4o-mini}:l   ZSET  lease id -> expiry ms   (only when concurrency is limited)
```

The `{…}` part is a Redis Cluster hash tag. Both keys hash to the same slot, so one script may touch both.

## 4. Token buckets that refill continuously

Each limit is a bucket with `capacity = limit`, refilling at `limit / windowMs` per millisecond:

```lua
local el = now - ts
if rpm > 0 then r  = math.min(rpm, r  + el * rpm / win) end
if tpm > 0 then tk = math.min(tpm, tk + el * tpm / win) end
if rpd > 0 then d  = math.min(rpd, d  + el * rpd / DAY) end
```

A continuous bucket means the wait time is exact. If 300 tokens are missing at 200,000 TPM, the wait is `300 * 60000 / 200000 = 90 ms`. Callers sleep that long, plus a little jitter, instead of polling.

## 5. One atomic check for every limit

The important rule: **only deduct if every limit has room.** If you check RPM, deduct it, and then find TPM is short, you've spent a request on a call that never happened. (The SitePoint article on sliding-window limiters [points out this drift](https://www.sitepoint.com/distributed-sliding-window-rate-limiter-typescript-redis/) in the two-call approach.)

```lua
local wait, reason = 0, ''
if blk > now then wait = blk - now; reason = 'penalty' end
if rpm > 0 and r < 1 then  local w = (1 - r) * win / rpm;     if w > wait then wait, reason = w, 'rpm' end end
if tpm > 0 and tk < cost then local w = (cost - tk) * win / tpm; if w > wait then wait, reason = w, 'tpm' end end
-- ... rpd and concurrency ...
if wait > 0 then save(); return reply(0, wait, reason) end
r, tk, d = r - 1, tk - cost, d - 1
```

The time comes from `redis.call('TIME')`. Since Redis 5, scripts replicate their effects rather than the script itself, so non-deterministic commands are fine. Every process sees the same clock.

## 6. Reserve, then settle

Before the call, reserve `prompt estimate + max_tokens`. After it, settle with the real usage:

```lua
if tpm > 0 and actual >= 0 then tk = math.min(tpm, tk + estimated - actual) end
```

If the call used less, the difference goes back to the bucket. If it used more, the bucket goes negative. That debt is a feature: later callers wait until the bucket has refilled past zero, which is what the provider will expect too.

The lease has three endings:

| | request | tokens | concurrency slot |
|---|---|---|---|
| `settle(actual)` | kept | refund / charge the difference | freed |
| `release()` (failed after sending) | kept | estimate kept | freed |
| `cancel()` (never sent) | refunded | refunded | freed |

## 7. Crash-safe concurrency

Concurrency is a sorted set of lease IDs scored by expiry time. Every call first runs `ZREMRANGEBYSCORE key -inf now`, so a worker that crashed mid-call loses its slot after `leaseTtlMs` instead of holding it forever.

## 8. When the provider says 429

Two rules:

1. **Pause the whole budget.** `retry-after-ms: 800` means the key is saturated, not just this worker. `run()` writes `blk = now + 800` into the shared hash, so every caller waits.
2. **Classify before retrying.** OpenAI returns 429 for `rate_limit_exceeded` *and* for `insufficient_quota`. Anthropic uses 529 for `overloaded_error`. `classifyLlmError()` maps these to `rate_limit`, `quota_exhausted`, `overloaded`, `server` or `other`, and only the retryable kinds are retried. (An HN submission, ["A 429 from a quota cap and a 429 from rate-limit need different cooldowns"](https://news.ycombinator.com/item?id=48064656), makes the same point.)

## 9. Syncing with the provider's numbers

Other services may share your key. `observe(headers)` reads the remaining requests and tokens from the response and **lowers** the local bucket if the provider reports less. It never raises it, because one stale header shouldn't let a burst through.

## 10. Testing it

The suite runs against a real Redis:

- 200 parallel `tryAcquire` calls from 5 separate clients against a 20-request budget admit no more than 20 plus the refill during the test.
- Token refunds and concurrency slots are shared between clients.
- After `SCRIPT FLUSH`, the `NOSCRIPT` fallback reloads the script, on both ioredis and node-redis.
- A BullMQ worker with concurrency 8 and a 4-per-second budget processes 10 jobs with no failures, and no one-second window sees more than bucket plus refill.
- A fake-clock memory store covers the arithmetic exactly (for example, the 20,000 ms wait for the fourth request on a 3 RPM budget).

## 11. A simulation you can run

`npm run storm` simulates a provider (10,000 tokens per 5 s, 429 with `retry-after-ms`) and six workers draining 30 jobs of 1,000 tokens each:

| mode | seconds | provider calls | 429s | jobs failed |
|---|---|---|---|---|
| a limiter per worker, up to 6 retries | 7.2 | 102 | 78 | 6 |
| one shared budget | 10.2 | 30 | 0 | 0 |

10 seconds is the theoretical floor at that limit. It's a simulation and says nothing about any specific provider. The point is the shape: shared pacing makes one call per job and finishes all of them.

## 12. Trying it

The npm release is coming soon. For now, install v0.1.0 from GitHub Releases:

```bash
npm install https://github.com/Krrishkumar125/llm-pacer/releases/download/v0.1.0/llm-pacer-0.1.0.tgz ioredis
```

## 13. Known limits

- Estimates are estimates. Leave some headroom under your dashboard limits.
- No built-in tenant fairness. Stack two budgets (per tenant, then shared) if you need it.
- If Redis is down, pacer calls reject. Whether to fail open or closed is your call.

The code is MIT licensed: [github.com/Krrishkumar125/llm-pacer](https://github.com/Krrishkumar125/llm-pacer). Feedback on the API, especially from people running mixed-provider setups, is very welcome.
