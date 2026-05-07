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
import { scoreRSLevels, formatRSContext, formatExitTargets } from './rs-level-scorer.js';
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
      ts: group[0].ts,
      open: group[0].open,
      high: Math.max(...group.map(b => b.high)),
      low: Math.min(...group.map(b => b.low)),
      close: group[group.length - 1].close,
    });
  }

  return fiveMins;
}

export function classifyTrend(symbol: Symbol, nowMs: number): Trend {
  const bars = buildFiveMinBars(symbol, nowMs);

  // Need exactly 3 five-minute bars
  if (bars.length < 3) return 'neutral';

  // Use the 3 most recent bars
  const [b1, b2, b3] = bars.slice(-3);

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
// Base 50. Bonuses:
//   Volume 1.5x threshold: +10
//   Volume 2.0x threshold: +20
//   Zero price range:      +10
//   Aggression >= 80%:     +5
//   Duration < 1s:         +5
//   Trend-aligned signal:  +5

function scoreAbsorption(
  volume: number,
  minVolume: number,
  priceRangeTicks: number,
  aggressionPct: number,
  durationMs: number,
  trendAligned: boolean
): number {
  let score = 50;
  const volumeRatio = volume / minVolume;
  if (volumeRatio >= 2.0) score += 20;
  else if (volumeRatio >= 1.5) score += 10;
  if (priceRangeTicks === 0) score += 10;
  if (aggressionPct >= 0.80) score += 5;
  if (durationMs < 1000) score += 5;
  if (trendAligned) score += 5;
  return Math.min(100, score);
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
      // Pre-score to check if this counter-trend signal is strong enough
      const preScore = scoreAbsorption(
        bestTotalVol, thresholds.minVolume, priceRangeTicks,
        aggressionPct, bestTimes.length > 1
          ? Math.max(...bestTimes) - Math.min(...bestTimes)
          : thresholds.windowMs,
        false
      );
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

  const score = scoreAbsorption(
    bestTotalVol, thresholds.minVolume, priceRangeTicks,
    aggressionPct, durationMs, trendAligned
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

  // RS level scoring: proximity bonus + hard filters + exit targets
  // currentPrice = bestPrice (the absorption level IS the current price)
  const rs = scoreRSLevels(bestPrice, direction, levels, bestPrice);

  // Hard filter: DD band rules
  if (rs.hardFiltered) {
    logger.debug({ symbol, direction, reason: rs.filterReason }, 'absorption hard-filtered by RS rules');
    return null;
  }

  // Apply RS bonuses and penalties to score
  const rsBonus = rs.proximityBonus + rs.greaterMarketBonus;
  const rsPenalty = rs.greaterMarketPenalty;
  const finalScore = Math.min(100, Math.max(0, score + rsBonus - rsPenalty));

  // Build RS context note for rationale
  let rsNote = '';
  if (rs.nearestMatch) {
    rsNote = ` AT ${rs.nearestMatch.label} (${rs.nearestMatch.isEST ? 'EST 90%' : 'RS pivot'}, +${rs.proximityBonus}pts).`;
  }
  if (rs.greaterMarketAligned) rsNote += ` GM-ALIGNED (+${rs.greaterMarketBonus}pts).`;
  if (rsPenalty > 0) rsNote += ` COUNTER-GM (-${rsPenalty}pts).`;
  if (rs.volatilityNote) rsNote += ` [${rs.volatilityNote}]`;

  // Build exit target note
  const exitNote = (rs.tp1 || rs.tp2) ? ` Targets: ${formatExitTargets(rs.tp1, rs.tp2)}` : '';

  // Conviction rating: pre-signal behavior analysis
  const conviction = await scoreConviction(symbol, direction, 'absorption', nowMs);

  logger.info({
    symbol, session, price: bestPrice, volume: bestTotalVol,
    priceRangeTicks, aggressionPct: Math.round(aggressionPct * 100),
    durationMs, direction,
    score, rsBonus, rsPenalty, finalScore,
    rsLevel: rs.nearestMatch?.label ?? 'none',
    trend, trendAligned, conviction,
  }, 'absorption detected');

  const signal: ConfluenceSignal = {
    ts: nowMs,
    source: 'rules-v2',
    type: 'confluence',
    symbol,
    ruleId: 'absorption',
    score: finalScore,
    direction,
    rationale: rationale + rsNote + exitNote,
    strategyVersion: 'B',
    ruleVersion: 'absorption-v1',
    tapeSpeedConfirmed,
    largePrintConfirmed,
    confluenceRules,
    trend,
    trendAligned,
    rsLevel: rs.nearestMatch?.label ?? null,
    rsBonus,
    tp1: rs.tp1,
    tp2: rs.tp2,
    greaterMarketAligned: rs.greaterMarketAligned,
    rsContext: formatRSContext(),
    conviction,
  } as ConfluenceSignal & {
    tapeSpeedConfirmed: boolean; largePrintConfirmed: boolean;
    confluenceRules: string[]; trend: Trend; trendAligned: boolean;
    rsLevel: string | null; rsBonus: number;
    tp1: typeof rs.tp1; tp2: typeof rs.tp2;
    greaterMarketAligned: boolean; rsContext: string;
    conviction: typeof conviction;
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
