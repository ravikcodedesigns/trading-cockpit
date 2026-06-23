// LM engine (Phase 3). The Liquidity-Map "Summary" read: given the day's LM code
// (zone B/Br + HP side L/S + HP-vs-MHP U/D), what direction/target does the day
// resolve to, and with what empirical probability. Anchored on the SPY study
// (spy-liquidity-maps-and-whp-breaks.png, HumbleTrader77 2025-04-18) — NOT guessed.
//
// Encodes BOTH: (a) per-code empirical odds (LM_ODDS, SPY study) and (b) the full
// Light_1 per-leg playbook (LM_PLAYBOOK) — extracted by tiling the 8000×4500 source
// and VERIFIED by Ravi 2026-06-18. Two "Break Only" legs (BrSD #3, BSD #2) have no
// stated size in the diagram → defaulted to S (⚠️ verify).
import type { MarketState, Setup, Dir, SizeTier } from './engine-types.js';

export interface LmRead {
  code: string;                    // LM code (one of the 8) or 'MR' (open in liquidity pocket)
  bias: 'bull' | 'bear' | 'neutral';
  target: 'BZB' | 'BrZT' | null;   // empirical resolution target
  targetLevel?: number;            // nearest BZB / BrZT price in the bias direction
  prob: number;                    // same-side resolution probability (SPY study)
  note: string;
}

// Per-code empirical odds. Bull-zone codes resolve to the bull-zone bottom (BZB),
// bear-zone codes to the bear-zone top (BrZT). L-codes beat S-codes within a group.
const LM_ODDS: Record<string, { target: 'BZB' | 'BrZT'; prob: number }> = {
  BLU: { target: 'BZB', prob: 0.539 }, BSU: { target: 'BZB', prob: 0.611 },
  BLD: { target: 'BZB', prob: 0.724 }, BSD: { target: 'BZB', prob: 0.667 },
  BrLU: { target: 'BrZT', prob: 0.571 }, BrSU: { target: 'BrZT', prob: 0.545 },
  BrLD: { target: 'BrZT', prob: 0.800 }, BrSD: { target: 'BrZT', prob: 0.667 },
};

const nearest = (xs: number[], to: number): number | undefined =>
  xs.length ? xs.reduce((a, b) => (Math.abs(b - to) < Math.abs(a - to) ? b : a)) : undefined;

/** The day's LM-code read for the current MarketState (null if no code + no open/HP). */
export function lmRead(ms: MarketState): LmRead | null {
  const code = ms.lmCode;
  if (code && LM_ODDS[code]) {
    const o = LM_ODDS[code];
    const bias = o.target === 'BZB' ? 'bull' : 'bear';
    const targetLevel = o.target === 'BZB' ? nearest(ms.levels.bzb, ms.price ?? 0) : nearest(ms.levels.brzt, ms.price ?? 0);
    return { code, bias, target: o.target, targetLevel, prob: o.prob, note: `${code} → ${o.target} ${(o.prob * 100).toFixed(0)}% (SPY study)` };
  }
  // MR / open-in-liquidity-pocket: bias from open vs weekly HP. open<WHP → 70% BZB / 30% BrZT; open>WHP → 50/50.
  if (ms.open != null && ms.levels.hp != null) {
    const up = ms.open < ms.levels.hp;
    return up
      ? { code: 'MR', bias: 'bull', target: 'BZB', targetLevel: nearest(ms.levels.bzb, ms.price ?? 0), prob: 0.70, note: 'MR open<WHP → 70% BZB / 30% BrZT' }
      : { code: 'MR', bias: 'neutral', target: null, prob: 0.50, note: 'MR open>WHP → 50/50 BZB/BrZT (no edge)' };
  }
  return null;
}

/** Does an EST setup's direction agree with the LM-code bias? */
export function lmAgrees(read: LmRead | null, direction: Dir): boolean | null {
  if (!read || read.bias === 'neutral') return null;
  return (read.bias === 'bull') === (direction === 'long');
}

/** Annotate EST setups with the LM read (agreement + code prob) for the shadow log.
 *  Does NOT change sizing — EST is take-every-time; LM is context surfaced for analysis. */
export function annotateWithLm(ms: MarketState, setups: Setup[]): Array<Setup & { lmCode: string; lmBias: LmRead['bias']; lmProb: number; lmAgrees: boolean | null }> {
  const read = lmRead(ms);
  return setups.map(s => ({
    ...s,
    lmCode: read?.code ?? '?',
    lmBias: read?.bias ?? 'neutral',
    lmProb: read?.prob ?? 0,
    lmAgrees: lmAgrees(read, s.direction),
  }));
}

