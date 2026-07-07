// CRACKER P3 · F9 + F10 — the book-state factors (Phase 4.2, through the frozen harness).
//
// PRE-REGISTERED SPECS (frozen 2026-07-07, before the post-rebuild first run):
//   F9 — WALL BEHAVIOR ON APPROACH: ΔL = (wd_open − wd_pre) / max(wd_pre, 1) —
//     the defending wall's relative change over the last 60s of approach.
//     Pulled (<0) / added (>0) / defended (≈0). Folklore: pulled ⇒ break,
//     added ⇒ hold — i.e. positive IC vs bounce — but NO sign is imposed
//     (F-series lessons). Declared 1m/5m (book information acts fast).
//   F10 — CAPACITY BEHIND THE LEVEL: beyond_def — resting size strictly behind
//     the level on the break side (W_BEYOND window; NULL when the ladder didn't
//     cover the window — coverage honesty). "Trapdoor" folklore: thin behind ⇒
//     breaks travel, holds are less sticky ⇒ positive IC of capacity vs bounce.
//     No sign imposed. Declared 5m/15m (structural timescale).
//     Secondary (non-gating): gap_max (largest empty-tick run behind).
//   Both: real pool vs sharp placebo twin; L2 screens (2.5× power), L3 must be
//   sign-consistent for an EDGE to stand; verdicts per harness (ρ* = 0.05).
//
// Run: [TRACE_DB=data/cracker-trace-l2.db] pnpm --filter @trading/aggregator exec tsx scripts/cracker_p3_f9f10_book.ts
import {
  loadVisits, splitDays, dayBoot, wmean, weightedSpearman, fmt, verdict, excl0,
  PLACEBO_POOL, HORIZONS, DB_PATH, type VisitRow,
} from './cracker_p3_harness.js';

const SYMS = ['NQ', 'ES'];
const REAL = ['swing', 'hvn', 'lvn', 'round'];

const dl = (r: VisitRow) => (r.wdOpen != null && r.wdPre != null ? (r.wdOpen - r.wdPre) / Math.max(r.wdPre, 1) : null);
const beyond = (r: VisitRow) => r.beyondDef;
const gapx = (r: VisitRow) => r.gapMax;

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

function runFactor(tag: string, declared: number[], sym: string, tr: VisitRow[], va: VisitRow[], value: (r: VisitRow) => number | null, seedBase: number, secondary?: { tag: string; value: (r: VisitRow) => number | null }): void {
  const cut = terciles(tr, REAL, value);
  for (const h of HORIZONS) {
    const isDecl = declared.includes(h);
    const icTr = dayBoot(tr, icStat(REAL, h, value), seedBase + h);
    const icVa = dayBoot(va, icStat(REAL, h, value), seedBase + 100 + h);
    const twVa = dayBoot(va, icStat(PLACEBO_POOL, h, value), seedBase + 100 + h);
    const dfVa = dayBoot(va, (rs: VisitRow[]) => icStat(REAL, h, value)(rs) - icStat(PLACEBO_POOL, h, value)(rs), seedBase + 100 + h);
    const beats = (excl0(icVa) && !excl0(twVa)) || (excl0(icVa) && excl0(twVa) && excl0(dfVa));
    const nOf = (rs: VisitRow[]) => rs.filter((r) => REAL.includes(r.source) && isFinite(value(r) ?? NaN) && r.y[h] != null).length;
    icTr.n = nOf(tr); icVa.n = nOf(va);
    const v = isDecl ? `  → ${verdict(sym, h, icTr, icVa, beats, 'ic')}` : '';
    console.log(`  ${tag} IC(${String(h).padStart(2)}m): train ${fmt(icTr)} | valid ${fmt(icVa)} | twin ${fmt(twVa)}${v}${isDecl ? ' [declared]' : ''}`);
    if (cut && isDecl) {
      const tcTr = dayBoot(tr, tercStat(REAL, h, value, cut), seedBase + 200 + h);
      const tcVa = dayBoot(va, tercStat(REAL, h, value, cut), seedBase + 300 + h);
      console.log(`  ${tag} Δterc(${String(h).padStart(2)}m): train ${fmt(tcTr, 'pt')} | valid ${fmt(tcVa, 'pt')}`);
    }
    if (secondary && isDecl) {
      const s1 = dayBoot(tr, icStat(REAL, h, secondary.value), seedBase + 400 + h);
      const s2 = dayBoot(va, icStat(REAL, h, secondary.value), seedBase + 500 + h);
      console.log(`  ${secondary.tag} IC(${String(h).padStart(2)}m): train ${s1.est >= 0 ? '+' : ''}${s1.est.toFixed(3)} | valid ${s2.est >= 0 ? '+' : ''}${s2.est.toFixed(3)}  (secondary)`);
    }
  }
}

function main() {
  console.log(`=== P3 · F9/F10 — book-state factors · DB: ${DB_PATH.split('/').pop()} ===`);
  for (const sym of SYMS) {
    const { rows, days } = loadVisits(sym);
    const { train, valid } = splitDays(days);
    const tr = rows.filter((r) => train.has(r.day)), va = rows.filter((r) => valid.has(r.day));
    const cov = rows.filter((r) => REAL.includes(r.source));
    const covPct = (f: (r: VisitRow) => number | null) => (100 * cov.filter((r) => f(r) != null).length / Math.max(cov.length, 1)).toFixed(0);
    console.log(`\n## ${sym} — train ${train.size}d / valid ${valid.size}d · coverage: ΔL ${covPct(dl)}% · beyond ${covPct(beyond)}%`);
    console.log(`  F9 — wall ΔL over approach (pulled<0 / added>0), declared 1m/5m:`);
    runFactor('ΔL  ', [1, 5], sym, tr, va, dl, 7100);
    console.log(`  F10 — capacity behind the level (break side), declared 5m/15m:`);
    runFactor('bey ', [5, 15], sym, tr, va, beyond, 7600, { tag: 'gap ', value: gapx });
  }
  console.log('\nVerdict rule: EDGE = train & validation IC CI95 exclude 0, same sign, beats twin (ρ*=0.05); L2 screens, L3 must be sign-consistent.');
}
main();
