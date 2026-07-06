// Lean multi-scale swings from parquet TRADES only (no depth/book — swings are price
// structure). Fast: streams just the trade price path for a day's RTH.
// Run: pnpm --filter @trading/aggregator exec tsx scripts/dump_swings_parq.ts 2026-06-05 NQ
import { DuckDBInstance } from '@duckdb/node-api';
import { MultiScaleSwingDetector } from '../src/l3/swing-levels-ms.js';
import { diffusionScale } from '../src/l3/divergence.js';

const DAY = process.argv[2] ?? '2026-06-05', SYM = process.argv[3] ?? 'NQ';
const PROOT = '/Users/ravikumarbasker/trading-cockpit/data/ticks-parquet';
const et = (hm: string) => Date.parse(`${DAY}T${hm}:00-04:00`);
const push = <T>(b: T[], x: T, cap: number) => { b.push(x); if (b.length > cap) b.shift(); };
const clock = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false }).slice(-8);
const BASE_WIN = 1800;

const inst = await DuckDBInstance.create();
const con = await inst.connect();
const ms = new MultiScaleSwingDetector();
const mids: number[] = [], midTs: number[] = [];
let lastObs = 0, lastRv = 0, base = 0;
const bases: number[] = [];
const confirmed: { ts: number; price: number; kind: string; scale: number; legSize: number }[] = [];

const SQL = `SELECT ts, price FROM read_parquet('${PROOT}/trades/symbol=${SYM}/date=${DAY}/*.parquet')
  WHERE size>0 AND price BETWEEN 20000 AND 40000 AND ts BETWEEN ${et('09:30')} AND ${et('16:00')} ORDER BY ts`;
const stream = await con.stream(SQL);
let chunk;
while ((chunk = await stream.fetchChunk()) && chunk.rowCount > 0) {
  for (const row of chunk.getRows() as any[]) {
    const ts = Number(row[0]), price = Number(row[1]);
    if (ts - lastObs < 200) continue; lastObs = ts;
    if (ts - lastRv >= 1000) {
      push(mids, price, BASE_WIN); push(midTs, ts, BASE_WIN); lastRv = ts;
      if (mids.length >= 60) { const b = diffusionScale(mids, midTs) * Math.sqrt(45); if (b > 0) { base = b; bases.push(b); } }
    }
    if (base > 0) for (const sw of ms.update(price, ts, base)) confirmed.push(sw);
  }
}
const sw = (s: number) => confirmed.filter(c => c.scale === s && c.legSize > 5);
const avg = bases.length ? bases.reduce((a, b) => a + b, 0) / bases.length : NaN;
console.log(`\n### ${SYM} ${DAY} — base vol ${bases.length ? Math.min(...bases).toFixed(1) + '-' + Math.max(...bases).toFixed(1) : 'n/a'}pt (avg ${avg.toFixed(1)}) | FINE ${sw(0).length} / MEDIUM ${sw(1).length} / COARSE ${sw(2).length}`);
console.log('COARSE skeleton: ' + sw(2).map(c => `${clock(c.ts).slice(0, 5)} ${c.kind[0]!.toUpperCase()}${c.price.toFixed(0)}`).join(' → '));
console.log('MEDIUM: ' + sw(1).map(c => `${clock(c.ts).slice(0, 5)}${c.kind[0]!.toUpperCase()}${c.price.toFixed(0)}`).join(' '));
process.exit(0);
