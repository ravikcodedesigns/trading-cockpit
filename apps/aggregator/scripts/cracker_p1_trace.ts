// CRACKER Phase 1 — build the TRACE on the L3-mini discovery set (CRACKER_PLAN §1.5).
//
// Per day (NQ mini, dominant contract, deterministic capture order):
//   OrderBook ← depth · SigmaEv ← mid (1s) · MultiScaleSwingDetector(mid, σ_1m)
//   TraceEngine ← every trade (NATIVE flag) · LevelMemory.observe ← throttled,
//   band = σ_1m (frozen interim), sources = MS-swings + placebos + round numbers.
// Then the deferred resolution pass (markouts, dual-direction barriers,
// uniqueness, clusters) from the day's 1-min bars, and day_context.
//
// PLACEBO SOURCES (causal — all derived from the PRIOR session only):
//   placebo-random : 12 levels uniform in prior-day range ±25%, LCG seeded by day
//   placebo-shifted: prior days' swing levels (from the registry) + seeded ±20–60pt offset
//   round          : 50-pt multiples in prior-day range ±25% (kind '100' on century marks)
//
// DB: data/cracker-trace.db (fresh Cracker dataset; spine tables via LevelMemory
// + trace tables via TraceEngine). Env: TRACE_DAYS = "N" | "d1,d2" | "until:YYYY-MM-DD".
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cracker_p1_trace.ts
import 'dotenv/config';
import { DuckDBInstance } from '@duckdb/node-api';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { OrderBook } from '../src/l3/order-book.js';
import { MultiScaleSwingDetector } from '../src/l3/swing-levels-ms.js';
import { SigmaEv } from '../src/l3/sigma-ev.js';
import { LevelMemory, type LevelSource } from '../src/l3/level-memory.js';
import { TraceEngine } from '../src/l3/trace.js';
import { computeProfile, type VolumeProfile } from '../src/l3/volume-profile.js';
import type { CtxBar } from '../src/l3/trace.js';
import { getVolDrift } from '../src/sources/quantdata-store.js';

