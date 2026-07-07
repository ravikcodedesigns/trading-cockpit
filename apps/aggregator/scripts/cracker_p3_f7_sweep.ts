// CRACKER P3 · F7 — sweep geometry: penetration depth × reversal speed.
// The stop-run reversal, quantified from the visit's realized shape.
//
// PRE-REGISTERED SPEC (frozen 2026-07-07, before first run):
//   Population: SWEPT-AND-RECLAIMED visits — penetration > 0 (price actually
//   pierced the level) AND held = 1 (resolved back the approach side). Both
//   are known at visit close → causal for post-close markouts.
//   Factor: sweep = (penetration / band) / max(dwell_min, 1/6) — depth in
//   band units per minute of dwell. Deep-and-fast (the stop-run signature)
//   scores high; slow grinding penetration scores low.
//   Expectation: POSITIVE — a violent sweep-reclaim traps stops and fuels the
//   bounce. Declared horizons 5m/15m (reversal development timescale).
//   Secondary (reported, non-gating): depth alone (penetration / band).
//   Twin: identical conditions on the placebo pool. DATASET RULE: L2 screens
//   (2.5× power), L3 must be sign-consistent for an EDGE to stand.
//
// Run: [TRACE_DB=data/cracker-trace-l2.db] pnpm --filter @trading/aggregator exec tsx scripts/cracker_p3_f7_sweep.ts
import {
  loadVisits, splitDays, dayBoot, wmean, weightedSpearman, fmt, verdict, excl0,
  PLACEBO_POOL, HORIZONS, DB_PATH, type VisitRow,
} from './cracker_p3_harness.js';

const SYMS = ['NQ', 'ES'];
const REAL = ['swing', 'hvn', 'lvn', 'round'];
const DECLARED = [5, 15];

const inPop = (r: VisitRow) => r.held === 1 && r.penetration > 0 && r.band > 0;
const sweep = (r: VisitRow) => (inPop(r) ? (r.penetration / r.band) / Math.max(r.dwellMs / 60_000, 1 / 6) : null);
const depth = (r: VisitRow) => (inPop(r) ? r.penetration / r.band : null);

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

function main() {
  console.log(`=== P3 · F7 — sweep geometry (swept-and-reclaimed pool) · DB: ${DB_PATH.split('/').pop()} ===`);
  for (const sym of SYMS) {
    const { rows, days } = loadVisits(sym);
    const { train, valid } = splitDays(days);
    const tr = rows.filter((r) => train.has(r.day)), va = rows.filter((r) => valid.has(r.day));
    const nPop = (rs: VisitRow[]) => rs.filter((r) => REAL.includes(r.source) && inPop(r)).length;
    console.log(`\n## ${sym} — swept-and-reclaimed real visits: train ${nPop(tr)}, valid ${nPop(va)}`);
    const cut = terciles(tr, REAL, sweep);
    for (const h of HORIZONS) {
      const declared = DECLARED.includes(h);
      const icTr = dayBoot(tr, icStat(REAL, h, sweep), 5100 + h);
      const icVa = dayBoot(va, icStat(REAL, h, sweep), 5200 + h);
      const twVa = dayBoot(va, icStat(PLACEBO_POOL, h, sweep), 5200 + h);
      const dfVa = dayBoot(va, (rs: VisitRow[]) => icStat(REAL, h, sweep)(rs) - icStat(PLACEBO_POOL, h, sweep)(rs), 5200 + h);
      const beats = (excl0(icVa) && !excl0(twVa)) || (excl0(icVa) && excl0(twVa) && excl0(dfVa));
      const nOf = (rs: VisitRow[]) => rs.filter((r) => REAL.includes(r.source) && isFinite(sweep(r) ?? NaN) && r.y[h] != null).length;
      icTr.n = nOf(tr); icVa.n = nOf(va);
      const v = declared ? `  → ${verdict(sym, h, icTr, icVa, beats, 'ic')}` : '';
      console.log(`  sweep IC(${String(h).padStart(2)}m): train ${fmt(icTr)} | valid ${fmt(icVa)} | twin ${fmt(twVa)}${v}${declared ? ' [declared]' : ''}`);
      if (cut && declared) {
        const tcTr = dayBoot(tr, tercStat(REAL, h, sweep, cut), 5300 + h);
        const tcVa = dayBoot(va, tercStat(REAL, h, sweep, cut), 5400 + h);
        console.log(`  sweep Δterc(${String(h).padStart(2)}m): train ${fmt(tcTr, 'pt')} | valid ${fmt(tcVa, 'pt')}`);
      }
      // secondary: depth alone (non-gating)
      const dpTr = dayBoot(tr, icStat(REAL, h, depth), 5500 + h);
      const dpVa = dayBoot(va, icStat(REAL, h, depth), 5600 + h);
      console.log(`  depth IC(${String(h).padStart(2)}m): train ${dpTr.est >= 0 ? '+' : ''}${dpTr.est.toFixed(3)} | valid ${dpVa.est >= 0 ? '+' : ''}${dpVa.est.toFixed(3)}  (secondary)`);
    }
  }
  console.log('\nVerdict rule: EDGE = train & validation IC CI95 exclude 0, same sign, beats twin (5m/15m, ρ*=0.05); L2 screens, L3 must be sign-consistent.');
}
main();
