// M1.4 — Iceberg backtest with FIXED TP/SL WIN/LOSS reporting (no MFE/MAE).
// For each iceberg candidate, simulate entering at the confirmation price
// in the iceberg-implied direction, then walk forward until TP or SL hit
// (or timeout = OPEN). Report WR, R-multiple, expectancy.

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

// Test these TP/SL grids
const GRIDS: Array<{ tp: number; sl: number; horizonMin: number; label: string }> = [
  { tp: 10, sl: 6,  horizonMin: 15, label: 'TP10/SL6 (1.67R)'   },
  { tp: 15, sl: 8,  horizonMin: 15, label: 'TP15/SL8 (1.88R)'   },
  { tp: 20, sl: 10, horizonMin: 30, label: 'TP20/SL10 (2.0R)'   },
];

function rthBounds(y: number, m: number, d: number): [number, number] {
  return [Date.UTC(y, m, d, 13, 30, 0), Date.UTC(y, m, d, 20, 0, 0)];
}

const tradeRangeStmt = xdb.prepare(`
  SELECT ts, price FROM trades
  WHERE symbol = ? AND ts >= ? AND ts <= ?
  ORDER BY ts ASC
`);

type Outcome = 'WIN' | 'LOSS' | 'OPEN';

function simulate(events: WindowedIcebergEvent[], tp: number, sl: number, horizonMs: number) {
  let win = 0, loss = 0, open = 0;
  const details: Array<{ ts: number; price: number; side: 0 | 1; outcome: Outcome; barsToExit: number }> = [];
  for (const e of events) {
    const direction = e.side === 1 ? -1 : 1;
    const after = tradeRangeStmt.all(SYMBOL, e.ts, e.ts + horizonMs) as Array<{ ts: number; price: number }>;
    if (after.length === 0) { open++; details.push({ ts: e.ts, price: e.price, side: e.side, outcome: 'OPEN', barsToExit: 0 }); continue; }
    const baseline = after[0]!.price;
    let outcome: Outcome = 'OPEN';
    let exitIdx = -1;
    for (let i = 1; i < after.length; i++) {
      const move = direction * (after[i]!.price - baseline);
      if (move >= tp) { outcome = 'WIN'; exitIdx = i; break; }
      if (move <= -sl) { outcome = 'LOSS'; exitIdx = i; break; }
    }
    if (outcome === 'WIN') win++;
    else if (outcome === 'LOSS') loss++;
    else open++;
    details.push({ ts: e.ts, price: e.price, side: e.side, outcome, barsToExit: exitIdx });
  }
  return { win, loss, open, details };
}

console.log(`\n══ Iceberg Backtest — WIN/LOSS at fixed TP/SL ══`);
console.log(`Detector: HIGH-CONVICTION (startSize≥20, vol≥80, ≥5 trades, ≤5s, hidden≥60, netΔ<0, avg≥3)\n`);

// Collect all iceberg events across all days
const allIcebergs: WindowedIcebergEvent[] = [];
for (const [y, m, d] of DAYS) {
  const [from, to] = rthBounds(y, m, d);
  const dayIcebergs: WindowedIcebergEvent[] = [];
  const detector = new WindowedIcebergDetector({
    windowMs: 10_000, maxAbsorptionMs: 5_000,
    minTradeVolume: 80, minNumTrades: 5,
    minAvgTradeSize: 3, minInferredHidden: 60, minStartSize: 20,
    onIceberg: (e) => dayIcebergs.push(e),
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
  allIcebergs.push(...dayIcebergs);
}

console.log(`Total candidates: ${allIcebergs.length}\n`);

for (const g of GRIDS) {
  const r = simulate(allIcebergs, g.tp, g.sl, g.horizonMin * 60_000);
  const closed = r.win + r.loss;
  const wr = closed > 0 ? r.win / closed * 100 : 0;
  // R-multiple expectancy (each WIN = +tp/sl R, each LOSS = -1R)
  const rWin = g.tp / g.sl;
  const expectancy = (wr/100) * rWin - (1 - wr/100) * 1;
  // Pts/contract net
  const ptsNet = r.win * g.tp - r.loss * g.sl;
  console.log(`${g.label}:  W=${r.win}  L=${r.loss}  OPEN=${r.open}  ` +
    `WR=${wr.toFixed(1)}%  expectancy=${expectancy.toFixed(2)}R  netPts=${ptsNet}`);
}

// Detailed table for the middle grid
console.log(`\n── All candidates (TP15/SL8, 15min horizon) ──`);
const middle = simulate(allIcebergs, 15, 8, 15 * 60_000);
console.log(`\n  ts (ET)            day         price     side  outcome  bars`);
for (let i = 0; i < middle.details.length; i++) {
  const d = middle.details[i]!;
  const et = new Date(d.ts - 4*60*60_000).toISOString();
  const side = d.side === 0 ? 'BID' : 'ASK';
  const mark = d.outcome === 'WIN' ? '✓' : d.outcome === 'LOSS' ? '✗' : '·';
  console.log(
    `  ${et.substring(11, 19)}  ${et.substring(0, 10)}  ${d.price.toFixed(2).padStart(8)}  ${side}   ` +
    `${mark} ${d.outcome.padEnd(5)}  ${String(d.barsToExit).padStart(5)}`
  );
}

xdb.close();
