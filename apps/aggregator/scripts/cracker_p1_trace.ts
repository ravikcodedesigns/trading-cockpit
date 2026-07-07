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
import { LevelMemory, LM_CFG, type LevelSource, type LmCfg } from '../src/l3/level-memory.js';
import { TraceEngine, T_CFG } from '../src/l3/trace.js';
import { computeProfile, VP_CFG, type VolumeProfile } from '../src/l3/volume-profile.js';
import { ApproachTracker, depthBeyond, maxGapBeyond, BS_CFG } from '../src/l3/book-state.js';
import type { CtxBar } from '../src/l3/trace.js';
import { getVolDrift } from '../src/sources/quantdata-store.js';

// ── Phase 1.7: per-instrument config (same code, per-symbol constants) ────────
// Dimensionless constants (σ multipliers, priors, retirement, hysteresis, z
// cutoffs) are SHARED. Price-dimension constants scale by the NQ/ES price ratio
// (~4.0 at 30,000/7,500), rounded tick-friendly; the profile floor was probed
// on 3 real ES days exactly like NQ (2026-07-07): 0.5pt fragments one shelf
// into three "HVNs" 4–8pt apart, 1.0pt yields 5–7 clean shelves (the NQ-2pt
// analogue), 2pt merges real ones → ES floor = 1.0pt. Round-number grid: ES
// flow clusters on 10s with 50s as majors (NQ: 50s/100s).
const INSTR: Record<string, {
  round: { step: number; major: number };
  lm: Partial<LmCfg>; tr: object; vp: object; ms: object; sg: object; bs: object;
}> = {
  NQ: { round: { step: 50, major: 100 }, lm: {}, tr: {}, vp: {}, ms: {}, sg: {}, bs: {} },
  ES: {
    round: { step: 10, major: 50 },
    lm: { MERGE_PTS: 1.25, CONFLUENCE_PTS: 1.25, NEAR_TICKS: 4 },  // 5/5/4pt ÷ 4
    tr: { CLUSTER_PTS: 2.5, IMB_BIN_PTS: 0.25 },                   // 10pt ÷ 4 · 1pt ÷ 4
    vp: { H_FLOOR_PTS: 1.0 },                                      // probe-validated (see above)
    ms: { DELTA_CAP: [10, 22.5, 45], BASE_FLOOR: 0.5, BASE_CAP: 10 },  // [40,90,180]/2/40 ÷ 4
    sg: { CAP_PT: 15 },
    bs: { K_WALL_TICKS: 4, W_BEYOND_TICKS: 10 },   // 16/40 NQ ticks ÷ 4 (price-scale)   // 60 ÷ 4; floor stays 0.5pt = 2 ticks on both (dead-tape guard is tick-scale)
  },
};

const SYM = process.env.TRACE_SYM ?? 'NQ', TICK = 0.25;  // L3 mini
const CFG = INSTR[SYM] ?? (() => { throw new Error(`no instrument config for ${SYM}`); })();
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
  // never trace the CURRENT ET day — mid-session partials would freeze in
  // (TRACE_NEW skips them on nightly runs; full rebuilds need the same guard)
  if (!process.env.TRACE_INCLUDE_TODAY) {
    const todayEt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    days = days.filter((d) => d < todayEt);
  }
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
    const p = computeProfile({ pxVol: rows.map((r: any) => ({ price: Number(r[0]), vol: Number(r[1]) })), totVol, totVolSq, tick: TICK }, { ...VP_CFG, ...CFG.vp } as typeof VP_CFG);
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
  // shifted-placebo offset scales with the round-number grid (NQ 20–60pt ↔ ES 4–12pt)
  const offScale = CFG.round.step / 50;
  const off = (20 + rnd() * 40) * offScale * (rnd() < 0.5 ? -1 : 1);
  for (const p of priorSwings.slice(0, 20)) out.push({ price: Math.round((p + off) / TICK) * TICK, source: 'placebo-shifted' as LevelSource, kind: 'shift' });
  const { step, major } = CFG.round;
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) out.push({ price: p, source: 'round' as LevelSource, kind: p % major === 0 ? String(major) : String(step) });
  return out;
}

