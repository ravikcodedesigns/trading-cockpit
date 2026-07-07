// volume-profile.ts — CRACKER Phase 1.6: kernel-smoothed volume-at-price profile.
//
// ── FIRST PRIMITIVE REBUILT UNDER THE 2026-07-07 REBUILD DIRECTIVE ──
// Cracker-owned. Pure functions, no I/O, no book dependency. Nothing outside the
// Cracker pipeline may grow a dependency on this file.
//
// MODEL
//   The session's volume-at-price is treated as a weighted sample from an unknown
//   density f(p): trade i contributes weight sizeᵢ at price priceᵢ. The profile is
//   the Gaussian kernel density estimate
//       f̂(p) = Σᵢ wᵢ·K_h(p − priceᵢ) / Σᵢ wᵢ ,  K_h = Gaussian with bandwidth h,
//   evaluated exactly on the instrument's tick grid (weighted histogram → discrete
//   Gaussian convolution; the histogram is EXACT, only the smoothing is a choice).
//   POC/HVN = prominence-qualified local maxima of f̂; LVN = prominence-qualified
//   local minima strictly between the outermost HVNs. Per P0.4 (NQ twin-peak
//   instability) the deliverable is the HVN SET, never a single POC.
//
// BANDWIDTH — the one genuinely consequential estimator choice
//   Primary: Improved Sheather-Jones (Botev, Grotowski & Kroese 2010, "Kernel
//   density estimation via diffusion", Ann. Statist. 38(5)) — solves the fixed
//   point t = ξγ^[l](t) in the DCT domain. Chosen because volume profiles are
//   MULTIMODAL and Silverman's rule (normal reference) systematically oversmooths
//   multimodal densities, merging exactly the twin peaks P0.4 measured.
//   Weighted-data adaptation: the sample size entering the selector is Kish's
//   effective sample size n_eff = (Σw)²/Σw² (Kish 1965) — one 200-lot print is
//   one opinion, not 200 (same principle as the frozen P0.5 imbalance z).
//   Fallback (fixed point fails to bracket): weighted Silverman
//   h = 0.9·min(σ_w, IQR_w/1.34)·n_eff^(−1/5).
//   STRUCTURAL FLOOR: h = max(selector, H_FLOOR_PTS). On a liquid session n_eff
//   is ~10⁵ and the MISE-optimal h collapses below a tick — statistically optimal
//   for estimating f, wrong for STRUCTURE: it resolves every 15-min balance
//   wrinkle as its own "HVN". Verified empirically (2026-07-07 probe, 3 ref
//   days): h≈0.6pt fragments single shelves into 13–16 extrema (six "HVNs"
//   within one 60pt shelf), the plan-frozen ≈2pt scale yields 7–12 cleanly
//   separated shelves, 4pt merges real ones. The floor encodes the frozen
//   CRACKER_PLAN §1.6 "bandwidth ≈ 2 bins" (bin = 1pt, NQ); the selector still
//   adapts UPWARD on thin sessions. H_FLOOR_PTS is per-instrument (NQ 2.0;
//   set the ES value when Phase 1.7 turns the ES trace on). Ceiling: range/10.
//   Method used is reported on the output — never silent.
//
// FAILURE MODES (documented, guarded)
//   • Degenerate input (one price, zero volume, <MIN_DISTINCT prices) → null.
//   • Kernel edge artifacts → extrema within h of the grid edge are discarded.
//   • Micro-wiggle extrema on flat profiles → prominence filter (≥ PROM_FRAC of
//     the global density peak; the standard topographic-prominence definition).
//   • Plateaus (equal smoothed bins) → collapsed to their center index.
//   • ISJ fixed-point divergence on near-uniform data → detected, Silverman used.
//
// FROZEN PARAMETERS (VP_CFG) — sensitivity sweep deferred to Phase 8 per plan §0.
// Pre-registered 2026-07-07 BEFORE any factor test consumed HVN/LVN outcomes.
//
// The 1R helper implements the frozen stop rule (CRACKER_PLAN §1 correction row):
//   1R = max(distance to 1 tick beyond the nearest LVN behind the level, σ_ev·√h_ref)
// "Behind" = the stop side. LVNs farther than STRUCT_WINDOW_R × σ-floor carry no
// structural information for this trade → σ-floor applies (documented completion
// of the under-specified frozen text; recorded in the ledger).

