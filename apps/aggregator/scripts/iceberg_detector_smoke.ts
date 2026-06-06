// Smoke test for the iceberg detector. Runs over one RTH day of NQ,
// reports all confirmed icebergs with their confirmation context.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchTrades } from './lib/trade-book-matcher.js';
import { IcebergDetector, type IcebergEvent } from './lib/iceberg-detector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TICKS_DB = path.resolve(__dirname, '../../../data/ticks.db');
const xdb = new Database(TICKS_DB, { readonly: true });

const SYMBOL = 'NQ';
const DAY_START_MS = Date.UTC(2026, 4, 28, 13, 30, 0);
const DAY_END_MS   = Date.UTC(2026, 4, 28, 20, 0, 0);

console.log(`\n══ Iceberg detector — smoke test ══`);
console.log(`Day: NQ 2026-05-28 RTH (09:30 → 16:00 ET)`);

const icebergs: IcebergEvent[] = [];

// Best-effort L2 thresholds — calibrated against 5/28 NQ filter-pass diagnostic.
// L2 fundamentally lacks resolution for high-recall iceberg detection; this is
// the high-PRECISION, low-recall mode.
const detector = new IcebergDetector({
  minPreSize: 10,
  minRefills: 2,
  minTotalHidden: 30,
  minPerEventHidden: 10,
  levelTtlMs: 45_000,
  onIceberg: (e) => icebergs.push(e),
});

const t0 = Date.now();
const stats = matchTrades({
  ticksDb: xdb, symbol: SYMBOL,
  fromTs: DAY_START_MS, toTs: DAY_END_MS,
  onMatch: (m) => detector.ingest(m),
});
const elapsed = Date.now() - t0;

console.log(`Processed in ${(elapsed/1000).toFixed(1)}s`);
console.log(`Trades evaluated: ${stats.tradesMatched.toLocaleString()}`);
console.log(`Confirmed icebergs: ${icebergs.length}`);

// Sort by hidden volume (most significant first)
const sorted = [...icebergs].sort((a, b) => b.totalHiddenVolume - a.totalHiddenVolume);

console.log(`\n── Confirmed icebergs (sorted by total hidden volume) ──`);
console.log(`\n  confirmed_at  price     side  refills  hidden  displayed  avg_latency_ms`);
for (const e of sorted) {
  const et = new Date(e.ts - 4*60*60_000).toISOString().substring(11, 19);
  const side = e.side === 0 ? 'BID' : 'ASK';
  console.log(
    `  ${et}     ${e.price.toFixed(2).padStart(8)}  ${side}   ` +
    `${String(e.refillCount).padStart(7)}  ${String(e.totalHiddenVolume).padStart(6)}  ${String(e.totalDisplayedAbsorbed).padStart(9)}  ${e.avgRefillLatencyMs.toFixed(0).padStart(14)}`
  );
}

if (icebergs.length === 0) {
  console.log('  (none — thresholds too strict or insufficient hidden activity)');
}

// Also show the bid/ask split (institutional buyer levels vs seller levels)
const bidIcebergs = icebergs.filter(e => e.side === 0);
const askIcebergs = icebergs.filter(e => e.side === 1);
console.log(`\n── Side breakdown ──`);
console.log(`  BID-side icebergs (buyers absorbing sells): ${bidIcebergs.length}`);
console.log(`  ASK-side icebergs (sellers absorbing buys): ${askIcebergs.length}`);

xdb.close();
