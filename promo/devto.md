---
title: "Six workers, one OpenAI key, and 78 wasted calls: sharing a token budget in Redis"
published: false
description: "Why per-worker rate limiters overshoot LLM tokens-per-minute limits, and how to share one RPM + TPM budget across every process with a single Redis Lua script."
tags: node, typescript, redis, llm
cover_image:
canonical_url:
---

If you call an LLM API from more than one process, you've probably seen this: each worker has a polite little rate limiter, each worker stays under the limit, and you still get a wall of `429 Too Many Requests`.

The reason is simple. The provider's limit belongs to your **API key**, but each limiter only counts its **own** calls. Six workers that each allow the full limit can send six times the limit together.

This post walks through the fix: one shared budget in Redis that counts requests *and* tokens, checked in one atomic step. At the end there's a small open-source package, [llm-pacer](https://github.com/Krrishkumar125/llm-pacer), that does it for you.

## Tokens per minute is the limit that hurts

OpenAI, Anthropic and most other providers enforce at least two limits at once:

- **RPM**: requests per minute
- **TPM**: tokens per minute (prompt plus completion)

They also send headers such as `x-ratelimit-remaining-tokens` and, on a 429, `retry-after-ms`. ([SimpleQ has a good table of the OpenAI headers](https://simpleq.io/blog/how-to-handle-openai-rate-limits-in-production).)

TPM is the awkward one, because you don't know a call's real cost until the reply comes back. A request counter can't model it. You need a counter where each call **reserves** an estimate and later **settles** the real number.

## What the usual tools give you

- **Per-process limiters** (p-limit, a local token bucket) don't share state between processes.
- **bottleneck** has Redis clustering and job weights. It still gets about 15 million downloads a week, but its last release was in August 2019. Its open issues include [Redis 7 errors in clustering mode](https://github.com/SGrondin/bottleneck/issues/205) and ["Is bottleneck still maintained?"](https://github.com/SGrondin/bottleneck/issues/207).
- **BullMQ's limiter** counts jobs, not tokens. Weighted or points-based limits are open feature requests ([#798](https://github.com/taskforcesh/bullmq/issues/798), [#3831](https://github.com/taskforcesh/bullmq/issues/3831)). The second one calls out AI model APIs directly.
- **HTTP rate limiters** like express-rate-limit or rate-limiter-flexible are excellent for *incoming* traffic. Pacing *outgoing* calls is a different job: you want to wait, not reject.

## The design

1. **One token bucket per limit** (RPM, TPM, optional requests per day), refilling continuously at `limit / window`.
2. **One Lua script** checks every bucket and deducts only if all of them have room. Redis runs it atomically, so 200 parallel callers can't oversubscribe it, and a call that's short on tokens never uses up a request slot.
3. **Reserve, then settle.** Before the call, reserve `prompt estimate + max_tokens`. After it, settle with `usage.total_tokens`. The unused part goes back to the bucket, and an over-run is charged as debt.
4. **One 429 pauses everyone.** When a 429 arrives with `retry-after`, the shared budget is paused, so the other workers stop too.
5. **Use the Redis clock** (`TIME` inside the script), so clock skew between machines doesn't matter.

## The code

```ts
import { Redis } from 'ioredis';
import { createPacer, estimateTokens } from 'llm-pacer';

const pacer = createPacer({
  name: 'openai:gpt-4o-mini',   // same name = same budget in every process
  redis: new Redis(process.env.REDIS_URL),
  limits: { rpm: 500, tpm: 200_000, concurrency: 20 },
});

const reply = await pacer.run(
  () => openai.chat.completions.create({ model: 'gpt-4o-mini', messages, max_tokens: 300 }),
  {
    tokens: estimateTokens(messages, { maxOutputTokens: 300 }),
    usage: (r) => r.usage?.total_tokens,
    retries: 3,
  },
);
```

With BullMQ, pace inside the processor. Jobs that don't fit go back to the queue without using an attempt:

```ts
const worker = new Worker('llm', async (job) => {
  const lease = await paceJob(pacer, worker, { tokens: job.data.tokens }, Worker.RateLimitError);
  const out = await callModel(job.data);
  await lease.settle(out.usage.total_tokens);
  return out;
}, { connection, concurrency: 16 });
```

## Not every 429 is a rate limit

OpenAI returns HTTP 429 both for "slow down" (`rate_limit_exceeded`) and for "your credits are used up" (`insufficient_quota`). Retrying the second one just burns time. `classifyLlmError(err)` tells them apart, and `run()` won't retry an exhausted quota.

## A reproducible comparison

The repo has `npm run storm`: 6 workers, 30 jobs of 1,000 tokens each, and a **simulated** provider that allows 10,000 tokens per 5 seconds and returns 429 with `retry-after-ms`. No real API is involved, so you can run it anywhere.

| mode | seconds | provider calls | 429s | jobs failed |
|---|---|---|---|---|
| a limiter per worker, up to 6 retries | 7.2 | 102 | 78 | 6 |
| one shared budget | 10.2 | 30 | 0 | 0 |

10 seconds is the floor at that limit. The per-worker run only looks faster because it gave up on 6 jobs. Change the numbers at the top of `examples/storm.ts` and try your own shape of traffic.

## Caveats

- Estimates are estimates. A long answer can push the bucket below zero, and later calls then wait. That's the intended behaviour.
- Leave some headroom under your dashboard limits. Providers count in their own way.
- There's no fairness across tenants built in. The docs show a two-budget recipe for that.

The code is MIT licensed: [github.com/Krrishkumar125/llm-pacer](https://github.com/Krrishkumar125/llm-pacer). Issues and PRs are welcome, especially header formats from providers I haven't covered yet.
