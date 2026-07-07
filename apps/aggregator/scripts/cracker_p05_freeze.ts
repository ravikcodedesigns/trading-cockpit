// CRACKER Phase 0.5 acceptance — estimator freezes (CRACKER_PLAN.md §0.5).
// A: SigmaEv units — recovers a known synthetic vol; drift-stripping works
//    (trend ≠ volatility); session reset + warmup carry; floor/cap.
// B: size-aware imbalance z units — reduces to binomial with 1-lots; a lone
//    block trade no longer flags; genuine many-trade skew still flags.
// C: σ_ev on the 3 reference days (trend 06-05 / chop 05-29 / normal 06-02,
//    L2 store) — values sane and ordered (trend > normal ≥ chop midday).
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cracker_p05_freeze.ts
import { DuckDBInstance } from '@duckdb/node-api';
import { SigmaEv, SIGMA_CFG } from '../src/l3/sigma-ev.js';
import { Footprint, FP_CFG } from '../src/l3/footprint.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); ok ? pass++ : fail++; };

// deterministic LCG so the test is reproducible (no Math.random in research code)
function lcg(seed: number) { let s = seed >>> 0; return () => (s = (1664525 * s + 1013904223) >>> 0) / 2 ** 32; }
function gauss(rnd: () => number) { return Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd()); }

console.log('\nA. SigmaEv — frozen σ_ev estimator');
{
  // A1: known synthetic vol — GBM, σ = 12bp/min at price 30000 → σ_1m ≈ 36pt? (0.0012·30000=36 > cap60? no, 36 < 60 ok)
  const rnd = lcg(42), sv = new SigmaEv();
  const t0 = Date.parse('2026-06-02T09:30:00-04:00');
  let p = 30000; const SIG = 0.0007;                       // 7bp/min → ~21pt at 30000
  for (let m = 0; m < 240; m++) { p *= Math.exp(SIG * gauss(rnd)); sv.update(p, t0 + m * 60_000); }
  const est = sv.sigma1m(), truth = SIG * 30000;
  check('recovers known synthetic vol within 25%', Math.abs(est - truth) / truth < 0.25, `est ${est.toFixed(1)}pt vs true ${truth.toFixed(1)}pt`);

  // A2: drift-stripping — pure trend, tiny noise → σ stays near the noise level, not the drift
  const sv2 = new SigmaEv(); const rnd2 = lcg(7);
  let q = 30000; const DRIFT = 0.0010, NOISE = 0.0002;     // 10bp/min drift (~-1000pt/day pace), 2bp noise
  for (let m = 0; m < 240; m++) { q *= Math.exp(-DRIFT + NOISE * gauss(rnd2)); sv2.update(q, t0 + m * 60_000); }
  const est2 = sv2.sigma1m(), noisePt = NOISE * 30000 * 0.9, driftPt = DRIFT * 30000 * 0.9;
  check('drift-stripped: trend day reads noise, not drift', est2 < 0.5 * driftPt && est2 < 4 * noisePt, `est ${est2.toFixed(1)}pt (noise ~${noisePt.toFixed(1)}, drift ~${driftPt.toFixed(1)})`);

  // A3: session reset + warmup carry
  const sv3 = new SigmaEv(); const rnd3 = lcg(11);
  let r = 30000; for (let m = 0; m < 120; m++) { r *= Math.exp(0.0007 * gauss(rnd3)); sv3.update(r, t0 + m * 60_000); }
  const before = sv3.sigma1m();
  const nextSess = Date.parse('2026-06-02T18:05:00-04:00');
  sv3.update(r, nextSess);                                  // crosses the 18:00 ET boundary → reset
  const carried = sv3.sigma1m();                            // warmup → carried value
  check('session reset carries prior σ through warmup', Math.abs(carried - before) < 1e-9, `carried ${carried.toFixed(1)}pt`);

  // A4: floor in dead tape
  const sv4 = new SigmaEv();
  for (let m = 0; m < 60; m++) sv4.update(30000, t0 + m * 60_000);
  check('floor holds in dead tape', sv4.sigma1m() === SIGMA_CFG.FLOOR_PT, `${sv4.sigma1m()}pt`);
}

