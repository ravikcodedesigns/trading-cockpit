// Verify the multi-scale swing detector on 07-01 (NQ): stable 30-min session-anchored
// base vol → floor/capped inside the detector → multi-scale zigzags. Dump swings BY SCALE
// with ET times, to check the granularity drift is fixed (stable, nested structure).
import { DuckDBInstance } from '@duckdb/node-api';
import { OrderBook } from '../src/l3/order-book.js';
import { MultiScaleSwingDetector } from '../src/l3/swing-levels-ms.js';
import { diffusionScale } from '../src/l3/divergence.js';

const SYM = 'NQ', TICK = 0.25, DAY = process.argv[2] ?? '2026-07-01';
const PROOT = '/Users/ravikumarbasker/trading-cockpit/data/ticks-parquet';
const gp = (t: string) => `read_parquet('${PROOT}/${t}/symbol=${SYM}/date=${DAY}/*.parquet')`;
const SANE = 'price BETWEEN 20000 AND 40000';
const THROTTLE = 200, RV_MS = 1000, BASE_WIN = 1800, WARM = 60, TAU = 45;  // 30-min base-vol buffer
const et = (hm: string) => Date.parse(`${DAY}T${hm}:00-04:00`);
const num = (v: any) => v == null ? null : Number(v);
const push = <T>(b: T[], x: T, cap: number) => { b.push(x); if (b.length > cap) b.shift(); };
const clock = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false }).slice(-8);

const inst = await DuckDBInstance.create();
const con = await inst.connect();
const book = new OrderBook(SYM, TICK);
const ms = new MultiScaleSwingDetector();
const mids: number[] = [], midTs: number[] = [];
let lastObs = 0, lastRv = 0;
const bases: number[] = [];
const confirmed: { ts: number; price: number; kind: string; scale: number; legSize: number }[] = [];

const SQL = `
  SELECT ts,'D' s, price, size, side, CAST(NULL AS BOOLEAN) iba FROM ${gp('depth')} WHERE ${SANE} AND ts BETWEEN ${et('09:00')} AND ${et('17:00')}
  UNION ALL SELECT ts,'T', price, size, CAST(NULL AS BIGINT), is_bid_aggressor FROM ${gp('trades')} WHERE size>0 AND ${SANE} AND ts BETWEEN ${et('09:00')} AND ${et('17:00')}
  ORDER BY ts`;
const stream = await con.stream(SQL);
let chunk;
while ((chunk = await stream.fetchChunk()) && chunk.rowCount > 0) {
  for (const row of chunk.getRows() as any[]) {
    const ts = Number(row[0]); book.lastTs = ts;
    if (row[1] === 'D') { const sz = num(row[3]); if (sz != null) book.applyDepth({ is_bid: Number(row[4]) === 0, size: sz, price_int: book.intFromPrice(num(row[2])!) }); }
    else book.applyTrade({ price_int: book.intFromPrice(num(row[2])!), price: num(row[2])!, size: num(row[3])!, is_bid_aggressor: !!row[5] });
    if (ts - lastObs < THROTTLE) continue; lastObs = ts;
    const bb = book.bestBid(), ba = book.bestAsk(); if (bb == null || ba == null || bb >= ba) continue;
    const mid = (book.priceFromInt(bb) + book.priceFromInt(ba)) / 2;
    if (ts - lastRv >= RV_MS) { push(mids, mid, BASE_WIN); push(midTs, ts, BASE_WIN); lastRv = ts; }
    if (mids.length >= WARM) {
      const base = diffusionScale(mids, midTs) * Math.sqrt(TAU);
      if (base > 0) { bases.push(base); for (const sw of ms.update(mid, ts, base)) if (ts >= et('09:30')) confirmed.push(sw); }
    }
  }
}
const avgBase = bases.reduce((a, b) => a + b, 0) / bases.length;
console.log(`\n=== Multi-scale swings — NQ 07-01 (stable 30-min base vol ~${Math.min(...bases).toFixed(1)}-${Math.max(...bases).toFixed(1)}pt, avg ${avgBase.toFixed(1)}; floored 2 / capped 40) ===`);
for (let s = 0; s < 3; s++) {
  const label = ['FINE (δ≈1.5×base)', 'MEDIUM (δ≈3×base)', 'COARSE (δ≈6×base)'][s];
  const sws = confirmed.filter(c => c.scale === s);
  console.log(`\n${label} — ${sws.length} swings:`);
  for (const c of sws) console.log(`  ${clock(c.ts)} ET  ${c.kind.toUpperCase().padEnd(4)} ${c.price.toFixed(2)}  (leg ${c.legSize.toFixed(0)}pt)`);
}
console.log('\nSWINGS_JSON=' + JSON.stringify(confirmed.map(c => ({ ts: c.ts, price: +c.price.toFixed(2), kind: c.kind, scale: c.scale, leg: Math.round(c.legSize) }))));
process.exit(0);
