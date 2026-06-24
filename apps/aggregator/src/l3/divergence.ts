// divergence.ts — the microstructure math for the DDA (distribution/accumulation) episode
// detector. PURE functions, no I/O, no book dependency → fully unit-testable in isolation.
//
// First principle: distribution = large signed order flow that FAILS to move price (absorption).
// So we measure price-impact-per-flow directly, not a CVD chart-slope.
//   - OFI (Order Flow Imbalance) — Cont, Kukanov & Stoikov (2014): signed flow from best-bid/ask
//     size+price changes (leads price more than executed CVD).
//   - Kyle's λ — Kyle (1985): Δmid = λ·OFI. λ is the price-impact coefficient; LOW/collapsing λ at a
//     level = flow absorbed = distribution/accumulation. Reported WITH its standard error.
//   - Mann-Kendall + Theil-Sen — robust, non-parametric trend (is λ collapsing / wall depleting
//     across retests?) without magnitude thresholds.
//   - CUSUM — online change-point: WHEN does the price↔flow relationship break.
// Every cutoff is dimensionless (Z, σ-units). No fixed price/volume magnitudes.

// ── OFI (Cont–Kukanov–Stoikov) ───────────────────────────────────────────────
// Per consecutive best-quote snapshot, the order-flow contribution e_n:
//   bid: P^b↑ → +q^b_n ;  P^b↓ → −q^b_{n-1} ;  P^b= → +(q^b_n − q^b_{n-1})
//   ask: P^a↓ → −q^a_n ;  P^a↑ → +q^a_{n-1} ;  P^a= → −(q^a_n − q^a_{n-1})
//   e_n = bid + ask.  OFI(window) = Σ e_n.  (+ve = net buy pressure.)
export interface Quote { bidPx: number; bidSz: number; askPx: number; askSz: number; }

export function ofiStep(prev: Quote, cur: Quote): number {
  let bid: number;
  if (cur.bidPx > prev.bidPx) bid = cur.bidSz;
  else if (cur.bidPx < prev.bidPx) bid = -prev.bidSz;
  else bid = cur.bidSz - prev.bidSz;
  let ask: number;
  if (cur.askPx < prev.askPx) ask = -cur.askSz;
  else if (cur.askPx > prev.askPx) ask = prev.askSz;
  else ask = -(cur.askSz - prev.askSz);
  return bid + ask;
}

/** OFI series (one value per quote transition) from a sequence of best quotes. */
export function ofiSeries(quotes: Quote[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < quotes.length; i++) out.push(ofiStep(quotes[i - 1]!, quotes[i]!));
  return out;
}

const mid = (q: Quote) => (q.bidPx + q.askPx) / 2;

// ── Kyle's λ : Δmid = α + λ·OFI ───────────────────────────────────────────────
// OLS slope with intercept; returns λ, its standard error, t-stat, and R². Aggregate the
// per-step OFI and Δmid over the window and regress. n<3 → null (can't estimate).
export interface Lambda { lambda: number; se: number; t: number; r2: number; n: number; }

/** OLS slope-with-intercept of y on x → {λ=slope, SE, t, R²}. The core estimator (testable directly). */
export function regress(x: number[], y: number[]): Lambda | null {
  const n = x.length;
  if (n < 3 || y.length !== n) return null;
  const mx = mean(x), my = mean(y);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (x[i]! - mx) ** 2; sxy += (x[i]! - mx) * (y[i]! - my); }
  if (sxx === 0) return null;                       // no order-flow variation → undefined impact
  const lambda = sxy / sxx;
  const alpha = my - lambda * mx;
  let ssr = 0, sst = 0;
  for (let i = 0; i < n; i++) { const e = y[i]! - (alpha + lambda * x[i]!); ssr += e * e; sst += (y[i]! - my) ** 2; }
  const se = n > 2 ? Math.sqrt((ssr / (n - 2)) / sxx) : Infinity;
  return { lambda, se, t: se > 0 && isFinite(se) ? lambda / se : 0, r2: sst > 0 ? 1 - ssr / sst : 0, n };
}

export function kyleLambda(quotes: Quote[]): Lambda | null {
  if (quotes.length - 1 < 3) return null;
  const x: number[] = [], y: number[] = [];
  for (let i = 1; i < quotes.length; i++) { x.push(ofiStep(quotes[i - 1]!, quotes[i]!)); y.push(mid(quotes[i]!) - mid(quotes[i - 1]!)); }
  return regress(x, y);
}

// ── Mann-Kendall non-parametric trend test (with ties correction) ─────────────
// S = Σ_{i<j} sgn(x_j − x_i). Z standardized. |Z|>1.96 ≈ 95% significant. Returns Z and dir.
export interface MK { S: number; z: number; dir: -1 | 0 | 1; n: number; }

