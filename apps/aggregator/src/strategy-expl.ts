/**
 * Strategy EXPL — Pre-Explosive Move Detector
 *
 * Detects institutional accumulation/distribution patterns 30–60 min before explosive moves.
 * Both LONG and SHORT directions.
 *
 * LONG (accumulation) confluences:
 *   1. Stacked BID imbalances in same zone across 2+ footprint periods
 *   2. Large lot BUY print at/near range low (>30 contracts)
 *   3. Cum delta profile: Profile A (bear trap recovery) or Profile B (bull continuation)
 *   4. Price compression (<12pt range in last 5 bars)
 *   5. Shakeout marker — sell spike absorbed, low held
 *
 * SHORT (distribution) confluences — mirrors LONG:
 *   1. Stacked ASK imbalances in same zone across 2+ footprint periods
 *   2. Large lot SELL print at/near range high (>30 contracts)
 *   3. Cum delta profile: A-SHORT (bull trap reversal) or B-SHORT (sustained negative)
 *   4. Price compression (<12pt range in last 5 bars)
 *   5. Reverse shakeout — buy spike rejected, high held (buyers exhausted)
 *
 * Quality gate: RTH only, score >= 3 required, 15-min cooldown per direction
 * Discord marker: EXPL 🚀 (LONG) / EXPL 🔻 (SHORT)
 */

import Database from 'better-sqlite3';
import path from 'path';
import { isSignalAllowed, getRegime } from './regime.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExplSignal {
  timestamp: number;           // ms since epoch
  timestampET: string;         // human-readable ET time
  symbol: string;
  direction: 'LONG' | 'SHORT';
  score: number;               // 1–5 confluence count
  profile: 'A' | 'B' | null;  // cum delta profile
  rangeHigh: number;
  rangeLow: number;
  rangePct: number | null;     // avg BID zone position as % of 60-min range (0=low, 1=high)
  compressionRange: number;    // avg range of last 5 bars
  stackedBidZones: number[];   // price levels where stacked BIDs confirmed (LONG) or ASKs (SHORT)
  largeLotPrice: number;       // price of triggering large lot print
  largeLotSize: number;
  shakeoutDetected: boolean;
  conditions: string[];        // human-readable condition list for Discord
}

interface FootprintBar {
  periodStart: number;   // unix ms
  price: number;
  bidVol: number;
  askVol: number;
  delta: number;
  ratio: number;
}

interface StackedZone {
  direction: 'BID' | 'ASK';
  levels: number;
  priceLow: number;
  priceHigh: number;
  periodStart: number;
}

interface MinuteBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  delta: number;
  cumDelta: number;
  bidVol: number;
  askVol: number;
}

