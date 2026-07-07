// CRACKER P3 · F8 — prior-visit delta divergence (test-over-test flow).
// Carmine's discriminator, formalized: the same level tested again, but the
// attack arrives visibly WEAKER than last time → the level should hold.
//
// PRE-REGISTERED SPEC (frozen 2026-07-07, before first run):
//   Pairs: consecutive visits of the SAME level_id from the SAME side
//   (closeTs order; the prior visit's features are strictly historical).
//   Attack intensity per visit: att = −s·ct_delta / ct_vol ∈ [−1, 1] —
//   aggressor flow INTO the level as a fraction of contact volume.
//   Factor (on the CURRENT visit): div = att_prev − att_cur.
//   Positive div = the re-test came in with weaker relative pressure.
//   Expectation: POSITIVE IC vs y (weakening attack → hold → bounce).
//   Declared 5m/15m. Secondary (non-gating): div of raw att (contracts).
//   Twin: identical pairing on the placebo pool. L2 screens; L3 must be
//   sign-consistent for an EDGE to stand.
//
// Run: [TRACE_DB=data/cracker-trace-l2.db] pnpm --filter @trading/aggregator exec tsx scripts/cracker_p3_f8_divergence.ts
import {
  loadVisits, splitDays, dayBoot, wmean, weightedSpearman, fmt, verdict, excl0,
  PLACEBO_POOL, HORIZONS, DB_PATH, type VisitRow,
} from './cracker_p3_harness.js';

const SYMS = ['NQ', 'ES'];
const REAL = ['swing', 'hvn', 'lvn', 'round'];
const DECLARED = [5, 15];

/** att = aggression INTO the level, as fraction of contact volume. */
const attFrac = (r: VisitRow): number | null => {
  if (r.ctVol <= 0) return null;
  const dStar = r.side === 'support' ? r.ctDelta : -r.ctDelta;
  return -dStar / r.ctVol;
};
const attRaw = (r: VisitRow): number => -(r.side === 'support' ? r.ctDelta : -r.ctDelta);

/** div maps keyed by `${levelId}|${closeTs}` for the CURRENT visit of each pair. */
function buildDiv(rows: VisitRow[], att: (r: VisitRow) => number | null): Map<string, number> {
  const byLevel = new Map<string, VisitRow[]>();
  for (const r of rows) { if (!byLevel.has(r.levelId)) byLevel.set(r.levelId, []); byLevel.get(r.levelId)!.push(r); }
  const out = new Map<string, number>();
  for (const vs of byLevel.values()) {
    vs.sort((a, b) => a.closeTs - b.closeTs);
    let prevBySide = new Map<string, VisitRow>();
    for (const v of vs) {
      const p = prevBySide.get(v.side);
      if (p) {
        const ap = att(p), ac = att(v);
        if (ap != null && ac != null && isFinite(ap) && isFinite(ac)) out.set(`${v.levelId}|${v.closeTs}`, ap - ac);
      }
      prevBySide.set(v.side, v);
    }
  }
  return out;
}

const icStat = (pool: string[], h: number, div: Map<string, number>) => (rs: VisitRow[]): number => {
  const x: number[] = [], y: number[] = [], w: number[] = [];
  for (const r of rs) {
    const v = div.get(`${r.levelId}|${r.closeTs}`);
    if (!pool.includes(r.source) || v == null || r.y[h] == null) continue;
    x.push(v); y.push(r.y[h]!); w.push(r.uniq);
  }
  return x.length >= 30 ? weightedSpearman(x, y, w) : NaN;
};

function main() {
  console.log(`=== P3 · F8 — test-over-test delta divergence (Carmine's discriminator) · DB: ${DB_PATH.split('/').pop()} ===`);
  for (const sym of SYMS) {
    const { rows, days } = loadVisits(sym);
    const { train, valid } = splitDays(days);
    const tr = rows.filter((r) => train.has(r.day)), va = rows.filter((r) => valid.has(r.day));
    const divF = buildDiv(rows, attFrac);          // pairing spans the whole window (past→present, causal)
    const divR = buildDiv(rows, (r) => attRaw(r));
    const nOf = (rs: VisitRow[]) => rs.filter((r) => REAL.includes(r.source) && divF.has(`${r.levelId}|${r.closeTs}`)).length;
    console.log(`\n## ${sym} — paired re-tests (real): train ${nOf(tr)}, valid ${nOf(va)}`);
    for (const h of HORIZONS) {
      const declared = DECLARED.includes(h);
      const icTr = dayBoot(tr, icStat(REAL, h, divF), 6100 + h);
      const icVa = dayBoot(va, icStat(REAL, h, divF), 6200 + h);
      const twVa = dayBoot(va, icStat(PLACEBO_POOL, h, divF), 6200 + h);
      const dfVa = dayBoot(va, (rs: VisitRow[]) => icStat(REAL, h, divF)(rs) - icStat(PLACEBO_POOL, h, divF)(rs), 6200 + h);
      const beats = (excl0(icVa) && !excl0(twVa)) || (excl0(icVa) && excl0(twVa) && excl0(dfVa));
      icTr.n = nOf(tr); icVa.n = nOf(va);
      const v = declared ? `  → ${verdict(sym, h, icTr, icVa, beats, 'ic')}` : '';
      console.log(`  divF IC(${String(h).padStart(2)}m): train ${fmt(icTr)} | valid ${fmt(icVa)} | twin ${fmt(twVa)}${v}${declared ? ' [declared]' : ''}`);
      const rwTr = dayBoot(tr, icStat(REAL, h, divR), 6300 + h);
      const rwVa = dayBoot(va, icStat(REAL, h, divR), 6400 + h);
      console.log(`  divRaw IC(${String(h).padStart(2)}m): train ${rwTr.est >= 0 ? '+' : ''}${rwTr.est.toFixed(3)} | valid ${rwVa.est >= 0 ? '+' : ''}${rwVa.est.toFixed(3)}  (secondary)`);
    }
  }
  console.log('\nVerdict rule: EDGE = train & validation IC CI95 exclude 0, same sign, beats twin (5m/15m, ρ*=0.05); L2 screens, L3 must be sign-consistent.');
}
main();
