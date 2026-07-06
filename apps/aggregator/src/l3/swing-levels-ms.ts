// swing-levels-ms.ts — MULTI-SCALE swing detector (v2 of swing-levels.ts).
//
// Fixes the granularity drift of v1 (δ = 3×a 2-min reactive vol → collapsed in
// quiet stretches spawning noise-swings, ballooned in bursts missing structure).
// Locked design (decision #5):
//   • STABLE base vol — a session-anchored, slow measure (not a 2-min window),
//     supplied by the caller; we FLOOR and CAP it here so δ can never collapse
//     (kills micro-noise swings) or explode (kills missed structure).
//   • MULTI-SCALE — run independent zigzags at several scales (fine/med/coarse)
//     so we never pick one granularity; a swing's SCALE is a significance signal.
//   • LEG-RELATIVE threshold — a reversal confirms when the pullback exceeds
//     δ = max(scaleMult × baseVol, RETRACE_FRAC × impulseLeg). The leg-relative
//     term makes it scale-free (matches how a trader reads a swing: a pullback
//     relative to the move that made it) and prevents over-detecting inside big trends.
//
// A swing high/low is the fossil of a prior absorption/reversal — a supply/demand
// zone. This module is ONLY the level SOURCE; zone width + significance come from
// the footprint/heatmap at formation (a separate layer).

export interface MSSwing {
  price: number; ts: number; kind: 'high' | 'low';
  scale: number;       // scale index (0=finest); higher = bigger/more significant swing
  legSize: number;     // size of the impulse leg that produced the reversal (points)
}

const MS_CFG = {
  // scale multipliers on the (floored/capped) base vol. 3 scales: fine, medium, coarse.
  SCALES: [1.5, 3.0, 6.0],
  RETRACE_FRAC: 0.5,   // a swing also needs the pullback ≥ this fraction of the impulse leg …
  DELTA_CAP: [40, 90, 180],   // … but δ is CAPPED per scale so a big trend leg can't inflate it
                              // unbounded (else a 900pt down-leg demands a 450pt bounce → no swing
                              // confirms for the whole move). Points.
  BASE_FLOOR: 2.0,     // base vol never below this (points) — no noise-swings in dead tape
  BASE_CAP: 40.0,      // base vol never above this (points) — a spike can't blank out structure
  DEDUP_FRAC: 0.5,     // within a scale, a same-kind swing within DEDUP_FRAC×δ is a duplicate
  MAX_PER_SCALE: 60,
};
export type MSCfg = typeof MS_CFG;

interface Leg { dir: 1 | -1 | 0; extPrice: number; extTs: number; legStart: number; }

export class MultiScaleSwingDetector {
  private cfg: MSCfg;
  private legs: Leg[];                 // one zigzag state per scale
  private swings: MSSwing[][];         // confirmed swings per scale

  constructor(cfg?: Partial<MSCfg>) {
    this.cfg = { ...MS_CFG, ...cfg };
    this.legs = this.cfg.SCALES.map(() => ({ dir: 0, extPrice: NaN, extTs: 0, legStart: NaN }));
    this.swings = this.cfg.SCALES.map(() => []);
  }

  /** Feed a price sample. `baseVol` = the caller's stable session-anchored vol (points).
   *  Returns any swings newly CONFIRMED this tick across all scales. */
  update(price: number, ts: number, baseVol: number): MSSwing[] {
    const base = Math.min(this.cfg.BASE_CAP, Math.max(this.cfg.BASE_FLOOR, baseVol));
    const out: MSSwing[] = [];
    for (let s = 0; s < this.cfg.SCALES.length; s++) {
      const L = this.legs[s]!;
      if (L.dir === 0 || !isFinite(L.extPrice)) { L.dir = 1; L.extPrice = price; L.extTs = ts; L.legStart = price; continue; }
      const legSize = Math.abs(L.extPrice - L.legStart);
      const delta = Math.min(this.cfg.DELTA_CAP[s]!, Math.max(this.cfg.SCALES[s]! * base, this.cfg.RETRACE_FRAC * legSize));
      if (L.dir === 1) {
        if (price > L.extPrice) { L.extPrice = price; L.extTs = ts; }
        else if (price <= L.extPrice - delta) { const sw = this.commit(s, 'high', delta, legSize); if (sw) out.push(sw); L.legStart = L.extPrice; L.dir = -1; L.extPrice = price; L.extTs = ts; }
      } else {
        if (price < L.extPrice) { L.extPrice = price; L.extTs = ts; }
        else if (price >= L.extPrice + delta) { const sw = this.commit(s, 'low', delta, legSize); if (sw) out.push(sw); L.legStart = L.extPrice; L.dir = 1; L.extPrice = price; L.extTs = ts; }
      }
    }
    return out;
  }

  private commit(s: number, kind: 'high' | 'low', delta: number, legSize: number): MSSwing | null {
    const L = this.legs[s]!;
    const sw: MSSwing = { price: L.extPrice, ts: L.extTs, kind, scale: s, legSize };
    const arr = this.swings[s]!;
    if (arr.some((x) => x.kind === kind && Math.abs(x.price - sw.price) <= this.cfg.DEDUP_FRAC * delta)) return null;
    arr.push(sw);
    if (arr.length > this.cfg.MAX_PER_SCALE) arr.shift();
    return sw;
  }

  /** All confirmed swings across scales (each tagged with its scale). */
  all(): MSSwing[] { return this.swings.flat().sort((a, b) => a.ts - b.ts); }

  /** Merge across scales into unique price levels, tagging each with its MAX scale
   *  (a level that's a swing at a coarse scale is more significant). */
  levels(mergePts: number): { price: number; kind: 'high' | 'low'; maxScale: number; ts: number }[] {
    const merged: { price: number; kind: 'high' | 'low'; maxScale: number; ts: number }[] = [];
    for (const sw of this.all()) {
      const hit = merged.find((m) => m.kind === sw.kind && Math.abs(m.price - sw.price) <= mergePts);
      if (hit) { hit.maxScale = Math.max(hit.maxScale, sw.scale); }
      else merged.push({ price: sw.price, kind: sw.kind, maxScale: sw.scale, ts: sw.ts });
    }
    return merged;
  }
}

export { MS_CFG };
