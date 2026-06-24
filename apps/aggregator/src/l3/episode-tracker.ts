// episode-tracker.ts — per-level state machine for the DDA detector. Watches each level's
// SEQUENCE of retests (not single touches), builds a per-retest feature row from the book, and
// classifies the episode via divergence.ts → emits distribution/accumulation/break setups.
//
// State per level: IDLE → TESTING (price inside a volatility-scaled band) → on departure the
// retest COMPLETES (record features) → after ≥K retests, classify. Re-test = NEW only after price
// leaves the band (structural debounce, not time — the fix for the "247 correlated touches").
//
// Reads the OrderBook read-only (never mutates it). The caller (offline replay or the live book
// worker's throttled loop) drives observe(); OFI fidelity = the call rate (full per-event in the
// offline proof, throttled live — a documented v1 tradeoff). Band/episode knobs are sensitivity-
// swept (scripts/sweep_band_tau.ts), not hand-fit. Construct with a cfg override to sweep them.
import type { OrderBook } from './order-book.js';
import {
  type Quote, type RetestFeatures, type EpisodeState, type EpisodeVerdict,
  kyleLambda, ofiSeries, classifyEpisode, diffusionScale,
} from './divergence.js';

export interface LevelRef { price: number; label: string; kind: string; }
export interface EpisodeSetup {
  ts: number; symbol: string; label: string; levelPrice: number;
  side: 'resistance' | 'support'; state: EpisodeState; direction: 'long' | 'short';
  confidence: number; entry: number; retests: number; note: string; evidence: Record<string, number>;
}

const CFG = {
  QUOTE_BUF: 200,        // rolling best-quote window for the BASELINE λ (prevailing impact)
  RV_WINDOW: 120,        // samples for the robust return-vol estimate (returns are drift-free, so a
                         // long window is safe even in a trend — unlike the old halfRange-of-mids)
  RV_SAMPLE_MS: 1000,    // sparse-sample the mid for the RV estimate. The 200ms observe grid is
                         // microstructure-noise-dominated (the mid is unchanged in most 200ms intervals
                         // → MAD of returns degenerates to 0); ~1s is the noise-robust sampling grid.
  WALL_TICKS: 4,         // depth summed within ±N ticks for the "wall"
  NEAR_TICKS: 16,        // tape window for absorbed volume
  K_RETESTS: 3,          // min retests before classifying (need a sequence)
  // band = BAND_K · σ · √τ, where σ = diffusionScale (robust realized return-vol, drift-free) and τ is
  // the touch timescale in seconds — "price within ~τ-sec of normal diffusion of the level is AT it".
  // This replaces the halfRange band that conflated trend with vol and engulfed retest zones in moves.
  BAND_K: 1.0,           // scale ×σ (1.0 = the 1σ diffusive excursion over τ)
  TAU_SEC: 45,           // touch timescale (s) — the main knob. Center of the STABLE plateau in the
                         // 06-24 sweep (scripts/sweep_band_tau.ts: retest counts stable τ≈30-90s,
                         // band ~6-10pt for NQ; degrades <10s churn / >240s level-merge). Chosen on
                         // structural stability, NOT signal count. Re-confirm per-instrument + forward.
  MIN_BAND_TICKS: 2,     // spread/quantization floor (band never below this)
  STALE_MS: 20 * 60_000, // END the episode if the level isn't retested for this long (NOT a distance —
                         // a distance reset fights the band: a normal intra-range pullback kills the seq)
  MIN_QUOTES: 8,         // min quotes in a retest to trust its λ (else fall back to baseline)
  CONF_MIN: 0.4,         // emit a setup only above this confidence
};
export type EpisodeCfg = typeof CFG;

interface ActiveRetest { startTs: number; quotes: Quote[]; extreme: number; }
interface Episode { side: 'resistance' | 'support'; retests: RetestFeatures[]; active: ActiveRetest | null; emitted: EpisodeState | null; lastTouchTs: number; }
interface SymState { quoteBuf: Quote[]; mids: number[]; midTs: number[]; lastRvTs: number; baseLambda: number; lastBand: number; levels: Map<string, Episode>; }

export class EpisodeTracker {
  private sym = new Map<string, SymState>();
  private cfg: EpisodeCfg;

  constructor(cfg?: Partial<EpisodeCfg>) { this.cfg = { ...CFG, ...cfg }; }

  /** Drive on each (throttled) book update. Returns any setups emitted this call. */
  observe(symbol: string, book: OrderBook, levels: LevelRef[], now: number): EpisodeSetup[] {
    const bbI = book.bestBid(), baI = book.bestAsk();
    if (bbI == null || baI == null) return [];
    const q: Quote = {
      bidPx: book.priceFromInt(bbI), bidSz: book.depthNear(bbI, 0, 'bid').size,
      askPx: book.priceFromInt(baI), askSz: book.depthNear(baI, 0, 'ask').size,
    };
    const mid = (q.bidPx + q.askPx) / 2;
    const tick = book.priceFromInt(1);

    const st = this.getSym(symbol);
    push(st.quoteBuf, q, this.cfg.QUOTE_BUF);
    if (now - st.lastRvTs >= this.cfg.RV_SAMPLE_MS) {   // sparse RV grid (noise-robust), not every observe
      push(st.mids, mid, this.cfg.RV_WINDOW);
      push(st.midTs, now, this.cfg.RV_WINDOW);
      st.lastRvTs = now;
    }
    // rolling baseline λ = prevailing price-impact over the recent quote stream
    const base = kyleLambda(st.quoteBuf);
    if (base && base.n >= this.cfg.MIN_QUOTES) st.baseLambda = Math.abs(base.lambda);

    // diffusion-scaled band: BAND_K · σ(returns, drift-free) · √τ, floored at the spread/quantization
    const sigma = diffusionScale(st.mids, st.midTs);
    const band = Math.max(this.cfg.MIN_BAND_TICKS * tick, this.cfg.BAND_K * sigma * Math.sqrt(this.cfg.TAU_SEC));
    st.lastBand = band;

    const out: EpisodeSetup[] = [];
    for (const lv of levels) {
      const setup = this.stepLevel(symbol, book, st, lv, mid, q, band, now);
      if (setup) out.push(setup);
    }
    return out;
  }

