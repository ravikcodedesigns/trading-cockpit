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
// offline proof, throttled live — a documented v1 tradeoff). Parameters below are v1 tunables to
// sensitivity-test (per the plan's "episode definition has knobs" gap).
import type { OrderBook } from './order-book.js';
import {
  type Quote, type RetestFeatures, type EpisodeState, type EpisodeVerdict,
  kyleLambda, ofiSeries, classifyEpisode,
} from './divergence.js';

export interface LevelRef { price: number; label: string; kind: string; }
export interface EpisodeSetup {
  ts: number; symbol: string; label: string; levelPrice: number;
  side: 'resistance' | 'support'; state: EpisodeState; direction: 'long' | 'short';
  confidence: number; entry: number; retests: number; note: string; evidence: Record<string, number>;
}

const CFG = {
  QUOTE_BUF: 200,      // rolling best-quote window for the BASELINE λ (prevailing impact)
  MID_BUF: 120,        // rolling mid window for the volatility-scaled band
  WALL_TICKS: 4,       // depth summed within ±N ticks for the "wall"
  NEAR_TICKS: 16,      // tape window for absorbed volume
  K_RETESTS: 3,        // min retests before classifying (need a sequence)
  BAND_FRAC: 0.33,     // band = BAND_FRAC × half the recent mid range  (volatility-scaled)
                       // KNOWN LIMITATION (06-24 replay): halfRange-of-mids conflates TREND with
                       // volatility — after a big directional move the buffer still holds the drift,
                       // so the band balloons and ENGULFS a subsequent retest zone (it missed the
                       // 06-24 accumulation bottom for this reason). P1 band-sensitivity work: a
                       // detrended / returns-based vol, weighing engulfing vs correlated-retest churn.
  MIN_BAND_TICKS: 2,   // band floor in ticks (quiet markets)
  STALE_MS: 20 * 60_000, // END the episode if the level isn't retested for this long (NOT a distance —
                       // a distance reset fights the band: a normal intra-range pullback would kill the sequence)
  MIN_QUOTES: 8,       // min quotes in a retest to trust its λ (else fall back to baseline)
  CONF_MIN: 0.4,       // emit a setup only above this confidence
};

interface ActiveRetest { startTs: number; quotes: Quote[]; extreme: number; }
interface Episode { side: 'resistance' | 'support'; retests: RetestFeatures[]; active: ActiveRetest | null; emitted: EpisodeState | null; lastTouchTs: number; }
interface SymState { quoteBuf: Quote[]; midBuf: number[]; baseLambda: number; levels: Map<string, Episode>; }

export class EpisodeTracker {
  private sym = new Map<string, SymState>();

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
    push(st.quoteBuf, q, CFG.QUOTE_BUF);
    push(st.midBuf, mid, CFG.MID_BUF);
    // rolling baseline λ = prevailing price-impact over the recent quote stream
    const base = kyleLambda(st.quoteBuf);
    if (base && base.n >= CFG.MIN_QUOTES) st.baseLambda = Math.abs(base.lambda);

    // volatility-scaled band
    const lo = Math.min(...st.midBuf), hi = Math.max(...st.midBuf);
    const band = Math.max(CFG.MIN_BAND_TICKS * tick, CFG.BAND_FRAC * (hi - lo) / 2);

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
      const lambda = lam && lam.n >= CFG.MIN_QUOTES ? Math.abs(lam.lambda) : st.baseLambda;  // too few quotes → neutral baseline
      const ofiNet = ofiSeries(a.quotes).reduce((s, v) => s + v, 0);
      let absorbed = 0; for (const p of book.tapeNear(lvInt, CFG.NEAR_TICKS, a.startTs)) absorbed += p.size;
      ep.retests.push({
        lambda, ofiNet, priceExtreme: a.extreme,
        wall: book.depthNear(lvInt, CFG.WALL_TICKS, defend).size, absorbedVol: absorbed,
      });

      if (ep.retests.length >= CFG.K_RETESTS) {
        const v = classifyEpisode(ep.retests, { side: ep.side, baselineLambda: st.baseLambda || 1 });
        const decisive = v.state === 'DISTRIBUTION' || v.state === 'ACCUMULATION' || v.state === 'BREAKING';
        if (decisive && v.confidence >= CFG.CONF_MIN && v.state !== ep.emitted) {
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
    if (now - ep.lastTouchTs > CFG.STALE_MS) st.levels.delete(key);
    return null;
  }

  /** Read-only audit of current episodes (interpretability + the test hook). */
  snapshot(symbol: string): Array<{ key: string; side: 'resistance' | 'support'; retests: RetestFeatures[]; baseLambda: number; verdict: EpisodeVerdict | null }> {
    const st = this.sym.get(symbol);
    if (!st) return [];
    return [...st.levels.entries()].map(([key, ep]) => ({
      key, side: ep.side, retests: ep.retests, baseLambda: st.baseLambda,
      verdict: ep.retests.length >= CFG.K_RETESTS
        ? classifyEpisode(ep.retests, { side: ep.side, baselineLambda: st.baseLambda || 1 }) : null,
    }));
  }

  private getSym(symbol: string): SymState {
    let s = this.sym.get(symbol);
    if (!s) { s = { quoteBuf: [], midBuf: [], baseLambda: 0, levels: new Map() }; this.sym.set(symbol, s); }
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
