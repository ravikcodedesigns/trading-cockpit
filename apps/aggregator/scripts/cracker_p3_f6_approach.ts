// CRACKER P3 · F6 — approach imbalance: does HOW price arrives at the level matter?
//
// PRE-REGISTERED SPEC (frozen 2026-07-07, before first run):
//   a* = s·ap_delta — net aggressor volume in the 60s ATTACK phase before the
//   visit opens (ring-buffer, ±3×band), signed into the bounce direction
//   (a* < 0 = one-sided aggression INTO the level). Causal by construction.
//   Variants: (a) a* raw (contracts); (b) a*/ap_vol (arrival imbalance fraction).
//   Declared horizons: 1m/5m (arrival flow is fast information).
//   Two mechanism stories exist (momentum-through vs exhaustion-reversal) —
//   no sign is imposed; EDGE needs the harness's same-sign train/valid + twin.
//   DATASET RULE (pre-registered): L2 micro = the SCREENING verdict (2.5×
//   power); L3 mini reported in parallel — an L2 EDGE stands only if the L3
//   point estimates are sign-consistent in both halves (attenuation-aware
//   consistency, not significance). Run with TRACE_DB to select the dataset.
//
// Run: [TRACE_DB=data/cracker-trace-l2.db] pnpm --filter @trading/aggregator exec tsx scripts/cracker_p3_f6_approach.ts
import {
  loadVisits, splitDays, dayBoot, wmean, weightedSpearman, fmt, verdict, excl0,
  PLACEBO_POOL, HORIZONS, DB_PATH, type VisitRow,
} from './cracker_p3_harness.js';

const SYMS = ['NQ', 'ES'];
const REAL = ['swing', 'hvn', 'lvn', 'round'];
const DECLARED = [1, 5];

const icStat = (pool: string[], h: number, value: (r: VisitRow) => number | null) => (rs: VisitRow[]): number => {
  const x: number[] = [], y: number[] = [], w: number[] = [];
  for (const r of rs) {
    const v = value(r);
    if (!pool.includes(r.source) || v == null || !isFinite(v) || r.y[h] == null) continue;
    x.push(v); y.push(r.y[h]!); w.push(r.uniq);
  }
  return x.length >= 30 ? weightedSpearman(x, y, w) : NaN;
};

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

function runVariant(name: string, sym: string, tr: VisitRow[], va: VisitRow[], value: (r: VisitRow) => number | null, seedBase: number): void {
  const cut = terciles(tr, REAL, value);
  for (const h of HORIZONS) {
    const declared = DECLARED.includes(h);
    const icTr = dayBoot(tr, icStat(REAL, h, value), seedBase + h);
    const icVa = dayBoot(va, icStat(REAL, h, value), seedBase + 100 + h);
    const twVa = dayBoot(va, icStat(PLACEBO_POOL, h, value), seedBase + 100 + h);
    const dfVa = dayBoot(va, (rs: VisitRow[]) => icStat(REAL, h, value)(rs) - icStat(PLACEBO_POOL, h, value)(rs), seedBase + 100 + h);
    const beats = (excl0(icVa) && !excl0(twVa)) || (excl0(icVa) && excl0(twVa) && excl0(dfVa));
    const nOf = (rs: VisitRow[]) => rs.filter((r) => REAL.includes(r.source) && isFinite(value(r) ?? NaN) && r.y[h] != null).length;
    icTr.n = nOf(tr); icVa.n = nOf(va);
    const v = declared ? `  → ${verdict(sym, h, icTr, icVa, beats, 'ic')}` : '';
    console.log(`  ${name} IC(${String(h).padStart(2)}m): train ${fmt(icTr)} | valid ${fmt(icVa)} | twin ${fmt(twVa)}${v}${declared ? ' [declared]' : ''}`);
    if (cut && declared) {
      const tcTr = dayBoot(tr, tercStat(REAL, h, value, cut), seedBase + 200 + h);
      const tcVa = dayBoot(va, tercStat(REAL, h, value, cut), seedBase + 300 + h);
      console.log(`  ${name} Δterc(${String(h).padStart(2)}m): train ${fmt(tcTr, 'pt')} | valid ${fmt(tcVa, 'pt')}`);
    }
  }
}

function main() {
  console.log(`=== P3 · F6 — approach imbalance (attack phase) · DB: ${DB_PATH.split('/').pop()} ===`);
  const aStar = (r: VisitRow) => (r.side === 'support' ? r.apDelta : -r.apDelta);
  const aFrac = (r: VisitRow) => (r.apVol > 0 ? aStar(r) / r.apVol : null);
  for (const sym of SYMS) {
    const { rows, days } = loadVisits(sym);
    const { train, valid } = splitDays(days);
    const tr = rows.filter((r) => train.has(r.day)), va = rows.filter((r) => valid.has(r.day));
    console.log(`\n## ${sym} — train ${train.size}d / valid ${valid.size}d`);
    console.log(`  (a) a* raw (contracts):`);
    runVariant('raw ', sym, tr, va, aStar, 4100);
    console.log(`  (b) a*/ap_vol (arrival imbalance fraction):`);
    runVariant('frac', sym, tr, va, aFrac, 4600);
  }
  console.log('\nVerdict rule: EDGE = train & validation IC CI95 exclude 0, same sign, beats twin (1m/5m, ρ*=0.05); L2 screens, L3 must be sign-consistent.');
}
main();
