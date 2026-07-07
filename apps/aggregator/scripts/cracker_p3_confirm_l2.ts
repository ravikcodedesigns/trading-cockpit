// CRACKER P3 — confirmation pass for forward-registered hypotheses on the
// INDEPENDENT L2 segment (days strictly before 2026-06-16 — zero overlap with
// the L3-mini discovery days that generated the hypotheses).
//
// REGISTERED FAMILY (frozen in the ledger BEFORE the L2 build completed):
//   F4b (NQ): IC(absorb_ratio, y(1m)) < 0 — high contact absorption predicts
//             1-minute continuation INTO the level. One-sided.
//   F5b (NQ): IC_twin(d*/ct_vol, 5m) − IC_real(d*/ct_vol, 5m) > 0 — generic
//             flow-continuation exists at placebo prices and is NEUTRALIZED at
//             real structure. One-sided.
//   MULTIPLICITY (frozen): Benjamini-Hochberg FDR q = 0.10 across the family.
//   ES reported descriptively (hypotheses were NQ-born; ES is not in the family).
//   One-sided p from the day-block bootstrap distribution (B = 4000): mass on
//   the wrong side of 0. CONFIRMED = BH-rejected at q=0.10 with declared sign.
//   Attenuation note: both hypotheses are L3-mini-born, tested on micro data —
//   P0.4 says true mini effects appear shrunk (×0.8 NQ), so confirmation here
//   is CONSERVATIVE for effect size; sign+significance is the claim.
//
// Run: TRACE_DB=data/cracker-trace-l2.db pnpm --filter @trading/aggregator exec tsx scripts/cracker_p3_confirm_l2.ts
import {
  loadVisits, weightedSpearman, lcg, PLACEBO_POOL, type VisitRow,
} from './cracker_p3_harness.js';

const CUTOFF = '2026-06-16';
const REAL = ['swing', 'hvn', 'lvn', 'round'];
const B = 4000;
const Q_FDR = 0.10;

function ic(rows: VisitRow[], pool: string[], h: number, value: (r: VisitRow) => number | null): number {
  const x: number[] = [], y: number[] = [], w: number[] = [];
  for (const r of rows) {
    const v = value(r);
    if (!pool.includes(r.source) || v == null || !isFinite(v) || r.y[h] == null) continue;
    x.push(v); y.push(r.y[h]!); w.push(r.uniq);
  }
  return x.length >= 30 ? weightedSpearman(x, y, w) : NaN;
}

/** Day-block bootstrap returning the full distribution (for one-sided p). */
function bootVals(rows: VisitRow[], stat: (rs: VisitRow[]) => number, seed: number): { est: number; vals: number[] } {
  const byDay = new Map<string, VisitRow[]>();
  for (const r of rows) { if (!byDay.has(r.day)) byDay.set(r.day, []); byDay.get(r.day)!.push(r); }
  const days = [...byDay.keys()].sort();
  const est = stat(rows);
  const rnd = lcg(90210);
  void seed;
  const vals: number[] = [];
  for (let b = 0; b < B; b++) {
    const rs: VisitRow[] = [];
    for (let i = 0; i < days.length; i++) rs.push(...byDay.get(days[Math.floor(rnd() * days.length)]!)!);
    const v = stat(rs);
    if (isFinite(v)) vals.push(v);
  }
  return { est, vals };
}

const pOneSided = (vals: number[], declaredSign: 1 | -1): number => {
  const wrong = vals.filter((v) => (declaredSign < 0 ? v >= 0 : v <= 0)).length;
  return Math.max(wrong / vals.length, 1 / vals.length);   // floor at bootstrap resolution
};

