// Strategy: Compression + Real-Bid-Wall + Capitulation (LONG only)
//
// SETUP (multi-condition confluence):
//   1. RTH only (09:30-14:30 ET; skip late-session chop)
//   2. 5-bar 1-min compression: high-low range ≤ COMPRESSION_MAX_RANGE pts
//   3. MBO real-bid-wall at the range low (within ±WALL_PRICE_BUFFER pts):
//      ≥ WALL_MIN_ORDERS distinct bid orders, each with size ≥ WALL_MIN_SIZE
//      and lifetime ≥ WALL_MIN_LIFETIME_MS (filters HFT spoofs from real defense).
//   4. Capitulation: ZERO sell-aggressor trades at range low ± CAP_ZONE_PT
//      in the last CAP_WINDOW_MS (sellers have stopped attacking).
//   5. 10-min cooldown per compression box (no re-fire while same setup persists).
//
// EXIT:
//   TP = +24 pts (range projection)
//   SL = -6 pts (R:R = 1:4, matches goal constraint)
//   Trail to BE after +12 pts
//   Hard time-stop: 10 min
//
// STATUS (2026-06-03): Shadow-mode. Quality gate in quality.ts forces 'silenced'
// tier until multi-day MBO validation. The rule logic is sound (single-day MBO
// produced zero qualifying conditions but that's because no compression+wall
// confluence formed). Re-evaluate after 2+ weeks of MBO accumulation.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';
import type { ConfluenceSignal, Symbol } from '@trading/contracts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Tunables ──────────────────────────────────────────────────────────────
const COMPRESSION_BARS      = 5;
const COMPRESSION_MAX_RANGE = 12.0;
const BAR_MS                = 60_000;

const WALL_LOOKBACK_MS      = 60_000;
const WALL_MIN_LIFETIME_MS  = 5_000;
const WALL_MIN_SIZE         = 20;
const WALL_PRICE_BUFFER     = 2.0;
const WALL_MIN_ORDERS       = 3;

const CAP_WINDOW_MS         = 5_000;
const CAP_ZONE_PT           = 1.0;

const COOLDOWN_MS           = 10 * 60_000;
const TOD_CUTOFF_MIN        = 14*60 + 30;  // skip after 14:30 ET

// ── State ──────────────────────────────────────────────────────────────────
let ticksDb: Database.Database | null = null;
let mboDb:   Database.Database | null = null;
const _lastSignalMs = new Map<string, number>();

function openTicksDb(): Database.Database {
  if (ticksDb) return ticksDb;
  ticksDb = new Database(path.resolve(__dirname, '../../../../data/ticks.db'), { readonly: true });
  return ticksDb;
}
function openMboDb(): Database.Database {
  if (mboDb) return mboDb;
  mboDb = new Database(path.resolve(__dirname, '../../../../data/mbo.db'), { readonly: true });
  return mboDb;
}

function isRTH(tsMs: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const min = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  return ['Mon','Tue','Wed','Thu','Fri'].includes(get('weekday'))
    && min >= 570 && min < TOD_CUTOFF_MIN;
}

interface Bar { ts: number; high: number; low: number; close: number; }

function buildBars(symbol: Symbol, sinceMs: number, nowMs: number): Bar[] {
  const db = openTicksDb();
  const trades = db.prepare(`
    SELECT ts, price FROM trades WHERE symbol = ? AND ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `).all(symbol, sinceMs, nowMs) as Array<{ts:number;price:number}>;
  const bars: Bar[] = [];
  let curBucket = 0, curBar: Bar | null = null;
  for (const t of trades) {
    const bk = Math.floor(t.ts / BAR_MS) * BAR_MS;
    if (bk !== curBucket) {
      if (curBar) bars.push(curBar);
      curBar = { ts: bk, high: t.price, low: t.price, close: t.price };
      curBucket = bk;
    } else if (curBar) {
      if (t.price > curBar.high) curBar.high = t.price;
      if (t.price < curBar.low) curBar.low = t.price;
      curBar.close = t.price;
    }
  }
  if (curBar) bars.push(curBar);
  return bars;
}

