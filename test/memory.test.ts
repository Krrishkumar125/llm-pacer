import { describe, expect, it } from 'vitest';
import { createPacer, MemoryStore, PacerRequestTooLargeError } from '../src/index.js';

function clocked(limits: Parameters<typeof createPacer>[0]['limits'], extra: Partial<Parameters<typeof createPacer>[0]> = {}) {
  let t = 1_000_000;
  const store = new MemoryStore(() => t);
  const pacer = createPacer({ name: 'm', limits, store, jitterMs: 0, ...extra });
  return { pacer, tick: (ms: number) => (t += ms) };
}

describe('memory store (fake clock)', () => {
  it('admits up to rpm, then reports the wait for one request to refill', async () => {
    const { pacer } = clocked({ rpm: 3 });
    for (let i = 0; i < 3; i++) expect((await pacer.tryAcquire()).ok).toBe(true);
    const r = await pacer.tryAcquire();
    expect(r).toEqual({ ok: false, retryAfterMs: 20_000, reason: 'rpm' });
  });

  it('refills continuously over the window', async () => {
    const { pacer, tick } = clocked({ rpm: 60 });
    for (let i = 0; i < 60; i++) await pacer.tryAcquire();
    expect((await pacer.tryAcquire()).ok).toBe(false);
    tick(1000);
    expect((await pacer.tryAcquire()).ok).toBe(true);
    expect((await pacer.tryAcquire()).ok).toBe(false);
  });

  it('counts tokens, not just requests', async () => {
    const { pacer } = clocked({ tpm: 1000 });
    expect((await pacer.tryAcquire({ tokens: 700 })).ok).toBe(true);
    const r = await pacer.tryAcquire({ tokens: 400 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('tpm');
      expect(r.retryAfterMs).toBe(6000); // 100 missing tokens at 1000/60s
    }
  });

  it('rejects a request larger than the whole token budget', async () => {
    const { pacer } = clocked({ tpm: 1000 });
    await expect(pacer.tryAcquire({ tokens: 1001 })).rejects.toBeInstanceOf(PacerRequestTooLargeError);
  });

  it('settle refunds unused estimated tokens', async () => {
    const { pacer } = clocked({ tpm: 1000 });
    const r = await pacer.tryAcquire({ tokens: 800 });
    if (!r.ok) throw new Error('expected lease');
    await r.lease.settle(200);
    expect((await pacer.status()).tokensLeft).toBe(800);
    expect((await pacer.tryAcquire({ tokens: 750 })).ok).toBe(true);
  });

  it('settle charges extra when real usage beats the estimate', async () => {
    const { pacer } = clocked({ tpm: 1000 });
    const r = await pacer.tryAcquire({ tokens: 100 });
    if (!r.ok) throw new Error('expected lease');
    await r.lease.settle(1300);
    expect((await pacer.status()).tokensLeft).toBe(-300);
    expect((await pacer.tryAcquire({ tokens: 1 })).ok).toBe(false);
  });

  it('settle is idempotent', async () => {
    const { pacer } = clocked({ tpm: 1000 });
    const r = await pacer.tryAcquire({ tokens: 500 });
    if (!r.ok) throw new Error('expected lease');
    await r.lease.settle(0);
    await r.lease.settle(0);
    expect((await pacer.status()).tokensLeft).toBe(1000);
  });

  it('cancel refunds the request and its tokens', async () => {
    const { pacer } = clocked({ rpm: 1, tpm: 100 });
    const r = await pacer.tryAcquire({ tokens: 100 });
    if (!r.ok) throw new Error('expected lease');
    await r.lease.cancel();
    expect((await pacer.tryAcquire({ tokens: 100 })).ok).toBe(true);
  });

  it('caps calls in flight and frees a slot on settle', async () => {
    const { pacer } = clocked({ concurrency: 2 });
    const a = await pacer.tryAcquire();
    await pacer.tryAcquire();
    const c = await pacer.tryAcquire();
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toBe('concurrency');
    if (a.ok) await a.lease.settle();
    expect((await pacer.tryAcquire()).ok).toBe(true);
  });

  it('frees a slot whose holder crashed once the lease expires', async () => {
    const { pacer, tick } = clocked({ concurrency: 1 }, { leaseTtlMs: 5000 });
    await pacer.tryAcquire(); // never settled
    expect((await pacer.tryAcquire()).ok).toBe(false);
    tick(5001);
    expect((await pacer.tryAcquire()).ok).toBe(true);
  });

  it('observe lowers the budget to what the provider reports, never raises it', async () => {
    const { pacer } = clocked({ rpm: 100, tpm: 10_000 });
    await pacer.observe({ 'x-ratelimit-remaining-requests': '5', 'x-ratelimit-remaining-tokens': '2500' });
    let s = await pacer.status();
    expect([s.requestsLeft, s.tokensLeft]).toEqual([5, 2500]);
    await pacer.observe({ 'x-ratelimit-remaining-requests': '99', 'x-ratelimit-remaining-tokens': '9999' });
    s = await pacer.status();
    expect([s.requestsLeft, s.tokensLeft]).toEqual([5, 2500]);
  });

  it('pause blocks every caller until it ends', async () => {
    const { pacer, tick } = clocked({ rpm: 100 });
    await pacer.pause(3000);
    const r = await pacer.tryAcquire();
    expect(r).toEqual({ ok: false, retryAfterMs: 3000, reason: 'penalty' });
    expect((await pacer.status()).pausedForMs).toBe(3000);
    tick(3000);
    expect((await pacer.tryAcquire()).ok).toBe(true);
  });

  it('enforces a daily cap', async () => {
    const { pacer } = clocked({ rpd: 2 });
    await pacer.tryAcquire();
    await pacer.tryAcquire();
    const r = await pacer.tryAcquire();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('rpd');
  });

  it('validates limits', () => {
    expect(() => createPacer({ name: 'x', limits: {} })).toThrow(/at least one/);
    expect(() => createPacer({ name: 'x', limits: { rpm: -1 } })).toThrow(/positive/);
    expect(() => createPacer({ name: '', limits: { rpm: 1 } })).toThrow(/name/);
  });
});
