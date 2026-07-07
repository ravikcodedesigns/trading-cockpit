// Build the level-memory SPINE over the L2 history (ticks-parquet, depth+trades).
// Replays each day through OrderBook → SwingDetector → LevelMemory, persisting the
// per-level interaction trace + lifecycle to data/level-memory.db. Then prints a
// DESCRIPTIVE summary (descriptive-first, no edge claim): hold rates by test index,
// by source, and the level-memory test-over-test question (does a prior hold/break
// predict the next?). Run:
//   pnpm --filter @trading/aggregator exec tsx scripts/build_level_memory.ts

import { DuckDBInstance } from '@duckdb/node-api';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { MarketBook } from '../src/l3/market-book.js';
import { SwingDetector } from '../src/l3/swing-levels.js';
import { diffusionScale } from '../src/l3/divergence.js';
import { LevelMemory, type LevelSource } from '../src/l3/level-memory.js';

const SYM = 'NQ', TICK = 0.25;
const ROOT = '/Users/ravikumarbasker/trading-cockpit/data';
const PROOT = `${ROOT}/ticks-parquet`;
// Env knobs (Cracker 0.1 acceptance harness): LM_DB = db path override;
// LM_DAYS = "N" (first N days) or "YYYY-MM-DD[,…]" (specific days); LM_KEEP=1 =
// don't wipe the db first (incremental/idempotency mode); LM_QUIET=1 = no summary.
const DB = process.env.LM_DB ?? `${ROOT}/level-memory.db`;
const gp = (type: string, day: string) => `read_parquet('${PROOT}/${type}/symbol=${SYM}/date=${day}/*.parquet', filename=true, file_row_number=true)`;
const SANE = 'price BETWEEN 20000 AND 40000';
const THROTTLE = 200, RV_MS = 1000, SWING_MULT = 3, WARM_RV = 30, TAU = 45;
const et = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-04:00`);
const num = (v: any) => v == null ? null : Number(v);
const push = <T>(b: T[], x: T, cap: number) => { b.push(x); if (b.length > cap) b.shift(); };

function availableDays(): string[] {
  const dir = `${PROOT}/depth/symbol=${SYM}`;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => d.startsWith('date=')).map((d) => d.slice(5)).sort();
}

async function runDay(con: any, day: string, mem: LevelMemory) {
  const [warm, rthLo, rthHi, end] = [et(day, '09:00'), et(day, '09:30'), et(day, '16:00'), et(day, '17:00')];
  const book = new MarketBook(SYM, TICK);
  const swing = new SwingDetector();
  const mids: number[] = [], midTs: number[] = [];
  let lastObs = 0, lastRv = 0, obsCount = 0;
  // Deterministic + truth-preserving ORDER BY (Cracker 0.1). Bare "ORDER BY ts"
  // let DuckDB's parallel scan break same-ms ties differently per run → replays
  // diverged (caught by cracker_p01_accept: 88559 vs 88561 obs). And a canonical
  // re-sort by price/size is WRONG: depth updates carry ABSOLUTE sizes, so
  // same-price updates within one ms are order-dependent ("5 then 0" clears the
  // level; re-sorted "0 then 5" leaves a phantom) — testing that variant left the
  // book permanently crossed (96,781 crossed obs vs 467). The parquet's FILE ROW
  // ORDER is the converter's capture order = the true sequence, exposed via
  // file_row_number. Order: ts, then depth-before-trades, then capture sequence.
  const SQL = `
    SELECT ts,'D' s, price, size, side, CAST(NULL AS BOOLEAN) iba, filename fn, file_row_number frn FROM ${gp('depth', day)} WHERE ${SANE} AND ts BETWEEN ${warm} AND ${end}
    UNION ALL SELECT ts,'T', price, size, CAST(NULL AS BIGINT), is_bid_aggressor, filename, file_row_number FROM ${gp('trades', day)} WHERE size>0 AND ${SANE} AND ts BETWEEN ${warm} AND ${end}
    ORDER BY ts, s, fn, frn`;
  const stream = await con.stream(SQL);
  let chunk;
  while ((chunk = await stream.fetchChunk()) && chunk.rowCount > 0) {
    for (const row of chunk.getRows() as any[]) {
      const ts = Number(row[0]);
      if (row[1] === 'D') { const sz = num(row[3]); if (sz != null) book.applyDepth({ ts, priceInt: book.intFromPrice(num(row[2])!), size: sz, isBid: Number(row[4]) === 0 }); }
      else book.applyTrade({ ts, priceInt: book.intFromPrice(num(row[2])!), size: num(row[3])!, isBuy: !!row[5] });
      if (ts - lastObs < THROTTLE) continue;
      lastObs = ts;
      const bb = book.bestBid(), ba = book.bestAsk();
      if (bb == null || ba == null || bb >= ba) continue;
      const mid = (book.priceFromInt(bb) + book.priceFromInt(ba)) / 2;
      if (ts - lastRv >= RV_MS) { push(mids, mid, 120); push(midTs, ts, 120); lastRv = ts; }
      let band = 0;
      if (mids.length >= WARM_RV) { band = diffusionScale(mids, midTs) * Math.sqrt(TAU); if (band > 0) swing.update(mid, ts, SWING_MULT * band); }
      if (ts < rthLo || ts > rthHi) continue;   // only track interactions in RTH
      const sources = swing.levels().map((s: any) => ({ price: s.price, source: 'swing' as LevelSource, kind: s.kind }));
      mem.observe(book, sources, mid, band, ts);
      obsCount++;
    }
  }
  return obsCount;
}

function summary() {
  const db = new Database(DB, { readonly: true });
  const q = (s: string) => db.prepare(s).all() as any[];
  const g = (s: string) => db.prepare(s).get() as any;
  const tot = g(`SELECT (SELECT COUNT(*) FROM levels) lv, (SELECT COUNT(*) FROM interactions) it, (SELECT ROUND(AVG(held),3) FROM interactions) hr, (SELECT ROUND(AVG(taps),1) FROM interactions) taps, (SELECT ROUND(AVG(dwell_ms)/1000,1) FROM interactions) dwell`);
  console.log(`\n=== LEVEL-MEMORY SPINE — descriptive summary (VISIT-normalized) ===`);
  console.log(`levels ${tot.lv}   VISITS ${tot.it}   overall hold-rate ${tot.hr}   avg taps/visit ${tot.taps}   avg dwell ${tot.dwell}s`);
  console.log(`\nhold-rate by visit index (does a level behave differently on its Nth visit?):`);
  for (const r of q(`SELECT MIN(visit_index,4) ti, COUNT(*) n, ROUND(AVG(held),3) hr FROM interactions GROUP BY MIN(visit_index,4) ORDER BY ti`))
    console.log(`  visit ${r.ti === 4 ? '4+' : r.ti}: n=${r.n}  hold ${r.hr}`);
  console.log(`\nhold-rate by side:`);
  for (const r of q(`SELECT side, COUNT(*) n, ROUND(AVG(held),3) hr FROM interactions GROUP BY side`))
    console.log(`  ${r.side.padEnd(11)} n=${r.n}  hold ${r.hr}`);
  // test-over-test: does the PRIOR interaction's outcome predict the NEXT one?
  console.log(`\nTEST-OVER-TEST (the level-memory value): does prior hold/break predict the next?`);
  const rows = q(`SELECT level_id, held FROM interactions ORDER BY level_id, ts_ms, visit_index`);
  const byLvl = new Map<string, number[]>();
  for (const r of rows) { (byLvl.get(r.level_id) ?? byLvl.set(r.level_id, []).get(r.level_id)!).push(r.held); }
  let afterHold = [0, 0], afterBreak = [0, 0];
  for (const seq of byLvl.values()) for (let i = 1; i < seq.length; i++) {
    const bucket = seq[i - 1] ? afterHold : afterBreak; bucket[0]! += seq[i]!; bucket[1]! += 1;
  }
  const pr = (b: number[]) => b[1] ? `${(100 * b[0]! / b[1]!).toFixed(1)}% (n=${b[1]})` : 'n/a';
  console.log(`  P(hold | prior HELD)  = ${pr(afterHold)}`);
  console.log(`  P(hold | prior BROKE) = ${pr(afterBreak)}`);
  console.log(`\n(descriptive-first — no edge claim. This is the substrate for P2 interaction semantics + P3 eval.)`);
  db.close();
}

async function main() {
  let days = availableDays();
  if (!days.length) { console.log(`no ticks-parquet found under ${PROOT}/depth/symbol=${SYM}`); return; }
  const sel = process.env.LM_DAYS;
  if (sel) days = /^\d+$/.test(sel) ? days.slice(0, Number(sel)) : days.filter((d) => sel.split(',').includes(d));
  if (!process.env.LM_KEEP) { fs.rmSync(DB, { force: true }); fs.rmSync(DB + '-wal', { force: true }); fs.rmSync(DB + '-shm', { force: true }); }
  process.stderr.write(`replaying ${days.length} NQ days ${days[0]}→${days[days.length - 1]} into level-memory...\n`);
  const inst = await DuckDBInstance.create();
  const con = await inst.connect();
  for (const day of days) {
    const mem = new LevelMemory(DB, SYM, day);
    try { const n = await runDay(con, day, mem); mem.flush(); process.stderr.write(`  ${day} → ${n} obs\n`); }
    catch (e: any) { process.stderr.write(`  ${day} ERR ${e.message.slice(0, 70)}\n`); }
    finally { mem.close(); }
  }
  if (!process.env.LM_QUIET) summary();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
