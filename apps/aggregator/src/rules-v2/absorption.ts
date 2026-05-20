// Absorption Detection Rule (Strategy B, rule version: absorption-v1)
//
// Detects institutional passive orders absorbing aggressive flow.
// Pattern: heavy one-sided aggression hitting a single price level
// with NO corresponding price movement. Indicates a large hidden
// order defending a level.
//
// Signal interpretation:
//   SELL aggression absorbed at price P = large BUYER defending P = bullish
//   BUY aggression absorbed at price P = large SELLER defending P = bearish
//
// RTH signals are filtered by a 5-minute trend filter (3-bar HH/HL structure).
// Counter-trend signals require score >= 80 to fire. Trend-aligned and
// neutral signals fire at normal threshold. Overnight signals bypass
// the trend filter (low dd@5m means tight stops protect adequately).

import { getRecentTrades } from './tick-client.js';
import { logger } from '../logger.js';
import { checkTapeSpeedConfirmed, checkLargePrintConfirmed, getConfluenceRules } from './confluence-tracker.js';
import { db } from '../db.js';
import { scoreConviction } from './conviction.js';
import type { ConfluenceSignal, Symbol, DailyLevels } from '@trading/contracts';

// --- Session classifier ---

type Session = 'rth' | 'overnight' | 'closed';

function classifySession(tsMs: number): Session {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  const min = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday);
  if (isWeekday && min >= 570 && min < 960) return 'rth';
  if (isWeekday) {
    if (min < 570) return 'overnight';
    if (weekday !== 'Fri' && min >= 1080) return 'overnight';
    return 'closed';
  }
  if (weekday === 'Sun' && min >= 1080) return 'overnight';
  return 'closed';
}

// --- 5-minute trend filter (RTH only) ---
//
// Aggregates last 15 one-minute bars into three 5-minute bars.
// Classifies trend as up/down/neutral using higher-highs/higher-lows structure.
//
// Uptrend:   3 consecutive 5-min bars with HH AND HL
// Downtrend: 3 consecutive 5-min bars with LH AND LL
// Neutral:   anything else (range, mixed, insufficient data)
//
// Counter-trend absorption requires score >= 80 to broadcast.
// This prevents shorting into a clear uptrend (like 2026-05-05 RTH).

type Trend = 'up' | 'down' | 'neutral';

interface FiveMinBar {
  open: number;
  high: number;
  low: number;
  close: number;
  ts: number;
}

function buildFiveMinBars(symbol: Symbol, nowMs: number): FiveMinBar[] {
  // Fetch last 20 one-minute bars (covers 3 full 5-min bars with buffer)
  const sinceMs = nowMs - 20 * 60 * 1000;
  const oneMins = db.recentBars(symbol, sinceMs) as Array<{
    ts: number; open: number; high: number; low: number; close: number;
  }>;

  if (oneMins.length < 9) return [];

  // Use only completed bars (not the current partial bar)
  // A bar is considered complete if its ts is more than 60s before now
  const completed = oneMins.filter(b => nowMs - b.ts >= 60_000);
  if (completed.length < 9) return [];

  // Take the most recent 15 completed bars
  const recent = completed.slice(-15);

  // Aggregate into 5-min bars by grouping every 5 one-min bars
  const fiveMins: FiveMinBar[] = [];
  for (let i = 0; i + 4 < recent.length; i += 5) {
    const group = recent.slice(i, i + 5);
    fiveMins.push({
      ts:    group[0]!.ts,
      open:  group[0]!.open,
      high:  Math.max(...group.map(b => b.high)),
      low:   Math.min(...group.map(b => b.low)),
      close: group[group.length - 1]!.close,
    });
  }

  return fiveMins;
}

export function classifyTrend(symbol: Symbol, nowMs: number): Trend {
  const bars = buildFiveMinBars(symbol, nowMs);

  // Need exactly 3 five-minute bars
  if (bars.length < 3) return 'neutral';

  // Use the 3 most recent bars
  const recent3 = bars.slice(-3);
  const [b1, b2, b3] = [recent3[0]!, recent3[1]!, recent3[2]!];

  // Uptrend: each bar's high AND low is higher than the previous
  const higherHighs = b2.high > b1.high && b3.high > b2.high;
  const higherLows = b2.low > b1.low && b3.low > b2.low;
  if (higherHighs && higherLows) return 'up';

  // Downtrend: each bar's high AND low is lower than the previous
  const lowerHighs = b2.high < b1.high && b3.high < b2.high;
  const lowerLows = b2.low < b1.low && b3.low < b2.low;
  if (lowerHighs && lowerLows) return 'down';

  return 'neutral';
}

// Minimum score required for counter-trend RTH absorption to fire.
// Set high enough to filter out noise but low enough to allow very
// strong counter-trend signals (e.g. major reversal at key level).
const COUNTER_TREND_MIN_SCORE = 80;

