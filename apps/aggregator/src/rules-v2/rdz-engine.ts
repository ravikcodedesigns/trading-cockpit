// Redistribution-Zone engine (Phase 6). From Light_10/11 (resilience) + transcripts
// 4 & 13. The RDZ is the open↔prev-close gap "box"; the half-gap (HG) is its most
// decisive pivot, tie-broken by WHITE (redistribution) resilience.
//
//   resW>0 → long to the TOP of the box (gap-and-go);  resW<0 → short to the BOTTOM
//   (gap fade). Valid only when RATIONAL; skip flat days (gap < 1 strike AND |resW|
//   <= 50 → resilience is noise). RDZ is a B+ tier (weaker than the strong pivots),
//   so it only fires on a NORMAL gate. open/half-gap/close double as gap-fill exit
//   targets (gapFillTargets, for the future exit layer).
// Pure, gate-aware, emits candidate Setups (family 'RDZ') for the shadow harness.
import type { MarketState, Setup, SizeTier } from './engine-types.js';

const RDZ_STRIKE: Record<'NQ' | 'ES', number> = { NQ: 40, ES: 10 };
const rdzDown = (t: SizeTier): SizeTier => (t === 'N' ? 'M' : t === 'M' ? 'S' : t === 'S' ? 'S' : '0');
const rdzUniqSort = (xs: Array<number | undefined>): number[] =>
  Array.from(new Set(xs.filter((x): x is number => x != null && Number.isFinite(x)))).sort((a, b) => a - b);

export function evaluateRdz(ms: MarketState, opts: { proximityPts?: number; maxTargets?: number } = {}): Setup[] {
  const out: Setup[] = [];
  // RDZ is resilience-based and B+ tier → only on a fully rational, normal gate.
  if (ms.price == null || ms.gate.mode !== 'normal' || !ms.confluence.isRational) return out;
  const open = ms.open, close = ms.prevClose, hg = ms.halfGap;
  if (open == null || close == null || hg == null) return out;

  const strike = RDZ_STRIKE[ms.symbol];
  const prox = opts.proximityPts ?? strike / 5;
  const maxT = opts.maxTargets ?? 3;
  const price = ms.price;
  const resW = ms.confluence.resWhite;
  const gap = Math.abs(open - close);
  // Flat-day gate: gap under 1 strike AND weak resilience → resilience is noise.
  if (gap < strike && Math.abs(resW) <= 50) return out;
  if (resW === 0) return out;

  const lo = Math.min(open, close), hi = Math.max(open, close);
  const all = rdzUniqSort([
    ...ms.levels.bzb, ...ms.levels.brzt, ms.levels.hp, ms.levels.mhp, ms.levels.dynHp, ms.levels.dynMhp,
    ms.levels.onHp, ms.levels.onMhp, ms.levels.ddUpper, ms.levels.ddLower, hg, open, close,
  ]);
  const sizeGate = (base: SizeTier): SizeTier => (ms.gate.sizeDown ? rdzDown(base) : base);

  // Half-gap (HG) tiebreak — the most decisive RDZ pivot.
  if (Math.abs(price - hg) <= prox) {
    if (resW > 0) {
      out.push({
        family: 'RDZ', pivot: 'HG', level: hg, direction: 'long', sizeTier: sizeGate('M'),
        entry: price, stop: +(hg - strike).toFixed(2),
        targets: [hi, ...all.filter(l => l > hi + 1)].slice(0, maxT), bounceVsBreak: 'bounce', baseProb: 0.72,
        confluenceNote: `half-gap tiebreak · Res +${resW} → top of box (gap-and-go) · box ${lo}-${hi}`,
      });
    } else if (!ms.gate.longOnly) {
      out.push({
        family: 'RDZ', pivot: 'HG', level: hg, direction: 'short', sizeTier: sizeGate('M'),
        entry: price, stop: +(hg + strike).toFixed(2),
        targets: [lo, ...all.filter(l => l < lo - 1).reverse()].slice(0, maxT), bounceVsBreak: 'bounce', baseProb: 0.72,
        confluenceNote: `half-gap tiebreak · Res ${resW} → bottom of box (gap fade) · box ${lo}-${hi}`,
      });
    }
  }
  return out;
}

/** Gap-fill / RDZ exit levels (open, prev close, half-gap) — for the exit layer. */
export function gapFillTargets(ms: MarketState): number[] {
  return rdzUniqSort([ms.open, ms.prevClose, ms.halfGap]);
}
