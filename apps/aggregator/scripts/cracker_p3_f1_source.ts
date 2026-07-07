// CRACKER P3 · F1 — level-source identity: do our levels matter AT ALL?
//
// PRE-REGISTERED SPEC (frozen 2026-07-07, before first run):
//   Factor: categorical — visit's level source ∈ {swing, hvn, lvn, round}.
//   Test:   visits-vs-visits contrast against the placebo pool (random+shifted),
//           per the P2 binding rule. Δy(h) = wmean(y | source) − wmean(y | placebo),
//           same day-resamples both sides (paired day-block bootstrap).
//   Outcome: y(h) = side-signed drift-adjusted markout (bounce-ness, points).
//           Secondary: hold-rate contrast (descriptive).
//   Mechanism horizons (declared): 5m and 15m — a defended level should show
//           its bounce on the visit timescale, not at 1m noise or 30m regime.
//   Twin:   the contrast vs placebo IS the twin test (beatsTwin ≡ true in
//           verdict(); the placebo pool sits on the other side of Δ).
//   Verdict per source at each declared horizon; EDGE requires train AND
//           validation CI95 excluding 0 with the same sign.
//   NOTE: the plan's coarse-vs-fine scale split is DEFERRED — swing `kind`
//           only persists high/low; scale tagging queued for the next rebuild.
//
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cracker_p3_f1_source.ts
import {
  loadVisits, splitDays, dayBoot, wmean, fmt, verdict, excl0,
  PLACEBO_POOL, HORIZONS, type VisitRow, type Boot,
} from './cracker_p3_harness.js';

const SYMS = ['NQ', 'ES'];
const SOURCES = ['swing', 'hvn', 'lvn', 'round'];
const DECLARED = [5, 15];

function contrast(rows: VisitRow[], source: string, h: number, seed: number): Boot | null {
  const pool = rows.filter((r) => (r.source === source || PLACEBO_POOL.includes(r.source)) && r.y[h] != null);
  if (!pool.length) return null;
  const nSrc = pool.filter((r) => r.source === source).length;
  const nPlc = pool.length - nSrc;
  if (nSrc < 30 || nPlc < 30) return null;
  const stat = (rs: VisitRow[]) => {
    const a = rs.filter((r) => r.source === source).map((r) => ({ x: r.y[h]!, w: r.uniq }));
    const b = rs.filter((r) => PLACEBO_POOL.includes(r.source)).map((r) => ({ x: r.y[h]!, w: r.uniq }));
    return a.length && b.length ? wmean(a) - wmean(b) : NaN;
  };
  const bt = dayBoot(pool, stat, seed);
  bt.n = nSrc;   // report the source bucket size (what the MDE gates on)
  return bt;
}

function holdContrast(rows: VisitRow[], source: string, seed: number): Boot | null {
  const pool = rows.filter((r) => r.source === source || PLACEBO_POOL.includes(r.source));
  if (pool.filter((r) => r.source === source).length < 30) return null;
  const stat = (rs: VisitRow[]) => {
    const a = rs.filter((r) => r.source === source);
    const b = rs.filter((r) => PLACEBO_POOL.includes(r.source));
    return a.length && b.length
      ? a.reduce((s, r) => s + r.held, 0) / a.length - b.reduce((s, r) => s + r.held, 0) / b.length : NaN;
  };
  const bt = dayBoot(pool, stat, seed);
  bt.n = pool.filter((r) => r.source === source).length;
  return bt;
}

function main() {
  console.log('=== P3 · F1 — level-source identity vs placebo pool (visits-vs-visits) ===');
  for (const sym of SYMS) {
    const { rows, days } = loadVisits(sym);
    const { train, valid } = splitDays(days);
    console.log(`\n## ${sym} — ${days.length} days: train ${train.size} (${[...train][0]}→${[...train][train.size - 1]}), validation ${valid.size}`);
    const tr = rows.filter((r) => train.has(r.day)), va = rows.filter((r) => valid.has(r.day));
    for (const src of SOURCES) {
      console.log(`\n  ${src}:`);
      for (const h of HORIZONS) {
        const bt = contrast(tr, src, h, 100 + h);
        const bv = contrast(va, src, h, 200 + h);
        if (!bt || !bv) { console.log(`    Δy(${h}m): insufficient n`); continue; }
        const declared = DECLARED.includes(h);
        const v = declared ? `  → ${verdict(sym, h, bt, bv, true)}` : '';
        console.log(`    Δy(${String(h).padStart(2)}m): train ${fmt(bt, 'pt')} | valid ${fmt(bv, 'pt')}${v}${declared ? ' [declared]' : ''}`);
      }
      const ht = holdContrast(tr, src, 300), hv = holdContrast(va, src, 400);
      if (ht && hv) console.log(`    Δhold:   train ${fmt(ht)} | valid ${fmt(hv)}  (secondary)`);
    }
  }
  console.log('\nVerdict rule: EDGE = train & validation CI95 exclude 0, same sign, declared horizon (5m/15m).');
}
main();
