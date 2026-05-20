// Strategy J — TRAP (Tick-Level Seller/Buyer Trap Detector)
//
// Detects when an opposing directional spike into an established CVD background
// is absorbed — the dominant side holds the level and resumes control.
//
// LONG (seller trapped): buyers dominated last 15 bars (CVD >= +MIN_CVD_BACKGROUND)
//   → sellers spike in  (worst 5s net delta in last 60s <= -MIN_SPIKE)
//   → buyers absorb     (net delta in the 10s AFTER spike peak >= MIN_RECOVERY)
//   → spike low held    (current price >= spike low - LEVEL_TOLERANCE)
//
// SHORT (buyer trapped): mirror
//
// Latency model with 500ms polling + 5s sub-windows:
//   spike detected in the peak 5s window (rolling, no fixed boundaries)
//   recovery confirmed after 10s of opposing pressure → signal fires within 0.5s
//   total delay: spike_duration + ~10s recovery window + ≤0.5s poll = ~10-20s
//
// Validated cases:
//   05/13 11:45 LONG 85pts: sellers spiked Δ=-817 in 30s, buyers absorbed, low held
//   05/15 10:24 SHORT 97pts: seller spike continued (no buyer recovery) — correctly not fired

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db.js';
import { logger } from '../logger.js';
import { isSignalAllowed } from '../regime.js';
import type { Symbol, ConfluenceSignal } from '@trading/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TICKS_DB_PATH = path.resolve(__dirname, '../../../../data/ticks.db');

const MIN_1 = 60_000;
const SEC_5 = 5_000;

const MACRO_N            = 15;       // bars of background CVD context
const MIN_CVD_BACKGROUND = 3000;    // strong directional background (calibrated 2026-05-15)
const MIN_SPIKE          = 300;     // min opposing contracts in worst 5s window
const MIN_RECOVERY       = 150;     // min same-dir contracts in 10s post-spike
const RECOVERY_MS        = 10_000;  // how long we watch for recovery after spike peak
const SPIKE_LOOKBACK_MS  = 60_000;  // how far back to search for the spike
const LEVEL_TOLERANCE    = 4;       // pts — spike low/high allowed to slip before invalidating
const MAX_STOP_DIST      = 15;      // pts — skip large-stop trades (bad R:R with fixed 20pt T1)
const OPEN_FILTER_MIN    = 600;     // skip before 10:00 ET (first 30min: CVD not established)
const COOLDOWN_MS        = 20 * 60_000;

interface Tick { ts: number; price: number; size: number; is_bid_aggressor: number; }

interface TrapSignal {
  direction: 'long' | 'short';
  cvd15: number;
  spikeDelta: number;    // worst 5s delta (negative for LONG trap)
  recoveryDelta: number; // net delta in RECOVERY_MS after spike peak
  spikeLo: number;
  spikeHi: number;
  spikeTs: number;       // timestamp of spike peak window
  entry: number;
  score: number;
}

const _lastSignalMs  = new Map<string, number>();
// Per-spike dedup: guards against multiple polls detecting the same spike event.
// Two polls that produce the same spikeTs for the same symbol+direction are the
// same event — only the first one should fire.
const _lastSpikeTs   = new Map<string, number>();

export function seedJCooldownFromDb(): void {
  for (const sym of ['NQ', 'ES'] as Symbol[]) {
    for (const dir of ['long', 'short']) {
      const ts = db.lastSignalTsFor('trap', sym, dir);
      if (ts > 0) _lastSignalMs.set(`${sym}:${dir}`, ts);
    }
  }
}

function isCooling(symbol: Symbol, direction: string, nowMs: number): boolean {
  return nowMs - (_lastSignalMs.get(`${symbol}:${direction}`) ?? 0) < COOLDOWN_MS;
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
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday) && min >= 570 && min < 960;
}

function buildCvd15(ticks: Tick[], nowMs: number): number {
  const currentBarStart = Math.floor(nowMs / MIN_1) * MIN_1;
  const windowStart = currentBarStart - MACRO_N * MIN_1;
  const bars = new Map<number, { bid: number; ask: number }>();
  for (const t of ticks) {
    if (t.ts < windowStart || t.ts >= currentBarStart) continue;
    const bucket = Math.floor(t.ts / MIN_1) * MIN_1;
    const bar = bars.get(bucket) ?? { bid: 0, ask: 0 };
    if (t.is_bid_aggressor === 1) bar.bid += t.size;
    else bar.ask += t.size;
    bars.set(bucket, bar);
  }
  return Array.from(bars.values()).reduce((s, b) => s + b.bid - b.ask, 0);
}