export const VP_CFG = {
  GRID_N: 512,          // DCT grid for bandwidth selection (power of two)
  PAD_FRAC: 0.10,       // Botev range padding on each side for the DCT grid
  KERNEL_TRUNC: 5,      // Gaussian support truncation, in units of h
  PROM_FRAC: 0.10,      // extremum qualifies at prominence ≥ 10% of global peak
  H_FLOOR_PTS: 2.0,     // structural bandwidth floor, points (NQ; per-instrument)
  H_HI_FRAC: 0.10,      // bandwidth clamp ceiling (fraction of price range)
  MIN_DISTINCT: 24,     // minimum distinct price levels for a meaningful profile
  VA_FRAC: 0.70,        // value area volume fraction (DESCRIPTIVE ONLY, plan §1 note)
  STRUCT_WINDOW_R: 5,   // structural-stop LVN search window, in σ-floor units
};
export type VpCfg = typeof VP_CFG;

export interface ProfileNode { price: number; density: number; prominence: number; }

export interface VolumeProfile {
  poc: number;                  // price of the global density maximum
  hvns: ProfileNode[];          // qualifying maxima, prominence-desc (poc included, first)
  lvns: ProfileNode[];          // qualifying minima between the outermost HVNs
  vaLo: number; vaHi: number;   // 70% value area (descriptive only)
  bandwidth: number;            // points
  bandwidthMethod: 'isj' | 'silverman';
  nEff: number;                 // Kish effective sample size
  totVol: number;
  gridLo: number; gridHi: number;
  density: Float64Array;        // smoothed volume per tick bin, index 0 = gridLo
}

export interface ProfileInput {
  /** Exact volume-at-price histogram (e.g. GROUP BY price from the trades store). */
  pxVol: Array<{ price: number; vol: number }>;
  /** Σ size over the SAME trades (for weights). */
  totVol: number;
  /** Σ size² over the SAME trades (for Kish n_eff). */
  totVolSq: number;
  tick: number;
}

// ── weighted moments / quantiles (histogram domain) ──────────────────────────
function weightedStats(pxVol: Array<{ price: number; vol: number }>, totVol: number) {
  let mu = 0;
  for (const b of pxVol) mu += b.price * b.vol;
  mu /= totVol;
  let varW = 0;
  for (const b of pxVol) varW += b.vol * (b.price - mu) ** 2;
  varW /= totVol;
  const sorted = [...pxVol].sort((a, b) => a.price - b.price);
  const q = (frac: number): number => {
    let acc = 0;
    const target = frac * totVol;
    for (const b of sorted) { acc += b.vol; if (acc >= target) return b.price; }
    return sorted[sorted.length - 1]!.price;
  };
  return { sigma: Math.sqrt(varW), iqr: q(0.75) - q(0.25) };
}

// ── DCT-II (scipy type-2 convention, unnormalized: y_k = 2·Σ x_n cos(πk(2n+1)/2N)) ──
// Direct O(N²) — N = 512, once per profile; a transform library is not worth the
// dependency. a2 (Botev's squared half-coefficients) is what the fixed point needs.
function dctA2(x: Float64Array): Float64Array {
  const N = x.length;
  const a2 = new Float64Array(N - 1);
  for (let k = 1; k < N; k++) {
    let s = 0;
    const w = (Math.PI * k) / (2 * N);
    for (let n = 0; n < N; n++) s += x[n]! * Math.cos(w * (2 * n + 1));
    a2[k - 1] = s * s;                       // (y_k / 2)² with the factor-2 convention
  }
  return a2;
}

