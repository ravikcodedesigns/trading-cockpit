// intensity.ts — event-arrival intensity estimation (the Hawkes-process frame, made live-cheap).
//
// A stop cascade is a SELF-EXCITING burst: each triggered stop moves price into the next pocket
// of stops, so events cause further events. In the Hawkes model the arrival intensity is
//   λ(t) = μ + Σ_{t_i < t} (1/τ)·e^{−(t−t_i)/τ}
// and a cascade is a period where the self-excited part dominates the exogenous rate μ
// (Filimonov & Sornette 2012 measured exactly this "reflexivity" on the E-mini). Full MLE fits
// are not live-tractable per tick, so we use the standard streaming reduction: TWO exponential-
// kernel estimators of the same arrival stream —
//   fast (τ_f ~ 1s)  ≈ instantaneous intensity λ(t)
//   slow (τ_s ~ 60s) ≈ local exogenous baseline μ̂
// For a stationary (Poisson) stream both converge to the true rate → ratio ≈ 1. In a self-
// exciting burst the fast estimator explodes ahead of the slow one → the BURST RATIO λ̂_f/λ̂_s is
// a direct, dimensionless self-excitation score, O(1) per event, exact on irregular arrivals.
//
// PURE math, no I/O — unit-tested in scripts/tape_unit_tests.ts.

export interface Intensity {
  lam: number;      // kernel-weighted rate estimate at lastTs (events per ms)
  lastTs: number;   // ts of the last arrival (0 = no arrivals yet)
  n: number;        // total arrivals observed (baseline-maturity check)
}

export function newIntensity(): Intensity { return { lam: 0, lastTs: 0, n: 0 }; }

/** Register one arrival at `ts` (ms) under an exponential kernel with e-folding `tauMs`. */
export function arrive(i: Intensity, ts: number, tauMs: number): void {
  if (i.lastTs > 0 && ts > i.lastTs) i.lam *= Math.exp(-(ts - i.lastTs) / tauMs);
  i.lam += 1 / tauMs;   // unit kernel mass → λ in events/ms; E[λ̂] = true rate for Poisson input
  i.lastTs = Math.max(i.lastTs, ts);
  i.n++;
}

/** Intensity decayed to `ts` without registering an arrival. */
export function rateAt(i: Intensity, ts: number, tauMs: number): number {
  if (i.lastTs === 0) return 0;
  return ts > i.lastTs ? i.lam * Math.exp(-(ts - i.lastTs) / tauMs) : i.lam;
}

/**
 * Burst ratio λ̂_fast / λ̂_slow at `ts` — the self-excitation score. Evaluated at ARRIVAL instants
 * (right-limit, self-mass included) since that is when qualification runs: steady deterministic
 * flow reads ≈1.5–2 under this convention (not 1 — the fast kernel keeps more of its just-added
 * mass), a genuine cascade reads 20–40+. The gate threshold is therefore EMPIRICAL, calibrated
 * from the recorded stoprun_burst distribution, not assumed from the Poisson ideal. Returns null
 * while the slow baseline is immature (< minBaseN arrivals): a gate must not bind blind.
 */
export function burstRatio(fast: Intensity, slow: Intensity, ts: number, tauFastMs: number, tauSlowMs: number, minBaseN: number): number | null {
  if (slow.n < minBaseN) return null;
  const s = rateAt(slow, ts, tauSlowMs);
  if (s <= 0) return null;
  return rateAt(fast, ts, tauFastMs) / s;
}
