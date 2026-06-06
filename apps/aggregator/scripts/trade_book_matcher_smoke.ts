// Smoke test for trade-book matcher. Runs over one RTH day of NQ, summarizes
// match quality, and surfaces the most extreme hidden-volume signals — the
// candidates an iceberg detector (M1.3) would investigate.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchTrades, type MatchedTrade } from './lib/trade-book-matcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TICKS_DB = path.resolve(__dirname, '../../../data/ticks.db');
const xdb = new Database(TICKS_DB, { readonly: true });

const SYMBOL = 'NQ';

// 2026-05-28 RTH (same day used for M1.1 smoke)
const DAY_START_MS = Date.UTC(2026, 4, 28, 13, 30, 0);
const DAY_END_MS   = Date.UTC(2026, 4, 28, 20, 0, 0);

console.log(`\n══ Trade-book matcher — smoke test ══`);
console.log(`Day: NQ 2026-05-28 RTH (09:30 → 16:00 ET)\n`);

const t0 = Date.now();
let totalTrades = 0;
let staleTrades = 0;
let fullMatch = 0;     // implied depletion ≈ trade size
let partialMatch = 0;  // implied depletion < trade size (some hidden)
let overMatch = 0;     // implied depletion > trade size (book went DOWN MORE than trade — multiple trades or cancellations)
let hiddenVolumeRecords: MatchedTrade[] = [];

const result = matchTrades({
  ticksDb: xdb, symbol: SYMBOL,
  fromTs: DAY_START_MS, toTs: DAY_END_MS,
  onMatch: (m) => {
    totalTrades++;
    if (m.staleAfter) { staleTrades++; return; }
    const dep = m.impliedDepletion!;
    const hidden = m.hiddenVolumeEstimate!;
    // Classify
    if (Math.abs(hidden) <= 2) fullMatch++;      // displayed depth fully absorbed the trade
    else if (hidden > 2) partialMatch++;          // hidden liquidity helped — iceberg candidate
    else overMatch++;                              // book dropped more than the trade — likely concurrent cancellations
    // Capture the top hidden-volume signals for inspection
    if (hidden >= 20) hiddenVolumeRecords.push(m);
  },
  onProgress: (n, ts) => {
    const et = new Date(ts - 4*60*60_000).toISOString().substring(11, 19);
    console.log(`  Progress: ${(n/1e6).toFixed(2)}M events, RTH ts=${et}`);
  },
  progressEvery: 2_000_000,
});
const elapsed = Date.now() - t0;

console.log(`\n── Run stats ──`);
console.log(`  Events processed: ${result.eventsProcessed.toLocaleString()}`);
console.log(`  Trades matched:   ${result.tradesMatched.toLocaleString()}`);
console.log(`  Stale matches:    ${result.staleMatches.toLocaleString()} (no depth event arrived within 250ms)`);
console.log(`  Elapsed:          ${(elapsed/1000).toFixed(1)}s`);

console.log(`\n── Match-quality breakdown ──`);
console.log(`  Full match (book absorbed ≈ all):   ${fullMatch.toLocaleString()} (${(fullMatch/totalTrades*100).toFixed(1)}%)`);
console.log(`  Hidden-liquidity hint (<actual):    ${partialMatch.toLocaleString()} (${(partialMatch/totalTrades*100).toFixed(1)}%)`);
console.log(`  Overmatch (book dropped >trade):    ${overMatch.toLocaleString()} (${(overMatch/totalTrades*100).toFixed(1)}%)`);
console.log(`  Stale (no post-event):              ${staleTrades.toLocaleString()} (${(staleTrades/totalTrades*100).toFixed(1)}%)`);

console.log(`\n── Top 15 hidden-volume candidates (raw L2-inferred) ──`);
console.log(`(These are individual trades where significantly less displayed depth depleted than trade volume — iceberg signal candidates)`);
console.log(`\n  ts (ET)    price     side  trade  pre  post  hidden_est`);
hiddenVolumeRecords
  .sort((a, b) => (b.hiddenVolumeEstimate ?? 0) - (a.hiddenVolumeEstimate ?? 0))
  .slice(0, 15)
  .forEach(m => {
    const et = new Date(m.ts - 4*60*60_000).toISOString().substring(11, 19);
    const side = m.passiveSide === 0 ? 'BID' : 'ASK';
    console.log(
      `  ${et}  ${m.price.toFixed(2).padStart(8)}  ${side}   ` +
      `${String(m.size).padStart(5)}  ${String(m.preSizeAtPrice).padStart(4)}  ` +
      `${String(m.postSizeAtPrice ?? '-').padStart(4)}  ${String(m.hiddenVolumeEstimate).padStart(8)}`
    );
  });

// Aggregate hidden volume by price level — which levels were most "iceberg-y" today?
const hiddenByPrice = new Map<string, { totalHidden: number; events: number; side: number }>();
for (const m of hiddenVolumeRecords) {
  if ((m.hiddenVolumeEstimate ?? 0) < 5) continue;
  const key = `${m.passiveSide}|${m.price}`;
  const cur = hiddenByPrice.get(key) ?? { totalHidden: 0, events: 0, side: m.passiveSide };
  cur.totalHidden += m.hiddenVolumeEstimate!;
  cur.events += 1;
  hiddenByPrice.set(key, cur);
}
console.log(`\n── Top 10 price levels by cumulative hidden volume ──`);
console.log(`(Levels where multiple iceberg-candidate events clustered — strong "hidden liquidity" zones)`);
console.log(`\n  price     side  events  total_hidden  avg_per_event`);
[...hiddenByPrice.entries()]
  .map(([key, v]) => {
    const [, priceStr] = key.split('|');
    return { price: parseFloat(priceStr ?? '0'), ...v };
  })
  .sort((a, b) => b.totalHidden - a.totalHidden)
  .slice(0, 10)
  .forEach(r => {
    const side = r.side === 0 ? 'BID' : 'ASK';
    console.log(
      `  ${r.price.toFixed(2).padStart(8)}  ${side}   ` +
      `${String(r.events).padStart(6)}  ${String(r.totalHidden).padStart(12)}  ` +
      `${(r.totalHidden / r.events).toFixed(1).padStart(13)}`
    );
  });

xdb.close();
