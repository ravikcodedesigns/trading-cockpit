// RS Level Scorer v2
//
// Three-component model — each component is independently meaningful:
//
//   Level Score  (0-50): which RS level the signal is near and how close
//   Context Score(0-30): LM code, greater market, DD float, resilience, volatility
//   Confirm Score(0-20): first vs repeat test, VVIX golden environment
//
// Total 0-100 → tier: PRIME(80+) HIGH(65+) MODERATE(50+) WEAK(35+) PASS(<35)
//
// Hard filters block signals regardless of score.
// Level test counts are in-memory session state — call resetLevelTestCounts()
// when new daily levels are loaded (new RTH session).

import type { DailyLevels, LmCode, RSTier } from '@trading/contracts';
import { getContext, type RSContext } from '../rs-context.js';

export type { RSTier };

// --- Constants ---

const PROXIMITY_PTS = 20;  // linear decay window in NQ points

// --- Internal types ---

type LevelType =
  | 'bzb' | 'brzt'
  | 'extra-bzb' | 'extra-brzt'
  | 'mhp' | 'hp'
  | 'dd-upper' | 'dd-lower'
  | 'hg' | 'qqq-open' | 'qqq-close'
  | 'on-mhp' | 'on-hp'
  | 'other';

interface RSLevel {
  label: string;
  price: number;
  type: LevelType;
  isEST: boolean;
}

// --- Public result type ---

export interface RSScoreComponents {
  level: number;    // 0-50
  context: number;  // 0-30
  confirm: number;  // 0-20
}

export interface RSScoreResult {
  score: number;
  tier: RSTier;
  components: RSScoreComponents;

  matchedLevel: { label: string; price: number; type: string; distancePts: number } | null;
  isEST: boolean;
  levelTestCount: number;     // tests at this level BEFORE this signal (0 = first test)
  nearestLevelPts: number;    // distance to nearest RS level (no threshold, 0 if no levels)

  hardFiltered: boolean;
  filterReason: string;

  tp1: { label: string; price: number; pts: number } | null;
  tp2: { label: string; price: number; pts: number } | null;

  gmAligned: boolean;
  ddAligned: boolean;
  lmCode: string | undefined;     // the LM code in effect at signal time (e.g. "BLU")
  lmCodeAligned: boolean | null;  // null if no LM code set for the day
  breakAndReturn: boolean;        // price breached level >15pts then returned

  isRational: boolean;
  labelLine: string;    // "BZB · First test · GM bull · BLD"
  volatilityNote: string;
}

// --- Session-scoped level test counter ---
// Tracks how many times each level has been tested this session.
// First test = highest conviction; third+ test = level likely to break.

const _testCounts = new Map<string, number>();

export function resetLevelTestCounts(): void {
  _testCounts.clear();
}

// --- Level extraction ---

function extractAllLevels(levels: DailyLevels): RSLevel[] {
  const out: RSLevel[] = [];

  // Primary zones
  out.push({ label: 'BZB',  price: levels.bullZone.low,  type: 'bzb',  isEST: true });
  out.push({ label: 'BrZT', price: levels.bearZone.high, type: 'brzt', isEST: true });

  // Secondary zone clusters
  for (const [i, ez] of (levels.extraZones ?? []).entries()) {
    out.push({ label: `BZB-${i + 2}`,  price: ez.bzb,  type: 'extra-bzb',  isEST: true });
    out.push({ label: `BrZT-${i + 2}`, price: ez.brzt, type: 'extra-brzt', isEST: true });
  }

  // DD bands
  out.push({ label: 'Upper DD Band', price: levels.ddBands.upper, type: 'dd-upper', isEST: false });
  out.push({ label: 'Lower DD Band', price: levels.ddBands.lower, type: 'dd-lower', isEST: false });

  // HP (weekly hedge pressure)
  out.push({ label: 'HP', price: levels.hedgePressure, type: 'hp', isEST: false });

  // MHP (monthly hedge pressure) — dedicated field, not in additionalLevels
  if (levels.mhp !== undefined) {
    out.push({ label: 'MHP', price: levels.mhp, type: 'mhp', isEST: false });
  }

  // Named additional levels — skip MHP if someone still has it there to avoid double-counting
  for (const al of levels.additionalLevels ?? []) {
    const lbl = al.label.toLowerCase().trim();
    if (lbl === 'mhp') continue; // now a dedicated field
    let type: LevelType = 'other';
    if      (lbl === 'on mhp')    type = 'on-mhp';
    else if (lbl === 'on hp')     type = 'on-hp';
    else if (lbl === 'hg')        type = 'hg';
    else if (lbl === 'qqq open')  type = 'qqq-open';
    else if (lbl === 'qqq close') type = 'qqq-close';
    out.push({ label: al.label, price: al.price, type, isEST: false });
  }

  return out;
}