async function runDay(con: any, days: string[], di: number) {
  const day = days[di]!;
  const [warm, rthLo, rthHi, end] = [et(day, '09:00'), et(day, '09:30'), et(day, '16:00'), et(day, '16:05')];
  const g = gp(day);
  const trace = new TraceEngine(DB, SYM, day, { ...T_CFG, ...CFG.tr } as typeof T_CFG);
  // Phase 4.1: book-state capture — tracker sampled on the throttle loop; the
  // wrapped close-hook computes wall/beyond/gap columns with zero lookahead.
  const bsCfg = { ...BS_CFG, ...CFG.bs } as typeof BS_CFG;
  const tracker = new ApproachTracker(bsCfg);
  // Book-state is computed AT OPEN (ring history is short; a long visit would
  // outlive it) and emitted at close when close_ts is known.
  type BookRow = { wd_open: number | null; wa_open: number | null; wd_pre: number | null; wa_pre: number | null; beyond_def: number | null; gap_max: number | null };
  const pendingBook = new Map<string, BookRow>();
  const hooks: typeof trace.hooks = {
    onVisitOpen: (lvl, startTs, approachSign) => {
      trace.hooks.onVisitOpen?.(lvl, startTs, approachSign);
      const pi = Math.round(lvl.price / TICK);
      const at = tracker.wallsAt(pi, startTs);
      const pre = tracker.wallsPre(pi, startTs);
      const defBid = approachSign > 0;                 // tested from above = support
      const snap = tracker.snapAt(startTs);
      let beyond: number | null = null, gap: number | null = null;
      if (snap) {
        const side = defBid ? snap.bids : snap.asks;
        const dir = (defBid ? -1 : 1) as 1 | -1;
        const dbb = depthBeyond(side, pi, dir, bsCfg.W_BEYOND_TICKS, bsCfg.LADDER_N);
        if (dbb.covered) beyond = dbb.size;
        const g = maxGapBeyond(side, pi, dir, bsCfg.W_BEYOND_TICKS, bsCfg.LADDER_N);
        if (g.covered) gap = g.gapTicks;
      }
      pendingBook.set(lvl.id, {
        wd_open: at ? (defBid ? at.bid : at.ask) : null,
        wa_open: at ? (defBid ? at.ask : at.bid) : null,
        wd_pre: pre ? (defBid ? pre.bid : pre.ask) : null,
        wa_pre: pre ? (defBid ? pre.ask : pre.bid) : null,
        beyond_def: beyond, gap_max: gap,
      });
    },
    onVisitClose: (lvl, info) => {
      trace.hooks.onVisitClose?.(lvl, info);
      const row = pendingBook.get(lvl.id);
      pendingBook.delete(lvl.id);
      if (row) trace.recordBookState({ level_id: lvl.id, close_ts: info.closeTs, ...row });
    },
  };
  const mem2 = new LevelMemory(DB, SYM, day, hooks, { ...LM_CFG, ...CFG.lm });
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
  const sv = new SigmaEv(CFG.sg);
  const ms = new MultiScaleSwingDetector(CFG.ms);
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
      const sources: Src[] = ms.levels(sigma).map((s) => ({ price: s.price, source: 'swing' as LevelSource, kind: s.kind }));
      sources.push(...placebos, ...profSources);
      if (tracker.due(ts)) {   // ladder() sort only when a sample will be taken
        const lad = book.ladder(bsCfg.LADDER_N);
        // sample REGISTRY prices (hooks look up lvl.price) + today's raw source prices
        const keys = mem2.activeLevels().map((l) => Math.round(l.price / TICK))
          .concat(sources.map((x) => Math.round(x.price / TICK)));
        tracker.maybeSample(ts, { ts, bids: lad.bids, asks: lad.asks }, keys);
      }
      if (ts < rthLo || ts > rthHi) continue;
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
  // Phase 1.4: context pass. The common factor is a MARKET-STATE variable, fixed
  // as (NQ, ES) regardless of the trace symbol — es_agree is symmetric and
  // rs_30m_bp is always NQ−ES. morning_iv = NDX ATM-IV for both symbols (the
  // market-vol proxy; SPX vol-drift has ~10 days of coverage, not viable).
  const ctx = trace.writeVisitContext(await ctxBars(con, day, 'NQ'), await ctxBars(con, day, 'ES'), await morningIv(day));
  trace.close(); mem2.close();
  return { obs, resolved, ctx };
}


/** TRACE_NEW=1: skip days already in the DB and the (incomplete) current ET day,
 *  while the full day list still provides causal context for placebos/profiles. */
function newDaySkipper(): (d: string) => boolean {
  if (!process.env.TRACE_NEW) return () => false;
  const todayEt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  let done = new Set<string>();
  try {
    const db = new Database(DB, { readonly: true });
    done = new Set((db.prepare(`SELECT DISTINCT trading_day d FROM visit_features WHERE symbol = ?`).all(SYM) as any[]).map((r) => r.d));
    db.close();
  } catch { /* fresh DB */ }
  return (d: string) => done.has(d) || d >= todayEt;
}