// Build rolling 5s sub-windows over the last SPIKE_LOOKBACK_MS
function build5sWindows(ticks: Tick[], fromMs: number, toMs: number) {
  const map = new Map<number, { bid: number; ask: number; lo: number; hi: number }>();
  for (const t of ticks) {
    if (t.ts < fromMs || t.ts >= toMs) continue;
    const b = Math.floor(t.ts / SEC_5) * SEC_5;
    const cur = map.get(b) ?? { bid: 0, ask: 0, lo: t.price, hi: t.price };
    if (t.is_bid_aggressor === 1) cur.bid += t.size;
    else cur.ask += t.size;
    cur.lo = Math.min(cur.lo, t.price);
    cur.hi = Math.max(cur.hi, t.price);
    map.set(b, cur);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a - b)
    .map(([ts, w]) => ({ ts, delta: w.bid - w.ask, lo: w.lo, hi: w.hi }));
}

function detect(ticks: Tick[], nowMs: number): TrapSignal | null {
  if (ticks.length < 10) return null;

  const cvd15 = buildCvd15(ticks, nowMs);
  if (Math.abs(cvd15) < MIN_CVD_BACKGROUND) return null;

  // Sliding 5s windows over spike lookback period (exclude last RECOVERY_MS — that's the recovery window)
  const spikeSearchEnd = nowMs - RECOVERY_MS;
  const windows = build5sWindows(ticks, nowMs - SPIKE_LOOKBACK_MS, spikeSearchEnd);
  if (windows.length === 0) return null;

  // Net delta in recovery window (last RECOVERY_MS)
  let recoveryBid = 0, recoveryAsk = 0;
  for (const t of ticks) {
    if (t.ts < spikeSearchEnd || t.ts >= nowMs) continue;
    if (t.is_bid_aggressor === 1) recoveryBid += t.size;
    else recoveryAsk += t.size;
  }
  const recoveryDelta = recoveryBid - recoveryAsk;

  const currentPrice = ticks.at(-1)!.price;

  // --- LONG trap: buyer background, seller spike absorbed ---
  if (cvd15 >= MIN_CVD_BACKGROUND) {
    // Find the worst (most negative) 5s window in the spike period
    const spike = windows.reduce((w, x) => x.delta < w.delta ? x : w);
    if (spike.delta > -MIN_SPIKE) return null;      // no real seller spike
    if (recoveryDelta < MIN_RECOVERY) return null;  // buyers didn't respond
    if (currentPrice < spike.lo - LEVEL_TOLERANCE) return null; // low broken

    let score = 80;
    if (Math.abs(spike.delta) >= 200) score += 5;
    if (recoveryDelta >= 120) score += 5;
    if (cvd15 >= 3000) score += 5;
    if (currentPrice > spike.lo) score += 5; // price fully above spike low

    return {
      direction: 'long', cvd15,
      spikeDelta: spike.delta, recoveryDelta,
      spikeLo: spike.lo, spikeHi: spike.hi, spikeTs: spike.ts,
      entry: currentPrice, score: Math.min(100, score),
    };
  }

  // --- SHORT trap: seller background, buyer spike absorbed ---
  if (cvd15 <= -MIN_CVD_BACKGROUND) {
    const spike = windows.reduce((w, x) => x.delta > w.delta ? x : w);
    if (spike.delta < MIN_SPIKE) return null;
    if (recoveryDelta > -MIN_RECOVERY) return null;
    if (currentPrice > spike.hi + LEVEL_TOLERANCE) return null;

    let score = 80;
    if (spike.delta >= 200) score += 5;
    if (Math.abs(recoveryDelta) >= 120) score += 5;
    if (Math.abs(cvd15) >= 3000) score += 5;
    if (currentPrice < spike.hi) score += 5;

    return {
      direction: 'short', cvd15,
      spikeDelta: spike.delta, recoveryDelta,
      spikeLo: spike.lo, spikeHi: spike.hi, spikeTs: spike.ts,
      entry: currentPrice, score: Math.min(100, score),
    };
  }

  return null;
}

