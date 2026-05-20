// Strategy I — Passive Seller (Short the Pop)
//
// Detects institutional passive sell distribution mechanics.
// A large seller sits at the offer and absorbs every aggressive buyer
// during relief bounces, repeatedly suppressing price at the same level.
//
// Requirements (all must hold on each 1-min bar close):
//   1. RTH only (9:30–16:00 ET)
//   2. Macro downtrend: 5+ of last 10 bar highs are lower than predecessor
//   3. CVD divergence: cumulative delta rising (buyers accumulating) over
//      last 10 bars while price is trending down — passive seller absorbing
//   4. Passive seller level: 2+ prior bars in last 15 with positive delta
//      AND upper wick rejection at same price zone (within 3pts)
//   5. Current bar: positive delta, high tests the level but forms a lower
//      high (does not exceed prior rejection peak), closes below it —
//      sellers reloading at the ceiling, not breaking out
//
// Entry:  close of rejection bar (bar ts = bar open for lightweight-charts)
// Stop:   passive seller level + 2pts (invalidated if price closes above)
// Target: T1 -20pts, T2 -40pts, T3 -60pts
// Cooldown: 30 min per symbol

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db.js';
import { logger } from '../logger.js';
import type { Symbol, ConfluenceSignal } from '@trading/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TICKS_DB_PATH = path.resolve(__dirname, '../../../../data/ticks.db');

const MIN_1       = 60_000;
const COOLDOWN_MS = 30 * 60 * 1000;
const STALE_MS    =  2 * MIN_1;
const BARS_NEEDED = 24;   // 15 level window + 10 CVD window + buffer

// Downtrend filter
const TREND_BARS    = 10;  // bars to evaluate macro direction
const TREND_MIN_LH  = 5;   // min number of lower-high transitions (out of 9)

// CVD divergence
const CVD_WINDOW    = 10;
const CVD_MIN_NET   = 50;   // min cumulative delta over window (buyers must be trying)
const PRICE_MIN_DROP = 2.0; // min price decline over same window (pts)

// Passive seller level
const LEVEL_WINDOW        = 15;   // bars to look back for level
const LEVEL_CLUSTER_PT    = 3.0;  // rejection highs within 3pts = same zone
const WICK_MIN_PT         = 1.5;  // min upper wick to call it a rejected bounce
const DELTA_BAR_MIN       = 30;   // min per-bar positive delta for "buyers trying"

// Stop placement
const STOP_BUFFER_PT      = 2.0;  // stop above passive seller level

interface OHLCBar {
  ts: number;
  open: number; high: number; low: number; close: number;
  vol: number; delta: number;
}

interface DetectedSignal {
  direction: 'short';
  score: number;
  passiveSellerLevel: number;
  rejectionCount: number;
  cvdNet: number;
  priceDrop: number;
  entry: number;
  stopLevel: number;
  stopDist: number;
  barTs: number;
  curDelta: number;
}

const _lastSignalMs = new Map<string, number>();

export function seedCooldownFromDb(): void {
  for (const sym of ['NQ', 'ES'] as Symbol[]) {
    const ts = db.lastSignalTsFor('passive-seller', sym, 'short');
    if (ts > 0) _lastSignalMs.set(`${sym}:short`, ts);
  }
}

