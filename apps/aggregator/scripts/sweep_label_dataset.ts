// Phase-A Strategy-A rebuild — Phase 1: labeled sweep dataset.
//
// TAPE-ONLY (trades, no depth, no RS levels, no CVD, no time gates).
// FULL DATASET: auto-discovers every NQ trading day in ticks.db and processes
// all sweeps, regardless of session. Each record carries a session tag so the
// analysis phase can slice by RTH / Globex / ON.
//
// For each sweep:
//   PRE-CONTEXT (60s lookback ending at sweep start):
//     - preVol60s         total trade volume
//     - preRange60s       price range (max - min) in pts
//     - preTradeCount60s  count of trades
//     - preBuyVol60s      buyer-aggressor volume (is_bid_aggressor=1)
//     - preSellVol60s     seller-aggressor volume
//     - volMultiple       sweep rate (vol/durSec) / baseline rate (preVol/60)
//
//   OUTCOMES (price moves from endPrice, signed in sweep direction):
//     - mfe / mae / close @ +1m / +3m / +5m / +15m
//
//   SESSION TAG (UTC-based, derived from sweep startTs):
//     'RTH'       — 13:30–20:00 UTC (09:30–16:00 ET)
//     'GLOBEX_PM' — 20:00–22:00 UTC (after RTH close → ON close)
//     'GLOBEX_ASIA' — 22:00–06:00 UTC (Asia hours)
//     'GLOBEX_EU' — 06:00–13:30 UTC (Europe hours)
//
// Output: JSONL to /tmp/sweep_dataset_NQ.jsonl. One record per sweep.

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SweepDetector, type SweepEvent } from './lib/sweep-detector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TICKS_DB = path.resolve(__dirname, '../../../data/ticks.db');
const OUT_PATH = '/tmp/sweep_dataset_NQ.jsonl';
const SYMBOL = 'NQ';

const xdb = new Database(TICKS_DB, { readonly: true });

// Auto-discover all NQ trade days (use ET date for grouping; days with <10k trades
// are dropped as Sunday-night-only fragments that don't carry meaningful flow).
const days = xdb.prepare(`
  SELECT date(ts/1000, 'unixepoch', '-04:00') AS day, COUNT(*) AS n
  FROM trades WHERE symbol = ?
  GROUP BY day HAVING n >= 10000
  ORDER BY day ASC
`).all(SYMBOL) as Array<{ day: string; n: number }>;

interface SweepRecord extends SweepEvent {
  day: string;
  session: 'RTH' | 'GLOBEX_PM' | 'GLOBEX_ASIA' | 'GLOBEX_EU';
  preVol60s: number;
  preRange60s: number;
  preTradeCount60s: number;
  preBuyVol60s: number;
  preSellVol60s: number;
  volMultiple: number;
  mfe1m: number;  mae1m: number;  close1m: number;
  mfe3m: number;  mae3m: number;  close3m: number;
  mfe5m: number;  mae5m: number;  close5m: number;
  mfe15m: number; mae15m: number; close15m: number;
}

function sessionFor(ts: number): SweepRecord['session'] {
  const utcHour = new Date(ts).getUTCHours() + new Date(ts).getUTCMinutes() / 60;
  if (utcHour >= 13.5 && utcHour < 20) return 'RTH';
  if (utcHour >= 20 && utcHour < 22)   return 'GLOBEX_PM';
  if (utcHour >= 22 || utcHour < 6)    return 'GLOBEX_ASIA';
  return 'GLOBEX_EU';
}

const out = fs.createWriteStream(OUT_PATH, { flags: 'w' });
console.log(`\n══ Sweep dataset builder — Phase 1 (TAPE ONLY) ══`);
console.log(`Days discovered: ${days.length} (${days[0]?.day} → ${days[days.length-1]?.day})`);
console.log(`Out: ${OUT_PATH}\n`);

let totalSweeps = 0;
let totalSkippedShortPre = 0;

