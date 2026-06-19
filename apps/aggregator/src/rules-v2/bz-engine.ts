// Bull/Bear-Zone engine (DD-Ratio matrix). From Light_8 (DD bullish) + Light_9 (DD
// bearish). Ties DD sign × where price OPENED (LM Open = B / MR / Br) → direction,
// size, and target at the zones — distinct from the pivot engines (which key off the
// CURRENT price). "Useful when there is no catalyst or event active."
//
//                 DD>0.5 (bullish)                     DD<0.5 (bearish)
//  Open B   long N → next resistance              long M → next res (closes in opening zone)
//  Open MR  long N, MR breaks UPSIDE → BZB tap    short S, MR breaks DOWNSIDE → BrZT tap
//  Open Br  long N → BZB tap only (closes in zone)  short N → next resistance (down)
//
// Pure, gate-aware, emits candidate Setups (family 'BZ') for the shadow harness.
import type { MarketState, Setup, SizeTier } from './engine-types.js';

const BZ_STRIKE: Record<'NQ' | 'ES', number> = { NQ: 40, ES: 10 };
const bzDown = (t: SizeTier): SizeTier => (t === 'N' ? 'M' : t === 'M' ? 'S' : t === 'S' ? 'S' : '0');
const bzCap = (t: SizeTier, max: SizeTier): SizeTier => (['N', 'M', 'S', '0'].indexOf(t) >= ['N', 'M', 'S', '0'].indexOf(max) ? t : max);
const bzUniqSort = (xs: Array<number | undefined>): number[] =>
  Array.from(new Set(xs.filter((x): x is number => x != null && Number.isFinite(x)))).sort((a, b) => a - b);

/** Open-zone from the LM-code prefix: 'Br' (bear), 'B' (bull), else 'MR' (pocket). */
export function openZone(lmCode?: string): 'B' | 'Br' | 'MR' {
  if (!lmCode) return 'MR';
  if (lmCode.startsWith('Br')) return 'Br';
  if (lmCode.startsWith('B')) return 'B';
  return 'MR';
}

export function evaluateBullBearZone(ms: MarketState, opts: { proximityPts?: number; maxTargets?: number } = {}): Setup[] {
  const out: Setup[] = [];
  if (ms.price == null || ms.gate.mode === 'sit-out') return out;
  const strike = BZ_STRIKE[ms.symbol];
  const prox = opts.proximityPts ?? strike / 5;
  const maxT = opts.maxTargets ?? 3;
  const price = ms.price;
  const dd = ms.confluence.ddRatio;
  const ddBull = dd > 0.5;
  const oz = openZone(ms.lmCode);
  const { bzb, brzt } = ms.levels;

  const all = bzUniqSort([
    ...bzb, ...brzt, ms.levels.hp, ms.levels.mhp, ms.levels.dynHp, ms.levels.dynMhp,
    ms.levels.onHp, ms.levels.onMhp, ms.levels.ddUpper, ms.levels.ddLower, ms.halfGap, ms.prevClose,
  ]);
  const tgtUp = (lvl: number) => all.filter(l => l > lvl + 1).slice(0, maxT);
  const tgtDn = (lvl: number) => all.filter(l => l < lvl - 1).reverse().slice(0, maxT);
  const sizeGate = (base: SizeTier): SizeTier => {
    let t = ms.gate.sizeDown ? bzDown(base) : base;
    if (ms.gate.mode === 'strong-pivots-small') t = bzCap(t, 'S');
    return t;
  };
  const nearBZB = bzb.find(b => Math.abs(price - b) <= prox);
  const nearBrZT = brzt.find(b => Math.abs(price - b) <= prox);
  const bzbAbove = bzb.filter(b => b > price + 1).sort((a, b) => a - b)[0];
  const brztBelow = brzt.filter(b => b < price - 1).sort((a, b) => b - a)[0];

  // Open B — at the bull-zone support (BZB) → long. DD>0.5 N to next res; DD<0.5 M (closes in opening zone).
  if (oz === 'B' && nearBZB != null) {
    out.push({
      family: 'BZ', pivot: 'open-B@BZB', level: nearBZB, direction: 'long', sizeTier: sizeGate(ddBull ? 'N' : 'M'),
      entry: price, stop: +(nearBZB - strike).toFixed(2), targets: tgtUp(nearBZB), bounceVsBreak: 'bounce', baseProb: ddBull ? 0.80 : 0.65,
      confluenceNote: `open in bull zone · DD ${dd} → ${ddBull ? 'long N to next resistance (bull-zone support)' : 'long M; more likely closes in opening zone'}`,
    });
  }
  // Open Br — at the bear-zone top. DD>0.5 long to BZB tap only (closes in zone); DD<0.5 short to next res.
  else if (oz === 'Br' && nearBrZT != null) {
    if (ddBull) {
      out.push({
        family: 'BZ', pivot: 'open-Br@BrZT', level: nearBrZT, direction: 'long', sizeTier: sizeGate('N'),
        entry: price, stop: +(nearBrZT - strike).toFixed(2), targets: bzbAbove != null ? [bzbAbove] : tgtUp(nearBrZT), bounceVsBreak: 'bounce', baseProb: 0.65,
        confluenceNote: `open in bear zone · DD ${dd} → long N, bull-zone tap only @${bzbAbove ?? '?'} (more likely closes in opening zone)`,
      });
    } else if (!ms.gate.longOnly) {
      out.push({
        family: 'BZ', pivot: 'open-Br@BrZT', level: nearBrZT, direction: 'short', sizeTier: sizeGate('N'),
        entry: price, stop: +(nearBrZT + strike).toFixed(2), targets: tgtDn(nearBrZT), bounceVsBreak: 'bounce', baseProb: 0.80,
        confluenceNote: `open in bear zone · DD ${dd} → short N to next resistance (down)`,
      });
    }
  }
  // Open MR (pocket) — DD>0.5 long (MR breaks upside → BZB tap); DD<0.5 short (breaks downside → BrZT tap).
  else if (oz === 'MR' && brztBelow != null && bzbAbove != null && price > brztBelow && price < bzbAbove) {
    if (ddBull) {
      out.push({
        family: 'BZ', pivot: 'open-MR(pocket)', level: bzbAbove, direction: 'long', sizeTier: sizeGate('N'),
        entry: price, stop: +(price - strike).toFixed(2), targets: [bzbAbove, ...tgtUp(bzbAbove)].slice(0, maxT), bounceVsBreak: 'bounce', baseProb: 0.70,
        confluenceNote: `open in MR pocket · DD ${dd} → breaks MR tie UPSIDE, bull-zone tap @${bzbAbove}`,
      });
    } else if (!ms.gate.longOnly) {
      out.push({
        family: 'BZ', pivot: 'open-MR(pocket)', level: brztBelow, direction: 'short', sizeTier: sizeGate('S'),
        entry: price, stop: +(price + strike).toFixed(2), targets: [brztBelow, ...tgtDn(brztBelow)].slice(0, maxT), bounceVsBreak: 'bounce', baseProb: 0.65,
        confluenceNote: `open in MR pocket · DD ${dd} → breaks MR tie DOWNSIDE, bear-zone tap @${brztBelow}`,
      });
    }
  }
  return out;
}
