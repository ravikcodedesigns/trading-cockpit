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
// Parameters are session-aware (RTH vs overnight) to account for
// different liquidity environments.

import { getRecentTrades } from './tick-client.js';
import { logger } from '../logger.js';
import type { ConfluenceSignal, Symbol } from '@trading/contracts';

// --- Session classifier ---

type Session = 'rth' | 'overnight' | 'closed';

function classifySession(tsMs: number): Session {
  const d = new Date(tsMs);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  const minutesOfDay = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  const RTH_START = 570;
  const RTH_END = 960;
  const ON_RESUME = 1080;
  const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday);
  if (isWeekday && minutesOfDay >= RTH_START && minutesOfDay < RTH_END) return 'rth';
  if (isWeekday) {
    if (minutesOfDay < RTH_START) return 'overnight';
    if (weekday !== 'Fri' && minutesOfDay >= ON_RESUME) return 'overnight';
    return 'closed';
  }
  if (weekday === 'Sun' && minutesOfDay >= ON_RESUME) return 'overnight';
  return 'closed';
}

// --- Session-aware thresholds ---
//
// RTH: tighter window, higher volume requirement (more liquidity)
// Overnight: wider window, lower volume requirement (thinner book)

interface AbsorptionThresholds {
  windowMs: number;          // sliding window duration
  minVolume: number;         // minimum contracts absorbed
  maxPriceRangeTicks: number; // max price movement within window (in 0.25pt ticks)
  minAggressionPct: number;  // minimum % one-sided aggression (0-1)
  cooldownMs: number;        // min ms between signals for same symbol+direction
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

const TICK_SIZE = 0.25; // NQ tick size

// --- Cooldown tracker ---

const _lastSignalMs = new Map<string, number>();

function isCoolingDown(symbol: string, direction: string, nowMs: number, cooldownMs: number): boolean {
  const key = `${symbol}:${direction}`;
  const last = _lastSignalMs.get(key) ?? 0;
  return nowMs - last < cooldownMs;
}

function recordSignal(symbol: string, direction: string, nowMs: number): void {
  _lastSignalMs.set(`${symbol}:${direction}`, nowMs);
}

// --- Scoring ---
//
// Base score 50. Bonuses for:
//   - Volume ratio above threshold (+10 per 1.5x multiple, max +20)
//   - Very tight price range (0 ticks = +10)
//   - High aggression concentration (>= 80% one-sided = +5)
//   - Fast absorption (completed in < 1s = +5)

function scoreAbsorption(
  volume: number,
  minVolume: number,
  priceRangeTicks: number,
  aggressionPct: number,
  durationMs: number
): number {
  let score = 50;
  const volumeRatio = volume / minVolume;
  if (volumeRatio >= 2.0) score += 20;
  else if (volumeRatio >= 1.5) score += 10;
  if (priceRangeTicks === 0) score += 10;
  if (aggressionPct >= 0.80) score += 5;
  if (durationMs < 1000) score += 5;
  return Math.min(100, score);
}

// --- Main rule function ---
//
// Called every POLL_MS (500ms) per symbol.
// Fetches recent trades, runs the sliding window analysis,
// and returns a signal if absorption is detected.

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
  nowMs: number
): Promise<AbsorptionResult | null> {
  const session = classifySession(nowMs);
  if (session === 'closed') return null;

  const thresholds = THRESHOLDS[session];

  // Fetch trades for the window
  const trades = await getRecentTrades(symbol, thresholds.windowMs);
  if (trades.length === 0) return null;

  // Group trades by price level (rounded to tick)
  const byPrice = new Map<number, { buyVol: number; sellVol: number; times: number[] }>();

  for (const trade of trades) {
    // Round to nearest tick to group adjacent prints
    const tickPrice = Math.round(trade.price / TICK_SIZE) * TICK_SIZE;
    if (!byPrice.has(tickPrice)) {
      byPrice.set(tickPrice, { buyVol: 0, sellVol: 0, times: [] });
    }
    const entry = byPrice.get(tickPrice)!;
    entry.times.push(trade.ts);
    if (trade.isBidAggressor) {
      // Buyer aggressor = sell aggression (hitting the bid)
      entry.sellVol += trade.size;
    } else {
      // Seller aggressor = buy aggression (lifting the ask)
      entry.buyVol += trade.size;
    }
  }

  // Overall price range of all trades in window
  const allPrices = trades.map(t => t.price);
  const minPrice = Math.min(...allPrices);
  const maxPrice = Math.max(...allPrices);
  const priceRangeTicks = Math.round((maxPrice - minPrice) / TICK_SIZE);

  // Price range must be tight — absorption means price isn't moving
  if (priceRangeTicks > thresholds.maxPriceRangeTicks) return null;

  // Find the price level with the most concentrated volume
  let bestPrice = 0;
  let bestTotalVol = 0;
  let bestBuyVol = 0;
  let bestSellVol = 0;
  let bestTimes: number[] = [];

  for (const [price, entry] of byPrice.entries()) {
    const total = entry.buyVol + entry.sellVol;
    if (total > bestTotalVol) {
      bestTotalVol = total;
      bestPrice = price;
      bestBuyVol = entry.buyVol;
      bestSellVol = entry.sellVol;
      bestTimes = entry.times;
    }
  }

  // Must meet minimum volume
  if (bestTotalVol < thresholds.minVolume) return null;

  // Must be one-sided aggression
  const dominantVol = Math.max(bestBuyVol, bestSellVol);
  const aggressionPct = dominantVol / bestTotalVol;
  if (aggressionPct < thresholds.minAggressionPct) return null;

  // Determine direction
  // BUY aggression (sellers absorbed) = BEARISH (big seller defending resistance)
  // SELL aggression (buyers absorbed) = BULLISH (big buyer defending support)
  const isBuyAggression = bestBuyVol > bestSellVol;
  const direction: 'long' | 'short' = isBuyAggression ? 'short' : 'long';
  const absorptionSide = isBuyAggression ? 'sell' : 'buy';

  // Cooldown check
  if (isCoolingDown(symbol, direction, nowMs, thresholds.cooldownMs)) return null;

  // Duration of absorption
  const durationMs = bestTimes.length > 1
    ? Math.max(...bestTimes) - Math.min(...bestTimes)
    : thresholds.windowMs;

  // Score
  const score = scoreAbsorption(
    bestTotalVol,
    thresholds.minVolume,
    priceRangeTicks,
    aggressionPct,
    durationMs
  );

  // Build rationale
  const aggressionDesc = isBuyAggression ? 'buy aggression' : 'sell aggression';
  const rationale = `ABSORPTION [${session.toUpperCase()}]: ${bestTotalVol} contracts of ${aggressionDesc} ` +
    `absorbed at ${bestPrice} over ${durationMs}ms. ` +
    `Price range: ${priceRangeTicks} tick(s). ` +
    `Aggression concentration: ${Math.round(aggressionPct * 100)}%. ` +
    `${absorptionSide.toUpperCase()} side defended.`;

  // Record cooldown
  recordSignal(symbol, direction, nowMs);

  logger.info({
    symbol,
    session,
    price: bestPrice,
    volume: bestTotalVol,
    priceRangeTicks,
    aggressionPct: Math.round(aggressionPct * 100),
    durationMs,
    direction,
    score,
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
    ruleVersion: 'absorption-v1',
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