  private stepLevel(symbol: string, book: OrderBook, st: SymState, lv: LevelRef,
                    mid: number, q: Quote, band: number, now: number): EpisodeSetup | null {
    const dist = mid - lv.price;
    const inBand = Math.abs(dist) <= band;
    const key = `${lv.label}:${lv.price}`;
    let ep = st.levels.get(key);

    if (inBand) {
      if (!ep) { ep = { side: dist < 0 ? 'resistance' : 'support', retests: [], active: null, emitted: null, lastTouchTs: now }; st.levels.set(key, ep); }
      ep.lastTouchTs = now;
      if (!ep.active) ep.active = { startTs: now, quotes: [], extreme: mid };
      ep.active.quotes.push(q);
      ep.active.extreme = ep.side === 'resistance' ? Math.max(ep.active.extreme, mid) : Math.min(ep.active.extreme, mid);
      return null;
    }

    // out of band
    if (!ep) return null;
    if (ep.active) {
      // a retest just COMPLETED — record its feature row
      const a = ep.active; ep.active = null;
      const lvInt = book.intFromPrice(lv.price);
      const defend: 'bid' | 'ask' = ep.side === 'resistance' ? 'ask' : 'bid';
      const lam = kyleLambda(a.quotes);
      const lambda = lam && lam.n >= this.cfg.MIN_QUOTES ? Math.abs(lam.lambda) : st.baseLambda;  // too few quotes → neutral baseline
      const ofiNet = ofiSeries(a.quotes).reduce((s, v) => s + v, 0);
      let absorbed = 0; for (const p of book.tapeNear(lvInt, this.cfg.NEAR_TICKS, a.startTs)) absorbed += p.size;
      ep.retests.push({
        lambda, ofiNet, priceExtreme: a.extreme,
        wall: book.depthNear(lvInt, this.cfg.WALL_TICKS, defend).size, absorbedVol: absorbed,
        reclaim: Math.sign(dist),   // exit side: dist=mid-level, out of band → +1 above (reclaim) / -1 below
      });

      if (ep.retests.length >= this.cfg.K_RETESTS) {
        const v = classifyEpisode(ep.retests, { side: ep.side, baselineLambda: st.baseLambda || 1 });
        const decisive = v.state === 'DISTRIBUTION' || v.state === 'ACCUMULATION' || v.state === 'BREAKING';
        if (decisive && v.confidence >= this.cfg.CONF_MIN && v.state !== ep.emitted) {
          ep.emitted = v.state;
          return {
            ts: now, symbol, label: lv.label, levelPrice: lv.price, side: ep.side, state: v.state,
            direction: directionFor(v.state, ep.side), confidence: +v.confidence.toFixed(2),
            entry: lv.price, retests: ep.retests.length, note: v.note, evidence: v.evidence,
          };
        }
      }
    }
    // level not retested for a while → END the episode (a fresh one starts on the next return)
    if (now - ep.lastTouchTs > this.cfg.STALE_MS) st.levels.delete(key);
    return null;
  }

  /** Read-only audit of current episodes (interpretability + the test hook). */
  snapshot(symbol: string): Array<{ key: string; side: 'resistance' | 'support'; retests: RetestFeatures[]; baseLambda: number; verdict: EpisodeVerdict | null }> {
    const st = this.sym.get(symbol);
    if (!st) return [];
    return [...st.levels.entries()].map(([key, ep]) => ({
      key, side: ep.side, retests: ep.retests, baseLambda: st.baseLambda,
      verdict: ep.retests.length >= this.cfg.K_RETESTS
        ? classifyEpisode(ep.retests, { side: ep.side, baselineLambda: st.baseLambda || 1 }) : null,
    }));
  }

  /** Most recently computed band width (price units) — for the sensitivity sweep / audit. */
  lastBand(symbol: string): number { return this.sym.get(symbol)?.lastBand ?? 0; }

  private getSym(symbol: string): SymState {
    let s = this.sym.get(symbol);
    if (!s) { s = { quoteBuf: [], mids: [], midTs: [], lastRvTs: 0, baseLambda: 0, lastBand: 0, levels: new Map() }; this.sym.set(symbol, s); }
    return s;
  }
}

// DISTRIBUTION = short, ACCUMULATION = long; BREAKING = with the break (res break up = long).
function directionFor(state: EpisodeState, side: 'resistance' | 'support'): 'long' | 'short' {
  if (state === 'DISTRIBUTION') return 'short';
  if (state === 'ACCUMULATION') return 'long';
  return side === 'resistance' ? 'long' : 'short';   // BREAKING through
}

function push<T>(buf: T[], x: T, cap: number): void { buf.push(x); if (buf.length > cap) buf.shift(); }

export { CFG as EPISODE_CFG };
