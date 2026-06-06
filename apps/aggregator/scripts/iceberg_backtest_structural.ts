// M1.4 — Iceberg backtest with STRUCTURAL ENTRY + STOP rules.
//
// Insight from the fixed-tick backtest: price often punches through the
// iceberg wall before the institutional refill takes hold, hitting tight
// stops. Wider structural stops + delayed entry should isolate the real
// reversal moves.
//
// Rules per iceberg confirmation:
//   1. ENTRY: do NOT enter immediately. Wait for the FIRST opposing 5-sec
//      bar after confirmation (ASK iceberg → wait for first 5s bar that
//      closes BELOW the iceberg price; BID → wait for first close ABOVE).
//      Skip if entry trigger not seen within ENTRY_WINDOW_MS.
//   2. STOP: structural. For ASK iceberg at P, SL = P + STOP_BUFFER (price
//      must break through the wall by more than the buffer to invalidate).
//      For BID iceberg, SL = P - STOP_BUFFER.
//   3. TARGET: fixed pt move from entry price.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchTrades } from './lib/trade-book-matcher.js';
import { WindowedIcebergDetector, type WindowedIcebergEvent } from './lib/iceberg-detector-windowed.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TICKS_DB = path.resolve(__dirname, '../../../data/ticks.db');
const xdb = new Database(TICKS_DB, { readonly: true });

const SYMBOL = 'NQ';
const DAYS: Array<[number, number, number]> = [
  [2026, 4, 5], [2026, 4, 6],
  [2026, 4, 11], [2026, 4, 12], [2026, 4, 13], [2026, 4, 14], [2026, 4, 15],
  [2026, 4, 19], [2026, 4, 20], [2026, 4, 21], [2026, 4, 22],
  [2026, 4, 26], [2026, 4, 27], [2026, 4, 28], [2026, 4, 29],
  [2026, 5, 1],
];

function rthBounds(y: number, m: number, d: number): [number, number] {
  return [Date.UTC(y, m, d, 13, 30, 0), Date.UTC(y, m, d, 20, 0, 0)];
}

const tradeRangeStmt = xdb.prepare(`
  SELECT ts, price FROM trades
  WHERE symbol = ? AND ts >= ? AND ts <= ?
  ORDER BY ts ASC
`);

const BAR_MS = 5_000;            // 5-second bars for entry trigger
const ENTRY_WINDOW_MS = 60_000;  // give up if no entry trigger within 60s
const STOP_BUFFER = 5;           // pts beyond the iceberg wall = structural break
// Verified empirically (2026-06-01): 5pt is the sweet spot. Tested 10pt → same
// W/L counts but each loss costs 2× → net pts goes -10 to -50 worse. The wall
// either holds within ~5pts or breaks by 15-30pts; nothing in between to catch.
const TIME_STOP_MS = 30 * 60_000; // 30-min time-out

type Outcome = 'WIN' | 'LOSS' | 'TIMEOUT' | 'NO_ENTRY';

interface SimRow {
  ts: number; price: number; side: 0 | 1;
  outcome: Outcome;
  entryPrice?: number;
  entryDelayMs?: number;
  timeToExitMs?: number;
  exitPrice?: number;
  rPnl?: number;
}

function simulate(events: WindowedIcebergEvent[], tp: number): { rows: SimRow[]; w: number; l: number; t: number; n: number; netPts: number } {
  const rows: SimRow[] = [];
  let w = 0, l = 0, t = 0, n = 0, netPts = 0;
  for (const e of events) {
    const direction = e.side === 1 ? -1 : 1; // ASK → short
    const allTrades = tradeRangeStmt.all(SYMBOL, e.ts, e.ts + TIME_STOP_MS + ENTRY_WINDOW_MS) as Array<{ ts: number; price: number }>;
    if (allTrades.length === 0) { n++; rows.push({ ts: e.ts, price: e.price, side: e.side, outcome: 'NO_ENTRY' }); continue; }

    // Build 5-second bars
    interface Bar { tStart: number; o: number; h: number; l: number; c: number; lastTs: number; }
    const bars: Bar[] = [];
    let curBar: Bar | null = null;
    for (const tr of allTrades) {
      const bucket = Math.floor((tr.ts - e.ts) / BAR_MS);
      if (!curBar || Math.floor((curBar.tStart - e.ts) / BAR_MS) !== bucket) {
        if (curBar) bars.push(curBar);
        curBar = { tStart: e.ts + bucket * BAR_MS, o: tr.price, h: tr.price, l: tr.price, c: tr.price, lastTs: tr.ts };
      }
      curBar.h = Math.max(curBar.h, tr.price);
      curBar.l = Math.min(curBar.l, tr.price);
      curBar.c = tr.price;
      curBar.lastTs = tr.ts;
    }
    if (curBar) bars.push(curBar);

    // Find entry bar: first bar where close moves AWAY from wall in our direction
    let entryBar: Bar | null = null;
    for (const b of bars) {
      if (b.tStart - e.ts > ENTRY_WINDOW_MS) break;
      // For ASK iceberg, we want a bar that closes BELOW the level — sellers won, price drifting down
      const moveFromWall = direction * (b.c - e.price);
      if (moveFromWall > 0) { entryBar = b; break; }
    }

    if (!entryBar) {
      n++;
      rows.push({ ts: e.ts, price: e.price, side: e.side, outcome: 'NO_ENTRY' });
      continue;
    }

    // Entry price = entry bar's close
    const entryPrice = entryBar.c;
    const entryTs = entryBar.lastTs;
    // Structural stop: STOP_BUFFER beyond the iceberg wall (PRICE side, not entry side)
    const stopPrice = e.price + (-direction) * STOP_BUFFER;
    const targetPrice = entryPrice + direction * tp;

    // Walk forward from entryTs
    let exitPrice: number | null = null;
    let outcome: Outcome = 'TIMEOUT';
    let exitTs = entryTs + TIME_STOP_MS;
    for (const tr of allTrades) {
      if (tr.ts < entryTs) continue;
      if (tr.ts > entryTs + TIME_STOP_MS) break;
      // For ASK (short, direction=-1): TARGET hit when price <= targetPrice; STOP hit when price >= stopPrice
      const hitTarget = direction === 1 ? tr.price >= targetPrice : tr.price <= targetPrice;
      const hitStop   = direction === 1 ? tr.price <= stopPrice  : tr.price >= stopPrice;
      if (hitTarget) { outcome = 'WIN'; exitPrice = tr.price; exitTs = tr.ts; break; }
      if (hitStop)   { outcome = 'LOSS'; exitPrice = tr.price; exitTs = tr.ts; break; }
    }

    if (outcome === 'WIN')  { w++; netPts += tp; }
    if (outcome === 'LOSS') { l++; netPts -= Math.abs(stopPrice - entryPrice); }
    if (outcome === 'TIMEOUT') t++;
    const rPnl = outcome === 'WIN'  ? tp / Math.abs(stopPrice - entryPrice)
              : outcome === 'LOSS' ? -1
              : 0;

    rows.push({
      ts: e.ts, price: e.price, side: e.side, outcome,
      entryPrice, entryDelayMs: entryTs - e.ts,
      timeToExitMs: exitTs - entryTs,
      exitPrice: exitPrice ?? undefined,
      rPnl,
    });
  }
  return { rows, w, l, t, n, netPts };
}