// ── Rule entry point ──────────────────────────────────────────────────────
export async function detectCompressionRealwall(
  symbol: Symbol,
  nowMs: number,
): Promise<{ signal: ConfluenceSignal } | null> {
  if (symbol !== 'NQ') return null;          // MNQ-equivalent only
  if (!isRTH(nowMs)) return null;
  const cdKey = `${symbol}:long`;
  if (nowMs - (_lastSignalMs.get(cdKey) ?? 0) < COOLDOWN_MS) return null;

  // Build last 6 minutes of bars
  const sinceMs = nowMs - 6 * BAR_MS;
  const bars = buildBars(symbol, sinceMs, nowMs);
  if (bars.length < COMPRESSION_BARS) return null;
  const window = bars.slice(-COMPRESSION_BARS);
  const high = Math.max(...window.map(b => b.high));
  const low  = Math.min(...window.map(b => b.low));
  if (high - low > COMPRESSION_MAX_RANGE) return null;

  // Real-bid-wall check via MBO
  const mbo = openMboDb();
  const wallSearchStart = nowMs - WALL_LOOKBACK_MS;
  const wallCount = mbo.prepare(`
    SELECT COUNT(*) as n FROM mbo_orders
    WHERE symbol = 'MNQM' AND is_bid = 1
      AND send_ts_ms IS NOT NULL
      AND send_ts_ms BETWEEN ? AND ?
      AND ABS(send_price - ?) <= ?
      AND send_size >= ?
      AND (last_ts_ms - send_ts_ms) >= ?
  `).get(wallSearchStart, nowMs, low, WALL_PRICE_BUFFER, WALL_MIN_SIZE, WALL_MIN_LIFETIME_MS) as {n: number};
  if (wallCount.n < WALL_MIN_ORDERS) return null;

  // Capitulation check: no sell-aggressors at range_low ± CAP_ZONE in last 5s
  const capStart = nowMs - CAP_WINDOW_MS;
  const violations = mbo.prepare(`
    SELECT COUNT(*) as n FROM mbo_trades
    WHERE symbol = 'MNQM' AND is_bid_aggressor = 0
      AND ts_ms BETWEEN ? AND ?
      AND ABS(price - ?) <= ?
      AND aggressor_order_id != ''
  `).get(capStart, nowMs, low, CAP_ZONE_PT) as {n: number};
  if (violations.n > 0) return null;

  // Entry price = current last trade (will be filled at next ask + slippage by trader)
  const lastPx = (openTicksDb().prepare(
    `SELECT price FROM trades WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`
  ).get(symbol, nowMs) as {price:number}|undefined)?.price;
  if (!lastPx) return null;

  _lastSignalMs.set(cdKey, nowMs);
  logger.info({
    symbol, rangeLow: low, rangeHigh: high, rangePts: high-low,
    wallOrders: wallCount.n, lastPx,
  }, 'compression-realwall: signal');

  return {
    signal: {
      ts: nowMs,
      source: 'rules-v2',
      type: 'confluence',
      symbol,
      ruleId: 'compression-realwall',
      score: 70,                  // gold-tier-eligible; quality.ts may silence
      direction: 'long',
      rationale:
        `COMPRESSION-REALWALL: 5-bar range ${(high-low).toFixed(1)}pt ` +
        `${low.toFixed(2)}-${high.toFixed(2)} | ` +
        `${wallCount.n} real-bid orders within ${WALL_PRICE_BUFFER}pt of low ` +
        `(size≥${WALL_MIN_SIZE}, life≥${WALL_MIN_LIFETIME_MS/1000}s) | ` +
        `zero sell-aggressors at low ±${CAP_ZONE_PT}pt in last ${CAP_WINDOW_MS/1000}s. ` +
        `TP=+24 SL=-6 (R:R 1:4). Status: SHADOW pending multi-day MBO validation.`,
      strategyVersion: 'COMPR-WALL' as any,
      ruleVersion: 'compr-wall-v1',
      entry: lastPx,
      stopLevel: lastPx - 6,
      stopDist: 6,
      pattern: 'COMPR-WALL',
      // Setup metadata
      rangeLow: low,
      rangeHigh: high,
      compressionRange: high - low,
      wallOrderCount: wallCount.n,
    } as any,
  };
}
