// M1.4 — Iceberg-bounce backtest across multiple NQ RTH days.
// Runs the HIGH-CONVICTION windowed iceberg detector on each day and
// validates each candidate against price action 1m/3m/5m AFTER confirmation.
//
// Question this answers: does the iceberg signature reliably precede price
// rejection? If precision holds across 8-10 days, this is a tradeable edge.

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
// 15 trading days of full NQ RTH (Apr index = month-1; May = 4, Jun = 5)
const DAYS: Array<[number, number, number]> = [
  [2026, 4, 5],  [2026, 4, 6],                                // 5/05, 5/06
  [2026, 4, 11], [2026, 4, 12], [2026, 4, 13], [2026, 4, 14], [2026, 4, 15], // wk of 5/11
  [2026, 4, 19], [2026, 4, 20], [2026, 4, 21], [2026, 4, 22], // wk of 5/19
  [2026, 4, 26], [2026, 4, 27], [2026, 4, 28], [2026, 4, 29], // wk of 5/26
  [2026, 5, 1],                                                 // 6/01
];

// RTH in ET: 09:30 to 16:00. UTC is +4h during DST (EDT). 13:30Z → 09:30 ET.
function rthBounds(y: number, m: number, d: number): [number, number] {
  return [Date.UTC(y, m, d, 13, 30, 0), Date.UTC(y, m, d, 20, 0, 0)];
}

const tradeRangeStmt = xdb.prepare(`
  SELECT ts, price FROM trades
  WHERE symbol = ? AND ts >= ? AND ts <= ?
  ORDER BY ts ASC
`);

interface BacktestResult {
  day: string;
  candidates: number;
  hits: { t1m: number; t3m: number; t5m: number };  // count where MFE ≥ 5pts
  avgMfe5m: number;
  rejectionDetails: Array<{
    ts: number; price: number; side: 0 | 1;
    mfe1m: number; mfe3m: number; mfe5m: number;
    hidden: number; vol: number; trades: number;
  }>;
}

const results: BacktestResult[] = [];

console.log(`\n══ Iceberg Backtest — Multi-day NQ RTH ══`);
console.log(`Detector: HIGH-CONVICTION (startSize≥20, vol≥80, ≥5 trades, absorbed in ≤5s, hidden≥60, netΔ<0, avg≥3)\n`);