function main() {
  console.log(`=== P3 CONFIRMATION — registered hypotheses on independent L2 days < ${CUTOFF} ===`);
  const dStar = (r: VisitRow) => (r.side === 'support' ? r.ctDelta : -r.ctDelta);
  const dFrac = (r: VisitRow) => (r.ctVol > 0 ? dStar(r) / r.ctVol : null);
  const absorb = (r: VisitRow) => r.absorbRatio;

  const results: { name: string; est: number; p: number; sign: 1 | -1; detail: string }[] = [];
  for (const sym of ['NQ', 'ES']) {
    const { rows } = loadVisits(sym);
    const pre = rows.filter((r) => r.day < CUTOFF);
    const days = new Set(pre.map((r) => r.day)).size;
    const inFamily = sym === 'NQ';

    // F4b: IC(absorb, 1m) < 0
    const f4 = bootVals(pre, (rs) => ic(rs, REAL, 1, absorb), 1);
    const f4twin = ic(pre, PLACEBO_POOL, 1, absorb);
    const p4 = pOneSided(f4.vals, -1);
    const s4 = [...f4.vals].sort((a, b) => a - b);
    const ci4 = [s4[Math.floor(0.025 * s4.length)]!, s4[Math.floor(0.975 * s4.length)]!];
    console.log(`\n${sym} (${days}d, n=${pre.filter((r) => REAL.includes(r.source)).length} real visits)${inFamily ? '' : '  [descriptive — not in BH family]'}`);
    console.log(`  F4b IC(absorb,1m): ${f4.est.toFixed(3)} CI95 [${ci4[0].toFixed(3)}, ${ci4[1].toFixed(3)}]  twin ${f4twin.toFixed(3)}  one-sided p=${p4.toFixed(4)} (declared <0)`);
    if (inFamily) results.push({ name: 'F4b', est: f4.est, p: p4, sign: -1, detail: `IC ${f4.est.toFixed(3)}, twin ${f4twin.toFixed(3)}` });

    // F5b: IC_twin(dfrac,5m) − IC_real(dfrac,5m) > 0
    const f5 = bootVals(pre, (rs) => ic(rs, PLACEBO_POOL, 5, dFrac) - ic(rs, REAL, 5, dFrac), 2);
    const p5 = pOneSided(f5.vals, 1);
    const s5 = [...f5.vals].sort((a, b) => a - b);
    const ci5 = [s5[Math.floor(0.025 * s5.length)]!, s5[Math.floor(0.975 * s5.length)]!];
    const twinIc = ic(pre, PLACEBO_POOL, 5, dFrac), realIc = ic(pre, REAL, 5, dFrac);
    console.log(`  F5b twin−real IC(dfrac,5m): ${f5.est.toFixed(3)} CI95 [${ci5[0].toFixed(3)}, ${ci5[1].toFixed(3)}]  (twin ${twinIc.toFixed(3)}, real ${realIc.toFixed(3)})  one-sided p=${p5.toFixed(4)} (declared >0)`);
    if (inFamily) results.push({ name: 'F5b', est: f5.est, p: p5, sign: 1, detail: `Δ ${f5.est.toFixed(3)} (twin ${twinIc.toFixed(3)} vs real ${realIc.toFixed(3)})` });
  }

  // BH-FDR across the registered family
  console.log(`\n— Benjamini-Hochberg FDR q=${Q_FDR} across the registered family (m=${results.length}) —`);
  const sorted = [...results].sort((a, b) => a.p - b.p);
  let kMax = 0;
  sorted.forEach((r, i) => { if (r.p <= (Q_FDR * (i + 1)) / sorted.length) kMax = i + 1; });
  sorted.forEach((r, i) => {
    const rejected = i < kMax;
    const signOk = Math.sign(r.est) === r.sign;
    console.log(`  ${r.name}: p=${r.p.toFixed(4)} (rank ${i + 1}, threshold ${((Q_FDR * (i + 1)) / sorted.length).toFixed(4)}) → ${rejected && signOk ? '★ CONFIRMED' : rejected && !signOk ? 'REJECTED (wrong sign)' : 'NOT CONFIRMED'}  [${r.detail}]`);
  });
}
main();