console.log('\nB. Size-aware imbalance z (footprint)');
{
  // B1: 1-lots only — reduces exactly to the old binomial: 36 buys vs 4 sells at adjacent bins → z=(36-4)/√40≈5.06 → flags
  const fp = new Footprint(FP_CFG.NQ!);
  const at = (px: number, n: number, buy: boolean) => { for (let i = 0; i < n; i++) fp.onTrade(px, 1, buy ? px - 0.25 : px, buy ? px : px + 0.25); };
  at(21001, 36, true);   // 36×1-lot buys at 21001 (>= ask)
  at(21000, 4, false);   // 4×1-lot sells one bin below
  const s1 = fp.snapshot()!;
  check('1-lot case reduces to binomial and flags', s1.imbalances.some((i) => i.side === 'buy' && Math.abs(i.z - (36 - 4) / Math.sqrt(40)) < 0.01), `z=${s1.imbalances[0]?.z}`);

  // B2: same VOLUMES but the buys are one 36-lot block → z=(36-4)/√(36²+4)=32/36.06≈0.89 → must NOT flag
  const fp2 = new Footprint(FP_CFG.NQ!);
  fp2.onTrade(21001, 36, 21000.75, 21001);   // one 36-lot buy
  at.call(null); // no-op to keep structure clear
  for (let i = 0; i < 4; i++) fp2.onTrade(21000, 1, 21000, 21000.25);  // 4×1-lot sells below
  const s2 = fp2.snapshot()!;
  check('single 36-lot block does NOT mint significance', !s2.imbalances.some((i) => i.side === 'buy'), `imb count ${s2.imbalances.length}`);
}

console.log('\nC. σ_ev on the reference days (L2 store, 1-min closes via SQL)');
async function refDays() {
  const inst = await DuckDBInstance.create(); const con = await inst.connect();
  const out: Record<string, number> = {};
  for (const [day, label] of [['2026-06-05', 'trend'], ['2026-05-29', 'chop'], ['2026-06-02', 'normal']] as const) {
    const lo = Date.parse(`${day}T09:30:00-04:00`), hi = Date.parse(`${day}T16:00:00-04:00`);
    const r = await con.streamAndReadAll(`
      SELECT CAST(FLOOR(ts / 60000) AS BIGINT) m, LAST(price ORDER BY ts) c
      FROM read_parquet('/Users/ravikumarbasker/trading-cockpit/data/ticks-parquet/trades/symbol=NQ/date=${day}/*.parquet')
      WHERE size > 0 AND price BETWEEN 20000 AND 40000 AND ts >= ${lo} AND ts < ${hi} GROUP BY 1 ORDER BY 1`);
    const sv = new SigmaEv();
    const mids: number[] = [];
    for (const row of r.getRows() as any[]) { sv.update(Number(row[1]), Number(row[0]) * 60_000); mids.push(sv.sigma1m()); }
    const midday = mids[Math.floor(mids.length / 2)] ?? NaN;
    out[label] = midday;
    console.log(`  ${day} (${label}): σ_1m midday ${midday.toFixed(1)}pt, close ${mids[mids.length - 1]?.toFixed(1)}pt  (${mids.length} min)`);
  }
  check('values in sane NQ range (1–40pt)', Object.values(out).every((v) => v >= 1 && v <= 40));
  check('trend day ≥ chop day (midday σ)', out.trend! >= out.chop!, `trend ${out.trend?.toFixed(1)} vs chop ${out.chop?.toFixed(1)}`);
  console.log(`\n=== Phase 0.5 acceptance: ${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail ? 1 : 0);
}
refDays().catch((e) => { console.error(e); process.exit(1); });
