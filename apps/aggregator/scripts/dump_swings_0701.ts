// Dump the SwingDetector's confirmed swings for 2026-07-01 (NQ), same pipeline/config
// as the spine, to compare against Ravi's visual reads. Swing.ts = the EXTREME's time
// (matches the chart), not the causal-confirmation time.
import { DuckDBInstance } from '@duckdb/node-api';
import { OrderBook } from '../src/l3/order-book.js';
import { SwingDetector } from '../src/l3/swing-levels.js';
import { diffusionScale } from '../src/l3/divergence.js';

const SYM = 'NQ', TICK = 0.25, DAY = '2026-07-01';
const PROOT = '/Users/ravikumarbasker/trading-cockpit/data/ticks-parquet';
const gp = (t: string) => `read_parquet('${PROOT}/${t}/symbol=${SYM}/date=${DAY}/*.parquet')`;
const SANE = 'price BETWEEN 20000 AND 40000';
const THROTTLE = 200, RV_MS = 1000, WARM_RV = 30, TAU = 45, SWING_MULT = 3;
const et = (hm: string) => Date.parse(`${DAY}T${hm}:00-04:00`);
const num = (v: any) => v == null ? null : Number(v);
const push = <T>(b: T[], x: T, cap: number) => { b.push(x); if (b.length > cap) b.shift(); };
const clock = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false }).slice(-8);

const inst = await DuckDBInstance.create();
const con = await inst.connect();
const book = new OrderBook(SYM, TICK);
const swing = new SwingDetector();
const mids: number[] = [], midTs: number[] = [];
let lastObs = 0, lastRv = 0;
const bands: number[] = [];
const confirmed: { ts: number; price: number; kind: string }[] = [];

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
    if (ts - lastRv >= RV_MS) { push(mids, mid, 120); push(midTs, ts, 120); lastRv = ts; }
    if (mids.length >= WARM_RV) {
      const band = diffusionScale(mids, midTs) * Math.sqrt(TAU);
      if (band > 0) { bands.push(band); const s = swing.update(mid, ts, SWING_MULT * band); if (s && ts >= et('09:30')) confirmed.push(s); }
    }
  }
}
confirmed.sort((a, b) => a.ts - b.ts);
console.log(`\n=== My detector's confirmed swings — NQ 07-01 (δ = 3×band; band ~${Math.min(...bands).toFixed(1)}-${Math.max(...bands).toFixed(1)}pt, δ ~${(3*bands.reduce((a,b)=>a+b,0)/bands.length).toFixed(1)}pt avg) ===`);
console.log(`HIGHS:`);
for (const s of confirmed.filter(s => s.kind === 'high')) console.log(`  ${clock(s.ts)} ET   ${s.price.toFixed(2)}`);
console.log(`LOWS:`);
for (const s of confirmed.filter(s => s.kind === 'low')) console.log(`  ${clock(s.ts)} ET   ${s.price.toFixed(2)}`);
console.log(`\ntotal ${confirmed.length} swings (${confirmed.filter(s=>s.kind==='high').length}H / ${confirmed.filter(s=>s.kind==='low').length}L)`);
process.exit(0);
