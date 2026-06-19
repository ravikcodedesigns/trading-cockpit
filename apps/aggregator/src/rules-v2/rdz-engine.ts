// Redistribution-Zone engine (Phase 6, full resilience modes). From Light_10 (bullish)
// + Light_11 (bearish) + transcripts 4 & 13. The RDZ is the open↔prev-close gap "box";
// WHITE (redistribution) resilience tie-breaks it. Direction at every RDZ pivot = the
// sign of resilience (resW>0 long / resW<0 short). Three modes:
//
//   Mode I  — INSIDE the box (at HG): tiebreak to the TOP (long, Res>0) or BOTTOM
//             (short, Res<0) of the box.
//   Mode II — OUTSIDE the box (at the near edge):
//             • top edge:    Res>0 → top-of-box is support, gap holds (long)
//                            Res<0 → gap likely to fade down (short)
//             • bottom edge: Res<0 → bottom-of-box is resistance, gap holds (short)
//                            Res>0 → gap likely to fade up (long)
//
// Valid only when RATIONAL + a NORMAL gate (B+ tier). Flat-day skip: gap < 1 strike AND
// |resW| <= 50 (resilience is noise; |resW|>50 overrides). open/half-gap/close double as
// gap-fill exit levels (gapFillTargets). Pure, gate-aware, emits Setups (family 'RDZ').
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
  if (gap < strike && Math.abs(resW) <= 50) return out; // flat-day skip
  if (resW === 0) return out;

  const lo = Math.min(open, close), hi = Math.max(open, close);
  const long = resW > 0;
  if (!long && ms.gate.longOnly) return out; // long-only gate drops the bearish RDZ

  const all = rdzUniqSort([
    ...ms.levels.bzb, ...ms.levels.brzt, ms.levels.hp, ms.levels.mhp, ms.levels.dynHp, ms.levels.dynMhp,
    ms.levels.onHp, ms.levels.onMhp, ms.levels.ddUpper, ms.levels.ddLower, hg, open, close,
  ]);
  const sizeGate = (base: SizeTier): SizeTier => (ms.gate.sizeDown ? rdzDown(base) : base);
  const emit = (pivot: string, level: number, note: string) => {
    out.push({
      family: 'RDZ', pivot, level, direction: long ? 'long' : 'short', sizeTier: sizeGate('M'),
      entry: price, stop: long ? +(level - strike).toFixed(2) : +(level + strike).toFixed(2),
      targets: long ? all.filter(l => l > price + 1).slice(0, maxT) : all.filter(l => l < price - 1).reverse().slice(0, maxT),
      bounceVsBreak: 'bounce', baseProb: 0.72, confluenceNote: note,
    });
  };
  const box = `box ${lo}-${hi}`;
  const res = `Res ${resW > 0 ? '+' : ''}${resW}`;

  // Mode I — inside the box, at the half-gap.
  if (price > lo && price < hi && Math.abs(price - hg) <= prox) {
    emit('HG', hg, `Mode I (inside RDZ) · HG tiebreak to ${long ? 'top' : 'bottom'} of box · ${res} · ${box}`);
  }
  // Mode II — top edge.
  if (Math.abs(price - hi) <= prox) {
    emit('RDZ-top', hi, `Mode II (top edge) · ${res} → ${long ? 'top of box is support, gap holds' : 'gap likely to fade down'} · ${box}`);
  }
  // Mode II — bottom edge.
  if (Math.abs(price - lo) <= prox) {
    emit('RDZ-bottom', lo, `Mode II (bottom edge) · ${res} → ${long ? 'gap likely to fade up' : 'bottom of box is resistance, gap holds'} · ${box}`);
  }
  return out;
}

/** Gap-fill / RDZ exit levels (open, prev close, half-gap) — for the exit layer. */
export function gapFillTargets(ms: MarketState): number[] {
  return rdzUniqSort([ms.open, ms.prevClose, ms.halfGap]);
}
