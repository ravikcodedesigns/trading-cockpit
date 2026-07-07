// CRACKER swap acceptance — trace-day diff: days rebuilt on MarketBook vs the
// production DB (legacy engine). EXPECTED, pre-registered decomposition:
//   (1) every science column identical byte-for-byte;
//   (2) interactions.absorbed_vol may INCREASE without bound (legacy ring
//       truncation repaired) and may DECREASE only within the volume traded in
//       the visit's OPEN/CLOSE boundary milliseconds (legacy re-counted trades
//       stamped in the open ms that had already executed before the open; the
//       cumulative read draws the causal line — verified empirically 2026-07-07:
//       180/189 decreases exact at the open ms, remainder = 1-lot close-ms
//       mirror). Anything outside this decomposition = swap bug, hard fail.
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cracker_swap_diff.ts
import { execFileSync } from 'node:child_process';
import { DuckDBInstance } from '@duckdb/node-api';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const ROOT = '/Users/ravikumarbasker/trading-cockpit/data';
const SCRATCH = process.env.CLAUDE_SCRATCH ?? '/Users/ravikumarbasker/.claude/jobs/6f21db17/tmp';
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); ok ? pass++ : fail++; };

// NOTE: single-day scratch rebuilds lack cross-day registry history, so we
// compare a day rebuilt in BOTH worlds identically: replay days 1..K into the
// scratch DB with the NEW engine and diff the LAST day's rows against
// production (which was built with the legacy engine over the same days).
const DAYS_K = '4';   // 06-16..06-19 (covers thin+normal)
const K_TICKS: Record<string, number> = { NQ: 16, ES: 4 };   // NEAR_TICKS (grid window, matches intFromPrice semantics)

async function run() {
  const inst = await DuckDBInstance.create();
  const con = await inst.connect();
  for (const sym of ['NQ', 'ES']) {
    const db = `${SCRATCH}/swapdiff-${sym}.db`;
    for (const sfx of ['', '-wal', '-shm']) fs.rmSync(db + sfx, { force: true });
    execFileSync('pnpm', ['exec', 'tsx', 'scripts/cracker_p1_trace.ts'], {
      cwd: '/Users/ravikumarbasker/trading-cockpit/apps/aggregator',
      env: { ...process.env, TRACE_DB: db, TRACE_DAYS: DAYS_K, TRACE_KEEP: '', TRACE_SYM: sym, TRACE_INCLUDE_TODAY: '' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const nu = new Database(db, { readonly: true });
    const prod = new Database(`${ROOT}/cracker-trace.db`, { readonly: true });
    const days = (nu.prepare(`SELECT DISTINCT trading_day d FROM visit_features WHERE symbol=? ORDER BY 1`).all(sym) as any[]).map((r) => r.d);
    const q = (d: Database.Database, t: string, cols: string, day: string) =>
      JSON.stringify(d.prepare(`SELECT ${cols} FROM ${t} WHERE symbol=? AND trading_day=? ORDER BY level_id, close_ts`).all(sym, day));
    let same = 0, diff = 0;
    for (const day of days) {
      const vfCols = 'level_id, close_ts, open_ts, source, kind, level_price, side, visit_index, held, band, sigma_ev, penetration, ap_delta, ap_vol, ct_delta, ct_vol, rs_delta, rs_vol, imb_n, absorb_ratio, confluence_n';
      if (q(nu, 'visit_features', vfCols, day) === q(prod, 'visit_features', vfCols, day)) same++; else diff++;
      const voCols = 'level_id, close_ts, entry_px, stop_1r_l, stop_1r_s, stop_src_l, stop_src_s, vert_l, vert_s, mo_1m, mo_5m, mo_15m, mo_30m, bl_1, bl_15, bl_2, bl_3, bs_1, bs_15, bs_2, bs_3, uniq_w, cluster_id';
      if (q(nu, 'visit_outcomes', voCols, day) === q(prod, 'visit_outcomes', voCols, day)) same++; else diff++;
      const iCols = 'level_id, ts_ms, source, kind, level_price, side, visit_index, held, taps, dwell_ms, penetration, lambda, ofi_net';
      const qi = (d: Database.Database) => JSON.stringify(d.prepare(`SELECT ${iCols} FROM interactions WHERE symbol=? AND trading_day=? ORDER BY level_id, ts_ms`).all(sym, day));
      if (qi(nu) === qi(prod)) same++; else diff++;
    }
    check(`${sym}: all science columns identical across ${days.length} days`, diff === 0, `${same} table-days same, ${diff} differ`);

    // absorbed_vol decomposition: increases unbounded; decreases ≤ open-ms + close-ms boundary volume
    const rows = nu.prepare(`
      SELECT i.level_id, i.ts_ms, i.trading_day day, vf.open_ts, i.level_price, i.absorbed_vol nu_abs
      FROM interactions i JOIN visit_features vf ON vf.level_id = i.level_id AND vf.close_ts = i.ts_ms AND vf.symbol = i.symbol
      WHERE i.symbol = ?`).all(sym) as any[];
    const prodMap = new Map((prod.prepare(`SELECT level_id, ts_ms, absorbed_vol FROM interactions WHERE symbol = ?`).all(sym) as any[])
      .map((r) => [`${r.level_id}|${r.ts_ms}`, r.absorbed_vol]));
    let up = 0, decOk = 0, decBad = 0;
    for (const r of rows) {
      const old = prodMap.get(`${r.level_id}|${r.ts_ms}`);
      if (old == null || r.nu_abs >= old) { if (old != null && r.nu_abs > old) up++; continue; }
      const dom = `(SELECT contract FROM read_parquet('${ROOT}/mbo-parquet/trades/symbol=${sym}/date=${r.day}/*.parquet') WHERE ts_ms >= ${Date.parse(r.day + 'T09:30:00-04:00')} AND ts_ms < ${Date.parse(r.day + 'T16:00:00-04:00')} GROUP BY contract ORDER BY SUM(size) DESC LIMIT 1)`;
      const bres = await con.streamAndReadAll(`SELECT COALESCE(SUM(size),0) FROM read_parquet('${ROOT}/mbo-parquet/trades/symbol=${sym}/date=${r.day}/*.parquet')
        WHERE contract = ${dom} AND size > 0 AND NOT is_otc AND ts_ms IN (${r.open_ts}, ${r.ts_ms}) AND ABS(ROUND(price/0.25) - ROUND(${r.level_price}/0.25)) <= ${K_TICKS[sym]}`);
      const boundary = Number(bres.getRows()[0]![0]);
      if (old - r.nu_abs <= boundary) decOk++; else decBad++;
    }
    check(`${sym}: absorbed_vol decomposition holds (↑ repair / ↓ ≤ boundary-ms volume)`, decBad === 0, `${up} increased, ${decOk} boundary-bounded decreases, ${decBad} UNEXPLAINED`);
    nu.close(); prod.close();
  }
}
await run();
console.log(`\n${pass}/${pass + fail} checks passed${fail ? ' — FAILURES ABOVE' : ''}`);
process.exit(fail ? 1 : 0);