for (const [y, m, d] of DAYS) {
  const [from, to] = rthBounds(y, m, d);
  const dayStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

  const icebergs: WindowedIcebergEvent[] = [];
  const detector = new WindowedIcebergDetector({
    windowMs: 10_000,
    maxAbsorptionMs: 5_000,
    minTradeVolume: 80,
    minNumTrades: 5,
    minAvgTradeSize: 3,
    minInferredHidden: 60,
    minStartSize: 20,
    onIceberg: (e) => icebergs.push(e),
  });

  // Load depth events
  const depthRows = xdb.prepare(`
    SELECT ts, side, price, size FROM depth
    WHERE symbol = ? AND ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `).all(SYMBOL, from, to) as Array<{ ts: number; side: number; price: number; size: number }>;

  if (depthRows.length === 0) {
    results.push({ day: dayStr, candidates: 0, hits: { t1m: 0, t3m: 0, t5m: 0 }, avgMfe5m: 0, rejectionDetails: [] });
    console.log(`  ${dayStr}: NO DEPTH DATA`);
    continue;
  }

  let depthIdx = 0;
  matchTrades({
    ticksDb: xdb, symbol: SYMBOL,
    fromTs: from, toTs: to,
    onMatch: (mat) => {
      while (depthIdx < depthRows.length && depthRows[depthIdx]!.ts <= mat.ts) {
        const r = depthRows[depthIdx]!;
        detector.onDepth({ ts: r.ts, symbol: SYMBOL, side: r.side as 0 | 1, price: r.price, size: r.size });
        depthIdx++;
      }
      detector.onTrade(mat);
    },
  });

  // Validate each iceberg with MFE check
  const details: BacktestResult['rejectionDetails'] = [];
  const hits = { t1m: 0, t3m: 0, t5m: 0 };
  let totalMfe5m = 0;
  for (const e of icebergs) {
    const direction = e.side === 1 ? -1 : 1;  // ASK iceberg → expect price DOWN
    const after = tradeRangeStmt.all(SYMBOL, e.ts, e.ts + 5 * 60_000) as Array<{ ts: number; price: number }>;
    if (after.length === 0) continue;
    const baseline = after[0]!.price;

    const mfe = [60_000, 180_000, 300_000].map(h => {
      let maxFav = 0;
      for (const t of after) {
        if (t.ts - e.ts > h) break;
        const move = direction * (t.price - baseline);
        if (move > maxFav) maxFav = move;
      }
      return maxFav;
    });

    if (mfe[0]! >= 5) hits.t1m++;
    if (mfe[1]! >= 5) hits.t3m++;
    if (mfe[2]! >= 5) hits.t5m++;
    totalMfe5m += mfe[2]!;
    details.push({
      ts: e.ts, price: e.price, side: e.side,
      mfe1m: mfe[0]!, mfe3m: mfe[1]!, mfe5m: mfe[2]!,
      hidden: e.inferredHidden, vol: e.tradeVolumeInWindow, trades: e.numTrades,
    });
  }

  const avgMfe5m = icebergs.length > 0 ? totalMfe5m / icebergs.length : 0;
  results.push({ day: dayStr, candidates: icebergs.length, hits, avgMfe5m, rejectionDetails: details });

  console.log(`  ${dayStr}: ${String(icebergs.length).padStart(2)} candidates  | ` +
    `hit@1m=${hits.t1m}/${icebergs.length}, @3m=${hits.t3m}/${icebergs.length}, @5m=${hits.t5m}/${icebergs.length}  | ` +
    `avg MFE 5m: ${avgMfe5m.toFixed(2)}pt`);
}

// Aggregate summary
const totalCandidates = results.reduce((s, r) => s + r.candidates, 0);
const totalHits1m = results.reduce((s, r) => s + r.hits.t1m, 0);
const totalHits3m = results.reduce((s, r) => s + r.hits.t3m, 0);
const totalHits5m = results.reduce((s, r) => s + r.hits.t5m, 0);
const totalMfe5m = results.reduce((s, r) => s + r.avgMfe5m * r.candidates, 0);

console.log(`\n══ Aggregate ══`);
console.log(`  Total candidates: ${totalCandidates}`);
console.log(`  ≥5pt favorable @ 1m: ${totalHits1m}/${totalCandidates} (${(totalHits1m/totalCandidates*100).toFixed(1)}%)`);
console.log(`  ≥5pt favorable @ 3m: ${totalHits3m}/${totalCandidates} (${(totalHits3m/totalCandidates*100).toFixed(1)}%)`);
console.log(`  ≥5pt favorable @ 5m: ${totalHits5m}/${totalCandidates} (${(totalHits5m/totalCandidates*100).toFixed(1)}%)`);
console.log(`  Weighted avg MFE 5m: ${(totalMfe5m/totalCandidates).toFixed(2)}pt`);

// Print full detail rows
console.log(`\n── All candidates ──`);
console.log(`\n  ts (ET)            day         price     side  trades  vol  hidden  mfe1m  mfe3m  mfe5m`);
for (const r of results) {
  for (const d of r.rejectionDetails) {
    const et = new Date(d.ts - 4*60*60_000).toISOString();
    const dayTok = et.substring(0, 10);
    const timeTok = et.substring(11, 19);
    const side = d.side === 0 ? 'BID' : 'ASK';
    console.log(
      `  ${timeTok}  ${dayTok}  ${d.price.toFixed(2).padStart(8)}  ${side}   ` +
      `${String(d.trades).padStart(6)}  ${String(d.vol).padStart(4)}  ` +
      `${String(d.hidden).padStart(6)}  ${d.mfe1m.toFixed(2).padStart(5)}  ${d.mfe3m.toFixed(2).padStart(5)}  ${d.mfe5m.toFixed(2).padStart(5)}`
    );
  }
}

xdb.close();
