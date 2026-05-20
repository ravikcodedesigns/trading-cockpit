/**
 * backfill_expl_short_obs.ts
 *
 * One-time backfill: scans all historical NQ 1-min bars for 80pt+ RTH down
 * moves and populates expl_short_observations with pre-move features.
 *
 * Run: cd apps/aggregator && npx tsx scripts/backfill_expl_short_obs.ts
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');

const db = new Database(TRADING_DB);

const DROP_THRESHOLD  = 80;
const LOOKBACK_BARS   = 35;
const APPROACH_BARS   = 10;
const COMPRESSION_BARS = 3;
const MIN_GAP_BARS    = 45; // min bars between detected events (de-dup)

// ── Build 1-min bars from events table ───────────────────────────────────────
interface Bar {
  ts: number; open: number; high: number; low: number; close: number;
  volume: number; buyVolume: number; sellVolume: number;
}

function isRTH(ts: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ts));
  const wd = parts.find(p => p.type === 'weekday')?.value ?? '';
  const h  = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0');
  const m  = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0');
  return ['Mon','Tue','Wed','Thu','Fri'].includes(wd) && (h*60+m) >= 570 && (h*60+m) < 960;
}

console.log('Loading NQ bar events…');
const rawBars = db.prepare(`
  SELECT payload FROM events
  WHERE source IN ('bookmap','bookmap-es') AND type='bar' AND symbol='NQ'
  ORDER BY ts ASC
`).all() as { payload: string }[];

// Deduplicate: keep the LAST entry per bar-start ts (final/most complete bar)
const byBucket = new Map<number, Bar>();
for (const r of rawBars) {
  const b = JSON.parse(r.payload) as Bar;
  byBucket.set(b.ts, b);
}
const bars = Array.from(byBucket.values()).sort((a, b) => a.ts - b.ts);
const rthBars = bars.filter(b => isRTH(b.ts));
console.log('RTH 1-min bars: ' + rthBars.length);

// ── Detect 80pt+ down moves ───────────────────────────────────────────────────
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

const insert = db.prepare(`
  INSERT OR IGNORE INTO expl_short_observations
    (detected_ts, peak_ts, peak_price, trough_price, drop_pts, mins_to_trough, symbol,
     approach_up_bars, approach_net_pts, approach_range_pts,
     approach_vol, approach_buy_vol, approach_sell_vol, approach_delta,
     compression_range, compression_delta)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

let inserted = 0;
let lastEventBar = -MIN_GAP_BARS;

for (let i = APPROACH_BARS; i < rthBars.length - LOOKBACK_BARS; i++) {
  if (i - lastEventBar < MIN_GAP_BARS) continue;

  const peak = rthBars[i]!.high;
  // Find the lowest low in the next LOOKBACK_BARS bars
  let trough = peak, troughIdx = i;
  for (let j = i + 1; j <= i + LOOKBACK_BARS && j < rthBars.length; j++) {
    if (rthBars[j]!.low < trough) { trough = rthBars[j]!.low; troughIdx = j; }
  }

  const drop = peak - trough;
  if (drop < DROP_THRESHOLD) continue;

  lastEventBar = i;

  // ── Pre-move features ───────────────────────────────────────────────────
  const approach = rthBars.slice(Math.max(0, i - APPROACH_BARS), i + 1);
  const upBars   = approach.filter(b => b.close >= b.open).length;
  const netPts   = approach[approach.length - 1]!.close - approach[0]!.open;
  const rangeH   = Math.max(...approach.map(b => b.high));
  const rangeL   = Math.min(...approach.map(b => b.low));
  const rangePts = rangeH - rangeL;
  const vol      = approach.reduce((s, b) => s + (b.volume     ?? 0), 0);
  const buyVol   = approach.reduce((s, b) => s + (b.buyVolume  ?? 0), 0);
  const sellVol  = approach.reduce((s, b) => s + (b.sellVolume ?? 0), 0);
  const delta    = buyVol - sellVol;

  const comp       = rthBars.slice(Math.max(0, i - COMPRESSION_BARS + 1), i + 1);
  const compH      = Math.max(...comp.map(b => b.high));
  const compL      = Math.min(...comp.map(b => b.low));
  const compRange  = compH - compL;
  const compBuy    = comp.reduce((s, b) => s + (b.buyVolume  ?? 0), 0);
  const compSell   = comp.reduce((s, b) => s + (b.sellVolume ?? 0), 0);
  const compDelta  = compBuy - compSell;

  const minsToTrough = troughIdx - i;
  const peakBar = rthBars[i]!;
  const troughBar = rthBars[troughIdx]!;

  insert.run(
    peakBar.ts, peakBar.ts, peakBar.high, troughBar.low,
    Math.round(drop * 4) / 4, minsToTrough, 'NQ',
    upBars, Math.round(netPts * 4) / 4, Math.round(rangePts * 4) / 4,
    vol, buyVol, sellVol, delta,
    Math.round(compRange * 4) / 4, compDelta,
  );

  console.log(
    fmt.format(new Date(peakBar.ts)).padEnd(14) +
    ' drop=' + Math.round(drop) + 'pt' +
    '  approach: ' + upBars + 'up net=' + Math.round(netPts) + 'pt delta=' + delta +
    '  comp_range=' + Math.round(compRange) + 'pt comp_delta=' + compDelta
  );
  inserted++;
}

db.close();
console.log('\nInserted: ' + inserted + ' observations');
