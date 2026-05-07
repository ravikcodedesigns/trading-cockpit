// Conviction Scorer
//
// Analyzes the 15-minute tick window BEFORE a signal fires.
// Returns null | '+' | '++' based on pre-signal behavior patterns
// identified empirically from gold tier signal history.
//
// Conviction is stored in signal payload as { conviction: '++' }
// and displayed as a suffix in Discord: "absorption (72) ++"
//
// Scoring is SEPARATE from the signal score — never modifies score.
// This preserves clean comparison: score = pattern strength,
// conviction = pre-signal context quality.
//
// Patterns identified (see pre-signal analysis, May 7 2026):
//
// LONG signals (ON absorption long, RTH absorption long):
//   ++ Delta positive AND diverging (weakening in 2nd half) AND vol contracting
//   +  Delta diverging only
//
// SHORT signals (ON absorption short, RTH divergence short):
//   ++ Delta diverging AND price already rolling over (velocity < -1pt/min last 3min)
//   +  Delta diverging only
//
// RTH divergence SHORT specific:
//   ++ Price accelerating up (>+2pts/min) AND delta positive AND delta diverging
//      (classic distribution: retail FOMO into institutional selling)
//   +  Delta diverging only

import { getRecentTrades } from './tick-client.js';
import type { Symbol } from '@trading/contracts';

export type ConvictionRating = '++' | '+' | null;

const WINDOW_MS = 15 * 60 * 1000;  // 15 minutes

interface PreSignalMetrics {
  // Delta
  totalDelta: number;          // cumulative buy - sell vol over 15min
  firstHalfDelta: number;      // delta in first 7.5min
  secondHalfDelta: number;     // delta in second 7.5min
  deltaIsDiverging: boolean;   // 2nd half weakens vs 1st half

  // Price
  priceDrift: number;          // price change over 15min (late avg - early avg)
  velocityLast3m: number;      // pts/min in final 3 minutes

  // Volume
  volTrend: 'expanding' | 'contracting' | 'stable';

  // Aggression
  lateAggressionRatio: number; // buy vol / total vol in last 3min (>0.5 = buyers dominant)

  nTicks: number;
}

