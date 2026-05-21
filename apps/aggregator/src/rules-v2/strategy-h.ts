// Strategy H — CLEAN Impulse Detector (FLIP only)
//
// LONG FLIP — bottom of range exhaustion reversal:
//   Prior 3 bars net bearish + current bar: strong buy delta + low in bottom 30% of range
//   deltaT >= +300, compPos(LOW) <= 0.30, deltaLast3 <= -100
//
// SHORT FLIP — top of range buyer exhaustion reversal:
//   NQ tops are made by buyer exhaustion, not seller aggression.
//   Prior 1–2 bars had a very strong push UP (priorImpulse >= 1400 delta).
//   Current bar: upper wick >= 15pts (strong rejection), body >= 5pts.
//   compPos uses bar HIGH — the wick reached the top; LOW is dragged down by the body.
//   compPosHigh in [0.50, 1.00] — upper half of range, not a new breakout bar.
//   deltaT can be weak/neutral — buyers just stop pushing.
//
// CONT signals removed: 33% win rate vs FLIP's ~60%, avg score 80 vs 93.
// Entry: close of reversal bar
// Stop:  low of bar (long) / high of bar (short)
// Targets: T1 +20pts, T2 +40pts, T3 +60pts
// Cooldown: 15 min per symbol+direction
// Staleness guard: bar must have closed within last 2 minutes

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db.js';
import { logger } from '../logger.js';
import { updateRegime, isSignalAllowed } from '../regime.js';
import type { Symbol, ConfluenceSignal } from '@trading/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TICKS_DB_PATH = path.resolve(__dirname, '../../../../data/ticks.db');

const MIN_1   = 60_000;
const MACRO_N = 30;
const COOLDOWN_MS       = 15 * 60 * 1000;
const CROSS_COOLDOWN_MS = 45 * 60 * 1000;  // suppress opposite direction after a signal
const STALE_MS          =  2 * MIN_1;

// Body size minimums
const BODY_MIN = 5.0;   // pts — must be a real impulse bar, not a doji

// FLIP thresholds — LONG
const FLIP_COMP_MIN_LONG  = -0.05;  // reject breakdowns: bar LOW must not be below macro range
const FLIP_COMP_MAX_LONG  =  0.30;  // long flip: bar LOW in bottom 30% of 30-bar range
const FLIP_DELTA_T_LONG   =  300;   // strong buy aggression on the reversal bar
const FLIP_PRIOR3_LONG    = -100;   // prior 3 bars must sum to <= -100 (bearish pressure)

// FLIP thresholds — SHORT
// NQ tops are made by BUYER EXHAUSTION, not seller aggression.
// The defining markers are: (1) prior 1–2 bars had a strong impulse UP, and
// (2) the reversal bar has an UPPER WICK (reached a new high, got rejected, closed lower).
// deltaT is often weak on the reversal bar — buyers just stop, sellers don't pile in yet.
// Using bar HIGH for compPos: the wick reached the top; bar LOW is dragged down by the body.
// Upper bound of 1.0: if compPosHigh > 1.0 the bar is breaking OUT (new macro high), not reversing.
const FLIP_COMP_MIN_SHORT_HIGH  = 0.50;  // bar HIGH in upper half of 30-bar range
const FLIP_COMP_MAX_SHORT_HIGH  = 1.00;  // must not be making a brand-new macro high (breakout)
const FLIP_WICK_MIN_SHORT       = 15.0;  // strong rejection wick: the failed push IS the signal
const FLIP_PRIOR_IMPULSE_SHORT  = 1400;  // prior 1–2 bars must have had a very strong push up
const FLIP_DELTA_T_SHORT_MAX    = 300;   // reversal bar must not be aggressively bullish
const FLIP_BAR_RANGE_MIN_SHORT  = 22.0;  // min high-low range — filters noise/doji consolidation bars

interface OHLCBar {
  ts: number;
  open: number; high: number; low: number; close: number;
  vol: number; delta: number;
}

type PatternType = 'FLIP';

interface DetectedSignal {
  direction: 'long' | 'short';
  pattern: PatternType;
  score: number;
  compPos: number;
  deltaT: number;
  delta5: number;
  delta15: number;
  deltaLast3: number;
  body: number;
  entry: number;
  stopLevel: number;
  barTs: number;
}

const _lastSignalMs = new Map<string, number>();

/** Call once on startup to restore cooldown state across restarts. */
export function seedCooldownFromDb(): void {
  for (const sym of ['NQ', 'ES'] as Symbol[]) {
    for (const dir of ['long', 'short']) {
      const ts = db.lastSignalTsFor('clean-impulse', sym, dir);
      if (ts > 0) _lastSignalMs.set(`${sym}:${dir}`, ts);
    }
  }
}

