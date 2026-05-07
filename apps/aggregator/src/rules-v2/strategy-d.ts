// Strategy D — 15-min Compression Breakout with 5-min Entry
//
// Two-stage detection:
//   Stage 1: 15-min watcher — 5 completed 15-min bars form compression
//             (range < 50pts, velocity < 8pts/bar)
//             → 15-min bar closes outside range → open 5-min watch window
//
//   Stage 2: 5-min confirmation — within 30 minutes, first 5-min bar
//             that closes outside the 15-min range in same direction
//             → fire signal
//
// Signal payload:
//   - compression range (high/low)
//   - direction
//   - stop level (compression boundary)
//   - entry price (5-min breakout close)
//   - time from 15-min alert to 5-min entry

import { db } from '../db.js';
import { logger } from '../logger.js';
import { getContext } from '../rs-context.js';
import type { Symbol, ConfluenceSignal } from '@trading/contracts';

const MIN_15 = 15 * 60 * 1000;
const MIN_5  = 5  * 60 * 1000;

const COMP_BARS   = 5;
const MAX_RANGE   = 50;   // pts — p25 of 15-min 5-bar compression
const MAX_VEL     = 8.0;  // pts per 15-min bar
const WATCH_MS    = 30 * 60 * 1000;  // 30 min window for 5-min confirmation
const COOLDOWN_MS = 60 * 60 * 1000;  // 1 hour cooldown per direction

interface OHLCBar {
  ts: number;
  open: number; high: number; low: number; close: number;
  vol: number; delta: number;
}

interface WatchWindow {
  direction: 'long' | 'short';
  compHigh: number;
  compLow: number;
  alertTs: number;
  stopLevel: number;
}

// Per-symbol state
const _watch15 = new Map<Symbol, WatchWindow | null>();
const _lastSignalMs = new Map<string, number>();

function isCooling(symbol: Symbol, direction: string, nowMs: number): boolean {
  return nowMs - (_lastSignalMs.get(`${symbol}:${direction}`) ?? 0) < COOLDOWN_MS;
}

// Build N-minute bars from 1-min bars stored in events
function buildBars(symbol: Symbol, intervalMs: number, sinceMs: number): OHLCBar[] {
  const rawBars = db.query<{ payload: string }>(`
    SELECT payload FROM events
    WHERE source = 'bookmap'
      AND type = 'bar'
      AND symbol = ?
      AND ts >= ?
    ORDER BY ts ASC
  `, [symbol, sinceMs]);

  // Aggregate 1-min bars into interval-sized bars
  const buckets = new Map<number, OHLCBar>();
  for (const row of rawBars) {
    try {
      const b = JSON.parse(row.payload) as OHLCBar;
      const bucket = Math.floor(b.ts / intervalMs) * intervalMs;
      if (!buckets.has(bucket)) {
        buckets.set(bucket, {
          ts: bucket, open: b.open, high: b.high,
          low: b.low, close: b.close,
          vol: b.vol ?? 0, delta: b.delta ?? 0,
        });
      } else {
        const agg = buckets.get(bucket)!;
        agg.high  = Math.max(agg.high, b.high);
        agg.low   = Math.min(agg.low,  b.low);
        agg.close = b.close;
        agg.vol  += b.vol ?? 0;
        agg.delta += b.delta ?? 0;
      }
    } catch { /* skip malformed */ }
  }
  return Array.from(buckets.values()).sort((a, b) => a.ts - b.ts);
}

function checkCompression(bars15: OHLCBar[]): {
  isCompressed: boolean;
  high: number; low: number; range: number;
} {
  if (bars15.length < COMP_BARS) return { isCompressed: false, high: 0, low: 0, range: 0 };

  const recent = bars15.slice(-COMP_BARS);
  const high = Math.max(...recent.map(b => b.high));
  const low  = Math.min(...recent.map(b => b.low));
  const range = high - low;

  if (range > MAX_RANGE) return { isCompressed: false, high, low, range };

  // Velocity check
  const last3 = recent.slice(-3);
  const vel = Math.abs((last3[2].close - last3[0].close) / 3);
  if (vel > MAX_VEL) return { isCompressed: false, high, low, range };

  return { isCompressed: true, high, low, range };
}

