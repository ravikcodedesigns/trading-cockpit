// CRACKER — the TRACE built on the 54-day L2 HISTORY (ticks-parquet, micro data).
//
// DATA-POLICY AMENDMENT (user decision 2026-07-07, supersedes the two-line
// policy's "no flow research on L2" for the SCREENING role only):
//   The L2 micro history (NQ=MNQ 05-04→, ES=MES 05-12→) becomes the Phase-3
//   SCREENING set — ~4× the days of the L3-mini set. Boundaries:
//   • Structure factors (F1–F3): fully valid here (structure transfers
//     micro↔mini at 0.96, P0.4).
//   • Delta-family flow factors (F4/F5/F6/F8): SCREEN here with the P0.4
//     attenuation (×0.8 NQ, ×0.65 ES); L3-mini confirmation MANDATORY before
//     any EDGE is final (the L3 forward set accrues ~400 visits/day).
//   • Bin-level imbalance factors: L3-ONLY (κ≈0.2, does not transfer). imb_n
//     is still recorded here but must not be used as a screening factor.
//   Aggressor flag: ticks-parquet is_bid_aggressor=true ⇔ BUY (pinned by P0.3:
//   grading under true⇔SELL gave r=−0.994 ⇒ the true⇔BUY reading is |r|≈0.994;
//   matches cvd-session.ts:7 and build_level_memory.ts).
//
// Same engines, same per-instrument configs as cracker_p1_trace.ts (micros trade
// at the SAME index price scale as minis — point-denominated constants carry).
// Differences are the data layer only: ticks-parquet paths, ts (not ts_ms),
// side 0/1 (not is_bid), SANE price filter, single contract (no dominant-
// contract selection, no is_otc). DB: data/cracker-trace-l2.db — "NQ"/"ES"
// labels mean MNQ/MES per the store's authoritative reading (plan §1.5).
//
// Run: TRACE_SYM=NQ|ES pnpm --filter @trading/aggregator exec tsx scripts/cracker_p1_trace_l2.ts
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
import type { CtxBar } from '../src/l3/trace.js';
import { getVolDrift } from '../src/sources/quantdata-store.js';

// per-instrument config — identical to cracker_p1_trace.ts (same price scale)
const INSTR: Record<string, {
  round: { step: number; major: number }; sane: [number, number];
  lm: Partial<LmCfg>; tr: object; vp: object; ms: object; sg: object;
}> = {
  NQ: { round: { step: 50, major: 100 }, sane: [20000, 40000], lm: {}, tr: {}, vp: {}, ms: {}, sg: {} },
  ES: {
    round: { step: 10, major: 50 }, sane: [4000, 9000],
    lm: { MERGE_PTS: 1.25, CONFLUENCE_PTS: 1.25, NEAR_TICKS: 4 },
    tr: { CLUSTER_PTS: 2.5, IMB_BIN_PTS: 0.25 },
    vp: { H_FLOOR_PTS: 1.0 },
    ms: { DELTA_CAP: [10, 22.5, 45], BASE_FLOOR: 0.5, BASE_CAP: 10 },
    sg: { CAP_PT: 15 },
  },
};

