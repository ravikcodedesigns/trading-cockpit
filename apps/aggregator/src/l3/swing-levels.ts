// swing-levels.ts — causal reactive-zone detector. A swing high/low is the FOSSIL of a prior
// absorption event (price reversed there because one side was overwhelmed) → a supply/demand zone.
// Feeding these to the EpisodeTracker tests whether that zone still holds on the RETEST (distribution/
// accumulation) — the same mechanism sampled twice. The detector is CAUSAL: a swing is confirmed only
// AFTER price reverses by a vol-scaled threshold δ off the extreme, so it's established before any
// retest (no look-ahead). This is just a level SOURCE — it does not touch the detector/band/math.
import type { LevelRef } from './episode-tracker.js';

export interface Swing { price: number; ts: number; kind: 'high' | 'low'; }

export class SwingDetector {
  private dir: 1 | -1 | 0 = 0;      // current leg: +1 up, -1 down, 0 uninit
  private extPrice = NaN;           // running extreme of the current leg
  private extTs = 0;
  private swings: Swing[] = [];
  constructor(private maxSwings = 40) {}

  /** Feed a price sample; δ = vol-scaled reversal threshold (caller supplies, e.g. SWING_MULT×band).
   *  Returns a newly-CONFIRMED swing (the prior leg's extreme) or null. */
  update(price: number, ts: number, delta: number): Swing | null {
    if (this.dir === 0 || !isFinite(this.extPrice)) { this.dir = 1; this.extPrice = price; this.extTs = ts; return null; }
    if (this.dir === 1) {
      if (price > this.extPrice) { this.extPrice = price; this.extTs = ts; return null; }
      if (price <= this.extPrice - delta) { const s = this.commit('high', delta); this.dir = -1; this.extPrice = price; this.extTs = ts; return s; }
    } else {
      if (price < this.extPrice) { this.extPrice = price; this.extTs = ts; return null; }
      if (price >= this.extPrice + delta) { const s = this.commit('low', delta); this.dir = 1; this.extPrice = price; this.extTs = ts; return s; }
    }
    return null;
  }

  private commit(kind: 'high' | 'low', delta: number): Swing | null {
    const sw: Swing = { price: this.extPrice, ts: this.extTs, kind };
    // dedupe: a same-kind zone already exists within ~½δ → reuse it (don't stack near-duplicate levels)
    if (this.swings.some(s => s.kind === kind && Math.abs(s.price - sw.price) <= delta / 2)) return null;
    this.swings.push(sw);
    if (this.swings.length > this.maxSwings) this.swings.shift();
    return sw;
  }

  /** Current confirmed zones as levels for the EpisodeTracker (grows through the session). */
  levels(): LevelRef[] {
    return this.swings.map(s => ({ price: s.price, label: `S${s.kind === 'high' ? 'H' : 'L'}${s.price.toFixed(2)}`, kind: 'swing' }));
  }
  all(): Swing[] { return this.swings; }
}