export async function runStrategyD(
  symbol: Symbol,
  nowMs: number
): Promise<ConfluenceSignal | null> {
  const sinceFetch = nowMs - (COMP_BARS + 2) * MIN_15;

  // ── Stage 1: Check for 15-min compression breakout ──────────────────────
  const bars15 = buildBars(symbol, MIN_15, sinceFetch);
  if (bars15.length < COMP_BARS + 1) return null;

  const completedBars15 = bars15.slice(0, -1); // exclude current incomplete bar
  const { isCompressed, high: compHigh, low: compLow } = checkCompression(completedBars15);

  if (isCompressed) {
    // Check if the latest completed 15-min bar broke out
    const lastCompleted = completedBars15[completedBars15.length - 1];
    const brokeUp   = lastCompleted.close > compHigh + 1.0;
    const brokeDown = lastCompleted.close < compLow  - 1.0;

    if ((brokeUp || brokeDown) && !_watch15.get(symbol)) {
      const direction = brokeUp ? 'long' : 'short';

      if (!isCooling(symbol, direction, nowMs)) {
        _watch15.set(symbol, {
          direction,
          compHigh, compLow,
          alertTs: lastCompleted.ts + MIN_15, // when the 15-min bar closed
          stopLevel: direction === 'long' ? compLow : compHigh,
        });

        logger.info({
          symbol, direction, compHigh, compLow,
          range: compHigh - compLow,
          alertTs: new Date(lastCompleted.ts + MIN_15).toISOString(),
        }, 'strategy-D: 15-min compression breakout — watching for 5-min entry');
      }
    }
  }

  // ── Stage 2: Check 5-min bars for entry confirmation ────────────────────
  const watch = _watch15.get(symbol);
  if (!watch) return null;

  // Expire watch window after 30 minutes
  if (nowMs - watch.alertTs > WATCH_MS) {
    _watch15.set(symbol, null);
    logger.debug({ symbol }, 'strategy-D: 5-min watch window expired');
    return null;
  }

  const bars5 = buildBars(symbol, MIN_5, watch.alertTs);
  if (bars5.length < 1) return null;

  // Check each 5-min bar for breakout in the same direction
  for (const bar5 of bars5) {
    if (bar5.ts < watch.alertTs) continue; // skip bars before alert

    const broke5Up   = bar5.close > watch.compHigh + 0.5;
    const broke5Down = bar5.close < watch.compLow  - 0.5;
    const confirmed  = (watch.direction === 'long'  && broke5Up) ||
                       (watch.direction === 'short' && broke5Down);

    if (!confirmed) continue;

    // Signal confirmed
    _watch15.set(symbol, null);
    _lastSignalMs.set(`${symbol}:${watch.direction}`, nowMs);

    const entry    = bar5.close;
    const stopDist = Math.abs(entry - watch.stopLevel);
    const ctx      = getContext();

    // Scoring: based on compression tightness and GM alignment
    const compRange = watch.compHigh - watch.compLow;
    let score = 60;
    if (compRange < 30) score += 15;       // very tight compression
    else if (compRange < 40) score += 8;   // tight compression
    const gmAligned = ctx.greaterMarket === 'neutral' ||
      (ctx.greaterMarket === 'bull' && watch.direction === 'long') ||
      (ctx.greaterMarket === 'bear' && watch.direction === 'short');
    if (gmAligned) score += 10;
    score = Math.min(100, score);

    const timeToConfirm = bar5.ts - watch.alertTs;
    const rationale =
      `COMPRESSION-BREAKOUT [15m→5m]: 75-min range ${compRange.toFixed(1)}pts ` +
      `(${watch.compLow}–${watch.compHigh}). ` +
      `15-min breakout ${watch.direction}. ` +
      `5-min confirmed in ${Math.round(timeToConfirm/60000)}min at ${entry}. ` +
      `Stop: ${watch.stopLevel} (${stopDist.toFixed(1)}pts). ` +
      `GM: ${ctx.greaterMarket}.`;

    logger.info({
      symbol, direction: watch.direction, entry,
      stopLevel: watch.stopLevel, stopDist,
      compRange, score, timeToConfirmMin: Math.round(timeToConfirm/60000),
    }, 'strategy-D: SIGNAL');

    return {
      ts: bar5.ts,
      source: 'rules-v2',
      type: 'confluence',
      symbol,
      ruleId: 'compression-breakout',
      score,
      direction: watch.direction,
      rationale,
      strategyVersion: 'D' as any,
      ruleVersion: 'compression-v1',
      // Extra fields
      compHigh: watch.compHigh,
      compLow: watch.compLow,
      compRange,
      stopLevel: watch.stopLevel,
      stopDist,
      entry,
    } as any;
  }

  return null;
}

export function getStrategyDWatchStatus(symbol: Symbol) {
  return _watch15.get(symbol) ?? null;
}
