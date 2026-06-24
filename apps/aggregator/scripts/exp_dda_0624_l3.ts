// P0 PROOF: replay 06-24 NQ L3 (real parquet) through the EpisodeTracker and show it flags
// DISTRIBUTION-short at the ~29800 top (~12:00-12:30 ET) and ACCUMULATION-long at the ~29380 bottom
// (~13:30-14:15 ET) — the two reversals that were readable upfront from the tape. Fed a GRID of
// levels every 50pts (NOT the two answers) so the detector, not the author, picks the episodes.
//
// Book-build bug fix: the depth parquet has ~0.0006% corrupt rows (price=1 / ~3e9) that latched
// bestBid/bestAsk onto garbage → million-$ mids. Filtered with `price BETWEEN 25000 AND 35000`.
import { DuckDBInstance } from '@duckdb/node-api';
import { OrderBook } from '../src/l3/order-book.js';
import { EpisodeTracker, type EpisodeSetup } from '../src/l3/episode-tracker.js';

const P = '/Users/ravikumarbasker/trading-cockpit/data/mbo-parquet';
const SYM = 'NQ';
const gp = (t: string) => `read_parquet('${P}/${t}/symbol=${SYM}/date=2026-06-24/*.parquet')`;
const LO = Date.parse('2026-06-24T11:00:00-04:00');   // window around both reversals
const HI = Date.parse('2026-06-24T15:00:00-04:00');
const OK = `price BETWEEN 25000 AND 35000 AND ts_ms BETWEEN ${LO} AND ${HI}`;
const THROTTLE = 200;                                  // observe() every 200ms of book-time (~5Hz)

// grid of candidate levels every 50pts spanning the day's range — the detector forms episodes only
// where price actually retests; the rest stay quiet (the honesty control).
const levels = [];
for (let p = 29350; p <= 29850; p += 25) levels.push({ price: p, label: `L${p}`, kind: 'structural' });

const etStr = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ms));
const num = (v: any) => v == null ? null : Number(v);

const book = new OrderBook(SYM, 0.25);
const tracker = new EpisodeTracker();
const setups: EpisodeSetup[] = [];
let lastObs = 0, lastSnap = 0;
// capture bottom-region episodes DURING the run (end-snapshot reaps them via staleness)
const botLog = new Map<string, any>();

const inst = await DuckDBInstance.create();
const con = await inst.connect();
const SQL = `
SELECT ts_ms,'D' src, CAST(NULL AS VARCHAR) act, CAST(NULL AS VARCHAR) oid, price_int, price, size, is_bid, CAST(NULL AS BOOLEAN) iba, CAST(NULL AS VARCHAR) aoid, CAST(NULL AS VARCHAR) poid FROM ${gp('depth')} WHERE ${OK}
UNION ALL SELECT ts_ms,'M', action, order_id, price_int, price, size, is_bid, CAST(NULL AS BOOLEAN), CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR) FROM ${gp('mbo')} WHERE ${OK}
UNION ALL SELECT ts_ms,'T', CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR), price_int, price, size, CAST(NULL AS BOOLEAN), is_bid_aggressor, aggressor_order_id, passive_order_id FROM ${gp('trades')} WHERE size>0 AND ${OK}
ORDER BY ts_ms`;

process.stderr.write(`streaming 06-24 ${SYM} 11:00-15:00 ET (~1 min)...\n`);
const stream = await con.stream(SQL);
let n = 0, chunk;
while ((chunk = await stream.fetchChunk()) && chunk.rowCount > 0) {
  for (const row of chunk.getRows() as any[]) {
    const ts = Number(row[0]), src = row[1];
    book.lastTs = ts;
    if (src === 'D') { const sz = num(row[6]); if (sz != null) book.applyDepth({ is_bid: !!row[7], size: sz, price_int: num(row[4])! }); }
    else if (src === 'M') {
      const act = row[2], oid = row[3];
      if (act === 'send') book.applySend({ order_id: oid, price_int: num(row[4])!, size: num(row[6]) ?? 0, is_bid: !!row[7] });
      else if (act === 'replace') book.applyReplace({ order_id: oid, price_int: num(row[4])!, size: num(row[6]) ?? 0 });
      else if (act === 'cancel') book.applyCancel({ order_id: oid });
    } else book.applyTrade({ price_int: num(row[4])!, price: num(row[5])!, size: num(row[6])!, is_bid_aggressor: !!row[8], aggressor_order_id: row[9], passive_order_id: row[10] });

    if (ts - lastObs >= THROTTLE) { lastObs = ts; for (const s of tracker.observe(SYM, book, levels, ts)) setups.push(s); }
    if (ts - lastSnap >= 60_000) {   // snapshot each minute; keep the richest state per bottom level
      lastSnap = ts;
      for (const ep of tracker.snapshot(SYM)) {
        const lp = Number(ep.key.split(':')[1]);
        if (lp > 29450 || ep.retests.length < 2) continue;
        const prev = botLog.get(ep.key);
        if (!prev || ep.retests.length >= prev.retests) botLog.set(ep.key, {
          ts, side: ep.side, retests: ep.retests.length, verdict: ep.verdict?.state ?? '—',
          ofi: ep.retests.map(r => Math.round(r.ofiNet)), lam: ep.retests.map(r => +r.lambda.toFixed(3)),
          ext: ep.retests.map(r => +r.priceExtreme.toFixed(1)),
        });
      }
    }
    n++;
  }
}
process.stderr.write(`processed ${n} events\n\n`);

console.log(`━━ EMITTED EPISODE SETUPS (06-24 ${SYM}) ━━`);
if (!setups.length) console.log('  (none)');
for (const s of setups) {
  console.log(`  ${etStr(s.ts)} ET  ${s.label} @${s.levelPrice}  ${s.state} ${s.direction.toUpperCase()}  conf ${s.confidence}  retests ${s.retests}`);
  console.log(`            ${s.note}`);
}

// diagnostic: bottom-region episodes captured DURING the run — to see WHY accumulation did/didn't form
console.log(`\n━━ BOTTOM-REGION EPISODE INTERNALS (levels ≤29450, captured live) ━━`);
if (!botLog.size) console.log('  (no episode ever formed ≥2 retests at any bottom level)');
for (const [key, e] of [...botLog.entries()].sort()) {
  console.log(`  ${key} side=${e.side} retests=${e.retests} verdict=${e.verdict} @${etStr(e.ts)}`);
  console.log(`     ofiNet:[${e.ofi.join(', ')}]  λ:[${e.lam.join(', ')}]  extreme:[${e.ext.join(', ')}]`);
}

const top = setups.filter(s => s.state === 'DISTRIBUTION' && s.levelPrice >= 29750);
const bot = setups.filter(s => s.state === 'ACCUMULATION' && s.levelPrice <= 29450);
console.log(`\n━━ PROOF CHECK ━━`);
console.log(`  DISTRIBUTION-short at the top (≥29750): ${top.length ? top.map(s => `${etStr(s.ts)}@${s.levelPrice}`).join(', ') : 'NONE'}`);
console.log(`  ACCUMULATION-long at the bottom (≤29450): ${bot.length ? bot.map(s => `${etStr(s.ts)}@${s.levelPrice}`).join(', ') : 'NONE'}`);
process.exit(0);