export async function runStrategyJ(symbol: Symbol, nowMs: number): Promise<ConfluenceSignal | null> {
  if (!isRTH(nowMs)) return null;

  // Skip opening 30 min — CVD background not yet established
  const etMin = (() => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(nowMs));
    const g = (t: string) => p.find(x => x.type === t)?.value ?? '0';
    return parseInt(g('hour'), 10) * 60 + parseInt(g('minute'), 10);
  })();
  if (etMin < OPEN_FILTER_MIN) return null;

  if (isCooling(symbol, 'long', nowMs) && isCooling(symbol, 'short', nowMs)) return null;

  const ticksDb = new Database(TICKS_DB_PATH, { readonly: true });
  let ticks: Tick[];
  try {
    const sinceMs = nowMs - (MACRO_N + 2) * MIN_1;
    ticks = ticksDb.prepare(`
      SELECT ts, price, size, is_bid_aggressor
      FROM trades WHERE symbol = ? AND ts >= ?
      ORDER BY ts ASC
    `).all(symbol, sinceMs) as Tick[];
  } finally {
    ticksDb.close();
  }

  const hit = detect(ticks, nowMs);
  if (!hit) return null;
  if (isCooling(symbol, hit.direction, nowMs)) return null;

  // Spike-level dedup: reject if this exact spike timestamp was already processed.
  // Prevents multiple 500ms polls from firing on the same absorbed spike event.
  const spikeKey = `${symbol}:${hit.direction}`;
  if (_lastSpikeTs.get(spikeKey) === hit.spikeTs) return null;

  // ORM gate: suppress counter-trend TRAP signals during trending opens.
  if (!isSignalAllowed(symbol, hit.direction, nowMs)) {
    logger.info({ symbol, direction: hit.direction }, 'strategy-J: ORM gate suppressed signal');
    return null;
  }

  const isLong  = hit.direction === 'long';
  const stop    = isLong ? hit.spikeLo - 2 : hit.spikeHi + 2;
  const stopDist = Math.abs(hit.entry - stop);
  if (stopDist > MAX_STOP_DIST) return null;  // skip bad R:R large-stop setups

  // DB-level dedup: reject if a trap signal for this symbol+direction already exists
  // within the same 1-minute candle bucket. Guards against in-memory cooldown loss on restart.
  const candle = Math.floor(nowMs / MIN_1) * MIN_1;
  const existing = db.lastSignalTsFor('trap', symbol, hit.direction);
  if (existing >= candle) return null;

  _lastSignalMs.set(`${symbol}:${hit.direction}`, nowMs);
  _lastSpikeTs.set(spikeKey, hit.spikeTs);

  const targets  = isLong
    ? `T1=${(hit.entry + 20).toFixed(2)} (+20) T2=${(hit.entry + 40).toFixed(2)} (+40)`
    : `T1=${(hit.entry - 20).toFixed(2)} (-20) T2=${(hit.entry - 40).toFixed(2)} (-40)`;

  const agoSec = Math.round((nowMs - hit.spikeTs) / 1000);
  const rationale =
    `TRAP ${hit.direction.toUpperCase()}: ` +
    `cvd15=${hit.cvd15 > 0 ? '+' : ''}${hit.cvd15} ` +
    `spike=${hit.spikeDelta}ct (${agoSec}s ago) recovery=+${hit.recoveryDelta}ct ` +
    `spikeLow=${hit.spikeLo} entry=${hit.entry} ` +
    `stop=${stop.toFixed(2)} (${stopDist.toFixed(1)}pts risk). ${targets}`;

  logger.info({
    symbol, direction: hit.direction, score: hit.score,
    cvd15: hit.cvd15, spikeDelta: hit.spikeDelta, recoveryDelta: hit.recoveryDelta,
    spikeAgoSec: agoSec, spikeLo: hit.spikeLo, spikeHi: hit.spikeHi,
    entry: hit.entry, stop,
  }, 'strategy-J TRAP fired');

  return {
    ts: Math.floor(nowMs / MIN_1) * MIN_1,
    source: 'rules-v2',
    type: 'confluence',
    symbol,
    ruleId: 'trap',
    score: hit.score,
    direction: hit.direction,
    rationale,
    strategyVersion: 'J' as any,
    ruleVersion: 'trap-v1',
    entry: hit.entry,
    stopLevel: stop,
    stopDist,
    cvd15: hit.cvd15,
    spikeDelta: hit.spikeDelta,
    recoveryDelta: hit.recoveryDelta,
    spikeLo: hit.spikeLo,
    spikeHi: hit.spikeHi,
    spikeTs: hit.spikeTs,
  } as any;
}