async function getMetrics(
  symbol: Symbol,
  signalTs: number
): Promise<PreSignalMetrics | null> {
  // Fetch 15min of ticks ending at signal time
  const trades = await getRecentTrades(symbol, WINDOW_MS).catch(() => []);

  // Filter to window (getRecentTrades returns last N ms from now,
  // but we want window ending at signalTs which is ~now)
  const window = trades.filter(t => t.ts >= signalTs - WINDOW_MS && t.ts < signalTs);

  if (window.length < 20) return null;

  // isBidAggressor=true means seller hit bid = SELL aggression
  // isBidAggressor=false means buyer lifted ask = BUY aggression
  const buyVol  = (t: typeof window[0]) => t.isBidAggressor ? 0 : t.size;
  const sellVol = (t: typeof window[0]) => t.isBidAggressor ? t.size : 0;

  // Delta
  const mid = Math.floor(window.length / 2);
  const firstHalfDelta  = window.slice(0, mid).reduce((s, t) => s + buyVol(t) - sellVol(t), 0);
  const secondHalfDelta = window.slice(mid).reduce((s, t) => s + buyVol(t) - sellVol(t), 0);
  const totalDelta = firstHalfDelta + secondHalfDelta;

  // Delta diverging: 2nd half weakens relative to 1st half
  const deltaIsDiverging =
    (firstHalfDelta > 50  && secondHalfDelta < firstHalfDelta * 0.7) ||
    (firstHalfDelta < -50 && secondHalfDelta > firstHalfDelta * 0.7);

  // Price drift: avg of first 3min vs avg of last 3min
  const early = window.filter(t => t.ts < signalTs - WINDOW_MS + 3 * 60 * 1000);
  const late  = window.filter(t => t.ts >= signalTs - 3 * 60 * 1000);

  const earlyAvg = early.length ? early.reduce((s, t) => s + t.price, 0) / early.length : window[0].price;
  const lateAvg  = late.length  ? late.reduce((s, t) => s + t.price, 0)  / late.length  : window[window.length - 1].price;
  const priceDrift = lateAvg - earlyAvg;

  // Velocity in last 3 minutes
  let velocityLast3m = 0;
  if (late.length > 1) {
    const range = late[late.length - 1].price - late[0].price;
    const mins  = (late[late.length - 1].ts - late[0].ts) / 60_000;
    velocityLast3m = mins > 0 ? range / mins : 0;
  }

  // Volume trend: first 5min vs last 5min
  const earlyVol = window.filter(t => t.ts < signalTs - WINDOW_MS + 5 * 60 * 1000)
                         .reduce((s, t) => s + t.size, 0);
  const lateVol  = window.filter(t => t.ts >= signalTs - 5 * 60 * 1000)
                         .reduce((s, t) => s + t.size, 0);
  const volTrend = lateVol > earlyVol * 1.1 ? 'expanding'
                 : lateVol < earlyVol * 0.9 ? 'contracting'
                 : 'stable';

  // Late aggression ratio
  const lateBuyVol  = late.reduce((s, t) => s + buyVol(t), 0);
  const lateSellVol = late.reduce((s, t) => s + sellVol(t), 0);
  const lateTotal   = lateBuyVol + lateSellVol;
  const lateAggressionRatio = lateTotal > 0 ? lateBuyVol / lateTotal : 0.5;

  return {
    totalDelta, firstHalfDelta, secondHalfDelta, deltaIsDiverging,
    priceDrift, velocityLast3m, volTrend, lateAggressionRatio,
    nTicks: window.length,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function scoreConviction(
  symbol: Symbol,
  direction: 'long' | 'short',
  ruleId: string,
  signalTs: number
): Promise<ConvictionRating> {
  const m = await getMetrics(symbol, signalTs);
  if (!m) return null;

  const isLong  = direction === 'long';
  const isShort = direction === 'short';
  const isDiv   = ruleId === 'delta-divergence';

  if (isLong) {
    // Long conviction not yet validated — insufficient sample for ++ longs,
    // and high drawdown observed. Disabled until recalibrated.
    return null;
  }

  if (isShort && isDiv) {
    // RTH divergence SHORT: price accelerating up + delta positive + delta diverging
    // = distribution into retail FOMO
    const priceAccelerating = m.velocityLast3m > 2.0;
    const deltaPositive     = m.totalDelta > 100;
    const deltaDiverging    = m.deltaIsDiverging;

    if (priceAccelerating && deltaPositive && deltaDiverging) return '++';
    if (deltaDiverging) return '+';
    return null;
  }

  if (isShort) {
    // Absorption SHORT: delta diverging + price already rolling over
    const deltaDiverging  = m.deltaIsDiverging;
    const rollingOver     = m.velocityLast3m < -1.0;

    if (deltaDiverging && rollingOver) return '++';
    if (deltaDiverging) return '+';
    return null;
  }

  return null;
}

// For backfill script: compute conviction from raw tick arrays
// (no HTTP call — data passed directly)
export function scoreConvictionFromTicks(
  ticks: Array<{ ts: number; price: number; size: number; isBidAggressor: boolean }>,
  direction: 'long' | 'short',
  ruleId: string,
  signalTs: number
): ConvictionRating {
  const window = ticks.filter(t => t.ts >= signalTs - WINDOW_MS && t.ts < signalTs);
  if (window.length < 20) return null;

  const buyVol  = (t: typeof window[0]) => t.isBidAggressor ? 0 : t.size;
  const sellVol = (t: typeof window[0]) => t.isBidAggressor ? t.size : 0;

  const mid = Math.floor(window.length / 2);
  const firstHalfDelta  = window.slice(0, mid).reduce((s, t) => s + buyVol(t) - sellVol(t), 0);
  const secondHalfDelta = window.slice(mid).reduce((s, t) => s + buyVol(t) - sellVol(t), 0);
  const totalDelta = firstHalfDelta + secondHalfDelta;

  const deltaIsDiverging =
    (firstHalfDelta > 50  && secondHalfDelta < firstHalfDelta * 0.7) ||
    (firstHalfDelta < -50 && secondHalfDelta > firstHalfDelta * 0.7);

  const early = window.filter(t => t.ts < signalTs - WINDOW_MS + 3 * 60 * 1000);
  const late  = window.filter(t => t.ts >= signalTs - 3 * 60 * 1000);

  let velocityLast3m = 0;
  if (late.length > 1) {
    const range = late[late.length - 1].price - late[0].price;
    const mins  = (late[late.length - 1].ts - late[0].ts) / 60_000;
    velocityLast3m = mins > 0 ? range / mins : 0;
  }

  const earlyVol = window.filter(t => t.ts < signalTs - WINDOW_MS + 5 * 60 * 1000)
                         .reduce((s, t) => s + t.size, 0);
  const lateVol  = window.filter(t => t.ts >= signalTs - 5 * 60 * 1000)
                         .reduce((s, t) => s + t.size, 0);
  const volTrend = lateVol > earlyVol * 1.1 ? 'expanding'
                 : lateVol < earlyVol * 0.9 ? 'contracting' : 'stable';

  const isLong = direction === 'long';
  const isDiv  = ruleId === 'delta-divergence';

  if (isLong) {
    // Long conviction disabled — not yet validated.
    return null;
  }

  if (!isLong && isDiv) {
    if (velocityLast3m > 2.0 && totalDelta > 100 && deltaIsDiverging) return '++';
    if (deltaIsDiverging) return '+';
    return null;
  }

  // absorption short
  if (deltaIsDiverging && velocityLast3m < -1.0) return '++';
  if (deltaIsDiverging) return '+';
  return null;
}
