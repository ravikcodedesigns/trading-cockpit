// DD-Bands engine (Phase 5). From Light_4 + transcript 8. DD bands = prior close
// ± 1 Risk Interval; ~88% of days close inside (4% above upper / 8% below lower) —
// the highest-odds pivots in the suite. Volume acts as a repulsive magnet pushing
// price back inside; break = irrational (gate handles size via the panel read).
//
//   Lower band → LONG reclaim/bounce EVERY TIME (92% close above), N(DD>0.5)/M(DD<0.5);
//                NEVER short below; full-exit at the band; "float on" when DD bullish.
//   Upper band → SHORT only when DD<0.5 ("DD<0.5 ONLY", 96% close below); never fade an
//                upper-band break in a bull market; "float on" when DD bearish. When
//                DD>0.5 the upper band is an EXIT target for longs, not an entry.
// Pure, gate-aware, emits candidate Setups (family 'DDBAND') for the shadow harness.
import type { MarketState, Setup, SizeTier } from './engine-types.js';

const DD_STRIKE: Record<'NQ' | 'ES', number> = { NQ: 40, ES: 10 };
const DD_TIERS: SizeTier[] = ['N', 'M', 'S', '0'];
const ddDown = (t: SizeTier): SizeTier => (t === 'N' ? 'M' : t === 'M' ? 'S' : t === 'S' ? 'S' : '0');
const ddCap = (t: SizeTier, max: SizeTier): SizeTier => (DD_TIERS.indexOf(t) >= DD_TIERS.indexOf(max) ? t : max);
const ddUniqSort = (xs: Array<number | undefined>): number[] =>
  Array.from(new Set(xs.filter((x): x is number => x != null && Number.isFinite(x)))).sort((a, b) => a - b);

export function evaluateDdBands(ms: MarketState, opts: { proximityPts?: number; maxTargets?: number } = {}): Setup[] {
  const out: Setup[] = [];
  if (ms.price == null || ms.gate.mode === 'sit-out') return out;
  const strike = DD_STRIKE[ms.symbol];
  const prox = opts.proximityPts ?? strike / 5;
  const maxT = opts.maxTargets ?? 3;
  const price = ms.price;
  const dd = ms.confluence.ddRatio;
  const ddBull = dd > 0.5;
  const lower = ms.levels.ddLower;
  const upper = ms.levels.ddUpper;

  const all = ddUniqSort([
    ...ms.levels.bzb, ...ms.levels.brzt, ms.levels.hp, ms.levels.mhp, ms.levels.dynHp, ms.levels.dynMhp,
    ms.levels.onHp, ms.levels.onMhp, upper, lower, ms.halfGap, ms.prevClose,
  ]);
  const tgtUp = (lvl: number) => all.filter(l => l > lvl + 1).slice(0, maxT);
  const tgtDn = (lvl: number) => all.filter(l => l < lvl - 1).reverse().slice(0, maxT);
  const sizeGate = (base: SizeTier): SizeTier => {
    let t = ms.gate.sizeDown ? ddDown(base) : base;
    if (ms.gate.mode === 'strong-pivots-small') t = ddCap(t, 'S');
    return t;
  };

  // Lower DD band — LONG reclaim/bounce, every time (92%). Never short below it.
  if (lower != null && Math.abs(price - lower) <= prox) {
    out.push({
      family: 'DDBAND', pivot: 'DD-lower', level: lower, direction: 'long',
      sizeTier: sizeGate(ddBull ? 'N' : 'M'), entry: price, stop: +(lower - strike).toFixed(2),
      targets: tgtUp(lower), bounceVsBreak: 'reclaim', baseProb: 0.92,
      confluenceNote: `lower DD-band reclaim · ${ddBull ? 'float-on (bull)' : 'DD<0.5 → medium'} · full-exit at band, never short below · DD ${dd}`,
    });
  }

  // Upper DD band — SHORT only when DD<0.5 (DD<0.5 ONLY). No fade in a bull market.
  if (upper != null && Math.abs(price - upper) <= prox) {
    if (!ddBull && !ms.gate.longOnly) {
      out.push({
        family: 'DDBAND', pivot: 'DD-upper', level: upper, direction: 'short',
        sizeTier: sizeGate('N'), entry: price, stop: +(upper + strike).toFixed(2),
        targets: tgtDn(upper), bounceVsBreak: 'bounce', baseProb: 0.96,
        confluenceNote: `upper DD-band — DD<0.5 ONLY · float-on (bear) · full-exit at band · DD ${dd}`,
      });
    }
    // DD>0.5 at the upper band → no entry (exit target for longs; never fade a bull break-up).
  }

  return out;
}
