/**
 * Pace OpenAI chat completions with plain fetch (no SDK needed).
 *   OPENAI_API_KEY=... REDIS_URL=redis://127.0.0.1:6379 npx tsx examples/openai-fetch.ts
 */
import { Redis } from 'ioredis';
import { createPacer, estimateTokens } from '../src/index.js';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
// Use the limits shown for your org and model on the provider dashboard.
const pacer = createPacer({ name: 'openai:gpt-4o-mini', redis, limits: { rpm: 500, tpm: 200_000, concurrency: 20 } });

async function ask(question: string) {
  const messages = [{ role: 'user', content: question }];
  const max_tokens = 300;
  return pacer.run(
    async () => {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens }),
      });
      const body = (await res.json()) as { usage?: { total_tokens: number }; error?: { code?: string; message?: string } };
      if (!res.ok) throw Object.assign(new Error(body.error?.message ?? res.statusText), { status: res.status, code: body.error?.code, headers: res.headers });
      return { body, headers: res.headers };
    },
    {
      tokens: estimateTokens(messages, { maxOutputTokens: max_tokens }),
      retries: 3,
      usage: (r) => r.body.usage?.total_tokens,
      headers: (r) => r.headers,
    },
  );
}

const out = await ask('Say hello in five words.');
console.log(JSON.stringify(out.body, null, 2));
await redis.quit();
