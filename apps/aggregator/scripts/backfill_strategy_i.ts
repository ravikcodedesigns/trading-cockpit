/**
 * Backfill Strategy I (Passive Seller) Signals
 *
 * Replays all historical 1-min bar closes from ticks.db through the
 * passive-seller detection logic and inserts qualifying signals into
 * trading.db so they appear on the chart for historical review.
 *
 * Usage:
 *   pnpm --filter aggregator backfill:strategy-i
 *   pnpm --filter aggregator backfill:strategy-i --since "2026-05-05 09:30"
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const TICKS_DB    = path.resolve(__dirname, '../../../data/ticks.db');
const TRADING_DB  = path.resolve(__dirname, '../../../data/trading.db');

// ── Constants (must match strategy-i.ts) ────────────────────────────────────
const MIN_1           = 60_000;
const STALE_MS        = 2 * MIN_1;
const COOLDOWN_MS     = 30 * 60 * 1000;
const BARS_NEEDED     = 24;
const TREND_BARS      = 10;
const TREND_MIN_LH    = 5;
const CVD_WINDOW      = 10;
const CVD_MIN_NET     = 50;
const PRICE_MIN_DROP  = 2.0;
const LEVEL_WINDOW    = 15;
const LEVEL_CLUSTER_PT = 3.0;
const WICK_MIN_PT     = 1.5;
const DELTA_BAR_MIN   = 30;
const STOP_BUFFER_PT  = 2.0;
const SYMBOLS         = ['NQ'];

// ── Arg parsing ──────────────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const sinceIdx    = args.indexOf('--since');
let sinceMs = 0;

if (sinceIdx !== -1 && args[sinceIdx + 1]) {
  const s = args[sinceIdx + 1];
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) { console.error('Invalid --since. Use YYYY-MM-DD HH:MM'); process.exit(1); }
  const [, y, mo, d, h, mi] = m;
  const utcProbe = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, 0));
  const fmtHr = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
  const nyHour = parseInt(fmtHr.format(utcProbe), 10);
  sinceMs = utcProbe.getTime() + (+h - nyHour) * 3_600_000;
}

// ── Session helpers ──────────────────────────────────────────────────────────
function isRTH(tsMs: number): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const get   = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const wd    = get('weekday');
  const min   = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  return ['Mon','Tue','Wed','Thu','Fri'].includes(wd) && min >= 570 && min < 960;
}

// ── DB setup ─────────────────────────────────────────────────────────────────
const ticksDb   = new Database(TICKS_DB, { readonly: true });
const tradingDb = new Database(TRADING_DB);
tradingDb.pragma('journal_mode = WAL');

const insertSignal = tradingDb.prepare(`
  INSERT OR IGNORE INTO signals
    (ts, symbol, rule_id, score, direction, strategy_version, rule_version, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

// ── Bar builder ───────────────────────────────────────────────────────────────
interface OHLCBar { ts: number; open: number; high: number; low: number; close: number; delta: number; }

function buildBars(symbol: string, sinceTs: number, untilTs: number): OHLCBar[] {
  const trades = ticksDb.prepare(`
    SELECT ts, price, size, is_bid_aggressor
    FROM trades
    WHERE symbol = ? AND ts >= ? AND ts < ?
    ORDER BY ts ASC
  `).all(symbol, sinceTs, untilTs) as { ts: number; price: number; size: number; is_bid_aggressor: number }[];

  const buckets = new Map<number, { open: number; close: number; high: number; low: number; bidVol: number; askVol: number }>();
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
    .map(([ts, b]) => ({
      ts, open: b.open, high: b.high, low: b.low, close: b.close,
      delta: b.bidVol - b.askVol,
    }));
}

// ── Detection (mirrors strategy-i.ts detect()) ───────────────────────────────
interface Signal {
  barTs: number; entry: number; stopLevel: number; stopDist: number;
  passiveSellerLevel: number; rejectionCount: number;
  cvdNet: number; priceDrop: number; curDelta: number; score: number;
}

function detect(bars: OHLCBar[], nowMs: number): Signal | null {
  if (bars.length < BARS_NEEDED) return null;

  const completed = bars.slice(0, -1);
  const cur = completed[completed.length - 1];
  if (!cur) return null;
  if (nowMs - (cur.ts + MIN_1) > STALE_MS) return null;
  if (completed.length < LEVEL_WINDOW + CVD_WINDOW) return null;

  // 1. Macro downtrend
  const trendBars = completed.slice(-(TREND_BARS + 1), -1);
  if (trendBars.length < TREND_BARS) return null;
  let lhCount = 0;
  for (let i = 1; i < trendBars.length; i++) {
    if (trendBars[i].high < trendBars[i - 1].high) lhCount++;
  }
  if (lhCount < TREND_MIN_LH) return null;

  // 2. CVD divergence
  const cvdBars = completed.slice(-(CVD_WINDOW + 1), -1);
  if (cvdBars.length < CVD_WINDOW) return null;
  let cumDelta = 0;
  for (const b of cvdBars) cumDelta += b.delta;
  const cvdNet    = cumDelta;
  const priceDrop = cvdBars[0].close - cvdBars[cvdBars.length - 1].close;
  if (cvdNet < CVD_MIN_NET)       return null;
  if (priceDrop < PRICE_MIN_DROP) return null;

  // 3. Passive seller level
  const levelBars = completed.slice(-(LEVEL_WINDOW + 1), -1);
  const rejBars   = levelBars.filter(b => {
    const wickUp = b.high - b.close;
    return b.delta >= DELTA_BAR_MIN
      && wickUp >= WICK_MIN_PT
      && b.close < (b.high + b.low) / 2;
  });
  if (rejBars.length < 2) return null;

  const maxRejHigh = Math.max(...rejBars.map(b => b.high));
  const clustered  = rejBars.filter(b => b.high >= maxRejHigh - LEVEL_CLUSTER_PT);
  if (clustered.length < 2) return null;

  const passiveSellerLevel = maxRejHigh;

  // 4. Current bar rejection
  const curWickUp     = cur.high - cur.close;
  const curTestsLevel = cur.high >= passiveSellerLevel - 2.0;
  const curLowerHigh  = cur.high < passiveSellerLevel + 1.0;  // reload, not breakout
  const curRejected   = curWickUp >= WICK_MIN_PT && cur.close < (cur.high + cur.low) / 2;
  const curBuying     = cur.delta >= DELTA_BAR_MIN;
  if (!curTestsLevel || !curLowerHigh || !curRejected || !curBuying) return null;

  // 5. Score
  let score = 75;
  if (clustered.length >= 3) score += 10;
  if (cur.delta >= 300)      score += 5;
  if (cvdNet >= 500)         score += 5;
  if (priceDrop >= 8)        score += 5;
  score = Math.min(100, score);

  const stopLevel = passiveSellerLevel + STOP_BUFFER_PT;
  const stopDist  = stopLevel - cur.close;
  if (stopDist <= 0) return null;

  return {
    barTs: cur.ts, entry: cur.close, stopLevel, stopDist,
    passiveSellerLevel, rejectionCount: clustered.length,
    cvdNet, priceDrop, curDelta: cur.delta, score,
  };
}

// ── Main backfill loop ────────────────────────────────────────────────────────
const tickRange = ticksDb.prepare(
  `SELECT MIN(ts) AS first, MAX(ts) AS last FROM trades WHERE symbol = 'NQ' AND ts >= ?`
).get(sinceMs) as { first: number; last: number };

if (!tickRange.first) {
  console.log('No tick data found.'); process.exit(0);
}

const startMs = tickRange.first;
const endMs   = tickRange.last;
console.log(`Replaying ${SYMBOLS.join(',')} from ${new Date(startMs).toISOString()} to ${new Date(endMs).toISOString()}`);

// Idempotency: skip signals already in DB
const existing = new Set<string>(
  (tradingDb.prepare(
    `SELECT ts, symbol FROM signals WHERE rule_id = 'passive-seller' AND ts >= ?`
  ).all(sinceMs) as Array<{ ts: number; symbol: string }>)
    .map(r => `${r.ts}:${r.symbol}`)
);

let nSignals = 0;
let nDupe    = 0;
let nCooldown = 0;

const lastSignalMs = new Map<string, number>();

for (const symbol of SYMBOLS) {
  console.log(`\nProcessing ${symbol}...`);

  // Step minute by minute through RTH bar closes
  let barCloseMs = Math.floor(startMs / MIN_1) * MIN_1 + MIN_1;
  let evaluated  = 0;

  while (barCloseMs <= endMs + MIN_1) {
    barCloseMs += MIN_1;
    evaluated++;

    if (!isRTH(barCloseMs)) continue;

    // Cooldown check
    const lastMs = lastSignalMs.get(symbol) ?? 0;
    if (barCloseMs - lastMs < COOLDOWN_MS) { nCooldown++; continue; }

    // Build bars for detection window
    const sinceTs = barCloseMs - (BARS_NEEDED + 2) * MIN_1;
    const bars    = buildBars(symbol, sinceTs, barCloseMs + MIN_1);

    const hit = detect(bars, barCloseMs);
    if (!hit) continue;

    const key = `${hit.barTs}:${symbol}`;
    if (existing.has(key)) { nDupe++; continue; }

    const fmt = (n: number) => n.toFixed(2);
    const entry = hit.entry;
    const stop  = hit.stopLevel;
    const rationale =
      `PASSIVE-SELLER SHORT: ${hit.rejectionCount}x rejections at ${fmt(hit.passiveSellerLevel)} ` +
      `(curΔ=+${hit.curDelta}, CVD net=+${hit.cvdNet.toFixed(0)}, price drop ${hit.priceDrop.toFixed(1)}pts). ` +
      `Entry=${fmt(entry)} Stop=${fmt(stop)} (${hit.stopDist.toFixed(1)}pts). ` +
      `T1=${fmt(entry-20)} T2=${fmt(entry-40)} T3=${fmt(entry-60)}`;

    const signal = {
      ts:              hit.barTs,
      source:          'rules-v2',
      type:            'confluence',
      symbol,
      ruleId:          'passive-seller',
      rule_id:         'passive-seller',
      score:           hit.score,
      direction:       'short',
      rationale,
      strategyVersion: 'I',
      ruleVersion:     'passive-seller-v1',
      pattern:         'PASSIVE-SELLER',
      entry,
      stopLevel:       stop,
      stopDist:        hit.stopDist,
      passiveSellerLevel: hit.passiveSellerLevel,
      rejectionCount:  hit.rejectionCount,
      cvdNet:          hit.cvdNet,
      priceDrop:       hit.priceDrop,
      curDelta:        hit.curDelta,
    };

    insertSignal.run(
      hit.barTs, symbol, 'passive-seller', hit.score,
      'short', 'I', 'passive-seller-v1', JSON.stringify(signal)
    );

    existing.add(key);
    lastSignalMs.set(symbol, barCloseMs);
    nSignals++;

    const timeET = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: true,
    }).format(new Date(hit.barTs));

    console.log(`  ${timeET}  score=${hit.score}  entry=${fmt(entry)}  stop=${fmt(stop)}  rej=${hit.rejectionCount}  cvdNet=+${hit.cvdNet.toFixed(0)}  drop=${hit.priceDrop.toFixed(1)}`);
  }

  console.log(`  ${symbol}: evaluated ${evaluated} bar closes`);
}

ticksDb.close();
tradingDb.close();

console.log(`\n─── Backfill complete ───`);
console.log(`  Signals inserted : ${nSignals}`);
console.log(`  Duplicates       : ${nDupe}`);
console.log(`  Cooldown skipped : ${nCooldown}`);
