// CRACKER P2.1 + P2.2 — pipeline self-test on placebos + baseline curves.
//
// 2.1 VALIDATES THE MEASUREMENT CODE, not the market: at placebo-random levels
// (prices a seeded dice roll picked) the recorded outcomes must reproduce what
// pure chance predicts. Failure here = pipeline bug. Two independent tests:
//   A. MARKOUT: drift-adjusted mean forward move m̃(h) = mo(h) − drift·h at
//      placebo-random visits ≈ 0 at every horizon.
//   B. BARRIER BOOKKEEPING: every stored barrier label (4R × 2 dir, all placebo
//      visits, both symbols) re-derived INDEPENDENTLY from raw 1-min bars in
//      this script and compared to the stored labels. Gate: 100% agreement
//      (same bars + same frozen rules ⇒ identical labels; any mismatch = a
//      write/join/indexing bug). entry_px equality asserted too.
//
//      HISTORY — why 2.1B is a re-derivation gate and not a stochastic null
//      (2026-07-07, both prior designs preserved in the ledger):
//      v1: iid Gaussian sim with constant day drift → FAIL 12/16 (real drift is
//          bursty; Gaussian tails too thin at 3R).
//      v2: empirical paired null — same march at 50 seeded random minutes
//          within ±60 min on the same day's REAL path → FAIL 13/16, but with
//          structure: NQ longs +6pp at 1.5–2R beyond the null @99.5%.
//      Diagnosis: placebo LEVELS are information-free, but visit-CLOSE moments
//      are state-selected (price just departed a consolidation decisively) and
//      carry real short-horizon continuation shared by ALL visits regardless of
//      level identity. NO bystander null (analytic or random-time) can predict
//      state-selected entries — the plan's 2.1 premise ("placebo = theory") is
//      FALSIFIED, and the deviation is a market measurement, not a bug. It is
//      published below as the VISIT-MECHANICS CONTINUATION baseline (2.2), and
//      it binds Phase 3: factors are tested VISITS-vs-VISITS (factor bucket vs
//      placebo/other visits — same mechanics on both sides), never vs
//      random-time or analytic nulls, which would flatter every factor.
// 2.2 BASELINES: hold-rate per source with day-block bootstrap CIs; markout
//      distribution at 200 seeded random RTH minutes/day (the "nothing" yardstick).
//
// GATE (markout criteria frozen 2026-07-07 pre-first-run; barrier criterion
// REVISED same day after v1/v2 falsified its premise — see HISTORY above):
//   markout: all 8 cells (2 sym × 4 horizons) inside 99% CI of 0; ≥7/8 inside 95%.
//   barrier: 100% of stored labels reproduced by independent re-derivation.
//   Statistics: markout = uniq_w-weighted mean; CIs = day-block bootstrap,
//   B = 2000, seeded LCG. Primary set: placebo-random; shifted/round reported.
//
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cracker_p21_selftest.ts
import { DuckDBInstance } from '@duckdb/node-api';
import Database from 'better-sqlite3';