// ── Botev fixed point: returns t − ξγ^[l](t); root in t is the ISJ solution ──
function botevFixedPoint(t: number, nEff: number, I2: Float64Array, a2: Float64Array): number {
  const L = 7;
  let f = 0;
  for (let i = 0; i < a2.length; i++)
    f += Math.pow(I2[i]!, L) * a2[i]! * Math.exp(-I2[i]! * Math.PI * Math.PI * t);
  f *= 2 * Math.pow(Math.PI, 2 * L);
  for (let s = L - 1; s >= 2; s--) {
    let K0 = 1;
    for (let j = 1; j <= 2 * s - 1; j += 2) K0 *= j;          // (2s−1)!!
    K0 /= Math.sqrt(2 * Math.PI);
    const cnst = (1 + Math.pow(0.5, s + 0.5)) / 3;
    const time = Math.pow((2 * cnst * K0) / (nEff * f), 2 / (3 + 2 * s));
    f = 0;
    for (let i = 0; i < a2.length; i++)
      f += Math.pow(I2[i]!, s) * a2[i]! * Math.exp(-I2[i]! * Math.PI * Math.PI * time);
    f *= 2 * Math.pow(Math.PI, 2 * s);
  }
  if (!isFinite(f) || f <= 0) return NaN;
  return t - Math.pow(2 * nEff * Math.sqrt(Math.PI) * f, -2 / 5);
}

/** ISJ bandwidth on [0,1]-scaled data; returns h in scaled units, or null if the
 *  fixed point cannot be bracketed (near-uniform / degenerate spectra). */
function isjBandwidthScaled(hist01: Float64Array, nEff: number): number | null {
  const a2 = dctA2(hist01);
  const I2 = new Float64Array(a2.length);
  for (let i = 0; i < I2.length; i++) I2[i] = (i + 1) * (i + 1);
  // bracket the root: f(t) is negative near 0⁺ and crosses once for well-behaved spectra
  let lo = -1, hi = -1, prev = NaN;
  for (let e = -28; e <= 0; e += 0.5) {
    const t = Math.pow(2, e);
    const v = botevFixedPoint(t, nEff, I2, a2);
    if (!isFinite(v)) { prev = NaN; continue; }
    if (isFinite(prev) && prev < 0 && v >= 0) { lo = Math.pow(2, e - 0.5); hi = t; break; }
    prev = v;
  }
  if (lo < 0) return null;
  for (let it = 0; it < 64; it++) {
    const mid = 0.5 * (lo + hi);
    const v = botevFixedPoint(mid, nEff, I2, a2);
    if (!isFinite(v)) return null;
    if (v < 0) lo = mid; else hi = mid;
  }
  const tStar = 0.5 * (lo + hi);
  return tStar > 0 ? Math.sqrt(tStar) : null;
}

// ── prominence-qualified extrema ──────────────────────────────────────────────
// Standard topographic prominence: walk from a peak in each direction to the first
// STRICTLY higher bin, tracking the lowest saddle passed; prominence = peak −
// max(leftSaddle, rightSaddle). Side with no higher bin uses that side's global
// minimum (signal-edge convention, as in scipy.signal.peak_prominences).
function extremaWithProminence(y: Float64Array): Array<{ idx: number; val: number; prom: number; isMax: boolean }> {
  const n = y.length;
  const out: Array<{ idx: number; val: number; prom: number; isMax: boolean }> = [];
  const peaks: Array<{ idx: number; isMax: boolean }> = [];
  let i = 1;
  while (i < n - 1) {
    if (y[i]! === y[i - 1]!) { i++; continue; }        // plateau interior — handled at entry
    let j = i;
    while (j + 1 < n && y[j + 1]! === y[j]!) j++;      // plateau [i..j]
    const leftUp = y[i]! > y[i - 1]!;
    if (j + 1 >= n) break;
    const rightDown = y[j + 1]! < y[j]!;
    if (leftUp && rightDown) peaks.push({ idx: (i + j) >> 1, isMax: true });
    if (!leftUp && !rightDown) peaks.push({ idx: (i + j) >> 1, isMax: false });
    i = j + 1;
  }
  for (const p of peaks) {
    const v = y[p.idx]!;
    const sgn = p.isMax ? 1 : -1;                       // minima: prominence on −y
    let saddleL = sgn * v, saddleR = sgn * v;
    for (let k = p.idx - 1; k >= 0; k--) {
      if (sgn * y[k]! > sgn * v) break;
      saddleL = Math.min(saddleL, sgn * y[k]!);
    }
    for (let k = p.idx + 1; k < n; k++) {
      if (sgn * y[k]! > sgn * v) break;
      saddleR = Math.min(saddleR, sgn * y[k]!);
    }
    out.push({ idx: p.idx, val: v, prom: sgn * v - Math.max(saddleL, saddleR), isMax: p.isMax });
  }
  return out;
}