function isCooling(symbol: Symbol, direction: string, nowMs: number): boolean {
  if (nowMs - (_lastSignalMs.get(`${symbol}:${direction}`) ?? 0) < COOLDOWN_MS) return true;
  // A SHORT suppresses LONG (don't buy right after a sell signal), but
  // a LONG does NOT suppress SHORT — tops and bottoms are independent events.
  if (direction === 'long') {
    if (nowMs - (_lastSignalMs.get(`${symbol}:short`) ?? 0) < CROSS_COOLDOWN_MS) return true;
  }
  return false;
}

function isRTH(tsMs: number): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  const min = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday) &&
    min >= 570 && min < 960;
}

// Returns false during windows where LONG signals have poor historical win rates:
//   before 09:54 ET  — opening volatility, 43% WR
//   14:30–16:00 ET   — late session, 28% WR (-13.9pts/trade)
function isLongTimeAllowed(tsMs: number): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const etMin = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  if (etMin < 594)               return false;  // before 09:54 ET
  if (etMin >= 870 && etMin < 960) return false;  // 14:30–16:00 ET
  return true;
}

// Returns true only when the last complete 1h bar is red (close < open).
// SHORT flip signals fired into a green 1h bar have 13% WR (-33.8pts/trade);
// fired into a red 1h bar they have 82% WR (+56.4pts/trade).
function isShortHourlyAligned(symbol: Symbol, tsMs: number): boolean {
  const HR1 = 60 * 60_000;
  const ticksDb = new Database(TICKS_DB_PATH, { readonly: true });
  try {
    // Last complete 1h bar = the one whose close time (ts + HR1) <= tsMs
    const barStart = Math.floor(tsMs / HR1) * HR1 - HR1;  // previous hour bucket
    const trades = ticksDb.prepare(
      `SELECT price FROM trades WHERE symbol=? AND ts >= ? AND ts < ? ORDER BY ts ASC`
    ).all(symbol, barStart, barStart + HR1) as { price: number }[];

    if (trades.length < 2) return true;  // not enough data — allow through
    const open  = trades[0]!.price;
    const close = trades[trades.length - 1]!.price;
    return close < open;  // red bar = short is aligned with hourly direction
  } finally {
    ticksDb.close();
  }
}

function buildBars(symbol: Symbol, sinceMs: number): OHLCBar[] {
  // Build 1-min bars from raw ticks (ticks.db) so delta is computed from
  // actual bid/ask aggressor flags — bookmap bar events don't include delta.
  const ticksDb = new Database(TICKS_DB_PATH, { readonly: true });
  try {
    const trades = ticksDb.prepare(`
      SELECT ts, price, size, is_bid_aggressor
      FROM trades
      WHERE symbol = ? AND ts >= ?
      ORDER BY ts ASC
    `).all(symbol, sinceMs) as { ts: number; price: number; size: number; is_bid_aggressor: number }[];

    const buckets = new Map<number, {
      open: number; close: number; high: number; low: number;
      bidVol: number; askVol: number;
    }>();

    for (const t of trades) {
      const bucket = Math.floor(t.ts / MIN_1) * MIN_1;
      const bar = buckets.get(bucket);
      if (!bar) {
        buckets.set(bucket, {
          open: t.price, close: t.price, high: t.price, low: t.price,
          bidVol: t.is_bid_aggressor === 1 ? t.size : 0,
          askVol: t.is_bid_aggressor === 0 ? t.size : 0,
        });
      } else {
        bar.high  = Math.max(bar.high, t.price);
        bar.low   = Math.min(bar.low,  t.price);
        bar.close = t.price;
        if (t.is_bid_aggressor === 1) bar.bidVol += t.size;
        else                          bar.askVol += t.size;
      }
    }

    return Array.from(buckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([ts, bar]) => ({
        ts,
        open:  bar.open,
        high:  bar.high,
        low:   bar.low,
        close: bar.close,
        vol:   bar.bidVol + bar.askVol,
        delta: bar.bidVol - bar.askVol,
      }));
  } finally {
    ticksDb.close();
  }
}

