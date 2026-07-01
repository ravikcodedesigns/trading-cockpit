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
  const pockets = ms.pockets?.pockets ?? [];   // precomputed LP/IP (50pt gap, wall-aware) for valid labels + sizing

  const allLevels = uniqSort([
    ...ms.levels.bzb, ...ms.levels.brzt,
    ms.levels.hp, ms.levels.mhp, ms.levels.dynHp, ms.levels.dynMhp,
    ms.levels.onHp, ms.levels.onMhp, ms.levels.ddUpper, ms.levels.ddLower,
    ms.halfGap, ms.prevClose,
  ]);
  const targetsAbove = (lvl: number) => allLevels.filter(l => l > lvl + 1).slice(0, maxT);
  const targetsBelow = (lvl: number) => allLevels.filter(l => l < lvl - 1).reverse().slice(0, maxT);
  const near = (lvl: number) => Math.abs(price - lvl) <= prox;
  // FROM_UP = price approached the level from ABOVE (the support-bounce / hold-through-long side).
  // Prefer the real candle OPEN (ms.barOpen > lvl = opened above); fall back to the cross-instant
  // price when barOpen isn't fed — at a FROM_UP cross price has just dipped to/below the level, so
  // price <= lvl. (Operators differ because the open and the cross sit on opposite sides for the
  // same approach.) TAD source for all engine gates — see deriveMarketState.barOpen.
  const fromUp = (lvl: number) => (ms.barOpen != null ? ms.barOpen > lvl : price <= lvl);
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

  // 1) MHP (and ON-MHP, the overnight MHP) — long bounce. VETO when MHP resilience is negative
  //    (negative resOrange = level failing/distributing → bounce not tradable). Only emit when
  //    resOrange >= 0 (N if >0, S if exactly 0). 90% full confluence / 73% base.
  //    FROM_UP TAD-gate (Ravi 2026-06-29): a support bounce only fires when price approached from
  //    ABOVE (fromUp) — FROM_BELOW (rising INTO the level = resistance) is excluded (lost on ON-MHP 06-26).
  for (const [lbl, lvl] of [['MHP', ms.levels.mhp], ['ON-MHP', ms.levels.onMhp]] as const) {
    if (lvl != null && near(lvl) && fromUp(lvl) && resO >= 0) {
      emit(lbl, lvl, 'long', resO > 0 ? 'N' : 'S', resO > 0 ? 0.90 : 0.73,
        'bounce', `${lbl} bounce (from-above) · resOrange ${resO >= 0 ? '+' : ''}${resO} · DD ${dd}`);
    }
  }

  // (DD bands moved to dd-engine.ts, Phase 5.)

  // 2) BZB — long bounce (N if DD>0.5 else M). IP is now a VALIDATED pocket (bull zone whose bottom
  //    is this BZB has a bear ≤50pt above by inner-gap). A wall-bull's IP is clamped (the rip starts
  //    at the wall top, not here) — emitted separately below.
  for (const bzb of ms.levels.bzb) {
    if (!near(bzb) || !fromUp(bzb)) continue;   // FROM_UP only — bounce off the bull-zone bottom (price dropped to it)
    // DD gate (Image 10 = strongest BZB long is DD>0.5; Image 9 = on DD<0.5 it's only the weak M-tap, and ONLY
    // if the LM opened bullish "If LM Open is B"). DD<0.5 + non-bull open ⇒ no qualifying BZB long → skip.
    if (!ddBull && ms.lmOpenZone !== 'B') continue;
    const ip = pockets.find(p => p.kind === 'IP' && Math.abs(p.lower.low - bzb) < 1);
    const ipNote = ip ? (ip.clamped ? ` · IP-rip above (bull wall; starts ${ip.entry})` : ` · ${ip.note}`) : '';
    emit('BZB', bzb, 'long', ddBull ? 'N' : 'M', 0.90, 'bounce',
      `bull-zone bottom${ipNote} · DD ${dd}${ddBull ? '' : ' · DD<0.5 LM-open-bull M-tap'}`);
  }

  // 3) BrZT — fires ONLY FROM_BELOW (price rising UP into the bear-top; FROM_UP = no standard EST).
  //    Direction (manual §3–4, settled w/ Ravi 2026-06-29): an LP (bull ≤50pt above) is a LONG bounce
  //    REGARDLESS of DD (the ~90% pocket; N if DD>0.5 else S — the LP size is N/S, not N/M). With no LP
  //    it's DD-driven: DD>0.5 → waltz-through LONG (N); DD<0.5 → reject SHORT (full confluence).
  for (const brzt of ms.levels.brzt) {
    if (!near(brzt) || fromUp(brzt)) continue;   // FROM_BELOW only
    const lp = pockets.find(p => p.kind === 'LP' && Math.abs(p.lower.high - brzt) < 1);
    if (lp || ddBull) {
      emit('BrZT', brzt, 'long', ddBull ? 'N' : 'S', 0.90, 'hold-through',
        `bear-zone top from below${lp ? ` · ${lp.note}` : ' · reclaim (DD>0.5)'} · DD ${dd}`);
    } else {
      emit('BrZT', brzt, 'short', 'N', 0.90, 'bounce',
        `bear-zone top rejection · DD ${dd} (DD<0.5, full confluence)`);
    }
  }

  // 4) Wall-clamped IP gap-rips — the entry is the wall's TOP edge (a break level, not a raw BZB),
  //    so it isn't in ms.levels.bzb; emit it directly off the pocket. IP sizing (N/M by DD).
  for (const p of pockets) {
    if (p.kind === 'IP' && p.clamped && near(p.entry)) {
      emit('IP', p.entry, 'long', ddBull ? 'N' : 'M', 0.90, 'break', `IP gap-rip · ${p.note}`);
    }
  }

  return out;
}

/** Wrap EST candidates into a Decision (for the shadow log). */
export function runEst(ms: MarketState, opts?: EstOpts): { symbol: 'NQ' | 'ES'; tsET: string; gate: MarketState['gate']['mode']; setups: Setup[] } {
  return { symbol: ms.symbol, tsET: ms.tsET, gate: ms.gate.mode, setups: evaluateEst(ms, opts) };
}