// ── the profile ───────────────────────────────────────────────────────────────
export function computeProfile(input: ProfileInput, cfg: VpCfg = VP_CFG): VolumeProfile | null {
  const { pxVol, totVol, totVolSq, tick } = input;
  if (!pxVol.length || totVol <= 0 || totVolSq <= 0 || tick <= 0) return null;
  const nEff = (totVol * totVol) / totVolSq;

  // exact tick-grid histogram
  let lo = Infinity, hi = -Infinity;
  for (const b of pxVol) { if (b.price < lo) lo = b.price; if (b.price > hi) hi = b.price; }
  if (!(hi > lo)) return null;
  const loI = Math.round(lo / tick), hiI = Math.round(hi / tick);
  const W = hiI - loI + 1;
  if (W > 200_000) return null;                        // corrupt-input guard (range explosion)
  const hist = new Float64Array(W);
  let distinct = 0;
  for (const b of pxVol) {
    const k = Math.round(b.price / tick) - loI;
    if (k < 0 || k >= W) continue;
    if (hist[k] === 0 && b.vol > 0) distinct++;
    hist[k]! += b.vol;
  }
  if (distinct < cfg.MIN_DISTINCT) return null;

  // ── bandwidth ──
  const range = hi - lo;
  const padded = range * (1 + 2 * cfg.PAD_FRAC);
  const gLo = lo - range * cfg.PAD_FRAC;
  const hist01 = new Float64Array(cfg.GRID_N);
  for (const b of pxVol) {
    const k = Math.min(cfg.GRID_N - 1, Math.max(0, Math.floor(((b.price - gLo) / padded) * cfg.GRID_N)));
    hist01[k]! += b.vol / totVol;
  }
  let h: number | null = null;
  let method: 'isj' | 'silverman' = 'isj';
  const hScaled = isjBandwidthScaled(hist01, nEff);
  if (hScaled != null) h = hScaled * padded;
  if (h == null || !isFinite(h) || h <= 0) {
    method = 'silverman';
    const { sigma, iqr } = weightedStats(pxVol, totVol);
    const spread = iqr > 0 ? Math.min(sigma, iqr / 1.34) : sigma;
    h = 0.9 * spread * Math.pow(nEff, -1 / 5);
  }
  h = Math.min(Math.max(h, cfg.H_FLOOR_PTS, 2 * tick), range * cfg.H_HI_FRAC);

  // ── density: discrete Gaussian convolution of the EXACT tick histogram ──
  const hBins = h / tick;
  const half = Math.max(1, Math.ceil(cfg.KERNEL_TRUNC * hBins));
  const kernel = new Float64Array(2 * half + 1);
  let kSum = 0;
  for (let k = -half; k <= half; k++) { const v = Math.exp(-0.5 * (k / hBins) ** 2); kernel[k + half] = v; kSum += v; }
  for (let k = 0; k < kernel.length; k++) kernel[k]! /= kSum;
  const density = new Float64Array(W);
  for (let iSrc = 0; iSrc < W; iSrc++) {
    const v = hist[iSrc]!;
    if (v === 0) continue;
    const a = Math.max(0, iSrc - half), b = Math.min(W - 1, iSrc + half);
    for (let iDst = a; iDst <= b; iDst++) density[iDst]! += v * kernel[iDst - iSrc + half]!;
  }

  // ── extrema ──
  let gMax = 0, pocIdx = 0;
  for (let k = 0; k < W; k++) if (density[k]! > gMax) { gMax = density[k]!; pocIdx = k; }
  if (gMax <= 0) return null;
  const promMin = cfg.PROM_FRAC * gMax;
  const edge = Math.ceil(hBins);                       // kernel edge-artifact zone
  const ex = extremaWithProminence(density).filter((e) => e.idx >= edge && e.idx < W - edge);

  const hvns: ProfileNode[] = ex
    .filter((e) => e.isMax && (e.prom >= promMin || e.idx === pocIdx))
    .map((e) => ({ price: (loI + e.idx) * tick, density: e.val, prominence: e.prom }));
  if (!hvns.length)                                     // POC sat inside the edge zone — keep it anyway
    hvns.push({ price: (loI + pocIdx) * tick, density: gMax, prominence: gMax });
  hvns.sort((a, b) => b.prominence - a.prominence);
  const pocPrice = (loI + pocIdx) * tick;
  const pocPos = hvns.findIndex((n) => n.price === pocPrice);
  if (pocPos > 0) { const [p] = hvns.splice(pocPos, 1); hvns.unshift(p!); }

  const hvnLo = Math.min(...hvns.map((n) => n.price)), hvnHi = Math.max(...hvns.map((n) => n.price));
  const lvns: ProfileNode[] = ex
    .filter((e) => !e.isMax && e.prom >= promMin)
    .map((e) => ({ price: (loI + e.idx) * tick, density: e.val, prominence: e.prom }))
    .filter((n) => n.price > hvnLo && n.price < hvnHi)  // LVN is only meaningful BETWEEN volume shelves
    .sort((a, b) => b.prominence - a.prominence);

  // ── value area (descriptive only) ──
  let vaSum = density[pocIdx]!, aVA = pocIdx, bVA = pocIdx;
  let dTot = 0; for (let k = 0; k < W; k++) dTot += density[k]!;
  while (vaSum < cfg.VA_FRAC * dTot && (aVA > 0 || bVA < W - 1)) {
    const dn = aVA > 0 ? density[aVA - 1]! : -1;
    const up = bVA < W - 1 ? density[bVA + 1]! : -1;
    if (up >= dn) { bVA++; vaSum += up; } else { aVA--; vaSum += dn; }
  }

  return {
    poc: pocPrice, hvns, lvns,
    vaLo: (loI + aVA) * tick, vaHi: (loI + bVA) * tick,
    bandwidth: h, bandwidthMethod: method, nEff, totVol,
    gridLo: loI * tick, gridHi: hiI * tick, density,
  };
}

