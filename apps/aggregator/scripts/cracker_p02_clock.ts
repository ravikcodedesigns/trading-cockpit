// CRACKER Phase 0.2 — clock alignment between the two feeds (CRACKER_PLAN.md §0.2).
//
// Question: do CQG (ticks-parquet, micro labeled NQ/ES) and Bookmap L3
// (mbo-parquet MNQ/MES) timestamps agree? Same instrument on both sides, so the
// same trades appear in both feeds — if the clocks agree, per-bin volume series
// line up at lag 0; if one feed stamps late, the correlation peaks at that lag.
//
// Method: per overlap day, bin RTH trade VOLUME into 50ms bins (volume, not event
// count — the feeds aggregate fills differently, but contracts traded must match).
// Pearson-correlate the two series at lags −3000..+3000ms, take the argmax, refine
// sub-bin by parabolic interpolation around the peak. Split morning/afternoon to
// measure intra-day drift. Sign convention: POSITIVE offset = Bookmap(L3) is LATE
// relative to CQG(L2) by that many ms.
//
// Acceptance (frozen): publish per-day offset + cross-day σ; STOP flag if
// intra-day |morning−afternoon| drift > 250ms on any day.
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cracker_p02_clock.ts
import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs';

const ROOT = '/Users/ravikumarbasker/trading-cockpit/data';
const BIN_MS = 50, MAX_LAG_MS = 3000, LAGS = MAX_LAG_MS / BIN_MS;   // ±60 lag steps
const EXCLUDE = new Set(['2026-06-29']);   // BMD-delayed day (memory: data_bmd_0629_excluded)
const PAIRS = [
  { name: 'MNQ', l2: `${ROOT}/ticks-parquet/trades/symbol=NQ`, l3: `${ROOT}/mbo-parquet/trades/symbol=MNQ` },
  { name: 'MES', l2: `${ROOT}/ticks-parquet/trades/symbol=ES`, l3: `${ROOT}/mbo-parquet/trades/symbol=MES` },
];
const et = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-04:00`);

function days(dir: string): Set<string> {
  if (!fs.existsSync(dir)) return new Set();
  return new Set(fs.readdirSync(dir).filter((x) => x.startsWith('date=')).map((x) => x.slice(5)));
}

/** Volume per BIN_MS bin over [lo, hi). `tsCol` differs per store (L2 `ts`,
 *  L3 `ts_ms`); L3 also tags rows by `contract` (front + back month both kept,
 *  per the multi-contract rule) — restrict to the day's dominant contract so
 *  back-month trickle doesn't blur the heartbeat. */
async function binSeries(con: any, glob: string, lo: number, hi: number, tsCol: string, byContract: boolean): Promise<Float64Array> {
  const n = Math.ceil((hi - lo) / BIN_MS);
  const out = new Float64Array(n);
  const dom = byContract
    ? `AND contract = (SELECT contract FROM read_parquet('${glob}/*.parquet') WHERE ${tsCol} >= ${lo} AND ${tsCol} < ${hi} GROUP BY contract ORDER BY SUM(size) DESC LIMIT 1)`
    : '';
  const r = await con.streamAndReadAll(
    `SELECT (${tsCol} - ${lo}) / ${BIN_MS} AS b, SUM(size) v FROM read_parquet('${glob}/*.parquet')
     WHERE ${tsCol} >= ${lo} AND ${tsCol} < ${hi} AND size > 0 ${dom} GROUP BY 1`,
  );
  for (const row of r.getRows() as any[]) { const b = Number(row[0]) | 0; if (b >= 0 && b < n) out[b] = Number(row[1]); }
  return out;
}

/** Pearson r of x vs y shifted by `lag` bins (y[i+lag] aligned to x[i]). */
function corrAtLag(x: Float64Array, y: Float64Array, lag: number): number {
  const n = x.length;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, m = 0;
  for (let i = Math.max(0, -lag); i < n && i + lag < n; i++) {
    const a = x[i]!, b = y[i + lag]!;
    sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b; m++;
  }
  const cov = sxy - (sx * sy) / m, vx = sxx - (sx * sx) / m, vy = syy - (sy * sy) / m;
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
}

/** argmax lag with parabolic sub-bin refinement → { offsetMs, peakR, runnerUpR } */
function bestLag(x: Float64Array, y: Float64Array): { offsetMs: number; peakR: number; runnerUpR: number } {
  const rs: number[] = [];
  for (let l = -LAGS; l <= LAGS; l++) rs.push(corrAtLag(x, y, l));
  let bi = 0;
  for (let i = 1; i < rs.length; i++) if (rs[i]! > rs[bi]!) bi = i;
  const peakR = rs[bi]!;
  const runnerUpR = Math.max(...rs.filter((_, i) => Math.abs(i - bi) > 2));
  // parabolic interpolation around the discrete peak for sub-bin resolution
  let frac = 0;
  if (bi > 0 && bi < rs.length - 1) {
    const a = rs[bi - 1]!, b = rs[bi]!, c = rs[bi + 1]!;
    const den = a - 2 * b + c;
    if (den < 0) frac = 0.5 * (a - c) / den;
  }
  return { offsetMs: ((bi - LAGS) + frac) * BIN_MS, peakR, runnerUpR };
}

async function main() {
  const inst = await DuckDBInstance.create();
  const con = await inst.connect();
  let stopFlag = false;

  for (const p of PAIRS) {
    const overlap = [...days(p.l2)].filter((d) => days(p.l3).has(d) && !EXCLUDE.has(d)).sort();
    console.log(`\n=== ${p.name}: L2(CQG) vs L3(Bookmap) — ${overlap.length} overlap days ===`);
    console.log(`day          offset(ms)  peakR   runnerUp   AM(ms)   PM(ms)   drift(ms)`);
    const offsets: number[] = [];
    for (const day of overlap) {
      const [lo, mid, hi] = [et(day, '09:30'), et(day, '12:30'), et(day, '16:00')];
      // sequential — concurrent queries on one DuckDB connection corrupt each other
      const x = await binSeries(con, `${p.l2}/date=${day}`, lo, hi, 'ts', false);
      const y = await binSeries(con, `${p.l3}/date=${day}`, lo, hi, 'ts_ms', true);
      const tot = x.reduce((s, v) => s + v, 0), tot2 = y.reduce((s, v) => s + v, 0);
      if (tot < 1000 || tot2 < 1000) { console.log(`${day}   (skipped — thin: L2 vol ${tot}, L3 vol ${tot2})`); continue; }
      const full = bestLag(x, y);
      const nAM = Math.ceil((mid - lo) / BIN_MS);
      const am = bestLag(x.slice(0, nAM), y.slice(0, nAM));
      const pm = bestLag(x.slice(nAM), y.slice(nAM));
      const drift = Math.abs(am.offsetMs - pm.offsetMs);
      if (drift > 250) stopFlag = true;
      offsets.push(full.offsetMs);
      console.log(`${day}   ${full.offsetMs.toFixed(1).padStart(8)}   ${full.peakR.toFixed(3)}   ${full.runnerUpR.toFixed(3)}    ${am.offsetMs.toFixed(0).padStart(6)}   ${pm.offsetMs.toFixed(0).padStart(6)}   ${drift.toFixed(0).padStart(6)}${drift > 250 ? '  ⚠ DRIFT' : ''}`);
    }
    if (offsets.length) {
      const mean = offsets.reduce((s, v) => s + v, 0) / offsets.length;
      const sd = Math.sqrt(offsets.reduce((s, v) => s + (v - mean) ** 2, 0) / offsets.length);
      console.log(`--- ${p.name}: mean offset ${mean.toFixed(1)}ms, cross-day σ ${sd.toFixed(1)}ms (n=${offsets.length})`);
    }
  }
  console.log(`\nVERDICT: ${stopFlag
    ? 'STOP-FLAG — intra-day drift >250ms detected: restrict L2↔L3 joins to coarse horizons (per CRACKER_PLAN §0.2).'
    : 'clocks usable — apply the mean offset as the correction constant for all L2↔L3 joins.'}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
