// CRACKER Phase 3 — THE FROZEN HARNESS (identical for every factor; CRACKER_PLAN §3).
//
// Factors queue through this one at a time. Nothing here changes between factor
// runs — a factor script supplies only its pre-registered spec (value function /
// category, mechanism horizons) and gets back the full battery + verdicts.
//
// ── FROZEN DEFINITIONS (2026-07-07) ──────────────────────────────────────────
// OUTCOME  y(h) = s·(mo(h) − drift·h), s = +1 support / −1 resistance —
//          side-signed drift-adjusted markout, in points ("bounce-ness").
//          Secondary outcome: held (binary).
// WEIGHTS  uniq_w on every mean (overlapping outcome windows down-weighted).
// CONTROL  visits-vs-visits ONLY (P2 finding: visit-close moments carry ~+6pp
//          NQ continuation — bystander nulls flatter factors). Placebo pool =
//          placebo-random + placebo-shifted ('round' excluded: real flow).
// IC       weighted Spearman: average-tie ranks recomputed per resample,
//          uniq_w-weighted Pearson on the ranks.
// CI       day-block bootstrap, B = 2000, seeded LCG; percentile intervals.
// SPLIT    chronological within the DISCOVERY FREEZE (days ≤ FREEZE_DAY):
//          train = first 60% of clean days, validation = the rest. Days after
//          FREEZE_DAY are the LOCKBOX — this harness refuses to read them
//          until Phase 5 (plan §1.5).
// TERCILES boundaries fitted on TRAIN factor values (weighted), applied
//          unchanged to validation. Contrast Δ = wmean(y | top) − wmean(y | bottom).
// POWER    plausible effect E*(h) = 0.15 × random-time markout SD (P2.2,
//          frozen constants below). Bucket MDE = 2.8 × bootstrap SE of the
//          contrast estimate.
// VERDICT  per declared mechanism horizon, validation primary:
//          EDGE         train CI excludes 0 AND validation CI excludes 0, same
//                       sign, AND the factor beats its placebo twin (twin CI
//                       contains 0 or |real| > |twin| with the difference CI
//                       excluding 0 under shared day-resamples).
//          UNDERPOWERED not EDGE and MDE > E* (couldn't have seen a plausible
//                       effect) → forward-accumulation queue.
//          NULL         not EDGE and MDE ≤ E* (had the power; nothing there).
//          STOP/GO is per-factor: NULL factors are dropped forever.
import Database from 'better-sqlite3';

const ROOT = '/Users/ravikumarbasker/trading-cockpit/data';
export const DB_PATH = process.env.TRACE_DB ?? `${ROOT}/cracker-trace.db`;
export const FREEZE_DAY = '2026-07-07';   // discovery freeze — later days = lockbox (Phase 5)
export const HORIZONS = [1, 5, 15, 30] as const;
export const B = 2000;
export const Z_MDE = 2.8;
export const PLAUSIBLE_FRAC = 0.15;
// P2.2 random-time markout SD (points) — frozen constants from cracker_p21_selftest
export const RT_SD: Record<string, Record<number, number>> = {
  NQ: { 1: 17.74, 5: 40.97, 15: 69.92, 30: 93.83 },
  ES: { 1: 2.55, 5: 6.38, 15: 10.47, 30: 14.02 },
};
export const PLACEBO_POOL = ['placebo-random', 'placebo-shifted'];

export function lcg(seed: number) { let s = seed >>> 0; return () => (s = (1664525 * s + 1013904223) >>> 0) / 2 ** 32; }

export interface VisitRow {
  day: string; closeTs: number; levelId: string; source: string; kind: string; side: string; held: number;
  visitIndex: number; confluenceN: number | null; band: number; sigmaEv: number;
  penetration: number; dwellMs: number; apDelta: number; apVol: number; ctDelta: number; ctVol: number;
  rsDelta: number; rsVol: number; imbN: number; absorbRatio: number;
  uniq: number; drift: number; todPhase: string | null; esAgree: number | null; rs30: number | null;
  wdOpen: number | null; waOpen: number | null; wdPre: number | null; waPre: number | null; beyondDef: number | null; gapMax: number | null;
  y: Record<number, number | null>;   // side-signed drift-adjusted markout per horizon
}

export function loadVisits(sym: string): { rows: VisitRow[]; days: string[] } {
  const db = new Database(DB_PATH, { readonly: true });
  const raw = db.prepare(`
    SELECT vf.trading_day day, vf.close_ts closeTs, vf.level_id levelId, vf.source, vf.kind, vf.side, vf.held,
      vf.visit_index visitIndex, vf.confluence_n confluenceN, vf.band, vf.sigma_ev sigmaEv,
      vf.penetration, li.dwell_ms dwellMs, vf.ap_delta apDelta, vf.ap_vol apVol, vf.ct_delta ctDelta, vf.ct_vol ctVol,
      vf.rs_delta rsDelta, vf.rs_vol rsVol, vf.imb_n imbN, vf.absorb_ratio absorbRatio,
      vo.uniq_w uniq, dc.drift_pt_min drift, vc.tod_phase todPhase, vc.es_agree esAgree, vc.rs_30m_bp rs30,
      vb.wd_open wdOpen, vb.wa_open waOpen, vb.wd_pre wdPre, vb.wa_pre waPre, vb.beyond_def beyondDef, vb.gap_max gapMax,
      vo.mo_1m, vo.mo_5m, vo.mo_15m, vo.mo_30m
    FROM visit_features vf
    JOIN visit_outcomes vo ON vo.level_id = vf.level_id AND vo.close_ts = vf.close_ts AND vo.symbol = vf.symbol
    JOIN day_context dc ON dc.symbol = vf.symbol AND dc.trading_day = vf.trading_day
    LEFT JOIN visit_context vc ON vc.level_id = vf.level_id AND vc.close_ts = vf.close_ts AND vc.symbol = vf.symbol
    LEFT JOIN interactions li ON li.level_id = vf.level_id AND li.ts_ms = vf.close_ts AND li.symbol = vf.symbol
    LEFT JOIN visit_book vb ON vb.level_id = vf.level_id AND vb.close_ts = vf.close_ts AND vb.symbol = vf.symbol
    WHERE vf.symbol = ? AND vf.trading_day <= ? AND vf.sigma_ev IS NOT NULL
    ORDER BY vf.trading_day, vf.close_ts`).all(sym, FREEZE_DAY) as any[];
  db.close();
  const rows: VisitRow[] = raw.map((r) => {
    const s = r.side === 'support' ? 1 : -1;
    const y: Record<number, number | null> = {};
    for (const h of HORIZONS) {
      const mo = r[`mo_${h}m`];
      y[h] = mo == null ? null : s * (mo - (r.drift ?? 0) * h);
    }
    return { ...r, uniq: r.uniq ?? 1, drift: r.drift ?? 0, y };
  });
  const days = [...new Set(rows.map((r) => r.day))].sort();
  return { rows, days };
}