interface LargeLotPrint {
  timestamp: number;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DB_PATH = path.join(process.env.HOME || '', 'trading-cockpit/data/ticks.db');

// RTH: 09:30–16:00 ET in minutes from midnight ET
const RTH_START_MIN = 9 * 60 + 30;   // 570
const RTH_END_MIN   = 16 * 60;        // 960

// Lookback window: 60 minutes in ms
const LOOKBACK_MS = 60 * 60 * 1000;

// Stacked BID detector thresholds
const STACKED_BID_MIN_LEVELS    = 3;    // minimum consecutive BID imbalance levels
const STACKED_BID_MIN_RATIO     = 3.0;  // minimum bid/ask ratio to qualify
const STACKED_BID_MIN_CONTRACTS = 10;   // minimum contracts on bid side
const STACKED_BID_ZONE_TOLERANCE = 2.0; // pts — how close two zones must be to count as "same zone"
const STACKED_BID_MIN_PERIODS   = 2;    // must appear in at least this many footprint periods

// Large lot thresholds
const LARGE_LOT_MIN_SIZE        = 30;   // contracts
const LARGE_LOT_MAX_ABOVE_LOW   = 5.0;  // pts above session/window low

// Compression thresholds
const COMPRESSION_BARS          = 5;    // number of recent bars to evaluate
const COMPRESSION_MAX_RANGE     = 12.0; // pts — max avg range to qualify as compressed

// Cum delta thresholds
const PROFILE_A_NEGATIVE_THRESHOLD = -500;  // cum delta must have dipped below this
const PROFILE_A_RECOVERY_MIN       = 200;   // must recover at least this much from trough
const PROFILE_B_POSITIVE_MIN       = 1500;  // sustained positive cum delta floor

// Volume spike (shakeout marker)
const SHAKEOUT_SPIKE_MULTIPLIER    = 2.0;   // volume must be this many times the 10-bar avg
const SHAKEOUT_DELTA_NEGATIVE      = true;  // spike must be sell-dominated

// Score threshold — minimum to emit signal
const MIN_SCORE_TO_FIRE   = 3;
const OPENING_MIN_SCORE   = 4;    // stricter threshold before 10:30 ET (opening range is noisier)
const OPENING_GATE_MIN_ET = 630;  // 10:30 ET in minutes from midnight
const ZONE_PROXIMITY_MAX  = 60;   // pts — stacked zones beyond this from current price are stale

// Zone position filter: if avg(stackedBidZones) is in the top N% of the 60-min window
// range AND the range is wide enough, suppress — zones at the top = chasing, not accumulation.
const ZONE_POS_MAX    = 0.75;  // top 25% of range triggers filter (LONG)
const ZONE_POS_MIN_RANGE = 50; // only apply filter when window range > 50pts

// Close position filter: if current bar's close is in the top 30% of a wide range,
// the move has already happened — suppress to avoid chasing.
const CLOSE_POS_MAX   = 0.70;  // suppress if close > 70% of window range (LONG)

// ── SHORT-side thresholds (mirrors of long, inverted) ──────────────────────────

// Stacked ASK detector — same ratio/level thresholds as BID, applied to ask/bid ratio
const STACKED_ASK_MIN_RATIO     = 3.0;
const STACKED_ASK_MIN_CONTRACTS = 10;

// Large lot SELL must be within this many pts BELOW the window high
const LARGE_LOT_MAX_BELOW_HIGH  = 5.0;

// Short cum delta profiles
const PROFILE_A_SHORT_POSITIVE_THRESHOLD = 500;   // cum delta must have spiked above this
const PROFILE_A_SHORT_DROP_MIN           = 200;   // must drop at least this much from peak
const PROFILE_B_SHORT_NEGATIVE_MIN       = -1500; // sustained negative cum delta ceiling

// Zone position filter for SHORT: ASK zones must be in the upper 75% (not bottom)
const ZONE_POS_SHORT_MIN  = 0.25;  // bottom 25% triggers filter — zones at bottom = chasing

// Close position filter for SHORT: close in the bottom 30% = already collapsed, chasing
const CLOSE_POS_SHORT_MIN = 0.30;  // suppress if close < 30% of window range

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert UTC ms timestamp to ET time string (UTC-4 during EDT)
 */
function toET(tsMs: number): string {
  const d = new Date(tsMs - 4 * 60 * 60 * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss} ET`;
}

/**
 * Return minutes since midnight ET for a UTC ms timestamp
 */
function etMinutes(tsMs: number): number {
  const etMs = tsMs - 4 * 60 * 60 * 1000;
  const d = new Date(etMs);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * Check if timestamp falls within RTH (09:30–16:00 ET)
 */
function isRTH(tsMs: number): boolean {
  const min = etMinutes(tsMs);
  return min >= RTH_START_MIN && min < RTH_END_MIN;
}

// ─── Data Fetchers ────────────────────────────────────────────────────────────

function getMinuteBars(db: Database.Database, fromMs: number, toMs: number, symbol: string): MinuteBar[] {
  // Aggregate tick data into 1-min bars with delta and cumDelta
  const rows = db.prepare(`
    SELECT
      (ts / 60000) * 60000 AS bar_ts,
      MIN(price)           AS low,
      MAX(price)           AS high,
      SUM(CASE WHEN is_bid_aggressor = 1 THEN size ELSE 0 END) AS bid_vol,
      SUM(CASE WHEN is_bid_aggressor = 0 THEN size ELSE 0 END) AS ask_vol,
      SUM(CASE WHEN is_bid_aggressor = 1 THEN size ELSE -size END) AS delta,
      COUNT(*)             AS trades
    FROM trades
    WHERE symbol = ? AND ts >= ? AND ts < ?
    GROUP BY bar_ts
    ORDER BY bar_ts ASC
  `).all(symbol, fromMs, toMs) as any[];

  let cumDelta = 0;
  return rows.map(r => {
    cumDelta += r.delta;
    return {
      timestamp: r.bar_ts,
      open:  r.low,
      high:  r.high,
      low:   r.low,
      close: r.high,
      volume: r.bid_vol + r.ask_vol,
      delta: r.delta,
      cumDelta,
      bidVol: r.bid_vol,
      askVol: r.ask_vol,
    };
  });
}

function getFootprintBars(db: Database.Database, fromMs: number, toMs: number, symbol: string): FootprintBar[] {
  // 5-min footprint: bid/ask per price level
  const rows = db.prepare(`
    SELECT
      (ts / 300000) * 300000 AS period_start,
      price,
      SUM(CASE WHEN is_bid_aggressor = 1 THEN size ELSE 0 END) AS bid_vol,
      SUM(CASE WHEN is_bid_aggressor = 0 THEN size ELSE 0 END) AS ask_vol
    FROM trades
    WHERE symbol = ? AND ts >= ? AND ts < ?
    GROUP BY period_start, price
    ORDER BY period_start ASC, price DESC
  `).all(symbol, fromMs, toMs) as any[];

  return rows.map(r => {
    const bidVol = r.bid_vol || 0;
    const askVol = r.ask_vol || 0;
    const delta  = bidVol - askVol;
    const ratio  = askVol === 0 ? bidVol * 1000 : bidVol / askVol;
    return {
      periodStart: r.period_start,
      price:       r.price,
      bidVol,
      askVol,
      delta,
      ratio,
    };
  });
}

function getLargeLotPrints(db: Database.Database, fromMs: number, toMs: number, symbol: string): LargeLotPrint[] {
  const rows = db.prepare(`
    SELECT ts AS timestamp, price, size,
           CASE WHEN is_bid_aggressor = 1 THEN 'BUY' ELSE 'SELL' END AS side
    FROM trades
    WHERE symbol = ? AND ts >= ? AND ts < ?
      AND size >= ?
    ORDER BY ts ASC
  `).all(symbol, fromMs, toMs, LARGE_LOT_MIN_SIZE) as any[];

  return rows.map(r => ({
    timestamp: r.timestamp,
    price:     r.price,
    size:      r.size,
    side:      r.side as 'BUY' | 'SELL',
  }));
}

// ─── Detectors ────────────────────────────────────────────────────────────────

/**
 * Detector 1: Stacked BID Imbalances
 * Returns zones (price bands) where stacked BIDs appeared in 2+ footprint periods
 */
function detectStackedBidZones(footprint: FootprintBar[]): number[] {
  // Group footprint rows by period
  const periods = new Map<number, FootprintBar[]>();
  for (const row of footprint) {
    if (!periods.has(row.periodStart)) periods.set(row.periodStart, []);
    periods.get(row.periodStart)!.push(row);
  }

  // For each period, find stacked BID zones
  const allZones: StackedZone[] = [];

  for (const [periodStart, rows] of periods) {
    // Sort by price descending
    const sorted = [...rows].sort((a, b) => b.price - a.price);

    let streak = 0;
    let streakStartPrice = 0;
    let streakEndPrice   = 0;

    for (const r of sorted) {
      const qualifies =
        r.ratio >= STACKED_BID_MIN_RATIO &&
        r.bidVol >= STACKED_BID_MIN_CONTRACTS;

      if (qualifies) {
        if (streak === 0) streakStartPrice = r.price;
        streak++;
        streakEndPrice = r.price;
      } else {
        if (streak >= STACKED_BID_MIN_LEVELS) {
          allZones.push({
            direction: 'BID',
            levels:    streak,
            priceHigh: streakStartPrice,
            priceLow:  streakEndPrice,
            periodStart,
          });
        }
        streak = 0;
      }
    }
    // Catch streak at end of list
    if (streak >= STACKED_BID_MIN_LEVELS) {
      allZones.push({
        direction: 'BID',
        levels:    streak,
        priceHigh: streakStartPrice,
        priceLow:  streakEndPrice,
        periodStart,
      });
    }
  }

  // Find zones that appear in 2+ different periods at the same price area
  const confirmedZoneMidpoints: number[] = [];

  for (let i = 0; i < allZones.length; i++) {
    const zoneA = allZones[i]!;
    const midA  = (zoneA.priceHigh + zoneA.priceLow) / 2;

    for (let j = i + 1; j < allZones.length; j++) {
      const zoneB = allZones[j]!;
      if (zoneB.periodStart === zoneA.periodStart) continue; // same period, skip

      const midB = (zoneB.priceHigh + zoneB.priceLow) / 2;
      if (Math.abs(midA - midB) <= STACKED_BID_ZONE_TOLERANCE) {
        // Same zone in different periods — confirmed
        if (!confirmedZoneMidpoints.some(z => Math.abs(z - midA) <= STACKED_BID_ZONE_TOLERANCE)) {
          confirmedZoneMidpoints.push(midA);
        }
      }
    }
  }

  return confirmedZoneMidpoints;
}

/**
 * Detector 2: Large Lot BUY at range low
 * Returns the qualifying print or null
 */
function detectLargeLotAtLow(
  largeLots: LargeLotPrint[],
  windowLow: number
): LargeLotPrint | null {
  const buys = largeLots.filter(l => l.side === 'BUY');
  if (buys.length === 0) return null;

  // Find largest BUY print within LARGE_LOT_MAX_ABOVE_LOW pts of the window low
  const candidates = buys.filter(l => l.price <= windowLow + LARGE_LOT_MAX_ABOVE_LOW);
  if (candidates.length === 0) return null;

  return candidates.reduce((best, cur) => cur.size > best.size ? cur : best);
}

/**
 * Detector 3: Cum delta profile classifier
 * Returns 'A' (bear trap), 'B' (bull continuation), or null (neither)
 */
function classifyCumDeltaProfile(bars: MinuteBar[]): 'A' | 'B' | null {
  if (bars.length < 5) return null;

  const cumDeltas = bars.map(b => b.cumDelta);
  const minCumDelta  = Math.min(...cumDeltas);
  const lastCumDelta = cumDeltas.at(-1) ?? 0;
  const minIdx = cumDeltas.indexOf(minCumDelta);

  // Profile A: dipped deeply negative, then recovered
  if (
    minCumDelta <= PROFILE_A_NEGATIVE_THRESHOLD &&
    minIdx < cumDeltas.length - 1 &&                         // trough not at last bar
    lastCumDelta - minCumDelta >= PROFILE_A_RECOVERY_MIN     // meaningful recovery
  ) {
    return 'A';
  }

  // Profile B: consistently positive and sustained
  const positiveCount = cumDeltas.filter(d => d >= PROFILE_B_POSITIVE_MIN).length;
  const majorityPositive = positiveCount >= Math.floor(cumDeltas.length * 0.6);
  if (majorityPositive && lastCumDelta >= PROFILE_B_POSITIVE_MIN) {
    return 'B';
  }

  return null;
}

/**
 * Detector 4: Price compression
 * Returns the average range of last N bars, and whether it's below threshold
 */
function detectCompression(bars: MinuteBar[]): { avgRange: number; compressed: boolean } {
  if (bars.length < COMPRESSION_BARS) return { avgRange: 999, compressed: false };

  const lastN = bars.slice(-COMPRESSION_BARS);
  const avgRange = lastN.reduce((sum, b) => sum + (b.high - b.low), 0) / lastN.length;
  return {
    avgRange,
    compressed: avgRange < COMPRESSION_MAX_RANGE,
  };
}

/**
 * Detector 5: Shakeout marker (optional)
 * Volume spike with negative delta that price absorbed (low held)
 */
function detectShakeout(bars: MinuteBar[]): boolean {
  if (bars.length < 12) return false;

  for (let i = 10; i < bars.length; i++) {
    const window = bars.slice(i - 10, i);
    const avgVol = window.reduce((s, b) => s + b.volume, 0) / window.length;
    const bar    = bars[i]!;

    const isSpike    = bar.volume >= avgVol * SHAKEOUT_SPIKE_MULTIPLIER;
    const isSellBar  = bar.delta < 0;

    if (isSpike && isSellBar) {
      // Check that subsequent bars held (price didn't make new low)
      const spikeBarLow = bar.low;
      const subsequent  = bars.slice(i + 1);
      const heldLow     = subsequent.every(b => b.low >= spikeBarLow - 1.0);
      if (heldLow) return true;
    }
  }
  return false;
}

// ─── SHORT Detectors ──────────────────────────────────────────────────────────

/**
 * SHORT Detector 1: Stacked ASK Imbalances
 * Mirror of detectStackedBidZones — uses ask/bid ratio instead of bid/ask ratio
 */
function detectStackedAskZones(footprint: FootprintBar[]): number[] {
  const periods = new Map<number, FootprintBar[]>();
  for (const row of footprint) {
    if (!periods.has(row.periodStart)) periods.set(row.periodStart, []);
    periods.get(row.periodStart)!.push(row);
  }

  const allZones: StackedZone[] = [];

  for (const [periodStart, rows] of periods) {
    // Sort by price ascending (top-down for shorts: we scan from high to low)
    const sorted = [...rows].sort((a, b) => a.price - b.price);

    let streak = 0;
    let streakStartPrice = 0;
    let streakEndPrice   = 0;

    for (const r of sorted) {
      const askRatio = r.bidVol === 0 ? r.askVol * 1000 : r.askVol / r.bidVol;
      const qualifies =
        askRatio >= STACKED_ASK_MIN_RATIO &&
        r.askVol >= STACKED_ASK_MIN_CONTRACTS;

      if (qualifies) {
        if (streak === 0) streakStartPrice = r.price;
        streak++;
        streakEndPrice = r.price;
      } else {
        if (streak >= STACKED_BID_MIN_LEVELS) {
          allZones.push({
            direction: 'ASK',
            levels:    streak,
            priceLow:  streakStartPrice,
            priceHigh: streakEndPrice,
            periodStart,
          });
        }
        streak = 0;
      }
    }
    if (streak >= STACKED_BID_MIN_LEVELS) {
      allZones.push({
        direction: 'ASK',
        levels:    streak,
        priceLow:  streakStartPrice,
        priceHigh: streakEndPrice,
        periodStart,
      });
    }
  }

  const confirmedZoneMidpoints: number[] = [];
  for (let i = 0; i < allZones.length; i++) {
    const zoneA = allZones[i]!;
    const midA  = (zoneA.priceHigh + zoneA.priceLow) / 2;
    for (let j = i + 1; j < allZones.length; j++) {
      const zoneB = allZones[j]!;
      if (zoneB.periodStart === zoneA.periodStart) continue;
      const midB = (zoneB.priceHigh + zoneB.priceLow) / 2;
      if (Math.abs(midA - midB) <= STACKED_BID_ZONE_TOLERANCE) {
        if (!confirmedZoneMidpoints.some(z => Math.abs(z - midA) <= STACKED_BID_ZONE_TOLERANCE)) {
          confirmedZoneMidpoints.push(midA);
        }
      }
    }
  }

  return confirmedZoneMidpoints;
}

/**
 * SHORT Detector 2: Large Lot SELL at range high
 */
function detectLargeLotAtHigh(
  largeLots: LargeLotPrint[],
  windowHigh: number
): LargeLotPrint | null {
  const sells = largeLots.filter(l => l.side === 'SELL');
  if (sells.length === 0) return null;

  const candidates = sells.filter(l => l.price >= windowHigh - LARGE_LOT_MAX_BELOW_HIGH);
  if (candidates.length === 0) return null;

  return candidates.reduce((best, cur) => cur.size > best.size ? cur : best);
}

/**
 * SHORT Detector 3: Cum delta profile classifier (SHORT side)
 * A-SHORT: bull trap — spiked high positive then recovered down ≥200
 * B-SHORT: sustained negative — distribution pattern
 */
function classifyCumDeltaProfileShort(bars: MinuteBar[]): 'A' | 'B' | null {
  if (bars.length < 5) return null;

  const cumDeltas = bars.map(b => b.cumDelta);
  const maxCumDelta  = Math.max(...cumDeltas);
  const lastCumDelta = cumDeltas.at(-1) ?? 0;
  const maxIdx = cumDeltas.indexOf(maxCumDelta);

  // Profile A-SHORT: peaked high then dropped — bull trap
  if (
    maxCumDelta >= PROFILE_A_SHORT_POSITIVE_THRESHOLD &&
    maxIdx < cumDeltas.length - 1 &&                         // peak not at last bar
    maxCumDelta - lastCumDelta >= PROFILE_A_SHORT_DROP_MIN   // meaningful rollover
  ) {
    return 'A';
  }

  // Profile B-SHORT: consistently negative and sustained
  const negativeCount = cumDeltas.filter(d => d <= PROFILE_B_SHORT_NEGATIVE_MIN).length;
  const majorityNegative = negativeCount >= Math.floor(cumDeltas.length * 0.6);
  if (majorityNegative && lastCumDelta <= PROFILE_B_SHORT_NEGATIVE_MIN) {
    return 'B';
  }

  return null;
}

/**
 * SHORT Detector 5: Reverse shakeout marker
 * Volume spike with POSITIVE delta (buy bar), subsequent bars hold the high
 * (buyers exhausted into resistance — trapped longs set up a distribution move)
 */
function detectReverseShakeout(bars: MinuteBar[]): boolean {
  if (bars.length < 12) return false;

  for (let i = 10; i < bars.length; i++) {
    const window = bars.slice(i - 10, i);
    const avgVol = window.reduce((s, b) => s + b.volume, 0) / window.length;
    const bar    = bars[i]!;

    const isSpike   = bar.volume >= avgVol * SHAKEOUT_SPIKE_MULTIPLIER;
    const isBuyBar  = bar.delta > 0;

    if (isSpike && isBuyBar) {
      // Check that subsequent bars held the high (no new high = buyers absorbed, exhausted)
      const spikeBarHigh = bar.high;
      const subsequent   = bars.slice(i + 1);
      if (subsequent.length === 0) continue;
      const heldHigh = subsequent.every(b => b.high <= spikeBarHigh + 1.0);
      if (heldHigh) return true;
    }
  }
  return false;
}

// ─── Signal Scorer ────────────────────────────────────────────────────────────

function scoreSignal(params: {
  stackedBidZones:  number[];
  largeLotPrint:    LargeLotPrint | null;
  cumDeltaProfile:  'A' | 'B' | null;
  compressed:       boolean;
  shakeout:         boolean;
}): { score: number; conditions: string[] } {
  const conditions: string[] = [];
  let score = 0;

  if (params.stackedBidZones.length > 0) {
    score++;
    conditions.push(
      `Stacked BID zones confirmed at ${params.stackedBidZones.map(z => z.toFixed(2)).join(', ')}`
    );
  }

  if (params.largeLotPrint) {
    score++;
    conditions.push(
      `${params.largeLotPrint.size}-lot BUY @ ${params.largeLotPrint.price.toFixed(2)} (at/near range low)`
    );
  }

  if (params.cumDeltaProfile === 'A') {
    score++;
    conditions.push(`Cum delta Profile A — bear trap recovery`);
  } else if (params.cumDeltaProfile === 'B') {
    score++;
    conditions.push(`Cum delta Profile B — bull continuation`);
  }

  if (params.compressed) {
    score++;
    conditions.push(`Price compression confirmed`);
  }

  if (params.shakeout) {
    score++;
    conditions.push(`Shakeout spike absorbed — sellers exhausted`);
  }

  return { score, conditions };
}

function scoreSignalShort(params: {
  stackedAskZones:  number[];
  largeLotPrint:    LargeLotPrint | null;
  cumDeltaProfile:  'A' | 'B' | null;
  compressed:       boolean;
  reverseShakeout:  boolean;
}): { score: number; conditions: string[] } {
  const conditions: string[] = [];
  let score = 0;

  if (params.stackedAskZones.length > 0) {
    score++;
    conditions.push(
      `Stacked ASK zones confirmed at ${params.stackedAskZones.map(z => z.toFixed(2)).join(', ')}`
    );
  }

  if (params.largeLotPrint) {
    score++;
    conditions.push(
      `${params.largeLotPrint.size}-lot SELL @ ${params.largeLotPrint.price.toFixed(2)} (at/near range high)`
    );
  }

  if (params.cumDeltaProfile === 'A') {
    score++;
    conditions.push(`Cum delta Profile A-SHORT — bull trap reversal`);
  } else if (params.cumDeltaProfile === 'B') {
    score++;
    conditions.push(`Cum delta Profile B-SHORT — sustained distribution`);
  }

  if (params.compressed) {
    score++;
    conditions.push(`Price compression confirmed`);
  }

  if (params.reverseShakeout) {
    score++;
    conditions.push(`Reverse shakeout absorbed — buyers exhausted`);
  }

  return { score, conditions };
}

// ─── Main Evaluate Function ───────────────────────────────────────────────────

/**
 * Called by the aggregator on every new tick or bar close.
 * Returns an ExplSignal if conditions are met, otherwise null.
 */
export function evaluateEXPL(nowMs: number, symbol = 'NQ'): ExplSignal | null {
  // 1. RTH gate
  if (!isRTH(nowMs)) return null;

  // 1b. ORM regime gate — TREND-DOWN opening suppresses LONG signals
  if (!isSignalAllowed(symbol, 'long', nowMs)) return null;

  const db = new Database(DB_PATH, { readonly: true });

  try {
    const fromMs = nowMs - LOOKBACK_MS;

    // 3. Fetch data
    const minuteBars  = getMinuteBars(db, fromMs, nowMs, symbol);
    const footprint   = getFootprintBars(db, fromMs, nowMs, symbol);
    const largeLots   = getLargeLotPrints(db, fromMs, nowMs, symbol);

    if (minuteBars.length < 10) return null;

    // 4. Compute window high/low
    const windowHigh = Math.max(...minuteBars.map(b => b.high));
    const windowLow  = Math.min(...minuteBars.map(b => b.low));

    // 5. Run detectors
    const stackedBidZones = detectStackedBidZones(footprint);
    const largeLotPrint   = detectLargeLotAtLow(largeLots, windowLow);
    const cumDeltaProfile = classifyCumDeltaProfile(minuteBars);
    const { avgRange, compressed } = detectCompression(minuteBars);
    const shakeout        = detectShakeout(minuteBars);

    // 5b. Zone proximity filter — discard stale zones (>60pt from current price)
    const currentPrice   = minuteBars.at(-1)!.close;
    const nearbyBidZones = stackedBidZones.filter(z => Math.abs(z - currentPrice) <= ZONE_PROXIMITY_MAX);
    if (nearbyBidZones.length === 0) return null;

    // 6. Score (uses only nearby zones so stale zone clusters don't count)
    const { score, conditions } = scoreSignal({
      stackedBidZones: nearbyBidZones,
      largeLotPrint,
      cumDeltaProfile,
      compressed,
      shakeout,
    });

    // 7. Threshold gate — stricter before 10:30 ET on CALM opening days only.
    // On TREND-UP days the ORM already validated a long signal; don't double-penalise.
    const ormMode = getRegime(symbol).mode;
    const openingIsCalm = etMinutes(nowMs) < OPENING_GATE_MIN_ET && ormMode === 'CALM';
    const effectiveMinScore = openingIsCalm ? OPENING_MIN_SCORE : MIN_SCORE_TO_FIRE;
    if (score < effectiveMinScore) return null;

    // 7b. Shakeout gate — only fire when institutional absorption is confirmed.
    // Score-3 signals without shakeout fire on Profile+Compression alone, which
    // occurs during slow grinds after extended moves (not pre-explosive setups).
    if (!shakeout) return null;

    // 7c. Zone position gate — stacked BID zones must be in the lower 75% of the
    // 60-min window range. If zones cluster near the TOP of a wide range, the setup
    // is chasing an extended move, not accumulation at a range low.
    const windowRange = windowHigh - windowLow;
    let rangePct: number | null = null;
    if (stackedBidZones.length > 0 && windowRange > ZONE_POS_MIN_RANGE) {
      const avgZone = stackedBidZones.reduce((s, z) => s + z, 0) / stackedBidZones.length;
      rangePct = (avgZone - windowLow) / windowRange;
      if (rangePct > ZONE_POS_MAX) return null;
    } else if (stackedBidZones.length > 0) {
      const avgZone = stackedBidZones.reduce((s, z) => s + z, 0) / stackedBidZones.length;
      rangePct = windowRange > 0 ? (avgZone - windowLow) / windowRange : null;
    }

    // 7d. Current price position gate — if price is already in the top 30% of a
    // wide range the explosive move has played out and we'd be chasing.
    if (windowRange > ZONE_POS_MIN_RANGE) {
      const currentClose = minuteBars.at(-1)!.close;
      const closePct = (currentClose - windowLow) / windowRange;
      if (closePct > CLOSE_POS_MAX) return null;
    }

    // 8. No new lows after large lot print (disqualifier)
    if (largeLotPrint) {
      const barsAfterPrint = minuteBars.filter(b => b.timestamp > largeLotPrint.timestamp);
      const newLowAfterPrint = barsAfterPrint.some(b => b.low < largeLotPrint.price - 2.0);
      if (newLowAfterPrint) return null;
    }

    // 9. Emit signal

    return {
      timestamp:        nowMs,
      timestampET:      toET(nowMs),
      symbol,
      direction:        'LONG',
      score,
      profile:          cumDeltaProfile,
      rangeHigh:        windowHigh,
      rangeLow:         windowLow,
      rangePct,
      compressionRange: avgRange,
      stackedBidZones:  nearbyBidZones,
      largeLotPrice:    largeLotPrint?.price ?? 0,
      largeLotSize:     largeLotPrint?.size ?? 0,
      shakeoutDetected: shakeout,
      conditions,
    };

  } finally {
    db.close();
  }
}

/**
 * SHORT mirror of evaluateEXPL.
 * Detects institutional distribution patterns before explosive down-moves.
 */
export function evaluateEXPLShort(nowMs: number, symbol = 'NQ'): ExplSignal | null {
  if (!isRTH(nowMs)) return null;

  // ORM regime gate — TREND-UP opening suppresses SHORT signals
  if (!isSignalAllowed(symbol, 'short', nowMs)) return null;

  const db = new Database(DB_PATH, { readonly: true });

  try {
    const fromMs = nowMs - LOOKBACK_MS;

    const minuteBars = getMinuteBars(db, fromMs, nowMs, symbol);
    const footprint  = getFootprintBars(db, fromMs, nowMs, symbol);
    const largeLots  = getLargeLotPrints(db, fromMs, nowMs, symbol);

    if (minuteBars.length < 10) return null;

    const windowHigh = Math.max(...minuteBars.map(b => b.high));
    const windowLow  = Math.min(...minuteBars.map(b => b.low));

    const stackedAskZones   = detectStackedAskZones(footprint);
    const largeLotPrint     = detectLargeLotAtHigh(largeLots, windowHigh);
    const cumDeltaProfile   = classifyCumDeltaProfileShort(minuteBars);
    const { avgRange, compressed } = detectCompression(minuteBars);
    const reverseShakeout   = detectReverseShakeout(minuteBars);

    // Zone proximity filter — discard stale ASK zones
    const currentPrice    = minuteBars.at(-1)!.close;
    const nearbyAskZones  = stackedAskZones.filter(z => Math.abs(z - currentPrice) <= ZONE_PROXIMITY_MAX);
    if (nearbyAskZones.length === 0) return null;

    const { score, conditions } = scoreSignalShort({
      stackedAskZones: nearbyAskZones,
      largeLotPrint,
      cumDeltaProfile,
      compressed,
      reverseShakeout,
    });

    const ormModeShort = getRegime(symbol).mode;
    const openingIsCalmShort = etMinutes(nowMs) < OPENING_GATE_MIN_ET && ormModeShort === 'CALM';
    const effectiveMinScore = openingIsCalmShort ? OPENING_MIN_SCORE : MIN_SCORE_TO_FIRE;
    if (score < effectiveMinScore) return null;

    // Reverse shakeout required — same reasoning as LONG shakeout gate
    if (!reverseShakeout) return null;

    // Zone position gate: ASK zones must be in the upper 75% of range
    // (zones near the bottom = not distribution at top = suppress)
    const windowRange = windowHigh - windowLow;
    let rangePct: number | null = null;
    if (stackedAskZones.length > 0 && windowRange > ZONE_POS_MIN_RANGE) {
      const avgZone = stackedAskZones.reduce((s, z) => s + z, 0) / stackedAskZones.length;
      rangePct = (avgZone - windowLow) / windowRange;
      if (rangePct < ZONE_POS_SHORT_MIN) return null;
    } else if (stackedAskZones.length > 0) {
      const avgZone = stackedAskZones.reduce((s, z) => s + z, 0) / stackedAskZones.length;
      rangePct = windowRange > 0 ? (avgZone - windowLow) / windowRange : null;
    }

    // Close position gate: if close is already in the bottom 30% of a wide range,
    // the move has already collapsed — suppress chasing
    if (windowRange > ZONE_POS_MIN_RANGE) {
      const currentClose = minuteBars.at(-1)!.close;
      const closePct = (currentClose - windowLow) / windowRange;
      if (closePct < CLOSE_POS_SHORT_MIN) return null;
    }

    // No new highs after large lot SELL print (disqualifier — distribution failed)
    if (largeLotPrint) {
      const barsAfterPrint = minuteBars.filter(b => b.timestamp > largeLotPrint.timestamp);
      const newHighAfterPrint = barsAfterPrint.some(b => b.high > largeLotPrint.price + 2.0);
      if (newHighAfterPrint) return null;
    }

    return {
      timestamp:        nowMs,
      timestampET:      toET(nowMs),
      symbol,
      direction:        'SHORT',
      score,
      profile:          cumDeltaProfile,
      rangeHigh:        windowHigh,
      rangeLow:         windowLow,
      rangePct,
      compressionRange: avgRange,
      stackedBidZones:  nearbyAskZones,   // field reused for ASK zones in SHORT signals
      largeLotPrice:    largeLotPrint?.price ?? 0,
      largeLotSize:     largeLotPrint?.size ?? 0,
      shakeoutDetected: reverseShakeout,
      conditions,
    };

  } finally {
    db.close();
  }
}

// ─── Discord Formatter ────────────────────────────────────────────────────────

export function formatEXPLDiscord(signal: ExplSignal): object {
  const isShort = signal.direction === 'SHORT';
  const scoreBar = '🟢'.repeat(signal.score) + '⬜'.repeat(5 - signal.score);
  const profileLabel = isShort
    ? (signal.profile === 'A' ? 'Bull Trap Reversal' : signal.profile === 'B' ? 'Sustained Distribution' : 'Unclassified')
    : (signal.profile === 'A' ? 'Bear Trap Recovery' : signal.profile === 'B' ? 'Bull Continuation'  : 'Unclassified');

  const zoneLabel  = isShort ? 'Stacked ASK Zones' : 'Stacked BID Zones';
  const shakeLabel = isShort ? '✅ Yes — buyers exhausted' : '✅ Yes — sellers absorbed';

  return {
    embeds: [{
      title: isShort
        ? `🔻 EXPL SHORT — Explosive Down-Move Setup`
        : `🚀 EXPL LONG — Explosive Up-Move Setup`,
      color: isShort ? 0xd64545 : 0x00ff88,
      fields: [
        { name: 'Time',      value: signal.timestampET,          inline: true },
        { name: 'Direction', value: `**${signal.direction}**`,   inline: true },
        { name: 'Score',     value: `${scoreBar}  (${signal.score}/5)`, inline: true },
        { name: 'Cum Delta Profile',    value: profileLabel,     inline: true },
        { name: 'Window Range',
          value: `${signal.rangeLow.toFixed(2)} — ${signal.rangeHigh.toFixed(2)}`, inline: true },
        { name: 'Compression (5-bar avg)',
          value: `${signal.compressionRange.toFixed(1)} pts`,    inline: true },
        { name: 'Confluences Confirmed',
          value: signal.conditions.map(c => `✅ ${c}`).join('\n'), inline: false },
        { name: isShort ? 'Reverse Shakeout' : 'Shakeout Detected',
          value: signal.shakeoutDetected ? shakeLabel : '❌ No', inline: true },
        { name: zoneLabel,
          value: signal.stackedBidZones.length > 0
            ? signal.stackedBidZones.map(z => z.toFixed(2)).join(', ')
            : 'None',
          inline: true },
      ],
      footer: { text: `Strategy EXPL | ${signal.symbol} Futures | Score threshold: ${MIN_SCORE_TO_FIRE}/5` },
      timestamp: new Date(signal.timestamp).toISOString(),
    }],
  };
}

// ─── Quality Gate Integration Point ──────────────────────────────────────────
//
// In quality.ts, add:
//
//   case 'expl':
//     return signal.score >= 3; // always GOLD if score met — no session filter beyond RTH gate
//
// In server.ts or the main signal loop, add:
//
//   import { evaluateEXPL, formatEXPLDiscord } from './strategy-expl';
//
//   // Run on every bar close (1-min)
//   const explSignal = evaluateEXPL(Date.now());
//   if (explSignal) {
//     const payload = formatEXPLDiscord(explSignal);
//     await sendDiscordWebhook(payload);
//     storeSignal({ ruleId: 'expl', ...explSignal });
//   }
