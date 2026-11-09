<!-- Medium import: set the canonical link to the Dev.to post URL (Story settings > Advanced > Customize canonical link). -->
# The 429 that wasn't a rate limit

*How a shared token budget in Redis stops workers from fighting over one LLM API key.*

---

There's a particular kind of production log that makes you doubt your own arithmetic.

You set the limiter to 500 requests per minute, exactly what the provider dashboard says. You run six workers so a batch finishes faster. Then the logs fill with `429 Too Many Requests`, the batch takes longer than it did with one worker, and a handful of jobs give up after their last retry.

Nothing is broken. Each worker is doing exactly what you told it to. The problem is that the provider's limit belongs to your **API key**, while each limiter only sees its **own process**. Six honest workers, each allowed the full limit, add up to six times the limit.

## Two limits, and one of them can't be counted in advance

LLM providers usually enforce **requests per minute** and **tokens per minute** at the same time. Requests are easy to count. Tokens are not: you know the prompt size up front, but the length of the answer only shows up when the response arrives.

So a useful limiter needs two moves:

1. **Reserve** an estimate before the call: the prompt tokens plus the `max_tokens` you asked for.
2. **Settle** after the call with the real usage, giving back what you didn't use or recording the overrun.

And because the limit is shared, the counter has to be shared too.

## One bucket per limit, one atomic check

The approach I settled on keeps a small token bucket per limit in Redis. Each bucket refills smoothly over its window. A single Lua script refills every bucket, checks them all and deducts only if every one has room. Otherwise it returns how long to wait for the slowest limit.

Because Redis runs the script atomically, it doesn't matter how many processes call it at once. Because the script reads the time from Redis itself, it doesn't matter whether the servers' clocks agree.

Two more details turned out to matter more than I expected:

- **One 429 should pause everyone.** When the provider says "retry after 800 ms", every worker sharing that key should hear it, not only the one that got the error.
- **Not every 429 is a rate limit.** OpenAI also uses 429 for "you've run out of credits". Retrying that is pointless, and treating it as a rate limit hides the real problem.

## The result, in a simulation you can run

I wrote a small script that simulates a provider allowing 10,000 tokens per 5 seconds, with six workers draining 30 jobs of 1,000 tokens each. With a separate limiter in each worker, the run made 102 provider calls, 78 of them came back 429, and 6 jobs failed. With one shared budget, it made 30 calls with no 429s and no failures, and finished in 10.2 seconds against a theoretical floor of 10.

It's a simulation, not a benchmark of any real provider. The script is in the repo so anyone can check it or change it.

## The package

I packaged this as **llm-pacer**, a small TypeScript library for Node.js with no runtime dependencies:

```ts
const pacer = createPacer({
  name: 'openai:gpt-4o-mini',
  redis,
  limits: { rpm: 500, tpm: 200_000, concurrency: 20 },
});

await pacer.run(() => callTheModel(), {
  tokens: estimateTokens(messages, { maxOutputTokens: 300 }),
  usage: (r) => r.usage?.total_tokens,
  retries: 3,
});
```

It also reads the providers' rate-limit headers to stay in sync, frees concurrency slots held by workers that crashed, and has a helper for BullMQ that puts jobs back in the queue instead of failing them.

It's MIT licensed and on GitHub: **https://github.com/Krrishkumar125/llm-pacer**. The npm release is coming soon. Until then, you can install v0.1.0 from the GitHub release:

```bash
npm install https://github.com/Krrishkumar125/llm-pacer/releases/download/v0.1.0/llm-pacer-0.1.0.tgz ioredis
```

If your provider sends rate-limit headers in a format it doesn't understand yet, an issue with an example response would help a lot.