function detect(bars: OHLCBar[], nowMs: number): DetectedSignal | null {
  if (bars.length < MACRO_N + 2) return null;

  // Exclude the current forming bar — use only completed bars
  const completed = bars.slice(0, -1);
  const cur = completed[completed.length - 1];
  if (!cur) return null;

  // Staleness guard: only fire on bars that closed within the last 2 minutes.
  // cur.ts is the bar's open (bucket start); bar closes at cur.ts + MIN_1.
  if (nowMs - (cur.ts + MIN_1) > STALE_MS) return null;

  // ── Macro context (30 bars before current) ────────────────────────────────
  const macroBars = completed.slice(-(MACRO_N + 1), -1);
  if (macroBars.length < MACRO_N) return null;

  const macroHigh  = Math.max(...macroBars.map(b => b.high));
  const macroLow   = Math.min(...macroBars.map(b => b.low));
  const macroRange = macroHigh - macroLow;

  // comp_pos (LONG): position of bar's LOW in 30-bar macro range — extreme bottom = flip zone
  const compPos = macroRange > 0 ? (cur.low - macroLow) / macroRange : 0.5;
  // comp_pos (SHORT): position of bar's HIGH — the bar reached a new high then got rejected
  const compPosHigh = macroRange > 0 ? (cur.high - macroLow) / macroRange : 0.5;

  // ── Delta windows ─────────────────────────────────────────────────────────
  const last15 = completed.slice(-16, -1);  // 15 bars before current
  const last5  = completed.slice(-6,  -1);  // 5 bars before current
  const last3  = completed.slice(-4,  -1);  // 3 bars before current

  const delta15    = last15.reduce((s, b) => s + b.delta, 0);
  const delta5     = last5.reduce((s, b) => s + b.delta, 0);
  const deltaLast3 = last3.reduce((s, b) => s + b.delta, 0);
  const deltaT     = cur.delta;

  // Prior bars for SHORT impulse check
  const prevBar  = completed[completed.length - 2];
  const prev2Bar = completed[completed.length - 3];
  const priorImpulse = Math.max(prevBar?.delta ?? 0, prev2Bar?.delta ?? 0);

  // ── Bar body / wicks ──────────────────────────────────────────────────────
  const bodyLong  = cur.close - cur.open;  // positive if bull bar
  const bodyShort = cur.open  - cur.close; // positive if bear bar
  const upperWick = cur.high  - cur.close;

  // ── LONG FLIP ─────────────────────────────────────────────────────────────
  // Bottom of range + prior bars were bearish → exhaustion reversal
  if (
    bodyLong   >= BODY_MIN          &&
    deltaT     >= FLIP_DELTA_T_LONG &&
    compPos    >= FLIP_COMP_MIN_LONG && compPos <= FLIP_COMP_MAX_LONG &&
    deltaLast3 <= FLIP_PRIOR3_LONG
  ) {
    let score = 80;
    if (deltaT >= 500)   score += 10;
    else if (deltaT >= 400) score += 5;
    if (bodyLong >= 15)  score += 5;
    if (compPos  <= 0.15) score += 5;   // deep extreme = stronger reversal signal
    score = Math.min(100, score);

    return {
      direction: 'long', pattern: 'FLIP', score,
      compPos, deltaT, delta5, delta15, deltaLast3,
      body: bodyLong,
      entry: cur.close, stopLevel: cur.low, barTs: cur.ts,
    };
  }

  // ── SHORT FLIP ────────────────────────────────────────────────────────────
  // NQ tops are made by BUYER EXHAUSTION, not seller aggression.
  // The prior 1–2 bars pushed UP hard (trapped buyers), then the current bar
  // tries to extend the breakout (upper wick), fails, and closes lower (body).
  // DeltaT on the reversal bar is often weak — buyers just stop.
  // Using bar HIGH for compPos: the wick reached the top, the low is mid-range.
  if (
    bodyShort       >= BODY_MIN                 &&
    upperWick       >= FLIP_WICK_MIN_SHORT      &&  // strong rejection wick (failure to hold new high)
    compPosHigh     >= FLIP_COMP_MIN_SHORT_HIGH &&  // bar HIGH reached upper 50% of 30-bar range
    compPosHigh     <= FLIP_COMP_MAX_SHORT_HIGH &&  // bar did NOT make a fresh new macro high (breakout)
    priorImpulse    >= FLIP_PRIOR_IMPULSE_SHORT &&  // prior 1–2 bars drove a very strong push up
    deltaT          <= FLIP_DELTA_T_SHORT_MAX   &&  // reversal bar not aggressively buying
    (cur.high - cur.low) >= FLIP_BAR_RANGE_MIN_SHORT  // not a noise/doji bar — must be a real range bar
  ) {
    let score = 80;
    if (bodyShort >= 15)        score += 5;
    if (upperWick >= 20)        score += 5;   // very large rejection wick = strong exhaustion
    if (compPosHigh >= 0.80)    score += 5;   // deep into the top of range
    if (priorImpulse >= 2000)   score += 5;   // extremely strong prior impulse
    score = Math.min(100, score);

    return {
      direction: 'short', pattern: 'FLIP', score,
      compPos: compPosHigh, deltaT, delta5, delta15, deltaLast3,
      body: bodyShort,
      entry: cur.close, stopLevel: cur.high, barTs: cur.ts,
    };
  }

  return null;
}