const SYM = 'NQ', TICK = 0.25;                          // L3 mini
const ROOT = '/Users/ravikumarbasker/trading-cockpit/data';
const DB = process.env.TRACE_DB ?? `${ROOT}/cracker-trace.db`;
const EXCLUDE = new Set(['2026-06-29']);
const THROTTLE = 200, RV_MS = 1000;
const et = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-04:00`);
const num = (v: any) => v == null ? null : Number(v);
const gp = (d: string) => ({
  depth: `read_parquet('${ROOT}/mbo-parquet/depth/symbol=${SYM}/date=${d}/*.parquet', filename=true, file_row_number=true)`,
  trades: `read_parquet('${ROOT}/mbo-parquet/trades/symbol=${SYM}/date=${d}/*.parquet', filename=true, file_row_number=true)`,
});
const domSQL = (d: string, sym = SYM) => `(SELECT contract FROM read_parquet('${ROOT}/mbo-parquet/trades/symbol=${sym}/date=${d}/*.parquet')
  WHERE ts_ms >= ${et(d, '09:30')} AND ts_ms < ${et(d, '16:00')} GROUP BY contract ORDER BY SUM(size) DESC LIMIT 1)`;

// Phase 1.4: 1-min closes 08:55→16:05 (context windows need 35 min of pre-RTH tape)
async function ctxBars(con: any, day: string, sym: string): Promise<CtxBar[]> {
  try {
    const src = `read_parquet('${ROOT}/mbo-parquet/trades/symbol=${sym}/date=${day}/*.parquet')`;
    return (await con.streamAndReadAll(`SELECT CAST(FLOOR(ts_ms / 60000) AS BIGINT) * 60000 t, LAST(price ORDER BY ts_ms) c
      FROM ${src} WHERE contract = ${domSQL(day, sym)} AND size > 0 AND NOT is_otc
        AND ts_ms >= ${et(day, '08:55')} AND ts_ms < ${et(day, '16:05')}
      GROUP BY 1 ORDER BY 1`)).getRows().map((r: any) => ({ t: Number(r[0]), c: Number(r[1]) }));
  } catch { return []; }   // symbol/day absent from the store → context columns null
}

// Phase 1.4: morning IV = mean NDX ATM-IV 09:30–10:00 ET (the validated IV→range
// forecaster input). qdCached: store hit or live fetch-and-persist; holidays /
// fetch failures resolve to null.
async function morningIv(day: string): Promise<number | null> {
  try {
    const vd = await getVolDrift('NDX', day);
    const lo = et(day, '09:30'), hi = et(day, '10:00');
    const pts = vd.filter((x) => x.epoch_ms >= lo && x.epoch_ms < hi && Number.isFinite(x.iv)).map((x) => x.iv);
    return pts.length >= 5 ? pts.reduce((a, b) => a + b, 0) / pts.length : null;
  } catch { return null; }
}

function lcg(seed: number) { let s = seed >>> 0; return () => (s = (1664525 * s + 1013904223) >>> 0) / 2 ** 32; }
const hashDay = (d: string) => [...d].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

function availableDays(): string[] {
  const dir = `${ROOT}/mbo-parquet/trades/symbol=${SYM}`;
  let days = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.startsWith('date=')).map((x) => x.slice(5)).sort() : [];
  days = days.filter((d) => !EXCLUDE.has(d));
  const sel = process.env.TRACE_DAYS;
  if (sel) {
    if (/^\d+$/.test(sel)) days = days.slice(0, Number(sel));
    else if (sel.startsWith('until:')) days = days.filter((d) => d <= sel.slice(6));
    else days = days.filter((d) => sel.split(',').includes(d));
  }
  return days;
}

/** Prior-session RTH range from mini trades (causal placebo basis). */
async function priorRange(con: any, days: string[], di: number): Promise<{ lo: number; hi: number } | null> {
  for (let j = di - 1; j >= 0; j--) {
    const d = days[j]!;
    const r = await con.streamAndReadAll(`SELECT MIN(price), MAX(price) FROM read_parquet('${ROOT}/mbo-parquet/trades/symbol=${SYM}/date=${d}/*.parquet')
      WHERE ts_ms >= ${et(d, '09:30')} AND ts_ms < ${et(d, '16:00')} AND size > 0`);
    const [lo, hi] = r.getRows()[0]!.map(Number);
    if (isFinite(lo) && isFinite(hi) && hi > lo) return { lo, hi };
  }
  return null;
}

// Phase 1.6: kernel profile of the PRIOR valid RTH session (causal — Monday reads
// Friday automatically by walking back through the available-days list). A session
// qualifies at ≥ MIN_PROF_VOL contracts (dominant contract, RTH) — thin partial-
// capture days walk further back rather than yield a junk profile.
const MIN_PROF_VOL = 50_000;
async function priorProfile(con: any, days: string[], di: number): Promise<{ p: VolumeProfile; day: string } | null> {
  for (let j = di - 1; j >= 0; j--) {
    const d = days[j]!;
    const src = `read_parquet('${ROOT}/mbo-parquet/trades/symbol=${SYM}/date=${d}/*.parquet')`;
    const where = `contract = ${domSQL(d)} AND size > 0 AND NOT is_otc AND ts_ms >= ${et(d, '09:30')} AND ts_ms < ${et(d, '16:00')}`;
    const tot = (await con.streamAndReadAll(`SELECT SUM(size), SUM(size*size) FROM ${src} WHERE ${where}`)).getRows()[0]!;
    const totVol = Number(tot[0] ?? 0), totVolSq = Number(tot[1] ?? 0);
    if (!(totVol >= MIN_PROF_VOL)) continue;
    const rows = (await con.streamAndReadAll(`SELECT price, SUM(size) FROM ${src} WHERE ${where} GROUP BY price`)).getRows();
    const p = computeProfile({ pxVol: rows.map((r: any) => ({ price: Number(r[0]), vol: Number(r[1]) })), totVol, totVolSq, tick: TICK });
    if (p) return { p, day: d };
  }
  return null;
}

type Src = { price: number; source: LevelSource; kind: string };
function makePlacebos(day: string, range: { lo: number; hi: number } | null, priorSwings: number[]): Src[] {
  if (!range) return [];
  const out: Src[] = [];
  const rng = range.hi - range.lo, lo = range.lo - 0.25 * rng, hi = range.hi + 0.25 * rng;
  const rnd = lcg(hashDay(day));
  for (let i = 0; i < 12; i++) out.push({ price: Math.round((lo + rnd() * (hi - lo)) / TICK) * TICK, source: 'placebo-random' as LevelSource, kind: 'rand' });
  const off = (20 + rnd() * 40) * (rnd() < 0.5 ? -1 : 1);
  for (const p of priorSwings.slice(0, 20)) out.push({ price: Math.round((p + off) / TICK) * TICK, source: 'placebo-shifted' as LevelSource, kind: 'shift' });
  for (let p = Math.ceil(lo / 50) * 50; p <= hi; p += 50) out.push({ price: p, source: 'round' as LevelSource, kind: p % 100 === 0 ? '100' : '50' });
  return out;
}

async function runDay(con: any, days: string[], di: number) {
  const day = days[di]!;
  const [warm, rthLo, rthHi, end] = [et(day, '09:00'), et(day, '09:30'), et(day, '16:00'), et(day, '16:05')];
  const g = gp(day);
  const trace = new TraceEngine(DB, SYM, day);
  const mem2 = new LevelMemory(DB, SYM, day, trace.hooks);
  // placebo-shifted basis = PRE-day registry swings (constructor has already wiped
  // own-day births, so this read is causally clean)
  const lvlDb = new Database(DB, { readonly: true });
  const swings0 = (lvlDb.prepare(`SELECT price FROM levels WHERE symbol = ? AND source = 'swing' AND retired = 0`).all(SYM) as any[]).map((r) => r.price);
  lvlDb.close();
  const placebos = makePlacebos(day, await priorRange(con, days, di), swings0);

  // Phase 1.6: prior-session profile → hvn/lvn level sources + LVNs for the structural 1R
  const prof = await priorProfile(con, days, di);
  const profSources: Src[] = prof ? [
    ...prof.p.hvns.map((n) => ({ price: n.price, source: 'hvn' as LevelSource, kind: n.price === prof.p.poc ? 'poc' : 'hvn' })),
    ...prof.p.lvns.map((n) => ({ price: n.price, source: 'lvn' as LevelSource, kind: 'lvn' })),
  ] : [];
  const lvnPrices = prof ? prof.p.lvns.map((n) => n.price) : [];
  if (prof) process.stderr.write(`    ${day} ← profile(${prof.day}) h=${prof.p.bandwidth.toFixed(2)}pt/${prof.p.bandwidthMethod} HVN×${prof.p.hvns.length} LVN×${prof.p.lvns.length} POC ${prof.p.poc}\n`);

  const book = new OrderBook(SYM, TICK);
  const sv = new SigmaEv();
  const ms = new MultiScaleSwingDetector();
  let lastObs = 0, lastRv = 0, obs = 0, visits0 = 0;
  let dayO = NaN, dayC = NaN, dayH = -Infinity, dayL = Infinity;

  const SQL = `
    SELECT ts_ms,'D' s, price, size, is_bid, CAST(NULL AS BOOLEAN) f, filename fn, file_row_number frn FROM ${g.depth}
      WHERE contract = ${domSQL(day)} AND ts_ms BETWEEN ${warm} AND ${end}
    UNION ALL SELECT ts_ms,'T', price, size, CAST(NULL AS BOOLEAN), is_bid_aggressor, filename, file_row_number FROM ${g.trades}
      WHERE contract = ${domSQL(day)} AND size > 0 AND NOT is_otc AND ts_ms BETWEEN ${warm} AND ${end}
    ORDER BY ts_ms, s, fn, frn`;
  const stream = await con.stream(SQL);
  let chunk;
  while ((chunk = await stream.fetchChunk()) && chunk.rowCount > 0) {
    for (const row of chunk.getRows() as any[]) {
      const ts = Number(row[0]); book.lastTs = ts;
      const price = num(row[2])!, size = num(row[3])!;
      if (row[1] === 'D') { book.applyDepth({ is_bid: !!row[4], size, price_int: book.intFromPrice(price) }); continue; }
      // trade: feed book tape + trace (NATIVE flag: true ⇔ BUY)
      book.applyTrade({ price_int: book.intFromPrice(price), price, size, is_bid_aggressor: !!row[5] });
      trace.onTrade(ts, price, size, !!row[5]);
      if (ts >= rthLo && ts <= rthHi) {
        if (isNaN(dayO)) dayO = price;
        dayC = price; dayH = Math.max(dayH, price); dayL = Math.min(dayL, price);
      }
      if (ts - lastObs < THROTTLE) continue;
      lastObs = ts;
      const bb = book.bestBid(), ba = book.bestAsk();
      if (bb == null || ba == null || bb >= ba) continue;
      const mid = (book.priceFromInt(bb) + book.priceFromInt(ba)) / 2;
      if (ts - lastRv >= RV_MS) { sv.update(mid, ts); lastRv = ts; }
      const sigma = sv.sigma1m();
      trace.currentSigma = sigma;
      ms.update(mid, ts, sigma);
      if (ts < rthLo || ts > rthHi) continue;
      const sources: Src[] = ms.levels(sigma).map((s) => ({ price: s.price, source: 'swing' as LevelSource, kind: s.kind }));
      sources.push(...placebos, ...profSources);
      mem2.observe(book, sources, mid, sigma, ts);
      obs++;
    }
  }
  mem2.flush();
  // deferred outcome resolution from 1-min bars (extend past close for late-window markouts)
  const bars = (await con.streamAndReadAll(`SELECT CAST(FLOOR(ts_ms / 60000) AS BIGINT) * 60000 t,
      FIRST(price ORDER BY ts_ms) o, MAX(price) h, MIN(price) l, LAST(price ORDER BY ts_ms) c
    FROM ${g.trades} WHERE contract = ${domSQL(day)} AND size > 0 AND NOT is_otc AND ts_ms >= ${rthLo} AND ts_ms < ${end}
    GROUP BY 1 ORDER BY 1`)).getRows().map((r: any) => ({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) }));
  const { resolved } = trace.resolveOutcomes(bars, { lvns: lvnPrices, tick: TICK });
  if (isFinite(dayO)) trace.writeDayContext({ openPx: dayO, closePx: dayC, hiPx: dayH, loPx: dayL });
  // Phase 1.4: context pass (tod phase, NQ–ES common factor, morning IV)
  const ctx = trace.writeVisitContext(await ctxBars(con, day, SYM), await ctxBars(con, day, 'ES'), await morningIv(day));
  trace.close(); mem2.close();
  return { obs, resolved, ctx };
}

async function main() {
  const days = availableDays();
  if (!days.length) { console.log('no L3 mini days found'); return; }
  if (!process.env.TRACE_KEEP) for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
  process.stderr.write(`building Cracker trace: ${days.length} ${SYM}-mini days ${days[0]} → ${days[days.length - 1]} → ${DB}\n`);
  const inst = await DuckDBInstance.create();
  const con = await inst.connect();
  for (const [di, day] of days.entries()) {
    try { const { obs, resolved } = await runDay(con, days, di); process.stderr.write(`  ${day} → ${obs} obs, ${resolved} visits resolved\n`); }
    catch (e: any) { process.stderr.write(`  ${day} ERR ${e.message.slice(0, 80)}\n`); }
  }
  // QA summary
  const db = new Database(DB, { readonly: true });
  const g1 = db.prepare(`SELECT COUNT(*) n FROM visit_features`).get() as any;
  const g2 = db.prepare(`SELECT COUNT(*) n FROM visit_outcomes`).get() as any;
  console.log(`\n=== TRACE QA ===`);
  console.log(`visit_features ${g1.n} rows · visit_outcomes ${g2.n} rows`);
  for (const r of db.prepare(`SELECT source, COUNT(*) n, ROUND(AVG(held),3) hold FROM visit_features GROUP BY source ORDER BY n DESC`).all() as any[])
    console.log(`  ${String(r.source).padEnd(16)} visits ${String(r.n).padStart(5)}  hold ${r.hold}`);
  const nulls = db.prepare(`SELECT SUM(sigma_ev IS NULL) s, SUM(mo_30m IS NULL) m FROM visit_features vf LEFT JOIN visit_outcomes vo USING (level_id, close_ts)`).get() as any;
  console.log(`null rates: sigma_ev ${nulls.s}, mo_30m ${nulls.m}`);
  const bar = db.prepare(`SELECT bl_2, COUNT(*) n FROM visit_outcomes GROUP BY bl_2`).all() as any[];
  console.log(`barrier long@2R distribution: ${bar.map((b) => `${b.bl_2}:${b.n}`).join('  ')}`);
  // Phase 1.6 QA: structural-stop engagement + confluence distribution (descriptive only)
  const ss = db.prepare(`SELECT stop_src_l, COUNT(*) n, ROUND(AVG(stop_1r_l),1) r FROM visit_outcomes GROUP BY stop_src_l`).all() as any[];
  console.log(`stop source (long): ${ss.map((s) => `${s.stop_src_l}:${s.n} (avg 1R ${s.r}pt)`).join('  ')}`);
  const cf = db.prepare(`SELECT confluence_n, COUNT(*) n FROM visit_features GROUP BY confluence_n ORDER BY confluence_n`).all() as any[];
  console.log(`confluence_n distribution: ${cf.map((c) => `${c.confluence_n}:${c.n}`).join('  ')}`);
  // Phase 1.4 QA
  const vc = db.prepare(`SELECT COUNT(*) n, ROUND(AVG(es_agree),3) ea, SUM(es_agree IS NULL) ean, ROUND(AVG(rs_30m_bp),1) rs FROM visit_context`).get() as any;
  const ph = db.prepare(`SELECT tod_phase, COUNT(*) n FROM visit_context GROUP BY tod_phase ORDER BY n DESC`).all() as any[];
  const iv = db.prepare(`SELECT SUM(morning_iv IS NOT NULL) y, COUNT(*) n FROM day_context`).get() as any;
  console.log(`visit_context ${vc.n} rows · es_agree avg ${vc.ea} (null ${vc.ean}) · rs_30m avg ${vc.rs}bp · phases ${ph.map((p) => `${p.tod_phase}:${p.n}`).join(' ')} · morning_iv ${iv.y}/${iv.n} days`);
  db.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