// --- Base score per level type (direction and context aware) ---
// Resilience-gated levels (HG, QQQ Open, QQQ Close) have three tiers.
// DD bands only score fully when direction matches the DD float orientation.

function levelBaseScore(type: LevelType, direction: 'long' | 'short', ctx: RSContext): number {
  const ddLong = ctx.ddRatio > 0.5;

  switch (type) {
    // BZB is canonical support — full score for LONG, penalised for counter-direction SHORT
    case 'bzb':        return direction === 'long'  ? 50 : 36;
    // BrZT is canonical resistance — full score for SHORT, penalised for counter-direction LONG
    case 'brzt':       return direction === 'short' ? 50 : 36;
    case 'extra-bzb':  return direction === 'long'  ? 44 : 30;
    case 'extra-brzt': return direction === 'short' ? 44 : 30;

    case 'mhp': {
      const aligned = (direction === 'long'  && ctx.mhpResilience > 0) ||
                      (direction === 'short' && ctx.mhpResilience < 0);
      const opposed = (direction === 'long'  && ctx.mhpResilience < 0) ||
                      (direction === 'short' && ctx.mhpResilience > 0);
      return aligned ? 40 : ctx.mhpResilience === 0 ? 37 : opposed ? 28 : 37;
    }

    case 'dd-lower':
      // Full score only when DD-long and signal is long (floating off lower band)
      return (ddLong && direction === 'long') ? 38 : 20;
    case 'dd-upper':
      // Full score only when DD-short and signal is short (floating off upper band)
      return (!ddLong && direction === 'short') ? 38 : 20;

    case 'hp': {
      const aligned = (direction === 'long'  && ctx.hpResilience > 0) ||
                      (direction === 'short' && ctx.hpResilience < 0);
      const opposed = (direction === 'long'  && ctx.hpResilience < 0) ||
                      (direction === 'short' && ctx.hpResilience > 0);
      return aligned ? 34 : ctx.hpResilience === 0 ? 31 : opposed ? 24 : 31;
    }

    case 'hg': {
      const aligned = (direction === 'long'  && ctx.redistResilience > 0) ||
                      (direction === 'short' && ctx.redistResilience < 0);
      const opposed = (direction === 'long'  && ctx.redistResilience < 0) ||
                      (direction === 'short' && ctx.redistResilience > 0);
      return aligned ? 38 : ctx.redistResilience === 0 ? 26 : opposed ? 18 : 26;
    }
    case 'qqq-open': {
      const aligned = (direction === 'long'  && ctx.redistResilience > 0) ||
                      (direction === 'short' && ctx.redistResilience < 0);
      const opposed = (direction === 'long'  && ctx.redistResilience < 0) ||
                      (direction === 'short' && ctx.redistResilience > 0);
      return aligned ? 34 : ctx.redistResilience === 0 ? 20 : opposed ? 14 : 20;
    }
    case 'qqq-close': {
      const aligned = (direction === 'long'  && ctx.redistResilience > 0) ||
                      (direction === 'short' && ctx.redistResilience < 0);
      const opposed = (direction === 'long'  && ctx.redistResilience < 0) ||
                      (direction === 'short' && ctx.redistResilience > 0);
      return aligned ? 30 : ctx.redistResilience === 0 ? 18 : opposed ? 12 : 18;
    }

    case 'on-mhp': return 15;
    case 'on-hp':  return 11;
    default:       return 8;
  }
}

// --- Component 1: Level Score (0-50) ---

interface LevelResult {
  score: number;
  matched: RSLevel | null;
  distancePts: number;
}

