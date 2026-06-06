// Smoke test for the WINDOWED iceberg detector.
// Aggregates trade volume per (price, side) over a rolling window and compares
// to net displayed-size change to infer hidden refill volume.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchTrades } from './lib/trade-book-matcher.js';
import { WindowedIcebergDetector, type WindowedIcebergEvent } from './lib/iceberg-detector-windowed.js';
import type { DepthEvent } from './lib/depth-replay.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TICKS_DB = path.resolve(__dirname, '../../../data/ticks.db');
const xdb = new Database(TICKS_DB, { readonly: true });

const SYMBOL = 'NQ';
const DAY_START_MS = Date.UTC(2026, 4, 28, 13, 30, 0);
const DAY_END_MS   = Date.UTC(2026, 4, 28, 20, 0, 0);

console.log(`\n══ Iceberg detector (WINDOWED) — smoke test ══`);
console.log(`Day: NQ 2026-05-28 RTH`);
console.log(`Approach: rolling 30s window per (symbol, side, price)`);

const icebergs: WindowedIcebergEvent[] = [];
// HIGH-CONVICTION mode: real institutional absorption signature only.
// - displayed wall ≥ 20 (real wall, not normal book)
// - absorbed within 5s (sweeps + walls, not slow churn)
// - avg trade ≥ 3 contracts (meaningful prints, not 1-lot retail churn)
// - net hidden ≥ 80 (clearly more flow than visible could absorb)
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

// We also need depth events to feed into onDepth so windowLastSize stays current.
// Read depth events for the day in chunks alongside the trade match.
const depthStmt = xdb.prepare(`
  SELECT ts, side, price, size
  FROM depth
  WHERE symbol = ? AND ts >= ? AND ts <= ?
  ORDER BY ts ASC
`);

const depthRows = depthStmt.all(SYMBOL, DAY_START_MS, DAY_END_MS) as Array<{
  ts: number; side: number; price: number; size: number;
}>;
console.log(`Loaded ${depthRows.length.toLocaleString()} depth rows`);

let depthIdx = 0;
const t0 = Date.now();
const stats = matchTrades({
  ticksDb: xdb, symbol: SYMBOL,
  fromTs: DAY_START_MS, toTs: DAY_END_MS,
  onMatch: (m) => {
    // Advance depth pointer up to this trade's ts
    while (depthIdx < depthRows.length && depthRows[depthIdx]!.ts <= m.ts) {
      const r = depthRows[depthIdx]!;
      detector.onDepth({
        ts: r.ts, symbol: SYMBOL,
        side: r.side as 0 | 1,
        price: r.price, size: r.size,
      });
      depthIdx++;
    }
    detector.onTrade(m);
  },
});
// Drain remaining depth events
while (depthIdx < depthRows.length) {
  const r = depthRows[depthIdx]!;
  detector.onDepth({
    ts: r.ts, symbol: SYMBOL,
    side: r.side as 0 | 1,
    price: r.price, size: r.size,
  });
  depthIdx++;
}
const elapsed = Date.now() - t0;

console.log(`\nProcessed in ${(elapsed/1000).toFixed(1)}s`);
console.log(`Trades evaluated: ${stats.tradesMatched.toLocaleString()}`);
console.log(`Confirmed icebergs: ${icebergs.length}`);

// Sort by inferred hidden volume
const sorted = [...icebergs].sort((a, b) => b.inferredHidden - a.inferredHidden);

console.log(`\n── Top confirmed windowed icebergs ──`);
console.log(`\n  confirmed_at  price     side  trades  vol  netΔsize  hidden  windowMs`);
for (const e of sorted.slice(0, 30)) {
  const et = new Date(e.ts - 4*60*60_000).toISOString().substring(11, 19);
  const side = e.side === 0 ? 'BID' : 'ASK';
  console.log(
    `  ${et}     ${e.price.toFixed(2).padStart(8)}  ${side}   ` +
    `${String(e.numTrades).padStart(6)}  ${String(e.tradeVolumeInWindow).padStart(4)}  ` +
    `${String(e.netDisplayedChange).padStart(7)}  ${String(e.inferredHidden).padStart(6)}  ${String(e.windowMs).padStart(7)}`
  );
}

if (icebergs.length === 0) {
  console.log('  (none)');
}

// Side breakdown
const bidIcebergs = icebergs.filter(e => e.side === 0);
const askIcebergs = icebergs.filter(e => e.side === 1);
console.log(`\n── Side breakdown ──`);
console.log(`  BID-side (buyers refilling, supporting price): ${bidIcebergs.length}`);
console.log(`  ASK-side (sellers refilling, capping price):   ${askIcebergs.length}`);

xdb.close();