// ── structural 1R (frozen stop rule) ─────────────────────────────────────────
/** Distance from `entry` to 1 tick beyond the nearest LVN behind `level` on the
 *  stop side. `dir` = trade direction (+1 long → stop below, −1 short → stop
 *  above). LVNs beyond STRUCT_WINDOW_R·σfloor of the level are ignored (no
 *  structural anchor → caller falls back to the σ floor). Returns null when no
 *  qualifying LVN exists or the geometry is degenerate (LVN not beyond entry). */
export function structuralStopDist(
  lvns: number[], level: number, entry: number, dir: 1 | -1, sigmaFloor: number, tick: number, cfg: VpCfg = VP_CFG,
): number | null {
  const win = cfg.STRUCT_WINDOW_R * sigmaFloor;
  let best: number | null = null;
  for (const p of lvns) {
    if (dir > 0 ? p >= level : p <= level) continue;          // must be BEHIND the level
    if (Math.abs(level - p) > win) continue;                  // outside the structural window
    if (best == null || Math.abs(level - p) < Math.abs(level - best)) best = p;
  }
  if (best == null) return null;
  const stopPx = dir > 0 ? best - tick : best + tick;
  const dist = dir > 0 ? entry - stopPx : stopPx - entry;
  return dist > 0 ? dist : null;
}