// --- Session-aware thresholds ---

interface AbsorptionThresholds {
  windowMs: number;
  minVolume: number;
  maxPriceRangeTicks: number;
  minAggressionPct: number;
  cooldownMs: number;
}

const THRESHOLDS: Record<Session, AbsorptionThresholds> = {
  rth: {
    windowMs: 3000,
    minVolume: 150,
    maxPriceRangeTicks: 1,
    minAggressionPct: 0.65,
    cooldownMs: 45_000,
  },
  overnight: {
    windowMs: 5000,
    minVolume: 60,
    maxPriceRangeTicks: 1,
    minAggressionPct: 0.65,
    cooldownMs: 60_000,
  },
  closed: {
    windowMs: 999999,
    minVolume: 999999,
    maxPriceRangeTicks: 0,
    minAggressionPct: 1,
    cooldownMs: 999999,
  },
};

const TICK_SIZE = 0.25;

// --- Cooldown tracker ---

const _lastSignalMs = new Map<string, number>();

function isCoolingDown(symbol: string, direction: string, nowMs: number, cooldownMs: number): boolean {
  return nowMs - (_lastSignalMs.get(`${symbol}:${direction}`) ?? 0) < cooldownMs;
}

function recordSignal(symbol: string, direction: string, nowMs: number): void {
  _lastSignalMs.set(`${symbol}:${direction}`, nowMs);
}

// --- Scoring ---
//
// Three components, each independently meaningful:
//
//   Speed (0-40):   How fast the absorption happened. Sub-100ms = single
//                   institutional block. 4000ms+ = scattered retail noise.
//
//   Purity (0-30):  Aggression % with full granularity. 98%+ = nobody on
//                   the other side; the passive order absorbed everything.
//
//   Context (0-30): Was this a clean setup or noisy? Rewards exhaustion
//                   approach, trend alignment. Penalizes signal clusters
//                   (level is failing) and RTH opening noise.

function scoreAbsorption(
  aggressionPct: number,
  durationMs: number,
  trendAligned: boolean,
  approachBars: number,
  isCluster2nd: boolean,
  isCluster3rdPlus: boolean,
  isOpeningPeriod: boolean,
): number {
  // Speed score (0–40)
  let speedScore: number;
  if      (durationMs < 100)  speedScore = 40;
  else if (durationMs < 500)  speedScore = 30;
  else if (durationMs < 2000) speedScore = 15;
  else if (durationMs < 4000) speedScore = 5;
  else                        speedScore = 0;

  // Purity score (0–30)
  let purityScore: number;
  if      (aggressionPct >= 0.98) purityScore = 30;
  else if (aggressionPct >= 0.90) purityScore = 20;
  else if (aggressionPct >= 0.80) purityScore = 12;
  else if (aggressionPct >= 0.70) purityScore = 5;
  else                            purityScore = 0;

  // Context score (base 15, range 0–30)
  let contextScore = 15;
  if      (approachBars >= 3) contextScore += 10; // exhaustion run into level
  else if (approachBars >= 1) contextScore += 5;
  if (trendAligned)           contextScore += 5;
  if (isCluster3rdPlus)       contextScore -= 20; // level actively failing
  else if (isCluster2nd)      contextScore -= 10; // level retesting, weakening
  if (isOpeningPeriod)        contextScore -= 5;  // RTH open noise
  contextScore = Math.max(0, contextScore);

  return Math.min(100, speedScore + purityScore + contextScore);
}

// Count consecutive 1-min bars pressing into the absorption level
// immediately before the signal. Used to detect exhaustion approach.
// SHORT (absorbing buyers): consecutive up-close bars = buy pressure
// LONG  (absorbing sellers): consecutive down-close bars = sell pressure
function countApproachBars(symbol: Symbol, direction: 'long' | 'short', nowMs: number): number {
  const sinceMs = nowMs - 7 * 60 * 1000;
  const raw = db.recentBars(symbol, sinceMs) as Array<{
    ts: number; open: number; high: number; low: number; close: number;
  }>;
  // Deduplicate: events table stores multiple updates per bar; keep the last.
  const byTs = new Map<number, { ts: number; open: number; close: number }>();
  for (const b of raw) byTs.set(b.ts, b);
  const bars = Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);

  const completed = bars.filter(b => nowMs - b.ts >= 60_000);
  if (!completed.length) return 0;
  let count = 0;
  for (let i = completed.length - 1; i >= 0; i--) {
    const b = completed[i]!;
    const pressing = direction === 'short' ? b.close > b.open : b.close < b.open;
    if (!pressing) break;
    count++;
  }
  return count;
}

