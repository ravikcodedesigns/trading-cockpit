// cqg-l2-book.ts — Stage 0 of the L2 Touch Decider (L2_TOUCH_DECIDER_PLAN.md).
//
// A reusable, source-agnostic L2 order book reconstructed from absolute size-per-level
// depth snapshots + trades. Fed by CQG/ticks.db now (time-accurate); the SAME class will
// be driven by BMD full-size once v1.2 exchange-time is validated — the swap is just the
// event source, not this code. Pure book state + accessors; no I/O.
//
// Depth convention (CQG ticks.db): side 0 = bid, 1 = ask; size is the ABSOLUTE resting
// size at that price (size<=0 removes the level). Trades carry an inferred is_bid_aggressor
// (CQG inference is ~3.5x off vs true — fine for CVD *shape*/relative reads, not absolute).
import type { Quote } from '../l3/divergence.js';

export class CqgL2Book {
  private bid = new Map<number, number>();   // price_int -> resting size
  private ask = new Map<number, number>();
  cvd = 0;
  lastTs = 0;

  constructor(public readonly tick = 0.25) {}

  intFromPrice(p: number): number { return Math.round(p / this.tick); }
  priceFromInt(i: number): number { return i * this.tick; }

  /** Absolute size-per-level update. side: 'bid'|'ask'. size<=0 removes the level. */
  applyDepth(side: 'bid' | 'ask', priceInt: number, size: number): void {
    const m = side === 'bid' ? this.bid : this.ask;
    if (size <= 0) m.delete(priceInt); else m.set(priceInt, size);
  }

  /** Trade tick → CVD (inferred aggressor). */
  applyTrade(size: number, isBuyAggressor: boolean): void {
    this.cvd += isBuyAggressor ? size : -size;
  }

  bestBidInt(): number | null {
    let b = -Infinity; for (const [p, s] of this.bid) if (s > 0 && p > b) b = p;
    return b === -Infinity ? null : b;
  }
  bestAskInt(): number | null {
    let a = Infinity; for (const [p, s] of this.ask) if (s > 0 && p < a) a = p;
    return a === Infinity ? null : a;
  }

  /** Best-quote snapshot for the OFI/Kyle-λ math (divergence.ts). null until both sides exist. */
  quote(): Quote | null {
    const bi = this.bestBidInt(), ai = this.bestAskInt();
    if (bi == null || ai == null) return null;
    return {
      bidPx: this.priceFromInt(bi), bidSz: this.bid.get(bi)!,
      askPx: this.priceFromInt(ai), askSz: this.ask.get(ai)!,
    };
  }

  midPrice(): number | null {
    const q = this.quote();
    return q ? (q.bidPx + q.askPx) / 2 : null;
  }

  /** Resting size within ±ticks on one side of a level (bid below = long defense; ask above = supply). */
  depthNear(levelInt: number, ticks: number, side: 'bid' | 'ask'): number {
    const m = side === 'bid' ? this.bid : this.ask;
    let sz = 0;
    for (const [p, s] of m) {
      if (s <= 0 || Math.abs(p - levelInt) > ticks) continue;
      if (side === 'bid' ? p <= levelInt : p >= levelInt) sz += s;
    }
    return sz;
  }
}