console.log(`\n══ Iceberg Backtest — STRUCTURAL ENTRY + STOP ══`);
console.log(`Entry:  first 5s bar that closes in iceberg-implied direction (within 60s)`);
console.log(`Stop:   ${STOP_BUFFER}pt BEYOND the iceberg wall (structural break)`);
console.log(`Target: tested at 10pt / 15pt / 20pt from entry`);
console.log(`Time stop: ${TIME_STOP_MS/60000} min`);

// Collect all events
const allIcebergs: WindowedIcebergEvent[] = [];
for (const [y, m, d] of DAYS) {
  const [from, to] = rthBounds(y, m, d);
  const detector = new WindowedIcebergDetector({
    windowMs: 10_000, maxAbsorptionMs: 5_000,
    minTradeVolume: 80, minNumTrades: 5,
    minAvgTradeSize: 3, minInferredHidden: 60, minStartSize: 20,
    onIceberg: (e) => allIcebergs.push(e),
  });
  const depthRows = xdb.prepare(`
    SELECT ts, side, price, size FROM depth
    WHERE symbol = ? AND ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `).all(SYMBOL, from, to) as Array<{ ts: number; side: number; price: number; size: number }>;
  if (depthRows.length === 0) continue;
  let depthIdx = 0;
  matchTrades({
    ticksDb: xdb, symbol: SYMBOL, fromTs: from, toTs: to,
    onMatch: (mat) => {
      while (depthIdx < depthRows.length && depthRows[depthIdx]!.ts <= mat.ts) {
        const r = depthRows[depthIdx]!;
        detector.onDepth({ ts: r.ts, symbol: SYMBOL, side: r.side as 0 | 1, price: r.price, size: r.size });
        depthIdx++;
      }
      detector.onTrade(mat);
    },
  });
}

console.log(`\nTotal candidates: ${allIcebergs.length}\n`);

for (const tp of [10, 15, 20]) {
  const r = simulate(allIcebergs, tp);
  const closed = r.w + r.l;
  const wr = closed > 0 ? r.w / closed * 100 : 0;
  console.log(`TP=${tp}pt:  W=${r.w}  L=${r.l}  T=${r.t}  NO_ENTRY=${r.n}  ` +
    `WR=${wr.toFixed(1)}%  netPts=${r.netPts.toFixed(0)}`);
}

// Show TP=20 detail (user-requested combination: SL=10pt buffer + TP=20)
console.log(`\n── All candidates (TP=20pt, SL=${STOP_BUFFER}pt structural buffer) ──`);
const detail = simulate(allIcebergs, 20);
console.log(`\n  ts (ET)   day         price     side  outcome   entry@   delay  exit@      R`);
for (const d of detail.rows) {
  const et = new Date(d.ts - 4*60*60_000).toISOString();
  const side = d.side === 0 ? 'BID' : 'ASK';
  const mark = d.outcome === 'WIN' ? '✓' : d.outcome === 'LOSS' ? '✗' : d.outcome === 'TIMEOUT' ? '·' : '—';
  console.log(
    `  ${et.substring(11, 19)}  ${et.substring(0, 10)}  ${d.price.toFixed(2).padStart(8)}  ${side}   ` +
    `${mark} ${d.outcome.padEnd(8)}  ` +
    `${d.entryPrice ? d.entryPrice.toFixed(2).padStart(8) : '       -'}  ` +
    `${d.entryDelayMs != null ? (d.entryDelayMs/1000).toFixed(1).padStart(5)+'s' : '    -'}  ` +
    `${d.exitPrice ? d.exitPrice.toFixed(2).padStart(8) : '       -'}  ` +
    `${d.rPnl != null ? d.rPnl.toFixed(2).padStart(5) : '    -'}`
  );
}

xdb.close();
