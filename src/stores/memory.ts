import type { PacerStore, StoreConfig, StoreOp, StoreReply, LimitReason } from '../types.js';

interface State {
  r: number;
  t: number;
  d: number;
  ts: number;
  blk: number;
  i: number;
  o: number;
  leases: Map<string, number>;
}

const DAY = 86_400_000;

/**
 * In-process store with the same behaviour as the Redis script. Use it for
 * tests, scripts and single-process apps. It does not coordinate across
 * processes; use the Redis store for that.
 */
export class MemoryStore implements PacerStore {
  private states = new Map<string, State>();
  constructor(private readonly now: () => number = Date.now) {}

  async exec(key: string, cfg: StoreConfig, op: StoreOp, args: Array<string | number>): Promise<StoreReply> {
    const now = this.now();
    const { rpm, tpm, rpd, concurrency: conc, windowMs: win, itpm, otpm } = cfg;
    let s = this.states.get(key);
    if (!s || op === 'reset') {
      s = { r: rpm, t: tpm, d: rpd, ts: now, blk: 0, i: itpm, o: otpm, leases: new Map() };
      this.states.set(key, s);
    }
    const el = Math.max(0, now - s.ts);
    if (rpm > 0) s.r = Math.min(rpm, s.r + (el * rpm) / win);
    if (tpm > 0) s.t = Math.min(tpm, s.t + (el * tpm) / win);
    if (rpd > 0) s.d = Math.min(rpd, s.d + (el * rpd) / DAY);
    if (itpm > 0) s.i = Math.min(itpm, s.i + (el * itpm) / win);
    if (otpm > 0) s.o = Math.min(otpm, s.o + (el * otpm) / win);
    s.ts = now;
    if (conc > 0) for (const [id, exp] of s.leases) if (exp <= now) s.leases.delete(id);

    const st = s;
    const reply = (ok: 1 | 0 | -1, wait: number, reason: LimitReason | ''): StoreReply => ({
      ok,
      waitMs: Math.ceil(wait),
      requestsLeft: Math.floor(st.r),
      tokensLeft: Math.floor(st.t),
      dailyLeft: Math.floor(st.d),
      inflight: conc > 0 ? st.leases.size : 0,
      reason,
      inputTokensLeft: Math.floor(st.i),
      outputTokensLeft: Math.floor(st.o),
    });

    switch (op) {
      case 'acquire': {
        const cost = Number(args[0]);
        const leaseId = String(args[1]);
        const leaseTtl = Number(args[2]);
        const costIn = Number(args[3] ?? 0);
        const costOut = Number(args[4] ?? 0);
        if ((tpm > 0 && cost > tpm) || (itpm > 0 && costIn > itpm) || (otpm > 0 && costOut > otpm))
          return reply(-1, 0, 'too_large');
        let wait = 0;
        let reason: LimitReason | '' = '';
        const consider = (w: number, why: LimitReason) => {
          if (w > wait) {
            wait = w;
            reason = why;
          }
        };
        if (s.blk > now) consider(s.blk - now, 'penalty');
        if (rpm > 0 && s.r < 1) consider(((1 - s.r) * win) / rpm, 'rpm');
        if (tpm > 0 && s.t < cost) consider(((cost - s.t) * win) / tpm, 'tpm');
        if (rpd > 0 && s.d < 1) consider(((1 - s.d) * DAY) / rpd, 'rpd');
        if (itpm > 0 && s.i < costIn) consider(((costIn - s.i) * win) / itpm, 'itpm');
        if (otpm > 0 && s.o < costOut) consider(((costOut - s.o) * win) / otpm, 'otpm');
        if (conc > 0 && s.leases.size >= conc) {
          const first = Math.min(...s.leases.values());
          consider(Math.max(1, Math.min(first - now, 250)), 'concurrency');
        }
        if (wait > 0) return reply(0, wait, reason);
        if (rpm > 0) s.r -= 1;
        if (tpm > 0) s.t -= cost;
        if (rpd > 0) s.d -= 1;
        if (itpm > 0) s.i -= costIn;
        if (otpm > 0) s.o -= costOut;
        if (conc > 0) s.leases.set(leaseId, now + leaseTtl);
        return reply(1, 0, '');
      }
      case 'settle': {
        const [leaseId, estimated, actual, refundRequest, estIn = 0, actIn = -1, estOut = 0, actOut = -1] = args;
        if (tpm > 0 && Number(actual) >= 0) s.t = Math.min(tpm, s.t + Number(estimated) - Number(actual));
        if (itpm > 0 && Number(actIn) >= 0) s.i = Math.min(itpm, s.i + Number(estIn) - Number(actIn));
        if (otpm > 0 && Number(actOut) >= 0) s.o = Math.min(otpm, s.o + Number(estOut) - Number(actOut));
        if (Number(refundRequest) === 1) {
          if (rpm > 0) s.r = Math.min(rpm, s.r + 1);
          if (rpd > 0) s.d = Math.min(rpd, s.d + 1);
        }
        s.leases.delete(String(leaseId));
        return reply(1, 0, '');
      }
      case 'observe': {
        const remReq = Number(args[0]);
        const remTok = Number(args[1]);
        const remIn = Number(args[2] ?? -1);
        const remOut = Number(args[3] ?? -1);
        if (rpm > 0 && remReq >= 0 && remReq < s.r) s.r = remReq;
        if (tpm > 0 && remTok >= 0 && remTok < s.t) s.t = remTok;
        if (itpm > 0 && remIn >= 0 && remIn < s.i) s.i = remIn;
        if (otpm > 0 && remOut >= 0 && remOut < s.o) s.o = remOut;
        return reply(1, 0, '');
      }
      case 'penalize': {
        s.blk = Math.max(s.blk, now + Number(args[0]));
        return reply(1, 0, '');
      }
      case 'reset':
        return reply(1, 0, '');
      default:
        return reply(1, s.blk > now ? s.blk - now : 0, '');
    }
  }
}
