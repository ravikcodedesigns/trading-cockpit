// CRACKER P3 · F4 — absorption ratio at contact: is passive defense predictive?
//
// PRE-REGISTERED SPEC (frozen 2026-07-07, before first run):
//   Factor: absorb_ratio (P1.5 frozen: contact volume / max(penetration, 1 tick)
//           — contracts digested per point of give; high = the defending side
//           absorbs aggression without yielding). Computed from the contact
//           phase, which ends before visit close → strictly causal.
//   Mechanism: absorption ⇒ defense ⇒ bounce; declared horizons 5m/15m.
//   Population: real sources (swing/hvn/lvn/round). Twin: identical ratio on
//           the placebo pool (absorption at a fake level = generic price
//           mechanics; the factor must beat it).
//   Tests: (a) weighted Spearman IC vs y(h); (b) tercile contrast — boundaries
//           fit on TRAIN real-pool values, applied unchanged to validation.
//   CONFOUND CHECK (non-gating, reported): IC of raw contact volume ct_vol —
//           if "absorption" is just "busy tape", this shows comparable IC.
//   Verdicts per harness (EDGE / NULL / UNDERPOWERED, ρ* = 0.05).
//
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cracker_p3_f4_absorption.ts
import {
  loadVisits, splitDays, dayBoot, wmean, weightedSpearman, fmt, verdict, excl0,
  PLACEBO_POOL, HORIZONS, type VisitRow, type Boot,
} from './cracker_p3_harness.js';

const SYMS = ['NQ', 'ES'];
const REAL = ['swing', 'hvn', 'lvn', 'round'];
const DECLARED = [5, 15];

const icStat = (pool: string[], h: number, value: (r: VisitRow) => number | null) => (rs: VisitRow[]): number => {
  const x: number[] = [], y: number[] = [], w: number[] = [];
  for (const r of rs) {
    const v = value(r);
    if (!pool.includes(r.source) || v == null || !isFinite(v) || r.y[h] == null) continue;
    x.push(v); y.push(r.y[h]!); w.push(r.uniq);
  }
  return x.length >= 30 ? weightedSpearman(x, y, w) : NaN;
};

/** Unweighted empirical terciles (pre-registered) of the factor on a row set. */
function terciles(rows: VisitRow[], pool: string[], value: (r: VisitRow) => number | null): [number, number] | null {
  const v = rows.map((r) => (pool.includes(r.source) ? value(r) : null)).filter((x): x is number => x != null && isFinite(x)).sort((a, b) => a - b);
  if (v.length < 90) return null;
  return [v[Math.floor(v.length / 3)]!, v[Math.floor((2 * v.length) / 3)]!];
}

const tercStat = (pool: string[], h: number, value: (r: VisitRow) => number | null, cut: [number, number]) => (rs: VisitRow[]): number => {
  const hi: { x: number; w: number }[] = [], lo: { x: number; w: number }[] = [];
  for (const r of rs) {
    const v = value(r);
    if (!pool.includes(r.source) || v == null || !isFinite(v) || r.y[h] == null) continue;
    if (v >= cut[1]) hi.push({ x: r.y[h]!, w: r.uniq });
    else if (v < cut[0]) lo.push({ x: r.y[h]!, w: r.uniq });
  }
  return hi.length && lo.length ? wmean(hi) - wmean(lo) : NaN;
};

function main() {
  console.log('=== P3 · F4 — absorption ratio at contact (first flow factor) ===');
  const value = (r: VisitRow) => r.absorbRatio;
  for (const sym of SYMS) {
    const { rows, days } = loadVisits(sym);
    const { train, valid } = splitDays(days);
    const tr = rows.filter((r) => train.has(r.day)), va = rows.filter((r) => valid.has(r.day));
    const cut = terciles(tr, REAL, value);
    console.log(`\n## ${sym} — train ${train.size}d / valid ${valid.size}d · tercile cuts [${cut?.[0].toFixed(0)}, ${cut?.[1].toFixed(0)}] contracts/pt`);
    for (const h of HORIZONS) {
      const declared = DECLARED.includes(h);
      const icTr = dayBoot(tr, icStat(REAL, h, value), 2100 + h);
      const icVa = dayBoot(va, icStat(REAL, h, value), 2200 + h);
      const twVa = dayBoot(va, icStat(PLACEBO_POOL, h, value), 2200 + h);
      const dfVa = dayBoot(va, (rs: VisitRow[]) => icStat(REAL, h, value)(rs) - icStat(PLACEBO_POOL, h, value)(rs), 2200 + h);
      const beats = (excl0(icVa) && !excl0(twVa)) || (excl0(icVa) && excl0(twVa) && excl0(dfVa));
      const nOf = (rs: VisitRow[]) => rs.filter((r) => REAL.includes(r.source) && isFinite(value(r) ?? NaN) && r.y[h] != null).length;
      icTr.n = nOf(tr); icVa.n = nOf(va);
      const v = declared ? `  → ${verdict(sym, h, icTr, icVa, beats, 'ic')}` : '';
      console.log(`  IC(${String(h).padStart(2)}m): train ${fmt(icTr)} | valid ${fmt(icVa)} | twin ${fmt(twVa)}${v}${declared ? ' [declared]' : ''}`);
      if (cut) {
        const tcTr = dayBoot(tr, tercStat(REAL, h, value, cut), 2300 + h);
        const tcVa = dayBoot(va, tercStat(REAL, h, value, cut), 2400 + h);
        console.log(`  Δterc(${String(h).padStart(2)}m): train ${fmt(tcTr, 'pt')} | valid ${fmt(tcVa, 'pt')}`);
      }
      // confound check (non-gating): is it just volume?
      const cvTr = dayBoot(tr, icStat(REAL, h, (r) => r.ctVol), 2500 + h);
      const cvVa = dayBoot(va, icStat(REAL, h, (r) => r.ctVol), 2600 + h);
      console.log(`  ct_vol IC(${String(h).padStart(2)}m): train ${cvTr.est >= 0 ? '+' : ''}${cvTr.est.toFixed(3)} | valid ${cvVa.est >= 0 ? '+' : ''}${cvVa.est.toFixed(3)}  (confound check)`);
    }
  }
  console.log('\nVerdict rule: EDGE = train & validation IC CI95 exclude 0, same sign, beats twin (5m/15m, ρ*=0.05).');
}
main();
