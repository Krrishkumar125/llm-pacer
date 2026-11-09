export interface EstimateOptions {
  /** Upper bound on completion tokens (the max_tokens you send). */
  maxOutputTokens?: number;
  /** Characters per token for the heuristic. Default 4 (English prose). */
  charsPerToken?: number;
}

type Part = string | { text?: unknown; content?: unknown };
type Message = string | { content?: unknown; role?: unknown };

function textOf(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p: Part) => (typeof p === 'string' ? p : textOf(p?.text ?? p?.content))).join('');
  return '';
}

/**
 * Rough, dependency-free token estimate: characters / 4 plus a small
 * per-message overhead, plus your max output tokens. It is deliberately
 * simple. If you have an exact tokenizer, pass its count instead; the pacer
 * corrects the bucket with the real usage when you settle the lease.
 */
export function estimateTokens(input: string | Message[], opts: EstimateOptions = {}): number {
  const cpt = opts.charsPerToken ?? 4;
  const messages = typeof input === 'string' ? [input] : input;
  let chars = 0;
  for (const m of messages) chars += typeof m === "string" ? m.length : textOf(m?.content).length;
  const overhead = typeof input === 'string' ? 0 : messages.length * 4 + 3;
  return Math.ceil(chars / cpt) + overhead + (opts.maxOutputTokens ?? 0);
}