const SYM = process.env.TRACE_SYM ?? 'NQ', TICK = 0.25;
const CFG = INSTR[SYM] ?? (() => { throw new Error(`no instrument config for ${SYM}`); })();
const ROOT = '/Users/ravikumarbasker/trading-cockpit/data';
const PROOT = `${ROOT}/ticks-parquet`;
const DB = process.env.TRACE_DB ?? `${ROOT}/cracker-trace-l2.db`;
const THROTTLE = 200, RV_MS = 1000;
const et = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-04:00`);
const num = (v: any) => v == null ? null : Number(v);
const SANE = (sym = SYM) => `price BETWEEN ${INSTR[sym]!.sane[0]} AND ${INSTR[sym]!.sane[1]}`;
const gp = (type: string, d: string, sym = SYM) =>
  `read_parquet('${PROOT}/${type}/symbol=${sym}/date=${d}/*.parquet', filename=true, file_row_number=true)`;

async function ctxBars(con: any, day: string, sym: string): Promise<CtxBar[]> {
  try {
    return (await con.streamAndReadAll(`SELECT CAST(FLOOR(ts / 60000) AS BIGINT) * 60000 t, LAST(price ORDER BY ts) c
      FROM read_parquet('${PROOT}/trades/symbol=${sym}/date=${day}/*.parquet')
      WHERE size > 0 AND ${SANE(sym)} AND ts >= ${et(day, '08:55')} AND ts < ${et(day, '16:05')}
      GROUP BY 1 ORDER BY 1`)).getRows().map((r: any) => ({ t: Number(r[0]), c: Number(r[1]) }));
  } catch { return []; }
}

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
  const dir = `${PROOT}/trades/symbol=${SYM}`;
  let days = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.startsWith('date=')).map((x) => x.slice(5)).sort() : [];
  const sel = process.env.TRACE_DAYS;
  if (sel) {
    if (/^\d+$/.test(sel)) days = days.slice(0, Number(sel));
    else if (sel.startsWith('until:')) days = days.filter((d) => d <= sel.slice(6));
    else days = days.filter((d) => sel.split(',').includes(d));
  }
  return days;
}

async function priorRange(con: any, days: string[], di: number): Promise<{ lo: number; hi: number } | null> {
  for (let j = di - 1; j >= 0; j--) {
    const d = days[j]!;
    const r = await con.streamAndReadAll(`SELECT MIN(price), MAX(price) FROM read_parquet('${PROOT}/trades/symbol=${SYM}/date=${d}/*.parquet')
      WHERE ts >= ${et(d, '09:30')} AND ts < ${et(d, '16:00')} AND size > 0 AND ${SANE()}`);
    const [lo, hi] = r.getRows()[0]!.map(Number);
    if (isFinite(lo) && isFinite(hi) && hi > lo) return { lo, hi };
  }
  return null;
}

const MIN_PROF_VOL = 50_000;
async function priorProfile(con: any, days: string[], di: number): Promise<{ p: VolumeProfile; day: string } | null> {
  for (let j = di - 1; j >= 0; j--) {
    const d = days[j]!;
    const src = `read_parquet('${PROOT}/trades/symbol=${SYM}/date=${d}/*.parquet')`;
    const where = `size > 0 AND ${SANE()} AND ts >= ${et(d, '09:30')} AND ts < ${et(d, '16:00')}`;
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
  const trace = new TraceEngine(DB, SYM, day, { ...T_CFG, ...CFG.tr } as typeof T_CFG);
  const mem2 = new LevelMemory(DB, SYM, day, trace.hooks, { ...LM_CFG, ...CFG.lm });
  const lvlDb = new Database(DB, { readonly: true });
  const swings0 = (lvlDb.prepare(`SELECT price FROM levels WHERE symbol = ? AND source = 'swing' AND retired = 0`).all(SYM) as any[]).map((r) => r.price);
  lvlDb.close();
  const placebos = makePlacebos(day, await priorRange(con, days, di), swings0);
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
  let lastObs = 0, lastRv = 0, obs = 0;
  let dayO = NaN, dayC = NaN, dayH = -Infinity, dayL = Infinity;

  // deterministic capture-order replay (P0.1 rules): ts, depth-before-trades, file, row
  const SQL = `
    SELECT ts,'D' s, price, size, side, CAST(NULL AS BOOLEAN) f, filename fn, file_row_number frn FROM ${gp('depth', day)}
      WHERE ${SANE()} AND ts BETWEEN ${warm} AND ${end}
    UNION ALL SELECT ts,'T', price, size, CAST(NULL AS BIGINT), is_bid_aggressor, filename, file_row_number FROM ${gp('trades', day)}
      WHERE size > 0 AND ${SANE()} AND ts BETWEEN ${warm} AND ${end}
    ORDER BY ts, s, fn, frn`;
  const stream = await con.stream(SQL);
  let chunk;
  while ((chunk = await stream.fetchChunk()) && chunk.rowCount > 0) {
    for (const row of chunk.getRows() as any[]) {
      const ts = Number(row[0]); book.lastTs = ts;
      const price = num(row[2])!, size = num(row[3])!;
      if (row[1] === 'D') { book.applyDepth({ is_bid: Number(row[4]) === 0, size, price_int: book.intFromPrice(price) }); continue; }
      // trade: is_bid_aggressor=true ⇔ BUY (P0.3-pinned L2 convention)
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
  const bars = (await con.streamAndReadAll(`SELECT CAST(FLOOR(ts / 60000) AS BIGINT) * 60000 t,
      FIRST(price ORDER BY ts) o, MAX(price) h, MIN(price) l, LAST(price ORDER BY ts) c
    FROM read_parquet('${PROOT}/trades/symbol=${SYM}/date=${day}/*.parquet')
    WHERE size > 0 AND ${SANE()} AND ts >= ${rthLo} AND ts < ${end}
    GROUP BY 1 ORDER BY 1`)).getRows().map((r: any) => ({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) }));
  const { resolved } = trace.resolveOutcomes(bars, { lvns: lvnPrices, tick: TICK });
  if (isFinite(dayO)) trace.writeDayContext({ openPx: dayO, closePx: dayC, hiPx: dayH, loPx: dayL });
  const ctx = trace.writeVisitContext(await ctxBars(con, day, 'NQ'), await ctxBars(con, day, 'ES'), await morningIv(day));
  trace.close(); mem2.close();
  return { obs, resolved, ctx };
}

async function main() {
  const days = availableDays();
  if (!days.length) { console.log('no L2 days found'); return; }
  if (!process.env.TRACE_KEEP && SYM === 'NQ') for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
  process.stderr.write(`building Cracker L2 trace: ${days.length} ${SYM}-micro days ${days[0]} → ${days[days.length - 1]} → ${DB}\n`);
  const inst = await DuckDBInstance.create();
  const con = await inst.connect();
  for (const [di, day] of days.entries()) {
    try { const { obs, resolved } = await runDay(con, days, di); process.stderr.write(`  ${day} → ${obs} obs, ${resolved} visits resolved\n`); }
    catch (e: any) { process.stderr.write(`  ${day} ERR ${e.message.slice(0, 100)}\n`); }
  }
  const db = new Database(DB, { readonly: true });
  console.log(`\n=== L2 TRACE QA (${SYM}) ===`);
  const g1 = db.prepare(`SELECT COUNT(*) n FROM visit_features WHERE symbol = ?`).get(SYM) as any;
  console.log(`visit_features ${g1.n} rows`);
  for (const r of db.prepare(`SELECT source, COUNT(*) n, ROUND(AVG(held),3) hold FROM visit_features WHERE symbol = '${SYM}' GROUP BY source ORDER BY n DESC`).all() as any[])
    console.log(`  ${String(r.source).padEnd(16)} visits ${String(r.n).padStart(5)}  hold ${r.hold}`);
  const ss = db.prepare(`SELECT stop_src_l, COUNT(*) n FROM visit_outcomes WHERE symbol = '${SYM}' GROUP BY stop_src_l`).all() as any[];
  console.log(`stop source (long): ${ss.map((s) => `${s.stop_src_l}:${s.n}`).join('  ')}`);
  const vc = db.prepare(`SELECT COUNT(*) n, ROUND(AVG(es_agree),3) ea FROM visit_context WHERE symbol = '${SYM}'`).get() as any;
  console.log(`visit_context ${vc.n} rows · es_agree avg ${vc.ea}`);
  db.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