export function mannKendall(v: number[]): MK {
  const n = v.length;
  if (n < 3) return { S: 0, z: 0, dir: 0, n };
  let S = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) S += Math.sign(v[j]! - v[i]!);
  // variance with ties correction
  const counts = new Map<number, number>();
  for (const x of v) counts.set(x, (counts.get(x) ?? 0) + 1);
  let tie = 0;
  for (const t of counts.values()) tie += t * (t - 1) * (2 * t + 5);
  const varS = (n * (n - 1) * (2 * n + 5) - tie) / 18;
  const z = varS <= 0 ? 0 : S > 0 ? (S - 1) / Math.sqrt(varS) : S < 0 ? (S + 1) / Math.sqrt(varS) : 0;
  return { S, z, dir: z > 0 ? 1 : z < 0 ? -1 : 0, n };
}

// ── Theil-Sen robust slope (median of pairwise slopes vs index) ───────────────
export function theilSen(v: number[]): number {
  const n = v.length;
  if (n < 2) return 0;
  const slopes: number[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) slopes.push((v[j]! - v[i]!) / (j - i));
  return median(slopes);
}

// ── CUSUM change-point (standardized, two-sided) ──────────────────────────────
// Standardize x against a reference (mean,std), then accumulate. Fires when |S| > h (in σ-units).
// k = slack (drift tolerance), h = decision interval — both DIMENSIONLESS, the standard design knobs.
export interface CusumHit { fired: boolean; dir: -1 | 0 | 1; atIndex: number; peak: number; }

export function cusum(v: number[], refMean: number, refStd: number, k = 0.5, h = 4): CusumHit {
  if (refStd <= 0 || v.length === 0) return { fired: false, dir: 0, atIndex: -1, peak: 0 };
  let sHi = 0, sLo = 0, peak = 0;
  for (let i = 0; i < v.length; i++) {
    const z = (v[i]! - refMean) / refStd;
    sHi = Math.max(0, sHi + z - k);
    sLo = Math.max(0, sLo - z - k);
    if (sHi > h) return { fired: true, dir: 1, atIndex: i, peak: sHi };
    if (sLo > h) return { fired: true, dir: -1, atIndex: i, peak: sLo };
    peak = Math.max(peak, sHi, sLo);
  }
  return { fired: false, dir: 0, atIndex: -1, peak };
}

// ── Episode classification ────────────────────────────────────────────────────
// One feature row per completed retest of a level (built by episode-tracker.ts from the book).
export interface RetestFeatures {
  lambda: number;        // Kyle's λ measured during this retest (price-impact-per-OFI)
  ofiNet: number;        // net OFI during the retest (+ = buyers aggressing)
  priceExtreme: number;  // the retest's penetration extreme (high for a resistance test, low for support)
  wall: number;          // defending-side resting size at the level
  absorbedVol: number;   // volume traded into the level
  reclaim: number;       // exit direction: +1 = exited back ABOVE the level (reclaim), -1 = exited below.
                         // This — not "no lower lows" — is the rejection signal: a spring/upthrust
                         // pokes through the level (a new extreme) yet exits back the other way.
}

export type EpisodeState = 'DISTRIBUTION' | 'ACCUMULATION' | 'HOLDING' | 'BREAKING' | 'NEUTRAL';
export interface EpisodeVerdict {
  state: EpisodeState;
  confidence: number;          // 0..1, from the strength of the evidence (MK |z|, λ-collapse ratio)
  evidence: Record<string, number>;
  note: string;
}

export interface ClassifyCtx {
  side: 'resistance' | 'support';  // is the level being tested from below (res) or above (sup)?
  baselineLambda: number;          // prevailing λ away from the level — "collapse" is relative to this
  zSig?: number;                   // dimensionless MK significance cutoff (default 1.64 ≈ 90%)
  lambdaCollapse?: number;         // λ < this × baseline counts as absorption (default 0.5)
}

