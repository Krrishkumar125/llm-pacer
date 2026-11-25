# Changelog

## 0.2.0

- New limits `itpm` and `otpm`: input and output tokens per window, checked in the same atomic step as the others. Reserve with `inputTokens` and `outputTokens`. This matches Anthropic's ITPM and OTPM and Gemini's input TPM.
- `lease.settle()` and `run({ usage })` accept `{ input, output, total }` as well as a number. Each bucket is corrected on its own.
- New `readUsage(result)` for OpenAI Chat Completions and Responses, Anthropic Messages, Gemini and the Vercel AI SDK. Anthropic cache reads do not count as input, matching how ITPM is metered.
- `observe()` and `parseRateLimitHeaders()` read `anthropic-ratelimit-input-tokens-*` and `anthropic-ratelimit-output-tokens-*`.
- `classifyLlmError()` reads Gemini's `RetryInfo.retryDelay` from the error body (`@google/genai`, `@google/generative-ai` and plain REST errors), and treats a `RESOURCE_EXHAUSTED` error that has a retry delay as a rate limit rather than an empty quota.
- `run()` syncs the budget with rate-limit headers that come back on a failed call.
- `status()` adds `inputTokensLeft` and `outputTokensLeft`. `PacerRequestTooLargeError` adds `limit`.
- The Lua script takes `itpm` and `otpm` as ARGV 7 and 8, so op arguments start at ARGV 9. This only matters if you call `PACER_LUA` yourself. Redis state written by 0.1.x is read as is; the new buckets start full.

## 0.1.1

- First release on npm: `npm install llm-pacer`. The library code is the same as 0.1.0.
- README and site install lines now use npm. Added npm and CI badges.
- package.json author now links the GitHub profile.
- Dev dependencies: vitest 4.1, bullmq 6.7.4 (fixes dev-only audit warnings).

## 0.1.0 (GitHub release only)

- First version: shared RPM / TPM / RPD / concurrency budget in Redis (one atomic Lua script), reserve-and-settle leases, `run()` with pause-on-429, provider header sync, 429 vs. quota classification, BullMQ `paceJob()`, in-memory store.