for (const { day } of days) {
  // Full day in ET = 04:00 UTC of day → 04:00 UTC of next day. Plus 15min after
  // for outcome scan after the last trade.
  const fromTs = Date.parse(`${day}T04:00:00Z`);
  const nextDay = new Date(fromTs + 24 * 60 * 60_000);
  const toTs = nextDay.getTime();
  const outcomeTail = 15 * 60_000;

  const trades = xdb.prepare(`
    SELECT ts, price, size, is_bid_aggressor
    FROM trades WHERE symbol = ? AND ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `).all(SYMBOL, fromTs, toTs + outcomeTail) as Array<{
    ts: number; price: number; size: number; is_bid_aggressor: number;
  }>;
  if (trades.length === 0) { console.log(`  ${day}: NO TRADES`); continue; }

  // Detect sweeps only within day; trades after toTs are kept for outcome lookups.
  const daySweeps: SweepEvent[] = [];
  const detector = new SweepDetector({
    symbol: SYMBOL,
    minLevels: 3, minVolume: 50, maxGapMs: 500,
    onSweep: (e) => { if (e.startTs < toTs) daySweeps.push(e); },
  });
  for (const t of trades) {
    if (t.ts >= toTs) break;
    detector.ingest(t.ts, t.price, t.size, t.is_bid_aggressor === 1);
  }
  detector.flush();

  for (const sw of daySweeps) {
    // Pre-context: [startTs-60s, startTs)
    const preStart = sw.startTs - 60_000;
    let lo = 0, hi = trades.length - 1, preIdx = trades.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (trades[mid]!.ts >= preStart) { preIdx = mid; hi = mid - 1; } else { lo = mid + 1; }
    }
    let preVol = 0, preTradeCount = 0, preHi = -Infinity, preLo = Infinity;
    let preBuyVol = 0, preSellVol = 0;
    for (let i = preIdx; i < trades.length && trades[i]!.ts < sw.startTs; i++) {
      const t = trades[i]!;
      preVol += t.size;
      preTradeCount++;
      if (t.price > preHi) preHi = t.price;
      if (t.price < preLo) preLo = t.price;
      if (t.is_bid_aggressor === 1) preBuyVol += t.size; else preSellVol += t.size;
    }
    // Drop sweeps with insufficient pre-window (cold-start at session open)
    if (preTradeCount < 5) { totalSkippedShortPre++; continue; }
    const preRange = preHi - preLo;
    const sweepDurSec = Math.max(0.1, sw.durationMs / 1000);
    const sweepRate = sw.volume / sweepDurSec;
    const baselineRate = preVol / 60;
    const volMultiple = baselineRate > 0 ? sweepRate / baselineRate : sweepRate;

    // Outcomes: scan trades in (endTs, endTs+horizon]
    lo = 0; hi = trades.length - 1; let postIdx = trades.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (trades[mid]!.ts > sw.endTs) { postIdx = mid; hi = mid - 1; } else { lo = mid + 1; }
    }
    const dirSign = sw.direction === 'long' ? 1 : -1;
    const horizons = [60_000, 180_000, 300_000, 900_000];
    const horizonRes: Array<{ mfe: number; mae: number; close: number }> = [];
    let scanIdx = postIdx;
    let mfeRun = 0, maeRun = 0, lastPrice = sw.endPrice;
    for (const h of horizons) {
      const cutoff = sw.endTs + h;
      while (scanIdx < trades.length && trades[scanIdx]!.ts <= cutoff) {
        const move = dirSign * (trades[scanIdx]!.price - sw.endPrice);
        if (move > mfeRun) mfeRun = move;
        if (move < maeRun) maeRun = move;
        lastPrice = trades[scanIdx]!.price;
        scanIdx++;
      }
      horizonRes.push({ mfe: mfeRun, mae: maeRun, close: dirSign * (lastPrice - sw.endPrice) });
    }

    const rec: SweepRecord = {
      ...sw,
      day,
      session: sessionFor(sw.startTs),
      preVol60s: preVol,
      preRange60s: preRange,
      preTradeCount60s: preTradeCount,
      preBuyVol60s: preBuyVol,
      preSellVol60s: preSellVol,
      volMultiple,
      mfe1m:  horizonRes[0]!.mfe,  mae1m:  horizonRes[0]!.mae,  close1m:  horizonRes[0]!.close,
      mfe3m:  horizonRes[1]!.mfe,  mae3m:  horizonRes[1]!.mae,  close3m:  horizonRes[1]!.close,
      mfe5m:  horizonRes[2]!.mfe,  mae5m:  horizonRes[2]!.mae,  close5m:  horizonRes[2]!.close,
      mfe15m: horizonRes[3]!.mfe, mae15m: horizonRes[3]!.mae, close15m: horizonRes[3]!.close,
    };
    out.write(JSON.stringify(rec) + '\n');
    totalSweeps++;
  }
  console.log(`  ${day}: ${daySweeps.length.toString().padStart(4)} sweeps detected`);
}

out.end();
console.log(`\nTotal sweeps written: ${totalSweeps}`);
console.log(`Skipped (short pre-window): ${totalSkippedShortPre}`);
console.log(`Dataset: ${OUT_PATH}`);
xdb.close();