// Check if prior absorption signals at this price level fired recently,
// indicating a signal cluster (level under repeated assault = weakening).
function checkSignalCluster(
  symbol: Symbol,
  direction: string,
  price: number,
  nowMs: number,
): { is2nd: boolean; is3rdPlus: boolean } {
  const rows = db.query<{ ts: number }>(`
    SELECT ts FROM signals
    WHERE symbol = ?
      AND rule_id = 'absorption'
      AND direction = ?
      AND ts >= ? AND ts < ?
      AND ABS(CAST(COALESCE(
            json_extract(payload, '$.entry'),
            CAST(SUBSTR(payload, INSTR(payload,'absorbed at ')+12,
                 INSTR(SUBSTR(payload,INSTR(payload,'absorbed at ')+12),' ')-1) AS REAL)
          ) AS REAL) - ?) <= 5.0
    ORDER BY ts ASC
  `, [symbol, direction, nowMs - 10 * 60_000, nowMs, price]);
  return { is2nd: rows.length === 1, is3rdPlus: rows.length >= 2 };
}

// --- Main detection function ---

interface AbsorptionResult {
  signal: Omit<ConfluenceSignal, 'ts'> & { ts: number };
  priceLevel: number;
  volume: number;
  durationMs: number;
  aggressionPct: number;
  priceRangeTicks: number;
}

