// CRACKER P1.4 — context columns: unit acceptance + BACKFILL over the existing trace.
//
// The context pass (trace.ts resolveContext) needs no book replay — it reads
// visit_features rows and joins 1-min closes of our own NQ/ES feeds + the cached
// quantdata NDX morning IV. This script:
//   A. unit-tests the frozen definitions (todPhase boundaries, commonFactor math,
//      causality: only bars ≤ the visit-close minute are consulted);
//   B. backfills every day present in visit_features (idempotent);
//   C. integration assertions + QA distributions.
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cracker_p14_context.ts
import 'dotenv/config';
import { DuckDBInstance } from '@duckdb/node-api';
import Database from 'better-sqlite3';
import { todPhase, commonFactor, resolveContext, type CtxBar } from '../src/l3/trace.js';
import { getVolDrift } from '../src/sources/quantdata-store.js';

const ROOT = '/Users/ravikumarbasker/trading-cockpit/data';
const DB = process.env.TRACE_DB ?? `${ROOT}/cracker-trace.db`;
const et = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-04:00`);

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

// ── A. units ──────────────────────────────────────────────────────────────────
console.log('=== P1.4 ACCEPTANCE — context columns ===\n-- units --');
const D = '2026-07-01';
check('A1 todPhase boundaries', todPhase(et(D, '09:30'), D) === 'open' && todPhase(et(D, '10:29'), D) === 'open'
  && todPhase(et(D, '10:30'), D) === 'mid' && todPhase(et(D, '14:29'), D) === 'mid'
  && todPhase(et(D, '14:30'), D) === 'close' && todPhase(et(D, '16:00'), D) === 'close');

const M = 60_000;
const mkBars = (t0: number, closes: number[]): Map<number, number> => new Map(closes.map((c, i) => [t0 + i * M, c]));
{
  // 36 minutes of bars; evaluate at minute 35 (index 35). Perfect co-movement → agree=1.
  const t0 = et(D, '10:00');
  const up = Array.from({ length: 36 }, (_, i) => 100 * Math.exp(0.001 * i));
  const dn = Array.from({ length: 36 }, (_, i) => 100 * Math.exp(-0.001 * i));
  const at = t0 + 35 * M;
  const a = commonFactor(mkBars(t0, up), mkBars(t0, up), at);
  const b = commonFactor(mkBars(t0, up), mkBars(t0, dn), at);
  check('A2 sign agreement: co-moving → 1, anti-moving → 0', a.agree === 1 && b.agree === 0);
  // rs: NQ +3.5% over 30m (0.1%/min), ES −3.5%-ish → rs ≈ (0.03 − (−0.03))·1e4 = 600bp
  const rsExp = (Math.log(up[35]! / up[5]!) - Math.log(dn[35]! / dn[5]!)) * 1e4;
  check('A3 rs_30m_bp exact', Math.abs(b.rsBp! - rsExp) < 1e-9, `${b.rsBp?.toFixed(1)}bp`);
  // thin data: <4 valid pairs → null agree
  const sparse = new Map([...mkBars(t0, up)].filter((_, i) => i > 25));
  check('A4 <4 valid pairs → agree null', commonFactor(sparse, mkBars(t0, up), at).agree === null);
  // causality: bars strictly after the minute must not change the result
  const withFuture = mkBars(t0, [...up, ...Array.from({ length: 10 }, () => 50)]);
  const c1 = commonFactor(mkBars(t0, up), mkBars(t0, up), at), c2 = commonFactor(withFuture, mkBars(t0, up), at);
  check('A5 causality: future bars do not alter the window', c1.agree === c2.agree && c1.rsBp === c2.rsBp);
  // flat (zero) returns are excluded from agreement pairs
  const flat = mkBars(t0, Array.from({ length: 36 }, () => 100));
  check('A6 zero returns excluded → agree null on flat tape', commonFactor(flat, mkBars(t0, up), at).agree === null);
}

// ── B. backfill ───────────────────────────────────────────────────────────────
console.log('\n-- backfill --');
async function bars(con: any, day: string, sym: string): Promise<CtxBar[]> {
  try {
    const src = `read_parquet('${ROOT}/mbo-parquet/trades/symbol=${sym}/date=${day}/*.parquet')`;
    const dom = `(SELECT contract FROM ${src} WHERE ts_ms >= ${et(day, '09:30')} AND ts_ms < ${et(day, '16:00')} GROUP BY contract ORDER BY SUM(size) DESC LIMIT 1)`;
    return (await con.streamAndReadAll(`SELECT CAST(FLOOR(ts_ms / 60000) AS BIGINT) * 60000 t, LAST(price ORDER BY ts_ms) c
      FROM ${src} WHERE contract = ${dom} AND size > 0 AND NOT is_otc AND ts_ms >= ${et(day, '08:55')} AND ts_ms < ${et(day, '16:05')}
      GROUP BY 1 ORDER BY 1`)).getRows().map((r: any) => ({ t: Number(r[0]), c: Number(r[1]) }));
  } catch { return []; }
}
async function iv(day: string): Promise<number | null> {
  try {
    const vd = await getVolDrift('NDX', day);
    const pts = vd.filter((x) => x.epoch_ms >= et(day, '09:30') && x.epoch_ms < et(day, '10:00') && Number.isFinite(x.iv)).map((x) => x.iv);
    return pts.length >= 5 ? pts.reduce((a, b) => a + b, 0) / pts.length : null;
  } catch { return null; }
}

async function main() {
  const db = new Database(DB);
  // union with day_context: a day can have 0 visits yet still own a day row
  // whose morning_iv must be filled (e.g. 07-06 partial-capture)
  const days = (db.prepare(`SELECT DISTINCT trading_day d, symbol s FROM
    (SELECT trading_day, symbol FROM visit_features UNION SELECT trading_day, symbol FROM day_context) ORDER BY 1`).all() as any[]);
  const inst = await DuckDBInstance.create();
  const con = await inst.connect();
  let total = 0;
  for (const { d, s } of days) {
    const n = resolveContext(db, s, d, await bars(con, d, s), await bars(con, d, 'ES'), await iv(d));
    total += n;
    process.stderr.write(`  ${d} → ${n} context rows\n`);
  }

  // ── C. integration ──
  console.log('\n-- integration --');
  const vf = (db.prepare(`SELECT COUNT(*) n FROM visit_features`).get() as any).n;
  const vc = (db.prepare(`SELECT COUNT(*) n FROM visit_context`).get() as any).n;
  check('C1 one context row per visit', vc === vf && total === vf, `${vc}/${vf}`);
  // idempotency: re-run one day → counts unchanged
  const d0 = days[days.length - 1]!;
  resolveContext(db, d0.s, d0.d, await bars(con, d0.d, d0.s), await bars(con, d0.d, 'ES'), await iv(d0.d));
  const vc2 = (db.prepare(`SELECT COUNT(*) n FROM visit_context`).get() as any).n;
  check('C2 idempotent re-run', vc2 === vc, `${vc}→${vc2}`);
  const q = db.prepare(`SELECT ROUND(AVG(es_agree),3) ea, 100.0*SUM(es_agree IS NULL)/COUNT(*) ean,
    ROUND(AVG(rs_30m_bp),1) rs, 100.0*SUM(rs_30m_bp IS NULL)/COUNT(*) rsn FROM visit_context`).get() as any;
  check('C3 es_agree populated (>90%) and in (0.5, 1) — correlated indices', q.ean < 10 && q.ea > 0.5 && q.ea < 1, `avg ${q.ea}, null ${q.ean.toFixed(1)}%`);
  check('C4 rs_30m populated (>90%), |avg| < 20bp', q.rsn < 10 && Math.abs(q.rs) < 20, `avg ${q.rs}bp, null ${q.rsn.toFixed(1)}%`);
  const ph = db.prepare(`SELECT tod_phase, COUNT(*) n FROM visit_context GROUP BY tod_phase`).all() as any[];
  const phm = new Map(ph.map((p: any) => [p.tod_phase, p.n]));
  check('C5 all three phases present, mid largest', (phm.get('mid') ?? 0) > (phm.get('open') ?? 0) && (phm.get('close') ?? 0) > 0,
    ph.map((p: any) => `${p.tod_phase}:${p.n}`).join(' '));
  // morning_iv must exist on every session the vendor can price (uncovered days
  // are FETCHED via dotenv + qdCached, so a null here means a real gap, not a
  // lazy fallback). Enumerated no-IV sessions, each with a verified cause:
  //   2026-06-19 — Juneteenth, options markets closed
  //   2026-07-03 — July-4th half-day; vendor 422 "data unavailable" (verified 2026-07-07)
  const NO_IV_SESSIONS = new Set(['2026-06-19', '2026-07-03']);
  const ivRows = db.prepare(`SELECT trading_day d, morning_iv v FROM day_context`).all() as any[];
  const badNull = ivRows.filter((r) => r.v == null && !NO_IV_SESSIONS.has(r.d)).map((r) => r.d);
  const ivVals = ivRows.map((r) => r.v).filter((v) => v != null);
  check('C6 morning_iv on every open-market day, sane IV% range (5–100)',
    badNull.length === 0 && Math.min(...ivVals) > 5 && Math.max(...ivVals) < 100,
    badNull.length ? `missing: ${badNull.join(', ')}` : `${ivVals.length}/${ivRows.length} days, IV ${Math.min(...ivVals).toFixed(1)}–${Math.max(...ivVals).toFixed(1)}`);
  db.close();
  console.log(`\n${pass}/${pass + fail} checks passed${fail ? ' — FAILURES ABOVE' : ''}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
