// CRACKER P3 · F3 — visit-index / test-over-test hold posterior.
// The corrected "94/7" question: does a level's own track record predict the
// NEXT visit — with the survivorship trap handled by construction.
//
// PRE-REGISTERED SPEC (frozen 2026-07-07, before first run):
//   History per visit = OBSERVED prior visits of the same level_id (closeTs
//   order) within the discovery window — strictly BEFORE the current visit
//   (causal; crossing the train/valid boundary is past→present and legitimate).
//   (a) VISIT-INDEX factor: x = min(observed prior count + 1, 5). All visits.
//       Question: is the Nth test different at all (fresh vs retested)?
//   (b) TRACK-RECORD factor: x = frozen Beta posterior holdPosterior(priorHolds,
//       priorN) — prior-only, no peeking. Population: visits with priorN ≥ 1.
//       Survivorship handling: (b) never compares "has history" vs "no history";
//       it ranks WITHIN the has-history population, where existence is given.
//   (c) TEST-OVER-TEST (secondary, descriptive): Δhold = P(hold | prev held) −
//       P(hold | prev broke), priorN ≥ 1, day-block CI.
//   Twin for all three: identical computation on the placebo pool — placebo
//   levels accumulate visit histories through the same registry, so "held
//   before → holds again" appearing there = price mechanics, not level memory.
//   Population: real sources (swing, hvn, lvn, round). Declared horizons: 5m/15m.
//   Verdicts per harness rules; IC bar ρ* = 0.05.
//
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cracker_p3_f3_history.ts
import {
  loadVisits, splitDays, dayBoot, weightedSpearman, fmt, verdict, excl0,
  PLACEBO_POOL, HORIZONS, type VisitRow, type Boot,
} from './cracker_p3_harness.js';
import { holdPosterior } from '../src/l3/level-memory.js';

const SYMS = ['NQ', 'ES'];
const REAL = ['swing', 'hvn', 'lvn', 'round'];
const DECLARED = [5, 15];

interface HRow extends VisitRow { priorN: number; priorHolds: number; prevHeld: number | null; }

/** Attach observed prior record (strictly earlier visits of the same level). */
function withHistory(rows: VisitRow[]): HRow[] {
  const byLevel = new Map<string, VisitRow[]>();
  for (const r of rows) { if (!byLevel.has(r.levelId)) byLevel.set(r.levelId, []); byLevel.get(r.levelId)!.push(r); }
  const out: HRow[] = [];
  for (const vs of byLevel.values()) {
    vs.sort((a, b) => a.closeTs - b.closeTs);
    let holds = 0;
    for (let i = 0; i < vs.length; i++) {
      out.push({ ...vs[i]!, priorN: i, priorHolds: holds, prevHeld: i > 0 ? vs[i - 1]!.held : null });
      holds += vs[i]!.held;
    }
  }
  return out.sort((a, b) => a.closeTs - b.closeTs);
}

const icStat = (pool: string[], h: number, value: (r: HRow) => number | null) => (rs: HRow[]): number => {
  const x: number[] = [], y: number[] = [], w: number[] = [];
  for (const r of rs) {
    const v = value(r);
    if (!pool.includes(r.source) || v == null || r.y[h] == null) continue;
    x.push(v); y.push(r.y[h]!); w.push(r.uniq);
  }
  return x.length >= 30 ? weightedSpearman(x, y, w) : NaN;
};

const totStat = (pool: string[]) => (rs: HRow[]): number => {
  let hh = 0, hn = 0, bh = 0, bn = 0;
  for (const r of rs) {
    if (!pool.includes(r.source) || r.prevHeld == null) continue;
    if (r.prevHeld) { hn++; hh += r.held; } else { bn++; bh += r.held; }
  }
  return hn >= 15 && bn >= 15 ? hh / hn - bh / bn : NaN;
};

function runIC(name: string, sym: string, tr: HRow[], va: HRow[], value: (r: HRow) => number | null, seedBase: number): void {
  for (const h of HORIZONS) {
    const declared = DECLARED.includes(h);
    const icTr = dayBoot(tr, icStat(REAL, h, value), seedBase + h);
    const icVa = dayBoot(va, icStat(REAL, h, value), seedBase + 100 + h);
    const twVa = dayBoot(va, icStat(PLACEBO_POOL, h, value), seedBase + 100 + h);
    const dfVa = dayBoot(va, (rs: HRow[]) => icStat(REAL, h, value)(rs) - icStat(PLACEBO_POOL, h, value)(rs), seedBase + 100 + h);
    const beats = (excl0(icVa) && !excl0(twVa)) || (excl0(icVa) && excl0(twVa) && excl0(dfVa));
    const nOf = (rs: HRow[]) => rs.filter((r) => REAL.includes(r.source) && value(r) != null && r.y[h] != null).length;
    icTr.n = nOf(tr); icVa.n = nOf(va);
    const v = declared ? `  → ${verdict(sym, h, icTr, icVa, beats, 'ic')}` : '';
    console.log(`  ${name} IC(${String(h).padStart(2)}m): train ${fmt(icTr)} | valid ${fmt(icVa)} | twin ${fmt(twVa)}${v}${declared ? ' [declared]' : ''}`);
  }
}

function main() {
  console.log('=== P3 · F3 — visit-index / test-over-test hold posterior (survivorship-aware) ===');
  for (const sym of SYMS) {
    const { rows, days } = loadVisits(sym);
    const hist = withHistory(rows);
    const { train, valid } = splitDays(days);
    const tr = hist.filter((r) => train.has(r.day)), va = hist.filter((r) => valid.has(r.day));
    const nH = hist.filter((r) => REAL.includes(r.source) && r.priorN >= 1).length;
    const dist = [0, 1, 2, 3].map((k) => hist.filter((r) => REAL.includes(r.source) && (k < 3 ? r.priorN === k : r.priorN >= 3)).length);
    console.log(`\n## ${sym} — real visits by prior count 0/1/2/3+: ${dist.join('/')} (${nH} with history)`);
    console.log(`  (a) visit-index factor (all visits):`);
    runIC('idx ', sym, tr, va, (r) => Math.min(r.priorN + 1, 5), 1100);
    console.log(`  (b) prior-record posterior (priorN ≥ 1):`);
    runIC('post', sym, tr, va, (r) => (r.priorN >= 1 ? holdPosterior(r.priorHolds, r.priorN) : null), 1300);
    // (c) test-over-test (secondary)
    const t1 = dayBoot(tr, totStat(REAL), 1500), v1 = dayBoot(va, totStat(REAL), 1600);
    const p1 = dayBoot(va, totStat(PLACEBO_POOL), 1600);
    console.log(`  (c) Δhold (prev-held − prev-broke): train ${fmt(t1)} | valid ${fmt(v1)} | twin ${fmt(p1)}  (secondary)`);
  }
  console.log('\nVerdict rule: EDGE = train & validation IC CI95 exclude 0, same sign, beats twin (5m/15m, ρ*=0.05).');
}
main();