// ── Light_1 LM Summary playbook (verified transcription, Ravi 2026-06-18) ──────────
// Per LM code: the ordered legs, each with a direction, a size rule, and an
// entry-pivot hint. Size gates: `res` = redistribution/half-gap resilience (white),
// `mres` = MHP resilience (orange), `dd` = DD ratio. '0' = sit-out (O on the sheet).
export type LegGate =
  | { kind: 'fixed'; size: SizeTier }
  | { kind: 'dd'; gt: SizeTier; lt: SizeTier }       // DD>0.5 → gt, else lt
  | { kind: 'res'; pos: SizeTier; neg: SizeTier }    // Res (white) >0 → pos, else neg
  | { kind: 'mres'; pos: SizeTier; neg: SizeTier };  // MRes (orange) >0 → pos, else neg

export interface LmLeg {
  id: string;                                  // '1' | '1a' | '1b' | '2' | '3' | '4'
  dir: Dir;
  gate: LegGate;
  at: 'open' | 'hp' | 'mhp' | 'zone' | 'break';  // entry-pivot hint (for wiring)
  breakOnly?: string;                          // leg only arms on this code's break
  note?: string;
}

export const LM_PLAYBOOK: Record<string, LmLeg[]> = {
  IP: [
    { id: '1', dir: 'long',  gate: { kind: 'dd', gt: 'N', lt: 'M' }, at: 'zone' },
    { id: '2', dir: 'short', gate: { kind: 'dd', gt: '0', lt: 'N' }, at: 'zone' },
  ],
  LP: [
    { id: '1', dir: 'long', gate: { kind: 'dd', gt: 'N', lt: 'S' }, at: 'zone' },
  ],
  BLU: [
    { id: '1a', dir: 'long', gate: { kind: 'res', pos: 'S', neg: '0' }, at: 'open' },
    { id: '1b', dir: 'long', gate: { kind: 'fixed', size: 'M' }, at: 'hp' },
  ],
  BLD: [
    { id: '1a', dir: 'long',  gate: { kind: 'res', pos: 'S', neg: '0' }, at: 'open' },
    { id: '1b', dir: 'long',  gate: { kind: 'fixed', size: 'M' }, at: 'hp' },
    { id: '2',  dir: 'short', gate: { kind: 'mres', pos: '0', neg: 'N' }, at: 'mhp' },
    { id: '3',  dir: 'long',  gate: { kind: 'fixed', size: 'S' }, at: 'mhp' },
    { id: '4',  dir: 'long',  gate: { kind: 'fixed', size: 'M' }, at: 'mhp', note: 'MHP break-up continuation' },
  ],
  BrSD: [
    { id: '1', dir: 'long',  gate: { kind: 'fixed', size: '0' }, at: 'open' },           // O = sit at open
    { id: '2', dir: 'long',  gate: { kind: 'fixed', size: 'M' }, at: 'mhp' },
    { id: '3', dir: 'short', gate: { kind: 'fixed', size: 'S' }, at: 'break', breakOnly: 'BrLD', note: '⚠️ size not stated (break leg) → default S' },
    { id: '4', dir: 'short', gate: { kind: 'mres', pos: '0', neg: 'N' }, at: 'mhp' },
  ],
  BrSU: [
    { id: '1a', dir: 'short', gate: { kind: 'fixed', size: 'S' }, at: 'open' },
    { id: '1b', dir: 'short', gate: { kind: 'mres', pos: '0', neg: 'M' }, at: 'open' },
    { id: '2',  dir: 'long',  gate: { kind: 'mres', pos: 'N', neg: 'S' }, at: 'mhp' },
    { id: '3',  dir: 'short', gate: { kind: 'fixed', size: 'S' }, at: 'mhp' },
  ],
  BrLU: [
    { id: '1a', dir: 'long', gate: { kind: 'res', pos: 'S', neg: '0' }, at: 'open' },
    { id: '1b', dir: 'long', gate: { kind: 'fixed', size: 'M' }, at: 'hp' },
  ],
  BrLD: [
    { id: '1', dir: 'short', gate: { kind: 'dd', gt: '0', lt: 'N' }, at: 'open' },
    { id: '2', dir: 'short', gate: { kind: 'mres', pos: '0', neg: 'N' }, at: 'mhp' },
  ],
  BSD: [
    { id: '1', dir: 'long', gate: { kind: 'fixed', size: '0' }, at: 'open' },            // O = sit at open
    { id: '2', dir: 'long', gate: { kind: 'fixed', size: 'S' }, at: 'break', breakOnly: 'BSD', note: '⚠️ size not stated (break leg) → default S' },
  ],
  BSU: [
    { id: '1', dir: 'long', gate: { kind: 'dd', gt: 'N', lt: 'M' }, at: 'open' },
    { id: '2', dir: 'long', gate: { kind: 'mres', pos: 'N', neg: 'M' }, at: 'mhp' },
    { id: '3', dir: 'long', gate: { kind: 'mres', pos: 'N', neg: 'M' }, at: 'mhp' },
  ],
};