function computeLevelScore(
  signalPrice: number,
  direction: 'long' | 'short',
  allLevels: RSLevel[],
  ctx: RSContext,
): LevelResult {
  let best: LevelResult = { score: 0, matched: null, distancePts: 0 };

  for (const level of allLevels) {
    const dist = Math.abs(signalPrice - level.price);
    if (dist > PROXIMITY_PTS) continue;

    const base  = levelBaseScore(level.type, direction, ctx);
    const decay = Math.max(0, 1 - dist / PROXIMITY_PTS);
    const score = base * decay;

    if (score > best.score) {
      best = { score, matched: level, distancePts: dist };
    }
  }

  return { score: Math.round(best.score), matched: best.matched, distancePts: Math.round(best.distancePts) };
}

// --- Component 2: Context Score (0-30) ---

interface ContextResult {
  score: number;
  gmAligned: boolean;
  ddAligned: boolean;
  lmAligned: boolean | null;
}

function computeContextScore(
  direction: 'long' | 'short',
  matched: RSLevel | null,
  lmCode: LmCode | undefined,
  ctx: RSContext,
): ContextResult {
  let score = 0;
  let gmAligned = false;
  let ddAligned = false;
  let lmAligned: boolean | null = null;

  // LM code (+12 aligned, -8 counter)
  if (lmCode) {
    const bullCode = !lmCode.startsWith('Br');
    lmAligned = (bullCode && direction === 'long') || (!bullCode && direction === 'short');
    score += lmAligned ? 12 : -8;
  }

  // Greater market (+8 aligned, -6 counter)
  if (ctx.greaterMarket !== 'neutral') {
    gmAligned = (ctx.greaterMarket === 'bull' && direction === 'long') ||
                (ctx.greaterMarket === 'bear' && direction === 'short');
    score += gmAligned ? 8 : -6;
  }

  // DD float (+6 aligned, -4 counter)
  const ddLong  = ctx.ddRatio > 0.5;
  const ddShort = ctx.ddRatio < 0.5;
  ddAligned = (ddLong && direction === 'long') || (ddShort && direction === 'short');
  if (ddAligned) score += 6;
  else if (ctx.ddRatio !== 0.5) score -= 4;

  // Resilience bonus/penalty for the matched level — direction-aware
  // Aligned = resilience sign matches trade direction (+6); Opposed = opposite (-5)
  if (matched) {
    const resAligned =
      (matched.type === 'mhp' &&
        ((direction === 'long'  && ctx.mhpResilience > 0) ||
         (direction === 'short' && ctx.mhpResilience < 0))) ||
      (matched.type === 'hp' &&
        ((direction === 'long'  && ctx.hpResilience > 0) ||
         (direction === 'short' && ctx.hpResilience < 0))) ||
      (['hg', 'qqq-open', 'qqq-close'].includes(matched.type) &&
        ((direction === 'long'  && ctx.redistResilience > 0) ||
         (direction === 'short' && ctx.redistResilience < 0)));
    const resOpposed =
      (matched.type === 'mhp' &&
        ((direction === 'long'  && ctx.mhpResilience < 0) ||
         (direction === 'short' && ctx.mhpResilience > 0))) ||
      (matched.type === 'hp' &&
        ((direction === 'long'  && ctx.hpResilience < 0) ||
         (direction === 'short' && ctx.hpResilience > 0))) ||
      (['hg', 'qqq-open', 'qqq-close'].includes(matched.type) &&
        ((direction === 'long'  && ctx.redistResilience < 0) ||
         (direction === 'short' && ctx.redistResilience > 0)));
    if (resAligned)      score += 6;
    else if (resOpposed) score -= 5;
  }

  // Volatility environment
  if (ctx.vvixGolden)   score += 3;
  if (ctx.vxAboveBBB)   score -= 4;
  if (ctx.vvixElevated) score -= 8;

  return { score: Math.max(0, Math.min(30, score)), gmAligned, ddAligned, lmAligned };
}

// --- Break-and-return detection ---
// Returns true if any recent bar breached the level by >15pts in the
// direction opposite to the trade, indicating a failed break then return.

const BR_PTS = 15;

function checkBreakAndReturn(
  matched: RSLevel,
  direction: 'long' | 'short',
  recentBars: { high: number; low: number }[],
): boolean {
  return direction === 'long'
    ? recentBars.some(b => b.low  < matched.price - BR_PTS)
    : recentBars.some(b => b.high > matched.price + BR_PTS);
}

// --- Component 3: Confirmation Score (0-20) ---

