// Faithful replay of the LIVE swing detector for one ET-day: reconstruct the book from
// parquet (depth+trades) → mid @200ms → vol-scaled band → SwingDetector (the exact live
// class + params). Prints every CONFIRMED swing (ET time, price, high/low). Usage:
//   tsx scripts/dump_swings.ts 2026-06-25 [NQ]
import { DuckDBInstance } from '@duckdb/node-api';
import { OrderBook } from '../src/l3/order-book.js';
import { SwingDetector } from '../src/l3/swing-levels.js';
import { diffusionScale } from '../src/l3/divergence.js';

const DAY = process.argv[2] ?? '2026-06-25';
const SYM = process.argv[3] ?? 'NQ';
const TICK = 0.25;
const PROOT = '/Users/ravikumarbasker/trading-cockpit/data/ticks-parquet';
const gp = (t: string) => `read_parquet('${PROOT}/${t}/symbol=${SYM}/date=${DAY}/*.parquet')`;
const SANE = 'price BETWEEN 20000 AND 40000';
const THROTTLE = 200, RV_MS = 1000, SWING_MULT = 3, WARM_RV = 30, TAU = 45;
const et = (hm: string) => Date.parse(`${DAY}T${hm}:00-04:00`);
const num = (v: any) => v == null ? null : Number(v);
const push = <T>(b: T[], x: T, cap: number) => { b.push(x); if (b.length > cap) b.shift(); };
const etTime = (ts: number) => new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });

const inst = await DuckDBInstance.create();
const con = await inst.connect();
const [warm, end] = [et('00:00'), et('23:59')];
const book = new OrderBook(SYM, TICK), swing = new SwingDetector(200);
const mids: number[] = [], midTs: number[] = [];
let lastObs = 0, lastRv = 0;
const swings: { ts: number; price: number; kind: string }[] = [];

const SQL = `
  SELECT ts,'D' s, price, size, side, CAST(NULL AS BOOLEAN) iba FROM ${gp('depth')} WHERE ${SANE} AND ts BETWEEN ${warm} AND ${end}
  UNION ALL SELECT ts,'T', price, size, CAST(NULL AS BIGINT), is_bid_aggressor FROM ${gp('trades')} WHERE size>0 AND ${SANE} AND ts BETWEEN ${warm} AND ${end}
  ORDER BY ts`;
const stream = await con.stream(SQL); let chunk;
while ((chunk = await stream.fetchChunk()) && chunk.rowCount > 0) {
  for (const row of chunk.getRows() as any[]) {
    const ts = Number(row[0]); book.lastTs = ts;
    if (row[1] === 'D') { const sz = num(row[3]); if (sz != null) book.applyDepth({ is_bid: Number(row[4]) === 0, size: sz, price_int: book.intFromPrice(num(row[2])!) }); }
    else { book.applyTrade({ price_int: book.intFromPrice(num(row[2])!), price: num(row[2])!, size: num(row[3])!, is_bid_aggressor: !!row[5] }); }
    if (ts - lastObs < THROTTLE) continue;
    lastObs = ts;
    const bb = book.bestBid(), ba = book.bestAsk(); if (bb == null || ba == null) continue;
    const mid = (book.priceFromInt(bb) + book.priceFromInt(ba)) / 2;
    if (ts - lastRv >= RV_MS) { push(mids, mid, 120); push(midTs, ts, 120); lastRv = ts; }
    if (mids.length >= WARM_RV) {
      const band = diffusionScale(mids, midTs) * Math.sqrt(TAU);
      if (band > 0) { const s = swing.update(mid, ts, SWING_MULT * band); if (s) swings.push({ ts: s.ts, price: s.price, kind: s.kind }); }
    }
  }
}

console.log(`\n=== confirmed swings — ${SYM} ${DAY}  (n=${swings.length}) ===`);
console.log('  ET time              price       kind`');
for (const s of swings.sort((a, b) => a.ts - b.ts)) {
  const near = Math.abs(s.price - 29872) <= 6 ? '   <== near 29872' : '';
  console.log(`  ${etTime(s.ts).padEnd(20)} ${s.price.toFixed(2).padStart(9)}   ${s.kind.toUpperCase().padEnd(4)}${near}`);
}
process.exit(0);