/** Resolve a leg's size tier from the current confluence. */
export function legSize(gate: LegGate, c: { ddRatio: number; resWhite: number; resOrange: number }): SizeTier {
  switch (gate.kind) {
    case 'fixed': return gate.size;
    case 'dd':    return c.ddRatio > 0.5 ? gate.gt : gate.lt;
    case 'res':   return c.resWhite > 0 ? gate.pos : gate.neg;
    case 'mres':  return c.resOrange > 0 ? gate.pos : gate.neg;
  }
}

/** The active LM code's playbook legs, sized for the current confluence. */
export function lmLegs(ms: MarketState): Array<LmLeg & { size: SizeTier }> {
  const legs = ms.lmCode ? LM_PLAYBOOK[ms.lmCode] : undefined;
  if (!legs) return [];
  const c = { ddRatio: ms.confluence.ddRatio, resWhite: ms.confluence.resWhite, resOrange: ms.confluence.resOrange };
  return legs.map(l => ({ ...l, size: legSize(l.gate, c) }));
}

// ── LM playbook → candidate Setups (gate-aware), for the shadow harness ────────────
const LM_STRIKE: Record<'NQ' | 'ES', number> = { NQ: 40, ES: 10 };
const LM_TIERS: SizeTier[] = ['N', 'M', 'S', '0'];
const lmDown = (t: SizeTier): SizeTier => (t === 'N' ? 'M' : t === 'M' ? 'S' : t === 'S' ? 'S' : '0');
const lmCap = (t: SizeTier, max: SizeTier): SizeTier => (LM_TIERS.indexOf(t) >= LM_TIERS.indexOf(max) ? t : max);
const lmUniqSort = (xs: Array<number | undefined>): number[] =>
  Array.from(new Set(xs.filter((x): x is number => x != null && Number.isFinite(x)))).sort((a, b) => a - b);

/** Emit the active LM-code's playbook legs as candidate Setups when price is at each
 *  leg's pivot. Gate-aware (sit-out→none, strong-pivots-small→cap S, long-only→drop
 *  shorts, sizeDown→step down). 'break' legs are skipped (need break-state wiring). */
export function evaluateLmSetups(ms: MarketState, opts: { proximityPts?: number; maxTargets?: number } = {}): Setup[] {
  const out: Setup[] = [];
  if (ms.price == null || ms.gate.mode === 'sit-out' || !ms.lmCode) return out;
  const strike = LM_STRIKE[ms.symbol];
  const prox = opts.proximityPts ?? strike / 5;
  const maxT = opts.maxTargets ?? 3;
  const price = ms.price;
  const read = lmRead(ms);
  const all = lmUniqSort([
    ...ms.levels.bzb, ...ms.levels.brzt, ms.levels.hp, ms.levels.mhp, ms.levels.dynHp, ms.levels.dynMhp,
    ms.levels.onHp, ms.levels.onMhp, ms.levels.ddUpper, ms.levels.ddLower, ms.halfGap, ms.prevClose,
  ]);
  const legLevel = (at: LmLeg['at'], dir: Dir): number | undefined => {
    switch (at) {
      case 'open': return ms.open;
      case 'hp': return ms.levels.hp;
      case 'mhp': return ms.levels.mhp;
      case 'zone': return dir === 'long' ? nearest(ms.levels.bzb, price) : nearest(ms.levels.brzt, price);
      case 'break': return undefined; // break legs need break-state — skipped for now
    }
  };
  for (const leg of lmLegs(ms)) {
    if (leg.size === '0' || leg.breakOnly) continue;            // sit-out + break legs skipped
    if (leg.dir === 'short' && ms.gate.longOnly) continue;
    const level = legLevel(leg.at, leg.dir);
    if (level == null || Math.abs(price - level) > prox) continue;
    let tier: SizeTier = ms.gate.sizeDown ? lmDown(leg.size) : leg.size;
    if (ms.gate.mode === 'strong-pivots-small') tier = lmCap(tier, 'S');
    out.push({
      family: 'LM', pivot: `${ms.lmCode}#${leg.id}@${leg.at}`, level, direction: leg.dir, sizeTier: tier,
      entry: price,
      stop: leg.dir === 'long' ? +(level - strike).toFixed(2) : +(level + strike).toFixed(2),
      targets: leg.dir === 'long' ? all.filter(l => l > level + 1).slice(0, maxT) : all.filter(l => l < level - 1).reverse().slice(0, maxT),
      bounceVsBreak: 'bounce',
      baseProb: read?.prob ?? 0,
      confluenceNote: `LM ${ms.lmCode} leg ${leg.id} @${leg.at}${leg.note ? ` · ${leg.note}` : ''}`,
    });
  }
  return out;
}
