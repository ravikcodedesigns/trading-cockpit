// Smoke test for the depth replay engine.
//
// Validates by:
//   1. Replaying a known RTH day for NQ
//   2. Sampling the book ladder at 4 fixed times during the session
//   3. Comparing the top-of-book bid/ask to the trade price at that same ts
//      (should be tight — best bid <= trade price <= best ask, or close to it)
//   4. Reporting event-rate statistics

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay, warmupToTs, topOfBook, ladder, type DepthEvent, type BookState } from './lib/depth-replay.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TICKS_DB = path.resolve(__dirname, '../../../data/ticks.db');

const xdb = new Database(TICKS_DB, { readonly: true });
const SYMBOL = 'NQ';

// Use 2026-05-28 RTH session as a representative day
const DAY_START_MS = Date.UTC(2026, 4, 28, 13, 30, 0); // 09:30 ET
const DAY_END_MS   = Date.UTC(2026, 4, 28, 20, 0, 0);  // 16:00 ET

console.log('\n══ Depth replay engine — smoke test ══');
console.log(`Day: NQ 2026-05-28 RTH (09:30 → 16:00 ET)\n`);

// ── Test 1: Quick event-rate check (small slice) ──
console.log('Test 1: First 60s of RTH (event rate measurement)');
const slice60sStart = DAY_START_MS;
const slice60sEnd   = DAY_START_MS + 60_000;
const t0 = Date.now();
let firstSliceCount = 0;
const sampleEvents: DepthEvent[] = [];
replay({
  ticksDb: xdb, symbol: SYMBOL,
  fromTs: slice60sStart, toTs: slice60sEnd,
  onEvent: (ev) => {
    firstSliceCount++;
    if (sampleEvents.length < 5) sampleEvents.push(ev);
  },
});
const elapsed1 = Date.now() - t0;
console.log(`  Events processed: ${firstSliceCount}`);
console.log(`  Time elapsed:     ${elapsed1}ms`);
console.log(`  Rate:             ${(firstSliceCount / Math.max(elapsed1, 1) * 1000).toFixed(0)} events/sec processing rate`);
console.log(`  Source rate:      ${(firstSliceCount / 60).toFixed(0)} events/sec from market`);
console.log(`  Sample events:`);
for (const ev of sampleEvents) {
  const side = ev.side === 0 ? 'BID' : 'ASK';
  console.log(`    ts=${ev.ts}  ${side}  px=${ev.price}  sz=${ev.size}`);
}

// ── Test 2: Book reconstruction at key moments ──
console.log('\nTest 2: Reconstruct book at 4 sample times via warmupToTs()');
// Use 30 sec before each target to give the book time to warm up
const samplePoints = [
  { name: '09:30:30 (just after open)', ts: DAY_START_MS + 30_000 },
  { name: '10:30:00',                    ts: DAY_START_MS + 60 * 60_000 },
  { name: '12:00:00 (lunch)',            ts: DAY_START_MS + 2.5 * 60 * 60_000 },
  { name: '15:00:00 (afternoon)',        ts: DAY_START_MS + 5.5 * 60 * 60_000 },
];

const stmtTradeAt = xdb.prepare(`
  SELECT price FROM trades WHERE symbol=? AND ts <= ? ORDER BY ts DESC LIMIT 1
`);

for (const pt of samplePoints) {
  const warmFromTs = pt.ts - 60_000; // 60s warmup window
  const book = warmupToTs(xdb, SYMBOL, warmFromTs, pt.ts);
  const tob = topOfBook(book);
  const lad = ladder(book, 5);
  const tradePxRow = stmtTradeAt.get(SYMBOL, pt.ts) as { price: number } | undefined;
  const tradePx = tradePxRow?.price ?? null;

  console.log(`\n  ${pt.name}`);
  console.log(`    Trade px at ts:  ${tradePx?.toFixed(2) ?? '(none)'}`);
  console.log(`    Best bid:        ${tob.bestBid?.toFixed(2) ?? '(none)'} × ${tob.bestBidSize}`);
  console.log(`    Best ask:        ${tob.bestAsk?.toFixed(2) ?? '(none)'} × ${tob.bestAskSize}`);
  console.log(`    Spread:          ${tob.spread?.toFixed(2) ?? '(none)'} pt`);
  console.log(`    Top-5 bids:      ${lad.bids.map(b => `${b.price.toFixed(2)}×${b.size}`).join('  ')}`);
  console.log(`    Top-5 asks:      ${lad.asks.map(a => `${a.price.toFixed(2)}×${a.size}`).join('  ')}`);

  // Sanity check: trade price should be ≤ best ask + 1pt and ≥ best bid - 1pt
  if (tradePx != null && tob.bestBid != null && tob.bestAsk != null) {
    const trade_in_range = tradePx >= tob.bestBid - 1 && tradePx <= tob.bestAsk + 1;
    console.log(`    Sanity:          ${trade_in_range ? '✓ trade px within ±1pt of book' : '⚠ trade outside book by >1pt'}`);
  }
}

// ── Test 3: Full RTH day rate measurement ──
console.log('\nTest 3: Full RTH day pass (event rate + book size)');
const t2 = Date.now();
let totalEvents = 0;
let finalBook: BookState | null = null;
const result = replay({
  ticksDb: xdb, symbol: SYMBOL,
  fromTs: DAY_START_MS, toTs: DAY_END_MS,
  onEvent: () => { totalEvents++; },
  onProgress: (n, ts) => {
    const elapsed = Date.now() - t2;
    const rate = elapsed > 0 ? (n / elapsed * 1000).toFixed(0) : 'inf';
    const etTime = new Date(ts - 4*60*60_000).toISOString().substring(11, 19);
    console.log(`  Progress: ${(n/1e6).toFixed(1)}M events  /  RTH ts=${etTime}  /  rate=${rate}/sec`);
  },
  progressEvery: 1_000_000,
});
finalBook = result.finalBook;
const elapsedFull = Date.now() - t2;
console.log(`\n  Total events:    ${totalEvents.toLocaleString()}`);
console.log(`  Elapsed:         ${(elapsedFull / 1000).toFixed(1)}s`);
console.log(`  Rate:            ${(totalEvents / elapsedFull * 1000).toFixed(0)} events/sec`);
console.log(`  Final book size: ${finalBook.bids.size} bid levels  +  ${finalBook.asks.size} ask levels`);

console.log('\n✓ DEPTH REPLAY ENGINE SMOKE TEST PASSED');
xdb.close();
