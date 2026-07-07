// CRACKER P3 · F2 — confluence count: do multi-source clusters out-predict lone levels?
//
// PRE-REGISTERED SPEC (frozen 2026-07-07, before first run):
//   Factor: confluence_n — distinct OTHER structural sources within ±5pt at
//           visit OPEN (built in P1.6; causal; self excluded).
//   Population: real-source visits (swing, hvn, lvn, round).
//   Twin:   identical computation on the placebo pool (random+shifted). This
//           twin is SHARP: a placebo sitting near real structure carries a
//           count too — if mere proximity-to-structure drives outcomes, the
//           twin shows it and the factor must BEAT it.
//   Tests:  (a) weighted Spearman IC of confluence_n vs y(h);
//           (b) binary contrast Δy(h) = wmean(y | n≥2 "stacked") − wmean(y | n=0 "lone").
//   Declared horizons: 5m, 15m. beatsTwin = twin validation CI contains 0 while
//           real excludes it, OR (both significant) paired diff CI excludes 0
//           under shared day-resamples.
//   Verdict per harness rules (EDGE / NULL / UNDERPOWERED).
//
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cracker_p3_f2_confluence.ts
import {
  loadVisits, splitDays, dayBoot, wmean, weightedSpearman, fmt, verdict, excl0,
  PLACEBO_POOL, HORIZONS, type VisitRow, type Boot,
} from './cracker_p3_harness.js';

const SYMS = ['NQ', 'ES'];
const REAL = ['swing', 'hvn', 'lvn', 'round'];
const DECLARED = [5, 15];

const icStat = (pool: string[], h: number) => (rs: VisitRow[]): number => {
  const x: number[] = [], y: number[] = [], w: number[] = [];
  for (const r of rs) {
    if (!pool.includes(r.source) || r.confluenceN == null || r.y[h] == null) continue;
    x.push(r.confluenceN); y.push(r.y[h]!); w.push(r.uniq);
  }
  return x.length >= 30 ? weightedSpearman(x, y, w) : NaN;
};

const splitStat = (pool: string[], h: number) => (rs: VisitRow[]): number => {
  const hi: { x: number; w: number }[] = [], lo: { x: number; w: number }[] = [];
  for (const r of rs) {
    if (!pool.includes(r.source) || r.confluenceN == null || r.y[h] == null) continue;
    if (r.confluenceN >= 2) hi.push({ x: r.y[h]!, w: r.uniq });
    else if (r.confluenceN === 0) lo.push({ x: r.y[h]!, w: r.uniq });
  }
  return hi.length && lo.length ? wmean(hi) - wmean(lo) : NaN;
};

function main() {
  console.log('=== P3 · F2 — confluence count (real visits; sharp placebo twin) ===');
  for (const sym of SYMS) {
    const { rows, days } = loadVisits(sym);
    const { train, valid } = splitDays(days);
    const tr = rows.filter((r) => train.has(r.day)), va = rows.filter((r) => valid.has(r.day));
    const nHi = (rs: VisitRow[]) => rs.filter((r) => REAL.includes(r.source) && (r.confluenceN ?? 0) >= 2).length;
    console.log(`\n## ${sym} — train ${train.size}d / valid ${valid.size}d · stacked(≥2) visits: train ${nHi(tr)}, valid ${nHi(va)}`);

    for (const h of HORIZONS) {
      const declared = DECLARED.includes(h);
      // (a) rank IC — real and twin, plus paired difference under shared resamples
      const icTr = dayBoot(tr, icStat(REAL, h), 500 + h);   bumpN(icTr, tr, REAL, h);
      const icVa = dayBoot(va, icStat(REAL, h), 600 + h);   bumpN(icVa, va, REAL, h);
      const twTr = dayBoot(tr, icStat(PLACEBO_POOL, h), 500 + h);
      const twVa = dayBoot(va, icStat(PLACEBO_POOL, h), 600 + h);
      const dfVa = dayBoot(va, (rs: VisitRow[]) => icStat(REAL, h)(rs) - icStat(PLACEBO_POOL, h)(rs), 600 + h);
      const beats = (excl0(icVa) && !excl0(twVa)) || (excl0(icVa) && excl0(twVa) && excl0(dfVa));
      const v = declared ? `  → IC verdict: ${verdict(sym, h, icTr, icVa, beats, 'ic')}` : '';
      console.log(`  IC(${String(h).padStart(2)}m): train ${fmt(icTr)} | valid ${fmt(icVa)} | twin-valid ${fmt(twVa)}${v}${declared ? ' [declared]' : ''}`);
      // (b) stacked-vs-lone contrast
      const spTr = dayBoot(tr, splitStat(REAL, h), 700 + h);
      const spVa = dayBoot(va, splitStat(REAL, h), 800 + h);
      const spTw = dayBoot(va, splitStat(PLACEBO_POOL, h), 800 + h);
      console.log(`  Δ≥2v0(${String(h).padStart(2)}m): train ${fmt(spTr, 'pt')} | valid ${fmt(spVa, 'pt')} | twin-valid ${fmt(spTw, 'pt')}`);
    }
  }
  console.log('\nVerdict rule: EDGE = train & validation IC CI95 exclude 0, same sign, beats sharp twin (5m/15m).');
}
// report the factor-bucket n (rows entering the IC), not the resample-pool n
function bumpN(b: Boot, rs: VisitRow[], pool: string[], h: number): void {
  b.n = rs.filter((r) => pool.includes(r.source) && r.confluenceN != null && r.y[h] != null).length;
}
main();