function computeConfirmScore(
  matched: RSLevel | null,
  ctx: RSContext,
  direction: 'long' | 'short',
  recentBars?: { high: number; low: number }[],
): number {
  if (!matched) return 0;

  let score = 0;
  const tests = _testCounts.get(matched.label) ?? 0;

  if (tests === 0)     score += 6;   // first test — full conviction
  else if (tests >= 2) score -= 6;   // third+ test — level likely to break

  if (ctx.vvixGolden) score += 4;

  // Break-and-return: price breached level >15pts then recovered → strong confirmation
  if (recentBars && recentBars.length > 0 && checkBreakAndReturn(matched, direction, recentBars)) {
    score += 10;
  }

  return Math.max(0, Math.min(20, score));
}

// --- Tier mapping ---

function toTier(score: number): RSTier {
  if (score >= 80) return 'PRIME';
  if (score >= 65) return 'HIGH';
  if (score >= 50) return 'MODERATE';
  if (score >= 35) return 'WEAK';
  return 'PASS';
}

// --- Nearest level distance (no threshold) ---

function findNearestLevelPts(signalPrice: number, allLevels: RSLevel[]): number {
  if (allLevels.length === 0) return 0;
  return Math.min(...allLevels.map(l => Math.abs(signalPrice - l.price)));
}

// --- Exit targets ---

function findExitTargets(
  signalPrice: number,
  direction: 'long' | 'short',
  allLevels: RSLevel[],
): { tp1: RSScoreResult['tp1']; tp2: RSScoreResult['tp2'] } {
  const relevant = allLevels
    .filter(l => direction === 'long'
      ? l.price > signalPrice + PROXIMITY_PTS
      : l.price < signalPrice - PROXIMITY_PTS)
    .sort((a, b) => direction === 'long' ? a.price - b.price : b.price - a.price);

  const tp1 = relevant[0]
    ? { label: relevant[0].label, price: relevant[0].price, pts: Math.round(Math.abs(relevant[0].price - signalPrice)) }
    : null;
  const tp2 = relevant[1]
    ? { label: relevant[1].label, price: relevant[1].price, pts: Math.round(Math.abs(relevant[1].price - signalPrice)) }
    : null;

  return { tp1, tp2 };
}

// --- Label line builder ---

function buildLabelLine(
  matched: RSLevel | null,
  testCount: number,
  gmAligned: boolean,
  ddAligned: boolean,
  lmAligned: boolean | null,
  lmCode: LmCode | undefined,
  ctx: RSContext,
  breakAndReturn: boolean,
): string {
  const parts: string[] = [];
  if (matched) parts.push(matched.label);

  if (testCount === 0)      parts.push('First test');
  else if (testCount === 1) parts.push('2nd test');
  else                      parts.push(`${testCount + 1}th test`);

  if (ctx.greaterMarket !== 'neutral') {
    parts.push(gmAligned ? `GM ${ctx.greaterMarket}` : `counter-GM`);
  }
  if (ctx.ddRatio !== 0.5) {
    parts.push(ddAligned ? (ctx.ddRatio > 0.5 ? 'DD-long' : 'DD-short') : 'DD-counter');
  }
  if (lmCode) parts.push(lmCode + (lmAligned === false ? '↯' : ''));
  if (breakAndReturn) parts.push('B&R');

  return parts.join(' · ');
}

function buildVolatilityNote(ctx: RSContext): string {
  if (ctx.vvixElevated) return `VVIX ${ctx.vvix} >100 — irrational`;
  if (ctx.vxAboveBBB)   return `VX ${ctx.vx} > BBB ${ctx.bbb} — spread entries`;
  if (ctx.vvixGolden)   return `VVIX ${ctx.vvix} <90 — golden`;
  return '';
}

// --- Hard filters ---

function checkHardFilters(
  direction: 'long' | 'short',
  currentPrice: number,
  levels: DailyLevels,
): { filtered: boolean; reason: string } {
  if (direction === 'short' && currentPrice < levels.ddBands.lower) {
    return {
      filtered: true,
      reason: `SHORT blocked: price ${currentPrice} below lower DD Band ${levels.ddBands.lower} — irrational territory`,
    };
  }
  return { filtered: false, reason: '' };
}

// --- Public API ---