function isCooling(symbol: Symbol, nowMs: number): boolean {
  return nowMs - (_lastSignalMs.get(`${symbol}:short`) ?? 0) < COOLDOWN_MS;
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

function buildBars(symbol: Symbol, sinceMs: number): OHLCBar[] {
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
  if (bars.length < BARS_NEEDED) return null;

  // Exclude the current forming bar — evaluate completed bars only
  const completed = bars.slice(0, -1);
  const cur = completed[completed.length - 1];
  if (!cur) return null;

  // Staleness: bar must have closed within last 2 minutes
  if (nowMs - (cur.ts + MIN_1) > STALE_MS) return null;

  if (completed.length < LEVEL_WINDOW + CVD_WINDOW) return null;

  // ── 1. Macro downtrend: count lower-high transitions in last 10 bars ────────
  const trendBars = completed.slice(-(TREND_BARS + 1), -1);
  if (trendBars.length < TREND_BARS) return null;

  let lhCount = 0;
  for (let i = 1; i < trendBars.length; i++) {
    const cur_h = trendBars[i]?.high;
    const prev_h = trendBars[i - 1]?.high;
    if (cur_h !== undefined && prev_h !== undefined && cur_h < prev_h) lhCount++;
  }
  if (lhCount < TREND_MIN_LH) return null;

  // ── 2. CVD divergence: net buying while price falls ─────────────────────────
  const cvdBars = completed.slice(-(CVD_WINDOW + 1), -1);
  if (cvdBars.length < CVD_WINDOW) return null;

  let cumDelta = 0;
  for (const b of cvdBars) cumDelta += b.delta;
  const cvdNet   = cumDelta;
  const priceDrop = (cvdBars[0]?.close ?? 0) - (cvdBars[cvdBars.length - 1]?.close ?? 0);

  if (cvdNet < CVD_MIN_NET)    return null;  // buyers must be accumulating
  if (priceDrop < PRICE_MIN_DROP) return null;  // price must be falling

  // ── 3. Passive seller level: find rejection cluster in prior bars ────────────
  const levelBars = completed.slice(-(LEVEL_WINDOW + 1), -1);

  // A rejection bar: buyers tried (positive delta) but price got rejected
  // (upper wick ≥ 1.5pts and bar closed in the lower half)
  const rejBars = levelBars.filter(b => {
    const wickUp = b.high - b.close;
    return b.delta >= DELTA_BAR_MIN
      && wickUp >= WICK_MIN_PT
      && b.close < (b.high + b.low) / 2;
  });

  if (rejBars.length < 2) return null;

  // Cluster: group rejection highs within LEVEL_CLUSTER_PT of the maximum
  const maxRejHigh = Math.max(...rejBars.map(b => b.high));
  const clustered  = rejBars.filter(b => b.high >= maxRejHigh - LEVEL_CLUSTER_PT);
  if (clustered.length < 2) return null;

  const passiveSellerLevel = maxRejHigh;

  // ── 4. Current bar: another test and rejection at the same level ─────────────
  const curWickUp     = cur.high - cur.close;
  const curTestsLevel = cur.high >= passiveSellerLevel - 2.0;
  const curLowerHigh  = cur.high < passiveSellerLevel + 1.0;  // reload, not breakout
  const curRejected   = curWickUp >= WICK_MIN_PT && cur.close < (cur.high + cur.low) / 2;
  const curBuying     = cur.delta >= DELTA_BAR_MIN;

  if (!curTestsLevel || !curLowerHigh || !curRejected || !curBuying) return null;

  // ── 5. Score ─────────────────────────────────────────────────────────────────
  let score = 75;
  if (clustered.length >= 3) score += 10;   // 3+ rejections = seller clearly defending
  if (cur.delta >= 300)      score += 5;    // high conviction absorption on entry bar
  if (cvdNet >= 500)         score += 5;    // large sustained buying absorbed
  if (priceDrop >= 8)        score += 5;    // clear trend decline
  score = Math.min(100, score);

  const stopLevel = passiveSellerLevel + STOP_BUFFER_PT;
  const stopDist  = stopLevel - cur.close;

  if (stopDist <= 0) return null;  // safety: skip if entry above stop

  return {
    direction: 'short',
    score,
    passiveSellerLevel,
    rejectionCount: clustered.length,
    cvdNet,
    priceDrop,
    entry:    cur.close,
    stopLevel,
    stopDist,
    barTs:    cur.ts,
    curDelta: cur.delta,
  };
}

export async function runStrategyI(
  symbol: Symbol,
  nowMs: number
): Promise<ConfluenceSignal | null> {
  if (!isRTH(nowMs)) return null;
  if (isCooling(symbol, nowMs)) return null;

  const sinceMs = nowMs - (BARS_NEEDED + 2) * MIN_1;
  const bars    = buildBars(symbol, sinceMs);

  const hit = detect(bars, nowMs);
  if (!hit) return null;

  _lastSignalMs.set(`${symbol}:short`, nowMs);

  const entry = hit.entry;
  const stop  = hit.stopLevel;

  const fmt    = (n: number) => n.toFixed(2);
  const targets =
    `T1=${fmt(entry - 20)} (-20) T2=${fmt(entry - 40)} (-40) T3=${fmt(entry - 60)} (-60)`;

  const rationale =
    `PASSIVE-SELLER SHORT: ${hit.rejectionCount}x rejections at ${fmt(hit.passiveSellerLevel)} ` +
    `(curΔ=+${hit.curDelta}, CVD net=+${hit.cvdNet.toFixed(0)}, price drop ${hit.priceDrop.toFixed(1)}pts). ` +
    `Entry=${fmt(entry)} Stop=${fmt(stop)} (${hit.stopDist.toFixed(1)}pts). ${targets}`;

  logger.info({
    symbol,
    score:   hit.score,
    level:   hit.passiveSellerLevel,
    rejections: hit.rejectionCount,
    cvdNet:  hit.cvdNet,
    priceDrop: hit.priceDrop,
    entry,
    stop,
    stopDist: hit.stopDist,
    curDelta: hit.curDelta,
  }, 'strategy-I: PASSIVE-SELLER signal fired');

  return {
    ts:              hit.barTs,
    source:          'rules-v2',
    type:            'confluence',
    symbol,
    ruleId:          'passive-seller',
    score:           hit.score,
    direction:       'short' as const,
    rationale,
    strategyVersion: 'I' as any,
    ruleVersion:     'passive-seller-v1',
    pattern:         'PASSIVE-SELLER' as any,
    entry,
    stopLevel:       stop,
    stopDist:        hit.stopDist,
    passiveSellerLevel: hit.passiveSellerLevel,
    rejectionCount:  hit.rejectionCount,
    cvdNet:          hit.cvdNet,
    priceDrop:       hit.priceDrop,
    curDelta:        hit.curDelta,
  } as any;
}
