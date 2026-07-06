// Verify the footprint engine on one day: replay depth+trades → OrderBook →
// Footprint (book-relative aggressor), print the session snapshot. Validation:
// on a DOWN day the session delta / aggressor-ratio should be NEGATIVE (sellers
// initiating) — a sanity check that the book-relative classification is right.
// Run: pnpm --filter @trading/aggregator exec tsx scripts/fp_smoke.ts 2026-06-05 NQ
import { DuckDBInstance } from '@duckdb/node-api';
import { OrderBook } from '../src/l3/order-book.js';
import { Footprint, FP_CFG } from '../src/l3/footprint.js';

const DAY = process.argv[2] ?? '2026-06-05', SYM = process.argv[3] ?? 'NQ';
const PROOT = '/Users/ravikumarbasker/trading-cockpit/data/ticks-parquet';
const gp = (t: string) => `read_parquet('${PROOT}/${t}/symbol=${SYM}/date=${DAY}/*.parquet')`;
const SANE = 'price BETWEEN 20000 AND 40000';
const et = (hm: string) => Date.parse(`${DAY}T${hm}:00-04:00`);
const num = (v: any) => v == null ? null : Number(v);

const inst = await DuckDBInstance.create();
const con = await inst.connect();
const book = new OrderBook(SYM, 0.25);
const fp = new Footprint(FP_CFG[SYM] ?? FP_CFG.NQ!);
let open = NaN, close = NaN, nTrades = 0;

const SQL = `
  SELECT ts,'D' s, price, size, side FROM ${gp('depth')} WHERE ${SANE} AND ts BETWEEN ${et('09:30')} AND ${et('16:00')}
  UNION ALL SELECT ts,'T', price, size, CAST(is_bid_aggressor AS BIGINT) FROM ${gp('trades')} WHERE size>0 AND ${SANE} AND ts BETWEEN ${et('09:30')} AND ${et('16:00')}
  ORDER BY ts`;
const stream = await con.stream(SQL);
let chunk;
while ((chunk = await stream.fetchChunk()) && chunk.rowCount > 0) {
  for (const row of chunk.getRows() as any[]) {
    const ts = Number(row[0]); book.lastTs = ts;
    const price = num(row[2])!, size = num(row[3]);
    if (row[1] === 'D') { if (size != null) book.applyDepth({ is_bid: Number(row[4]) === 0, size, price_int: book.intFromPrice(price) }); }
    else {
      const bbI = book.bestBid(), baI = book.bestAsk();
      if (bbI != null && baI != null && size != null) {
        fp.onTrade(price, size, book.priceFromInt(bbI), book.priceFromInt(baI));
        if (isNaN(open)) open = price; close = price; nTrades++;
      }
    }
  }
}

const snap = fp.snapshot();
if (!snap) { console.log('no footprint data'); process.exit(0); }
console.log(`\n=== Footprint session snapshot — ${SYM} ${DAY} (bin ${snap.binPts}pt, ${nTrades} trades) ===`);
console.log(`day: open ${open} → close ${close}  (${(close - open >= 0 ? '+' : '') + (close - open).toFixed(0)}pt)`);
console.log(`POC ${snap.poc}   value area ${snap.valueLow}–${snap.valueHigh}`);
console.log(`totalVol ${snap.totalVol}   buy ${snap.totalBuy}   sell ${snap.totalSell}   DELTA ${snap.delta >= 0 ? '+' : ''}${snap.delta}   aggressorRatio ${snap.aggressorRatio.toFixed(3)}`);
console.log(`\nVALIDATION: down day → delta should be NEGATIVE. → ${(close - open < 0) === (snap.delta < 0) ? 'CONSISTENT ✓' : 'MISMATCH ✗'} (day ${(close - open).toFixed(0)}pt, delta ${snap.delta})`);
console.log(`\nstacked imbalances (${snap.stacked.length}) — clustered initiative zones:`);
for (const s of snap.stacked.slice(0, 12)) console.log(`  ${s.side.toUpperCase().padEnd(4)} ${s.loPrice}–${s.hiPrice}  (${s.count} stacked)`);
process.exit(0);
