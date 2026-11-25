/**
 * Token usage of one finished call, split the way providers meter it.
 * `input` is what the provider counts against an input-token limit.
 */
export interface TokenUsage {
  input?: number;
  output?: number;
  /** Total for a combined tpm limit. Defaults to input + output. */
  total?: number;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const sum = (...v: Array<number | undefined>) => v.reduce<number>((a, b) => a + (b ?? 0), 0);

/**
 * Reads token usage from an OpenAI (Chat Completions or Responses), Anthropic
 * Messages, Gemini generateContent or Vercel AI SDK (4 and 5+) result, and
 * from the `{ data, response }` pair that `.withResponse()` returns. Returns undefined when the
 * result has no usage it recognises.
 *
 * Anthropic: `input_tokens` already excludes cache reads, and cache reads do
 * not count toward ITPM, so input is `input_tokens + cache_creation_input_tokens`.
 * OpenAI: input is `prompt_tokens` (or `input_tokens`), cached tokens included.
 * Gemini: input is `promptTokenCount`, output is candidates plus thinking tokens.
 * AI SDK: input and output tokens as the SDK reports them (`totalUsage` first).
 */
export function readUsage(result: unknown): TokenUsage | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as Record<string, unknown>;
  if (r.data && typeof r.data === 'object' && r.response) return readUsage(r.data);

  const meta = r.usageMetadata as Record<string, unknown> | undefined;
  if (meta && typeof meta === 'object') {
    const input = num(meta.promptTokenCount);
    const output = sum(num(meta.candidatesTokenCount), num(meta.thoughtsTokenCount));
    return { input, output, total: num(meta.totalTokenCount) ?? sum(input, output) };
  }

  const u = (r.totalUsage ?? r.usage) as Record<string, unknown> | undefined;
  if (!u || typeof u !== 'object') return undefined;

  const aiIn = num(u.inputTokens) ?? num(u.promptTokens);
  const aiOut = num(u.outputTokens) ?? num(u.completionTokens);
  if (aiIn !== undefined || aiOut !== undefined) {
    return { input: aiIn, output: aiOut, total: num(u.totalTokens) ?? sum(aiIn, aiOut) };
  }

  if (num(u.prompt_tokens) !== undefined || num(u.completion_tokens) !== undefined) {
    const input = num(u.prompt_tokens);
    const output = num(u.completion_tokens);
    return { input, output, total: num(u.total_tokens) ?? sum(input, output) };
  }

  if (num(u.input_tokens) !== undefined || num(u.output_tokens) !== undefined) {
    const input = sum(num(u.input_tokens), num(u.cache_creation_input_tokens));
    const output = num(u.output_tokens);
    return { input, output, total: sum(input, output) };
  }
  return undefined;
}