export function scoreRSLevels(
  signalPrice: number,
  direction: 'long' | 'short',
  levels: DailyLevels | undefined,
  currentPrice: number,
  recentBars?: { high: number; low: number }[],
): RSScoreResult {
  const ctx = getContext();
  const volNote = buildVolatilityNote(ctx);

  const empty: RSScoreResult = {
    score: 0, tier: 'PASS',
    components: { level: 0, context: 0, confirm: 0 },
    matchedLevel: null, isEST: false, levelTestCount: 0, nearestLevelPts: 0,
    hardFiltered: false, filterReason: '',
    tp1: null, tp2: null,
    gmAligned: false, ddAligned: false, lmCode: undefined, lmCodeAligned: null, breakAndReturn: false,
    isRational: ctx.isRational,
    labelLine: 'No RS levels loaded',
    volatilityNote: volNote,
  };

  if (!levels) return empty;

  // Hard filters first — these block regardless of score
  const { filtered, reason } = checkHardFilters(direction, currentPrice, levels);
  const allLevels = extractAllLevels(levels);
  const nearestLevelPts = Math.round(findNearestLevelPts(signalPrice, allLevels));
  if (filtered) return { ...empty, nearestLevelPts, hardFiltered: true, filterReason: reason };

  // Component 1: level proximity
  const { score: lScore, matched, distancePts } = computeLevelScore(signalPrice, direction, allLevels, ctx);

  // Component 2: context — lmCode from daily levels, falling back to RSContext if not set there
  const effectiveLmCode = levels.lmCode ?? (ctx.lmCode as any);
  const { score: cScore, gmAligned, ddAligned, lmAligned } = computeContextScore(direction, matched, effectiveLmCode, ctx);

  // Component 3: confirmation (reads test count BEFORE recording this test)
  const testCount = matched ? (_testCounts.get(matched.label) ?? 0) : 0;
  const breakAndReturn = !!(matched && recentBars?.length && checkBreakAndReturn(matched, direction, recentBars));
  const confirmScore = computeConfirmScore(matched, ctx, direction, recentBars);

  // Record this signal as a level test
  if (matched) {
    _testCounts.set(matched.label, testCount + 1);
  }

  // Apply irrational market caps
  let total = lScore + cScore + confirmScore;
  if (ctx.vvixElevated && ctx.vxAboveBBB) total = Math.min(total, 65);
  else if (ctx.vxAboveBBB)                total = Math.min(total, 75);

  total = Math.round(total);

  const { tp1, tp2 } = findExitTargets(signalPrice, direction, allLevels);
  const labelLine = buildLabelLine(matched, testCount, gmAligned, ddAligned, lmAligned, effectiveLmCode, ctx, breakAndReturn);

  return {
    score: total,
    tier: toTier(total),
    components: { level: lScore, context: cScore, confirm: confirmScore },
    matchedLevel: matched
      ? { label: matched.label, price: matched.price, type: matched.type, distancePts }
      : null,
    isEST: matched?.isEST ?? false,
    levelTestCount: testCount,
    nearestLevelPts,
    hardFiltered: false,
    filterReason: '',
    tp1,
    tp2,
    gmAligned,
    ddAligned,
    lmCode: levels.lmCode,
    lmCodeAligned: lmAligned,
    breakAndReturn,
    isRational: ctx.isRational,
    labelLine,
    volatilityNote: volNote,
  };
}

// --- Discord format helpers ---

export function formatRSContext(): string {
  const ctx = getContext();
  const gm = ctx.greaterMarket === 'bull' ? '🟢 BULL' : ctx.greaterMarket === 'bear' ? '🔴 BEAR' : '⚪ NEUTRAL';
  const vx = ctx.vxAboveBBB ? `🔴 VX ${ctx.vx} > BBB ${ctx.bbb}` : `🟢 VX ${ctx.vx} < BBB ${ctx.bbb}`;
  const vvix = ctx.vvixElevated ? `🔴 VVIX ${ctx.vvix}` : ctx.vvixGolden ? `🟢 VVIX ${ctx.vvix}` : `🟡 VVIX ${ctx.vvix}`;
  return `GM: ${gm} | DD: ${ctx.ddRatio.toFixed(2)} | ${vx} | ${vvix}`;
}

export function formatExitTargets(
  tp1: RSScoreResult['tp1'],
  tp2: RSScoreResult['tp2'],
): string {
  if (!tp1) return 'No RS level target identified';
  let s = `TP1: ${tp1.label} @ ${tp1.price} (+${tp1.pts}pts)`;
  if (tp2) s += `\nTP2: ${tp2.label} @ ${tp2.price} (+${tp2.pts}pts)`;
  return s;
}