export function classifyEpisode(retests: RetestFeatures[], ctx: ClassifyCtx): EpisodeVerdict {
  const k = retests.length;
  const zSig = ctx.zSig ?? 1.64;
  const collapseRatio = ctx.lambdaCollapse ?? 0.5;
  if (k < 3) return { state: 'NEUTRAL', confidence: 0, evidence: { retests: k }, note: 'too few retests' };

  const lambdas = retests.map(r => r.lambda);
  const walls = retests.map(r => r.wall);
  const ofiNet = retests.reduce((s, r) => s + r.ofiNet, 0);
  const medLambda = median(lambdas);
  const lambdaRatio = ctx.baselineLambda > 0 ? medLambda / ctx.baselineLambda : 1;  // <1 = absorbing

  const mkLambda = mannKendall(lambdas);     // λ declining across retests?
  const mkWall = mannKendall(walls);         // wall depleting?

  const absorbing = lambdaRatio < collapseRatio || (mkLambda.dir < 0 && Math.abs(mkLambda.z) > zSig);
  const depleting = mkWall.dir < 0 && Math.abs(mkWall.z) > zSig;
  // netReclaim = mean exit direction across retests. +1 = price keeps reclaiming back ABOVE the level
  // (downside rejected), -1 = price keeps getting rejected back BELOW it (upside rejected). THIS is the
  // generic rejection signal — it admits springs (lower-low wick that reclaims) and upthrusts (higher-
  // high wick that rejects), which the old "no lower/higher highs" extreme-trend gate threw away.
  const netReclaim = mean(retests.map(r => r.reclaim));
  const reclaimStrength = Math.abs(netReclaim);                                          // 0..1 consistency
  const conf = (raw: number) => Math.max(0, Math.min(1, raw));
  // Confidence LEADS with λ-collapse trend significance (self-referential — the rolling baseline λ is
  // contaminated by at-level quotes), gated by how consistently price rejected/reclaimed: need BOTH.
  const trendStrength = conf(Math.abs(mkLambda.z) / 2);                                  // |z|≈2 (95%) → full
  const ratioStrength = ctx.baselineLambda > 0 ? conf((collapseRatio - lambdaRatio) / collapseRatio) : 0;
  const absorptionStrength = Math.max(trendStrength, ratioStrength);
  const strength = conf(absorptionStrength * (0.5 + 0.5 * reclaimStrength));
  const ev = { retests: k, lambdaRatio: +lambdaRatio.toFixed(3), zLambda: +mkLambda.z.toFixed(2),
    netReclaim: +netReclaim.toFixed(2), zWall: +mkWall.z.toFixed(2), ofiNet: Math.round(ofiNet) };
  const absNote = lambdaRatio < collapseRatio ? `λ ${(lambdaRatio * 100).toFixed(0)}% of baseline` : `λ collapsing (z${mkLambda.z.toFixed(1)})`;

  // DISTRIBUTION: buyers aggress into resistance (OFI>0) but price is REJECTED back down (exits below,
  // netReclaim<0 — covers flat-high holds AND upthrust pokes) and the buying is absorbed (low λ).
  if (ctx.side === 'resistance' && ofiNet > 0 && netReclaim < 0 && absorbing) {
    return { state: 'DISTRIBUTION', confidence: strength, evidence: ev,
      note: `buyers absorbed + rejected at resistance: OFI+${Math.round(ofiNet)}, ${(-netReclaim * 100).toFixed(0)}% exits down, ${absNote}${depleting ? ', wall depleting' : ''}` };
  }
  // ACCUMULATION: sellers aggress into support (OFI<0) but price RECLAIMS (exits above, netReclaim>0 —
  // covers flat-low holds AND spring pokes) and the selling is absorbed.
  if (ctx.side === 'support' && ofiNet < 0 && netReclaim > 0 && absorbing) {
    return { state: 'ACCUMULATION', confidence: strength, evidence: ev,
      note: `sellers absorbed + reclaimed at support: OFI${Math.round(ofiNet)}, ${(netReclaim * 100).toFixed(0)}% exits up, ${absNote}` };
  }
  // BREAKING: price exits THROUGH the level (resistance→up / support→down) consistently, with HEALTHY
  // impact (λ not collapsed) — a genuine break, not absorption.
  const through = (ctx.side === 'resistance' && netReclaim > 0) || (ctx.side === 'support' && netReclaim < 0);
  if (through && lambdaRatio >= collapseRatio && reclaimStrength >= 0.5) {
    return { state: 'BREAKING', confidence: conf(reclaimStrength), evidence: ev,
      note: `decisive follow-through ${ctx.side === 'resistance' ? 'up' : 'down'} (${(reclaimStrength * 100).toFixed(0)}% exits through), λ healthy` };
  }
  // HOLDING: price is rejected/bounced back (resistance→down / support→up) with HEALTHY impact and no
  // special absorption — the level defends normally (distinct from DISTRIBUTION/ACCUMULATION, which add
  // absorbed aggressive flow on top of the rejection).
  const defended = (ctx.side === 'resistance' && netReclaim < 0) || (ctx.side === 'support' && netReclaim > 0);
  if (defended && lambdaRatio >= collapseRatio) {
    return { state: 'HOLDING', confidence: 0.3, evidence: ev, note: 'level defended, normal impact' };
  }
  return { state: 'NEUTRAL', confidence: 0, evidence: ev, note: 'no decisive signature' };
}

// ── small stats helpers ───────────────────────────────────────────────────────
export function mean(v: number[]): number { return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; }
export function std(v: number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v); return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}
export function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b); const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
