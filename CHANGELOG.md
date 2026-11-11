# Changelog

## 0.1.1

- First release on npm: `npm install llm-pacer`. The library code is the same as 0.1.0.
- README and site install lines now use npm. Added npm and CI badges.
- package.json author now links the GitHub profile.
- Dev dependencies: vitest 4.1, bullmq 6.7.4 (fixes dev-only audit warnings).

## 0.1.0 (GitHub release only)

- First version: shared RPM / TPM / RPD / concurrency budget in Redis (one atomic Lua script), reserve-and-settle leases, `run()` with pause-on-429, provider header sync, 429 vs. quota classification, BullMQ `paceJob()`, in-memory store.