export async function detectAbsorption(
  symbol: Symbol,
  nowMs: number,
  levels?: DailyLevels
): Promise<AbsorptionResult | null> {
  const session = classifySession(nowMs);
  if (session === 'closed') return null;

  const thresholds = THRESHOLDS[session];

  // Fetch trades for the window
  const trades = await getRecentTrades(symbol, thresholds.windowMs);
  if (trades.length === 0) return null;

  // Group trades by price level (per-bucket range check)
  const byPrice = new Map<number, { buyVol: number; sellVol: number; times: number[]; prices: number[] }>();

  for (const trade of trades) {
    const tickPrice = Math.round(trade.price / TICK_SIZE) * TICK_SIZE;
    if (!byPrice.has(tickPrice)) {
      byPrice.set(tickPrice, { buyVol: 0, sellVol: 0, times: [], prices: [] });
    }
    const entry = byPrice.get(tickPrice)!;
    entry.times.push(trade.ts);
    entry.prices.push(trade.price);
    if (trade.isBidAggressor) {
      entry.sellVol += trade.size;
    } else {
      entry.buyVol += trade.size;
    }
  }

  // Find the highest-volume bucket that passes the price-range check
  let bestPrice = 0;
  let bestTotalVol = 0;
  let bestBuyVol = 0;
  let bestSellVol = 0;
  let bestTimes: number[] = [];
  let bestPriceRangeTicks = 0;

  for (const [price, entry] of byPrice.entries()) {
    const total = entry.buyVol + entry.sellVol;
    if (total <= bestTotalVol) continue;
    const minP = Math.min(...entry.prices);
    const maxP = Math.max(...entry.prices);
    const rangeTicks = Math.round((maxP - minP) / TICK_SIZE);
    if (rangeTicks > thresholds.maxPriceRangeTicks) continue;
    bestTotalVol = total;
    bestPrice = price;
    bestBuyVol = entry.buyVol;
    bestSellVol = entry.sellVol;
    bestTimes = entry.times;
    bestPriceRangeTicks = rangeTicks;
  }

  if (bestTotalVol < thresholds.minVolume) return null;

  const priceRangeTicks = bestPriceRangeTicks;
  const dominantVol = Math.max(bestBuyVol, bestSellVol);
  const aggressionPct = dominantVol / bestTotalVol;
  if (aggressionPct < thresholds.minAggressionPct) return null;

  const isBuyAggression = bestBuyVol > bestSellVol;
  const direction: 'long' | 'short' = isBuyAggression ? 'short' : 'long';
  const absorptionSide = isBuyAggression ? 'sell' : 'buy';

  // Structural stop: 1 tick beyond the furthest price reached during absorption.
  // For SHORT: buyers pushed to maxAbsPrice — if they break through that, signal fails.
  // For LONG: sellers pushed to minAbsPrice — if they break through that, signal fails.
  const absPrices = byPrice.get(bestPrice)?.prices ?? [bestPrice];
  const maxAbsPrice = Math.max(...absPrices);
  const minAbsPrice = Math.min(...absPrices);
  const entry = bestPrice;
  const stopLevel = direction === 'short' ? maxAbsPrice + TICK_SIZE : minAbsPrice - TICK_SIZE;
  const stopDist  = Math.abs(entry - stopLevel);

  if (isCoolingDown(symbol, direction, nowMs, thresholds.cooldownMs)) return null;

  // --- Trend filter (RTH and overnight) ---
  //
  // Apply 5-minute HH/HL trend filter to both sessions.
  // Counter-trend signals require score >= COUNTER_TREND_MIN_SCORE.
  // The overnight market is slower but equally directional on trend days.

  let trend: Trend = 'neutral';
  let trendAligned = false;
  let trendNote = '';

  if (session === 'rth' || session === 'overnight') {
    trend = classifyTrend(symbol, nowMs);
    const isCounterTrend =
      (trend === 'up' && direction === 'short') ||
      (trend === 'down' && direction === 'long');
    trendAligned =
      (trend === 'up' && direction === 'long') ||
      (trend === 'down' && direction === 'short');

    if (isCounterTrend) {
      // Pre-score (no approach/cluster context yet) to check if this
      // counter-trend signal has enough raw speed+purity to warrant firing.
      const preDuration = bestTimes.length > 1
        ? Math.max(...bestTimes) - Math.min(...bestTimes)
        : thresholds.windowMs;
      const preScore = scoreAbsorption(aggressionPct, preDuration, false, 0, false, false, false);
      if (preScore < COUNTER_TREND_MIN_SCORE) {
        logger.debug({
          symbol, session, direction, trend, preScore,
          required: COUNTER_TREND_MIN_SCORE,
        }, 'absorption filtered: counter-trend below threshold');
        return null;
      }
      trendNote = ` COUNTER-TREND (${trend} trend, score ${preScore} >= ${COUNTER_TREND_MIN_SCORE}).`;
    } else if (trendAligned) {
      trendNote = ` TREND-ALIGNED (${trend}).`;
    } else {
      trendNote = ` NEUTRAL trend.`;
    }
  }

  const durationMs = bestTimes.length > 1
    ? Math.max(...bestTimes) - Math.min(...bestTimes)
    : thresholds.windowMs;

  const approachBars   = countApproachBars(symbol, direction, nowMs);
  const cluster        = checkSignalCluster(symbol, direction, bestPrice, nowMs);
  const isOpeningPeriod = session === 'rth' && (() => {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = fmt.formatToParts(new Date(nowMs));
    const h = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0');
    const m = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0');
    return (h * 60 + m) < 585; // before 9:45 ET
  })();

  const score = scoreAbsorption(
    aggressionPct, durationMs, trendAligned,
    approachBars, cluster.is2nd, cluster.is3rdPlus, isOpeningPeriod,
  );

  const aggressionDesc = isBuyAggression ? 'buy aggression' : 'sell aggression';
  const rationale = `ABSORPTION [${session.toUpperCase()}]: ${bestTotalVol} contracts of ${aggressionDesc} ` +
    `absorbed at ${bestPrice} over ${durationMs}ms. ` +
    `Price range: ${priceRangeTicks} tick(s). ` +
    `Aggression: ${Math.round(aggressionPct * 100)}%. ` +
    `${absorptionSide.toUpperCase()} side defended.${trendNote}`;

  recordSignal(symbol, direction, nowMs);

  // Confluence tracker check
  const tapeSpeedConfirmed = checkTapeSpeedConfirmed(symbol, direction, nowMs);
  const largePrintConfirmed = checkLargePrintConfirmed(symbol, direction, nowMs);
  const confluenceRules = getConfluenceRules(symbol, direction, nowMs);

  if (score < 80) return null;

  // Conviction: boolean — true if pre-signal behavior confirms direction
  const conviction = (await scoreConviction(symbol, direction, 'absorption', nowMs)) !== null;

  logger.info({
    symbol, session, price: bestPrice, volume: bestTotalVol,
    priceRangeTicks, aggressionPct: Math.round(aggressionPct * 100),
    durationMs, direction, score,
    approachBars, clusterIs2nd: cluster.is2nd, clusterIs3rd: cluster.is3rdPlus,
    isOpeningPeriod, trend, trendAligned, conviction,
  }, 'absorption detected');

  const signal: ConfluenceSignal = {
    ts: nowMs,
    source: 'rules-v2',
    type: 'confluence',
    symbol,
    ruleId: 'absorption',
    score,
    direction,
    rationale,
    strategyVersion: 'B',
    ruleVersion: 'absorption-v2',
    tapeSpeedConfirmed,
    largePrintConfirmed,
    confluenceRules,
    trend,
    trendAligned,
    conviction,
    entry,
    stopLevel,
    stopDist,
  } as ConfluenceSignal & {
    tapeSpeedConfirmed: boolean; largePrintConfirmed: boolean;
    confluenceRules: string[]; trend: Trend; trendAligned: boolean;
    conviction: boolean;
    entry: number; stopLevel: number; stopDist: number;
  };

  return {
    signal,
    priceLevel: bestPrice,
    volume: bestTotalVol,
    durationMs,
    aggressionPct,
    priceRangeTicks,
  };
}
