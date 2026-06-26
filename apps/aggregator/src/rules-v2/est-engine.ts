// EST engine (Phase 2 — MVP). Encodes the "Every Single Time" strong-pivot setups
// (RS_ENGINE_SPEC §4) on top of deriveMarketState. EST = take every time the gate
// allows; confluence only SIZES it (N/M/S, never 0). Emits candidate Setups for
// shadow-logging — no orders. Pure & testable.
//
// Entry pivots (all "strong pivots"): MHP, bull-zone bottom (BZB), bear-zone top
// (BrZT). LP/IP are characterizations of the BZB/BrZT trade by where the target sits
// (LP = BrZT→BZB slow; IP = BZB→BrZT fast), noted not double-emitted. DD bands have
// their own engine (dd-engine.ts, Phase 5).
import type { MarketState, Setup, SizeTier, Dir, BounceVsBreak } from './engine-types.js';

const STRIKE: Record<'NQ' | 'ES', number> = { NQ: 40, ES: 10 };

const TIERS: SizeTier[] = ['N', 'M', 'S', '0'];
const downTier = (t: SizeTier): SizeTier => (t === 'N' ? 'M' : t === 'M' ? 'S' : t === 'S' ? 'S' : '0');
const capTier = (t: SizeTier, max: SizeTier): SizeTier =>
  TIERS.indexOf(t) >= TIERS.indexOf(max) ? t : max;

const uniqSort = (xs: Array<number | undefined>): number[] =>
  Array.from(new Set(xs.filter((x): x is number => x != null && Number.isFinite(x)))).sort((a, b) => a - b);

export interface EstOpts {
  proximityPts?: number;   // "at the level" trigger tolerance; default = strike / 5
  maxTargets?: number;     // interrupts to list as targets; default 3
}

/** Evaluate all EST strong-pivot setups for the current MarketState. */
export function evaluateEst(ms: MarketState, opts: EstOpts = {}): Setup[] {
  const out: Setup[] = [];
  if (ms.price == null || ms.gate.mode === 'sit-out') return out;

  const strike = STRIKE[ms.symbol];
  const prox = opts.proximityPts ?? strike / 5;
  const maxT = opts.maxTargets ?? 3;
  const price = ms.price;
  const dd = ms.confluence.ddRatio;
  const ddBull = dd > 0.5;
  const resO = ms.confluence.resOrange;
  const strongOnly = ms.gate.mode === 'strong-pivots-small'; // all 4 EST pivots are strong → only caps size
  const longOnly = ms.gate.longOnly;
  const sizeDown = ms.gate.sizeDown;

  const allLevels = uniqSort([
    ...ms.levels.bzb, ...ms.levels.brzt,
    ms.levels.hp, ms.levels.mhp, ms.levels.dynHp, ms.levels.dynMhp,
    ms.levels.onHp, ms.levels.onMhp, ms.levels.ddUpper, ms.levels.ddLower,
    ms.halfGap, ms.prevClose,
  ]);
  const targetsAbove = (lvl: number) => allLevels.filter(l => l > lvl + 1).slice(0, maxT);
  const targetsBelow = (lvl: number) => allLevels.filter(l => l < lvl - 1).reverse().slice(0, maxT);
  const near = (lvl: number) => Math.abs(price - lvl) <= prox;
  const applyGate = (t: SizeTier): SizeTier => {
    let r = sizeDown ? downTier(t) : t;
    if (strongOnly) r = capTier(r, 'S');
    return r;
  };

  const emit = (
    pivot: string, level: number, direction: Dir, baseTier: SizeTier,
    baseProb: number, bvb: BounceVsBreak, note: string,
  ) => {
    if (direction === 'short' && longOnly) return; // gate: long-only
    const sizeTier = applyGate(baseTier);
    out.push({
      family: 'EST', pivot, level, direction, sizeTier,
      entry: price,
      stop: direction === 'long' ? +(level - strike).toFixed(2) : +(level + strike).toFixed(2),
      targets: direction === 'long' ? targetsAbove(level) : targetsBelow(level),
      bounceVsBreak: bvb, baseProb,
      confluenceNote: note,
    });
  };

  // 1) MHP — long bounce. VETO when MHP resilience is negative: a negative resOrange means the
  //    level is failing/distributing, so the bounce isn't tradable — don't emit (don't log) it.
  //    Only emit when resOrange >= 0 (N if >0, S if exactly 0). 90% full confluence / 73% base.
  if (ms.levels.mhp != null && near(ms.levels.mhp) && resO >= 0) {
    emit('MHP', ms.levels.mhp, 'long', resO > 0 ? 'N' : 'S', resO > 0 ? 0.90 : 0.73,
      'bounce', `MHP bounce · resOrange ${resO >= 0 ? '+' : ''}${resO} · DD ${dd}`);
  }

  // (DD bands moved to dd-engine.ts, Phase 5.)

  // 2) BZB — long bounce (N if DD>0.5 else M). Label IP when the next interrupt up is a BrZT (fast).
  for (const bzb of ms.levels.bzb) {
    if (!near(bzb)) continue;
    const firstAbove = allLevels.find(l => l > bzb + 1);
    const isIp = firstAbove != null && ms.levels.brzt.some(b => Math.abs(b - firstAbove) < 1);
    emit('BZB', bzb, 'long', ddBull ? 'N' : 'M', 0.90, 'bounce',
      `bull-zone bottom${isIp ? ' · IP→BrZT (fast)' : ''} · DD ${dd}`);
  }

  // 3) BrZT — from below = hold-through long (LP, N/M by DD); from above = short only if DD<0.5 & GM bear.
  for (const brzt of ms.levels.brzt) {
    if (!near(brzt)) continue;
    if (price <= brzt) {
      emit('BrZT', brzt, 'long', ddBull ? 'N' : 'M', 0.90, 'hold-through',
        `bear-zone top from below · LP→BZB · DD ${dd} (often waltzes through)`);
    } else if (!ddBull && ms.confluence.gm === 'bear') {
      emit('BrZT', brzt, 'short', 'N', 0.90, 'bounce',
        `bear-zone top rejection · DD ${dd} · GM bear (full confluence)`);
    }
  }

  return out;
}

/** Wrap EST candidates into a Decision (for the shadow log). */
export function runEst(ms: MarketState, opts?: EstOpts): { symbol: 'NQ' | 'ES'; tsET: string; gate: MarketState['gate']['mode']; setups: Setup[] } {
  return { symbol: ms.symbol, tsET: ms.tsET, gate: ms.gate.mode, setups: evaluateEst(ms, opts) };
}
