# Show HN (final, approved; post from the browser)

**Title** (76 chars):

Show HN: llm-pacer – one shared RPM/TPM budget for LLM calls across workers

**URL:**

https://github.com/Krrishkumar125/llm-pacer

**First comment** (post right after submitting):

LLM providers limit requests and tokens per minute per API key, but most apps call them from several processes, each with its own limiter. Together they overshoot, get 429s, and retry into the same wall.

llm-pacer keeps one budget in Redis. Every call reserves its estimated tokens, and one Lua script checks RPM, TPM, requests per day and calls in flight together, so it deducts only when all of them have room. After the call you settle with the real usage and the unused tokens go back. A 429 with retry-after pauses the shared budget, so every worker waits instead of just one. It also tells an OpenAI 429 rate limit apart from a 429 "insufficient_quota" (which shouldn't be retried), reads x-ratelimit-* and anthropic-ratelimit-* headers, and has a BullMQ helper that puts jobs back in the queue without using up an attempt.

It's TypeScript for Node 20+ with no runtime dependencies, and works with ioredis or node-redis (Cluster-safe keys). The npm release is coming soon; for now v0.1.0 installs from the GitHub release (the command is in the README).

The repo includes a simulation (`npm run storm`, no real API): 6 workers, 30 jobs, and a fake provider at 10k tokens per 5 s. Per-worker limiters made 102 calls, 78 of them 429s, and 6 jobs failed. The shared budget made 30 calls with no 429s and finished in 10.2 s, against a 10 s floor.

I'd like feedback on the reserve/settle API and on provider header formats it doesn't handle yet.