const ROOT = '/Users/ravikumarbasker/trading-cockpit/data';
const DB = process.env.TRACE_DB ?? `${ROOT}/cracker-trace.db`;
const SYMS = ['NQ', 'ES'];
const HORIZONS = [1, 5, 15, 30] as const;
const R_GRID = [1, 1.5, 2, 3] as const;
const B = 2000;           // bootstrap resamples
const NULL_K = 50;        // random-entry marches per visit (empirical null)
const NULL_WIN_MIN = 60;  // random entries within ±this of the visit's minute
const et = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-04:00`);

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

function lcg(seed: number) { let s = seed >>> 0; return () => (s = (1664525 * s + 1013904223) >>> 0) / 2 ** 32; }

/** Day-block bootstrap of a statistic over per-day groups. Returns percentile CIs. */
function dayBootstrap<T>(byDay: Map<string, T[]>, stat: (rows: T[]) => number, seed: number): { est: number; ci95: [number, number]; ci99: [number, number] } {
  const days = [...byDay.keys()].sort();
  const est = stat(days.flatMap((d) => byDay.get(d)!));
  const rnd = lcg(seed);
  const vals: number[] = [];
  for (let b = 0; b < B; b++) {
    const rows: T[] = [];
    for (let i = 0; i < days.length; i++) rows.push(...byDay.get(days[Math.floor(rnd() * days.length)]!)!);
    const v = stat(rows);
    if (isFinite(v)) vals.push(v);
  }
  vals.sort((a, b2) => a - b2);
  const q = (p: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(p * vals.length)))]!;
  return { est, ci95: [q(0.025), q(0.975)], ci99: [q(0.005), q(0.995)] };
}

interface Visit {
  day: string; closeTs: number; sigma: number; drift: number; uniq: number; entryPx: number;
  mo: Record<number, number | null>;
  oneRL: number; oneRS: number; vertL: number; vertS: number;
  bl: Record<string, string>; bs: Record<string, string>;
  simW?: Record<string, number>;   // empirical-null P(W) per cell key `${dir}${R}`
}

function loadVisits(db: Database.Database, sym: string, source: string): Visit[] {
  return (db.prepare(`
    SELECT vf.trading_day day, vf.close_ts closeTs, vf.sigma_ev sigma, dc.drift_pt_min drift, vo.uniq_w uniq, vo.entry_px entryPx,
      vo.mo_1m, vo.mo_5m, vo.mo_15m, vo.mo_30m,
      vo.stop_1r_l, vo.stop_1r_s, vo.vert_l, vo.vert_s,
      vo.bl_1, vo.bl_15, vo.bl_2, vo.bl_3, vo.bs_1, vo.bs_15, vo.bs_2, vo.bs_3
    FROM visit_features vf
    JOIN visit_outcomes vo ON vo.level_id = vf.level_id AND vo.close_ts = vf.close_ts AND vo.symbol = vf.symbol
    JOIN day_context dc ON dc.symbol = vf.symbol AND dc.trading_day = vf.trading_day
    WHERE vf.symbol = ? AND vf.source = ? AND vf.sigma_ev IS NOT NULL`).all(sym, source) as any[])
    .map((r) => ({
      day: r.day, closeTs: r.closeTs, sigma: r.sigma, drift: r.drift ?? 0, uniq: r.uniq ?? 1, entryPx: r.entryPx,
      mo: { 1: r.mo_1m, 5: r.mo_5m, 15: r.mo_15m, 30: r.mo_30m },
      oneRL: r.stop_1r_l, oneRS: r.stop_1r_s, vertL: r.vert_l, vertS: r.vert_s,
      bl: { '1': r.bl_1, '15': r.bl_15, '2': r.bl_2, '3': r.bl_3 },
      bs: { '1': r.bs_1, '15': r.bs_15, '2': r.bs_2, '3': r.bs_3 },
    }));
}

const keyOf = (R: number) => String(R).replace('.', '');

/** March the real 1-min bars from a given entry minute with the visit's own
 *  stop geometry — the SAME rules as trace.resolveOutcomes. Returns 'W'|'L'|'T'. */
function marchBars(bars: { t: number; h: number; l: number; c: number }[], idx: Map<number, number>,
  m0: number, dir: 1 | -1, oneR: number, R: number, vertMin: number): string | null {
  const bi = idx.get(m0);
  if (bi == null) return null;
  const entry = bars[bi]!.c;
  const tEnd = m0 + vertMin * 60_000;
  const tgt = entry + dir * R * oneR, stp = entry - dir * oneR;
  for (let j = bi + 1; j < bars.length && bars[j]!.t <= tEnd; j++) {
    const hitT = dir > 0 ? bars[j]!.h >= tgt : bars[j]!.l <= tgt;
    const hitS = dir > 0 ? bars[j]!.l <= stp : bars[j]!.h >= stp;
    if (hitT && hitS) return 'L';
    if (hitS) return 'L';
    if (hitT) return 'W';
  }
  return 'T';
}

/** Empirical paired null: per visit, the same march at NULL_K seeded random
 *  minutes within ±NULL_WIN_MIN of the visit's own close minute (same day, real
 *  path, own minute ±2 excluded). Fills v.simW with null win rates per cell. */
function empiricalNull(v: Visit, closeTs: number, bars: { t: number; h: number; l: number; c: number }[],
  idx: Map<number, number>, rnd: () => number): void {
  const m0 = Math.floor(closeTs / 60_000) * 60_000;
  const win: Record<string, number> = {}, n: Record<string, number> = {};
  for (const R of R_GRID) for (const dir of ['L', 'S']) { win[`${dir}${keyOf(R)}`] = 0; n[`${dir}${keyOf(R)}`] = 0; }
  const lo = Math.max(bars[0]!.t + 5 * 60_000, m0 - NULL_WIN_MIN * 60_000);
  const hi = Math.min(bars[bars.length - 1]!.t - 5 * 60_000, m0 + NULL_WIN_MIN * 60_000);
  if (hi <= lo) { v.simW = undefined; return; }
  let tries = 0, drawn = 0;
  while (drawn < NULL_K && tries < NULL_K * 8) {
    tries++;
    const m = lo + Math.floor(rnd() * ((hi - lo) / 60_000 + 1)) * 60_000;
    if (Math.abs(m - m0) <= 2 * 60_000 || !idx.has(m)) continue;
    drawn++;
    for (const R of R_GRID) {
      const k = keyOf(R);
      const rl = marchBars(bars, idx, m, 1, v.oneRL, R, v.vertL);
      if (rl) { win[`L${k}`]! += rl === 'W' ? 1 : 0; n[`L${k}`]!++; }
      const rs = marchBars(bars, idx, m, -1, v.oneRS, R, v.vertS);
      if (rs) { win[`S${k}`]! += rs === 'W' ? 1 : 0; n[`S${k}`]!++; }
    }
  }
  v.simW = {};
  for (const k of Object.keys(win)) v.simW[k] = n[k]! ? win[k]! / n[k]! : NaN;
}

/** Closed-form gambler's-ruin anchor (no vertical barrier): P(hit +R·s before −s). */
function closedForm(mu: number, sigma: number, s: number, R: number): number {
  if (s <= 0 || sigma <= 0) return NaN;
  const theta = (2 * mu) / (sigma * sigma);
  if (Math.abs(theta * s) < 1e-9) return 1 / (1 + R);
  return (1 - Math.exp(-theta * s)) / (1 - Math.exp(-theta * (R + 1) * s));
}

async function main() {
  const db = new Database(DB, { readonly: true });
  const inst = await DuckDBInstance.create();
  const con = await inst.connect();
  // shared 1-min OHLC bar cache per (symbol, day) — used by the empirical null and 2.2
  type Bar = { t: number; h: number; l: number; c: number };
  const barsCache = new Map<string, { bars: Bar[]; idx: Map<number, number> }>();
  async function barsFor(sym: string, day: string): Promise<{ bars: Bar[]; idx: Map<number, number> } | null> {
    const key = `${sym}|${day}`;
    if (barsCache.has(key)) return barsCache.get(key)!;
    try {
      const src = `read_parquet('${ROOT}/mbo-parquet/trades/symbol=${sym}/date=${day}/*.parquet')`;
      const dom = `(SELECT contract FROM ${src} WHERE ts_ms >= ${et(day, '09:30')} AND ts_ms < ${et(day, '16:00')} GROUP BY contract ORDER BY SUM(size) DESC LIMIT 1)`;
      const bars = (await con.streamAndReadAll(`SELECT CAST(FLOOR(ts_ms/60000) AS BIGINT)*60000 t, MAX(price) h, MIN(price) l, LAST(price ORDER BY ts_ms) c
        FROM ${src} WHERE contract = ${dom} AND size > 0 AND NOT is_otc AND ts_ms >= ${et(day, '09:30')} AND ts_ms < ${et(day, '16:05')}
        GROUP BY 1 ORDER BY 1`)).getRows().map((r: any) => ({ t: Number(r[0]), h: Number(r[1]), l: Number(r[2]), c: Number(r[3]) }));
      const entry = { bars, idx: new Map(bars.map((b: Bar, i: number) => [b.t, i])) };
      barsCache.set(key, entry);
      return entry;
    } catch { return null; }
  }
  console.log('=== P2.1 PIPELINE SELF-TEST (placebo-random gates; shifted/round reported) ===');

  // ── A. markout self-test ──
  console.log('\n-- 2.1A markout: drift-adjusted weighted mean at placebo-random ≈ 0 --');
  let mkIn95 = 0, mkIn99 = 0, mkCells = 0;
  for (const sym of SYMS) {
    const vs = loadVisits(db, sym, 'placebo-random');
    for (const h of HORIZONS) {
      const rows = vs.filter((v) => v.mo[h] != null).map((v) => ({ day: v.day, x: (v.mo[h]! - v.drift * h), w: v.uniq }));
      const byDay = new Map<string, typeof rows>();
      for (const r of rows) { if (!byDay.has(r.day)) byDay.set(r.day, []); byDay.get(r.day)!.push(r); }
      const wmean = (rs: typeof rows) => { let sw = 0, sx = 0; for (const r of rs) { sw += r.w; sx += r.w * r.x; } return sw > 0 ? sx / sw : NaN; };
      const bt = dayBootstrap(byDay, wmean, 42 + h + (sym === 'ES' ? 1000 : 0));
      const in95 = bt.ci95[0] <= 0 && 0 <= bt.ci95[1], in99 = bt.ci99[0] <= 0 && 0 <= bt.ci99[1];
      mkCells++; if (in95) mkIn95++; if (in99) mkIn99++;
      console.log(`  ${sym} m̃(${String(h).padStart(2)}m): ${bt.est >= 0 ? '+' : ''}${bt.est.toFixed(3)}pt  CI95 [${bt.ci95[0].toFixed(3)}, ${bt.ci95[1].toFixed(3)}] ${in95 ? '∋0' : in99 ? '∋0@99' : 'EXCLUDES 0'}  (n=${rows.length})`);
    }
  }
  check('2.1A gate: all 8 cells ∋0 @99%, ≥7/8 @95%', mkIn99 === mkCells && mkIn95 >= mkCells - 1, `${mkIn95}/${mkCells} @95, ${mkIn99}/${mkCells} @99`);

  // ── B. barrier bookkeeping gate: independent label re-derivation ──
  console.log('\n-- 2.1B barrier bookkeeping: stored labels vs independent re-derivation from bars --');
  let cmp = 0, mismatch = 0, entryMis = 0;
  for (const sym of SYMS) {
    const vs = loadVisits(db, sym, 'placebo-random');
    for (const v of vs) {
      const bb = await barsFor(sym, v.day);
      if (!bb) continue;
      const m0 = Math.floor(v.closeTs / 60_000) * 60_000;
      const bi = bb.idx.get(m0);
      if (bi == null) continue;
      if (Math.abs(bb.bars[bi]!.c - v.entryPx) > 1e-9) entryMis++;
      for (const R of R_GRID) {
        const k = keyOf(R);
        const rl = marchBars(bb.bars, bb.idx, m0, 1, v.oneRL, R, v.vertL);
        const rs = marchBars(bb.bars, bb.idx, m0, -1, v.oneRS, R, v.vertS);
        if (rl) { cmp++; if (rl !== v.bl[k]) mismatch++; }
        if (rs) { cmp++; if (rs !== v.bs[k]) mismatch++; }
      }
    }
  }
  check('2.1B gate: 100% of stored barrier labels re-derived identically', mismatch === 0 && entryMis === 0 && cmp > 5000,
    `${cmp} labels compared, ${mismatch} mismatches, ${entryMis} entry_px mismatches`);

  // ── visit-mechanics continuation baseline (2.2, descriptive — see header) ──
  console.log('\n-- 2.2 visit-mechanics continuation: placebo-visit W-rate minus random-time paired null (real path) --');
  for (const sym of SYMS) {
    let vs = loadVisits(db, sym, 'placebo-random');
    const rnd = lcg(7 + (sym === 'ES' ? 1 : 0));
    for (const v of vs) {
      const bb = await barsFor(sym, v.day);
      if (bb) empiricalNull(v, v.closeTs, bb.bars, bb.idx, rnd); else v.simW = undefined;
    }
    vs = vs.filter((v) => v.simW && Object.values(v.simW).every((x) => isFinite(x)));
    const byDay = new Map<string, Visit[]>();
    for (const v of vs) { if (!byDay.has(v.day)) byDay.set(v.day, []); byDay.get(v.day)!.push(v); }
    for (const dir of ['L', 'S'] as const) {
      for (const R of R_GRID) {
        const k = keyOf(R);
        const diffStat = (rows: Visit[]) => {
          let obs = 0, prd = 0, n = 0;
          for (const r of rows) {
            const lab = dir === 'L' ? r.bl[k] : r.bs[k];
            if (!lab) continue;
            obs += lab === 'W' ? 1 : 0; prd += r.simW![`${dir}${k}`]!; n++;
          }
          return n ? (obs - prd) / n : NaN;
        };
        const bt = dayBootstrap(byDay, diffStat, 99 + R * 10 + (dir === 'S' ? 7 : 0) + (sym === 'ES' ? 3000 : 0));
        console.log(`  ${sym} ${dir}@${R}R: continuation ${bt.est >= 0 ? '+' : ''}${(100 * bt.est).toFixed(1)}pp  CI95 [${(100 * bt.ci95[0]).toFixed(1)}, ${(100 * bt.ci95[1]).toFixed(1)}]`);
      }
    }
  }

  // non-gating: shifted + round markout means (reported)
  console.log('\n-- non-gating: other null sources, drift-adjusted m̃(15m) --');
  for (const sym of SYMS) for (const src of ['placebo-shifted', 'round']) {
    const vs = loadVisits(db, sym, src).filter((v) => v.mo[15] != null);
    let sw = 0, sx = 0; for (const v of vs) { sw += v.uniq; sx += v.uniq * (v.mo[15]! - v.drift * 15); }
    console.log(`  ${sym} ${src.padEnd(16)} m̃(15m) ${sw ? (sx / sw >= 0 ? '+' : '') + (sx / sw).toFixed(3) : '—'}pt (n=${vs.length})`);
  }

  // ── 2.2 baselines ──
  console.log('\n=== P2.2 BASELINES ===\n-- hold rates with day-block bootstrap CI95 --');
  for (const sym of SYMS) {
    const rows = db.prepare(`SELECT trading_day day, source, held FROM visit_features WHERE symbol = ?`).all(sym) as any[];
    const srcs = [...new Set(rows.map((r) => r.source))].sort();
    for (const src of srcs) {
      const rs = rows.filter((r) => r.source === src);
      const byDay = new Map<string, any[]>();
      for (const r of rs) { if (!byDay.has(r.day)) byDay.set(r.day, []); byDay.get(r.day)!.push(r); }
      const bt = dayBootstrap(byDay, (xs) => xs.reduce((a, x) => a + x.held, 0) / xs.length, 555);
      console.log(`  ${sym} ${src.padEnd(16)} hold ${bt.est.toFixed(3)}  CI95 [${bt.ci95[0].toFixed(3)}, ${bt.ci95[1].toFixed(3)}]  (n=${rs.length})`);
    }
  }

  console.log('\n-- markout at 200 seeded random RTH minutes/day (the "nothing" yardstick) --');
  for (const sym of SYMS) {
    const days = (db.prepare(`SELECT DISTINCT trading_day d FROM visit_features WHERE symbol = ?`).all(sym) as any[]).map((r) => r.d);
    const per: Record<number, number[]> = { 1: [], 5: [], 15: [], 30: [] };
    for (const d of days) {
      const bb = await barsFor(sym, d);
      if (!bb) continue;
      const idx = new Map(bb.bars.map((b) => [b.t, b.c]));
      const drift = (db.prepare(`SELECT drift_pt_min v FROM day_context WHERE symbol=? AND trading_day=?`).get(sym, d) as any)?.v ?? 0;
      const rnd = lcg(hash(`${sym}${d}`));
      for (let i = 0; i < 200; i++) {
        const m0 = et(d, '09:35') + Math.floor(rnd() * 350) * 60_000;   // 09:35–15:25
        const c0 = idx.get(m0);
        if (c0 == null) continue;
        for (const h of HORIZONS) { const c1 = idx.get(m0 + h * 60_000); if (c1 != null) per[h]!.push(c1 - c0 - drift * h); }
      }
    }
    for (const h of HORIZONS) {
      const xs = per[h]!.sort((a, b2) => a - b2);
      const sd = Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / xs.length - (xs.reduce((a, x) => a + x, 0) / xs.length) ** 2);
      const q = (p: number) => xs[Math.floor(p * xs.length)]!;
      console.log(`  ${sym} m̃(${String(h).padStart(2)}m): sd ${sd.toFixed(2)}pt  p10/50/90 ${q(0.1).toFixed(2)}/${q(0.5).toFixed(2)}/${q(0.9).toFixed(2)}  (n=${xs.length})`);
    }
  }

  db.close();
  console.log(`\n=== GATE 2.1: ${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail ? 1 : 0);
}
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
main().catch((e) => { console.error(e); process.exit(1); });