export async function runStrategyH(
  symbol: Symbol,
  nowMs: number
): Promise<ConfluenceSignal | null> {
  if (!isRTH(nowMs)) return null;

  const sinceMs = nowMs - (MACRO_N + 5) * MIN_1;
  const bars    = buildBars(symbol, sinceMs);

  // Keep regime current on every bar — even when no signal fires
  const _completed = bars.slice(0, -1);
  const _lastBar   = _completed[_completed.length - 1];
  if (_lastBar) updateRegime(symbol, nowMs, _lastBar.close);

  const hit = detect(bars, nowMs);
  if (!hit) return null;

  if (hit.direction === 'long' && !isLongTimeAllowed(nowMs)) {
    logger.info({ symbol, nowMs }, 'strategy-H: LONG suppressed by time-of-day gate');
    return null;
  }

  if (hit.direction === 'short' && !isShortHourlyAligned(symbol, nowMs)) {
    logger.info({ symbol, nowMs }, 'strategy-H: SHORT suppressed — 1h bar not red (82% WR requires red 1h)');
    return null;
  }

  if (isCooling(symbol, hit.direction, nowMs)) return null;
  if (!isSignalAllowed(symbol, hit.direction, nowMs)) {
    logger.info({ symbol, direction: hit.direction }, 'strategy-H: ORM gate suppressed signal');
    return null;
  }

  // Check if this signal flips an open position (opposite direction fired within 15 min)
  const oppositeDir = hit.direction === 'long' ? 'short' : 'long';
  const lastOppositeMs = _lastSignalMs.get(`${symbol}:${oppositeDir}`) ?? 0;
  const isPositionFlip = (nowMs - lastOppositeMs) < COOLDOWN_MS;

  _lastSignalMs.set(`${symbol}:${hit.direction}`, nowMs);

  const entry    = hit.entry;
  const stop     = hit.stopLevel;
  const stopDist = Math.abs(entry - stop);
  const isLong   = hit.direction === 'long';

  const targets = isLong
    ? `T1=${entry + 20} (+20) T2=${entry + 40} (+40) T3=${entry + 60} (+60)`
    : `T1=${entry - 20} (-20) T2=${entry - 40} (-40) T3=${entry - 60} (-60)`;

  const fmt = (n: number) => (n > 0 ? '+' : '') + n;
  const flipPrefix = isPositionFlip
    ? `⚡ FLIP — CLOSE ${oppositeDir.toUpperCase()} / ENTER ${hit.direction.toUpperCase()}: `
    : '';
  const rationale =
    flipPrefix +
    `CLEAN-${hit.pattern} ${hit.direction.toUpperCase()}: ` +
    `body=${hit.body.toFixed(1)}pts, deltaT=${fmt(hit.deltaT)}, ` +
    `delta_last3=${fmt(hit.deltaLast3)}, delta5=${fmt(hit.delta5)}, delta15=${fmt(hit.delta15)}, ` +
    `comp_pos=${hit.compPos.toFixed(2)}. ` +
    `Entry=${entry} Stop=${stop} (${stopDist.toFixed(1)}pts risk). ` +
    `${targets}.`;

  logger.info({
    symbol, direction: hit.direction, pattern: hit.pattern,
    score: hit.score, entry, stop, stopDist, isPositionFlip,
    compPos: hit.compPos, deltaT: hit.deltaT,
    delta5: hit.delta5, delta15: hit.delta15, deltaLast3: hit.deltaLast3,
  }, 'strategy-H: CLEAN signal fired');

  return {
    ts: hit.barTs,  // bar open timestamp — lightweight-charts identifies bars by open, not close
    source: 'rules-v2',
    type: 'confluence',
    symbol,
    ruleId: 'clean-impulse',
    score: hit.score,
    direction: hit.direction,
    rationale,
    strategyVersion: 'H' as any,
    ruleVersion: 'clean-v1',
    pattern: hit.pattern,
    entry,
    stopLevel: stop,
    stopDist,
    compPos: hit.compPos,
    deltaT: hit.deltaT,
    delta5: hit.delta5,
    delta15: hit.delta15,
    deltaLast3: hit.deltaLast3,
    isPositionFlip,
  } as any;
}