/** Chronological 60/40 split of clean days (frozen). */
export function splitDays(days: string[]): { train: Set<string>; valid: Set<string> } {
  const nTrain = Math.round(days.length * 0.6);
  return { train: new Set(days.slice(0, nTrain)), valid: new Set(days.slice(nTrain)) };
}

export const wmean = (rows: { x: number; w: number }[]): number => {
  let sw = 0, sx = 0;
  for (const r of rows) { sw += r.w; sx += r.w * r.x; }
  return sw > 0 ? sx / sw : NaN;
};

/** Average-tie ranks. */
function ranks(v: number[]): number[] {
  const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array(v.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k]![1]] = r;
    i = j + 1;
  }
  return out;
}

/** uniq_w-weighted Spearman (weighted Pearson on average-tie ranks). */
export function weightedSpearman(x: number[], yv: number[], w: number[]): number {
  const rx = ranks(x), ry = ranks(yv);
  let sw = 0, mx = 0, my = 0;
  for (let i = 0; i < x.length; i++) { sw += w[i]!; mx += w[i]! * rx[i]!; my += w[i]! * ry[i]!; }
  mx /= sw; my /= sw;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = rx[i]! - mx, dy = ry[i]! - my;
    sxy += w[i]! * dx * dy; sxx += w[i]! * dx * dx; syy += w[i]! * dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

export interface Boot { est: number; se: number; ci95: [number, number]; n: number; }

/** Day-block bootstrap of an arbitrary statistic over rows grouped by day.
 *  The SAME day-resample indices drive every statistic computed with the same
 *  seed — enabling paired real-vs-twin differences. */
export function dayBoot<T extends { day: string }>(rows: T[], stat: (rs: T[]) => number, seed: number): Boot {
  const byDay = new Map<string, T[]>();
  for (const r of rows) { if (!byDay.has(r.day)) byDay.set(r.day, []); byDay.get(r.day)!.push(r); }
  const days = [...byDay.keys()].sort();
  const est = stat(rows);
  const rnd = lcg(seed);
  const vals: number[] = [];
  for (let b = 0; b < B; b++) {
    const rs: T[] = [];
    for (let i = 0; i < days.length; i++) rs.push(...byDay.get(days[Math.floor(rnd() * days.length)]!)!);
    const v = stat(rs);
    if (isFinite(v)) vals.push(v);
  }
  vals.sort((a, b2) => a - b2);
  const m = vals.reduce((a, v) => a + v, 0) / vals.length;
  const se = Math.sqrt(vals.reduce((a, v) => a + (v - m) ** 2, 0) / (vals.length - 1));
  const q = (p: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(p * vals.length)))]!;
  return { est, se, ci95: [q(0.025), q(0.975)], n: rows.length };
}

export const excl0 = (b: Boot) => b.ci95[0] > 0 || b.ci95[1] < 0;
export const fmt = (b: Boot, unit = '') =>
  `${b.est >= 0 ? '+' : ''}${b.est.toFixed(3)}${unit} CI95 [${b.ci95[0].toFixed(3)}, ${b.ci95[1].toFixed(3)}] n=${b.n}`;

/** Plausible-effect bar for a dimensionless rank IC (frozen: ρ* = 0.05, the
 *  conventional bar for a decision-relevant IC). Added 2026-07-07 when F2
 *  exposed a units bug — the points-denominated E* made IC verdicts default to
 *  NULL regardless of power. The fix can only relabel NULL→UNDERPOWERED. */
export const PLAUSIBLE_IC = 0.05;

/** Verdict for one declared horizon: EDGE / NULL / UNDERPOWERED (frozen rules).
 *  `kind`: 'points' for markout contrasts, 'ic' for dimensionless correlations. */
export function verdict(sym: string, h: number, train: Boot, valid: Boot, beatsTwin: boolean, kind: 'points' | 'ic' = 'points'): string {
  const eStar = kind === 'ic' ? PLAUSIBLE_IC : PLAUSIBLE_FRAC * RT_SD[sym]![h]!;
  const sameSign = Math.sign(train.est) === Math.sign(valid.est);
  if (excl0(train) && excl0(valid) && sameSign && beatsTwin) return 'EDGE';
  const mde = Z_MDE * valid.se;
  return mde > eStar ? `UNDERPOWERED (MDE ${mde.toFixed(kind === 'ic' ? 3 : 2)} > E* ${eStar.toFixed(kind === 'ic' ? 3 : 2)})` : 'NULL';
}