async function main() {
  const days = availableDays();
  if (!days.length) { console.log('no L3 mini days found'); return; }
  // fresh-wipe only on the default NQ run — a non-NQ run shares the DB with the
  // standing NQ trace and must never delete it (per-day idempotency still applies)
  if (!process.env.TRACE_KEEP && SYM === 'NQ') for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
  process.stderr.write(`building Cracker trace: ${days.length} ${SYM}-mini days ${days[0]} → ${days[days.length - 1]} → ${DB}\n`);
  const inst = await DuckDBInstance.create();
  const con = await inst.connect();
  const skip = newDaySkipper();
  for (const [di, day] of days.entries()) {
    if (skip(day)) continue;
    try { const { obs, resolved } = await runDay(con, days, di); process.stderr.write(`  ${day} → ${obs} obs, ${resolved} visits resolved\n`); }
    catch (e: any) { process.stderr.write(`  ${day} ERR ${e.message.slice(0, 80)}\n`); }
  }
  // QA summary
  const db = new Database(DB, { readonly: true });
  const g1 = db.prepare(`SELECT COUNT(*) n FROM visit_features WHERE symbol = ?`).get(SYM) as any;
  const g2 = db.prepare(`SELECT COUNT(*) n FROM visit_outcomes WHERE symbol = ?`).get(SYM) as any;
  console.log(`\n=== TRACE QA (${SYM}) ===`);
  console.log(`visit_features ${g1.n} rows · visit_outcomes ${g2.n} rows`);
  for (const r of db.prepare(`SELECT source, COUNT(*) n, ROUND(AVG(held),3) hold FROM visit_features WHERE symbol = '${SYM}' GROUP BY source ORDER BY n DESC`).all() as any[])
    console.log(`  ${String(r.source).padEnd(16)} visits ${String(r.n).padStart(5)}  hold ${r.hold}`);
  const nulls = db.prepare(`SELECT SUM(sigma_ev IS NULL) s, SUM(mo_30m IS NULL) m FROM visit_features vf LEFT JOIN visit_outcomes vo USING (level_id, close_ts) WHERE vf.symbol = '${SYM}'`).get() as any;
  console.log(`null rates: sigma_ev ${nulls.s}, mo_30m ${nulls.m}`);
  const bar = db.prepare(`SELECT bl_2, COUNT(*) n FROM visit_outcomes WHERE symbol = '${SYM}' GROUP BY bl_2`).all() as any[];
  console.log(`barrier long@2R distribution: ${bar.map((b) => `${b.bl_2}:${b.n}`).join('  ')}`);
  // Phase 1.6 QA: structural-stop engagement + confluence distribution (descriptive only)
  const ss = db.prepare(`SELECT stop_src_l, COUNT(*) n, ROUND(AVG(stop_1r_l),1) r FROM visit_outcomes WHERE symbol = '${SYM}' GROUP BY stop_src_l`).all() as any[];
  console.log(`stop source (long): ${ss.map((s) => `${s.stop_src_l}:${s.n} (avg 1R ${s.r}pt)`).join('  ')}`);
  const cf = db.prepare(`SELECT confluence_n, COUNT(*) n FROM visit_features WHERE symbol = '${SYM}' GROUP BY confluence_n ORDER BY confluence_n`).all() as any[];
  console.log(`confluence_n distribution: ${cf.map((c) => `${c.confluence_n}:${c.n}`).join('  ')}`);
  // Phase 1.4 QA
  const vc = db.prepare(`SELECT COUNT(*) n, ROUND(AVG(es_agree),3) ea, SUM(es_agree IS NULL) ean, ROUND(AVG(rs_30m_bp),1) rs FROM visit_context WHERE symbol = '${SYM}'`).get() as any;
  const ph = db.prepare(`SELECT tod_phase, COUNT(*) n FROM visit_context WHERE symbol = '${SYM}' GROUP BY tod_phase ORDER BY n DESC`).all() as any[];
  const iv = db.prepare(`SELECT SUM(morning_iv IS NOT NULL) y, COUNT(*) n FROM day_context WHERE symbol = '${SYM}'`).get() as any;
  console.log(`visit_context ${vc.n} rows · es_agree avg ${vc.ea} (null ${vc.ean}) · rs_30m avg ${vc.rs}bp · phases ${ph.map((p) => `${p.tod_phase}:${p.n}`).join(' ')} · morning_iv ${iv.y}/${iv.n} days`);
  db.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
