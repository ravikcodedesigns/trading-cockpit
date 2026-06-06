// iceberg-detector-windowed.ts — alternative iceberg detection that aggregates
// trade flow over a rolling window per (symbol, side, price) and infers hidden
// liquidity from the imbalance between aggregate trade volume and aggregate
// displayed-size change.
//
// Mechanic: a real iceberg of size N visible / total M:
//   - Sees aggressive trades sum to M across the window
//   - Maintains displayed size of N most of the time (refreshes after each hit)
//   - Net displayed-size change is small (e.g., -10 net, not -M)
//   - Implied hidden = M - |net_displayed_change|
//
// This handles the "fast refresh" case that the per-trade matcher misses,
// because we don't depend on capturing the exact pre/post pair around any
// single trade — we just need the volumes to balance over the window.

import type { MatchedTrade } from './trade-book-matcher.js';
import type { DepthEvent } from './depth-replay.js';
import { type Side } from './depth-replay.js';

export interface WindowedIcebergEvent {
  ts: number;             // when the level was confirmed
  symbol: string;
  side: Side;
  price: number;
  windowMs: number;
  tradeVolumeInWindow: number;       // aggressive volume at the price/side
  netDisplayedChange: number;        // pre-window displayed - post-window displayed
  inferredHidden: number;            // ≈ tradeVolumeInWindow - |netDisplayedChange|
  numTrades: number;                 // count of separate trades at this level
  firstTradeTs: number;
}

interface LevelWindow {
  side: Side;
  price: number;
  symbol: string;
  windowStartTs: number;
  windowFirstSize: number;            // displayed size at window start
  windowLastSize: number;             // most recent displayed size
  tradeVolume: number;
  numTrades: number;
  firstTradeTs: number;
  confirmed: boolean;
}

export interface WindowedIcebergOpts {
  windowMs?: number;              // default 30_000 (30s)
  minTradeVolume?: number;        // default 100 (must be substantial trade flow)
  minNumTrades?: number;          // default 4 (at least 4 separate trades in window)
  minInferredHidden?: number;     // default 50 (at least 50 contracts hidden)
  minStartSize?: number;          // default 10 (displayed size must be visible at start)
  // Max time from first trade to confirmation — real institutional absorption
  // happens fast (sub-10s). Longer windows are mostly normal price churn.
  maxAbsorptionMs?: number;       // default unlimited
  // Min average trade size — real absorption has big prints, not 1-lot churn.
  minAvgTradeSize?: number;       // default 0
  onIceberg: (e: WindowedIcebergEvent) => void;
}

/**
 * Two streams in: matched-trade events (already book-aware) + depth events
 * (raw book state). The detector maintains a window per (symbol, side, price).
 *
 * Caller is responsible for feeding events in chronological order using
 * onTrade() and onDepth(). The trade-book matcher's `streamEvents` already
 * gives the right interleaved order.
 */
export class WindowedIcebergDetector {
  private opts: Required<Omit<WindowedIcebergOpts, 'onIceberg'>> & { onIceberg: WindowedIcebergOpts['onIceberg'] };
  private byLevel = new Map<string, LevelWindow>();

  constructor(opts: WindowedIcebergOpts) {
    this.opts = {
      windowMs:          opts.windowMs          ?? 30_000,
      minTradeVolume:    opts.minTradeVolume    ?? 100,
      minNumTrades:      opts.minNumTrades      ?? 4,
      minInferredHidden: opts.minInferredHidden ?? 50,
      minStartSize:      opts.minStartSize      ?? 10,
      maxAbsorptionMs:   opts.maxAbsorptionMs   ?? Number.POSITIVE_INFINITY,
      minAvgTradeSize:   opts.minAvgTradeSize   ?? 0,
      onIceberg:         opts.onIceberg,
    };
  }

  /** Feed a matched trade. */
  onTrade(m: MatchedTrade): void {
    const key = `${m.symbol}|${m.passiveSide}|${m.price}`;
    let w = this.byLevel.get(key);
    const now = m.ts;
    const startSize = m.preSizeAtPrice;

    if (!w || (now - w.windowStartTs) > this.opts.windowMs) {
      // Window expired or fresh — start a new one
      w = {
        side: m.passiveSide,
        price: m.price,
        symbol: m.symbol,
        windowStartTs: now,
        windowFirstSize: startSize,
        windowLastSize: startSize,  // updated on subsequent depth events
        tradeVolume: m.size,
        numTrades: 1,
        firstTradeTs: now,
        confirmed: false,
      };
      this.byLevel.set(key, w);
      return;
    }

    w.tradeVolume += m.size;
    w.numTrades++;

    // Confirmation check
    const absorptionMs = now - w.firstTradeTs;
    const avgTradeSize = w.tradeVolume / Math.max(1, w.numTrades);
    if (!w.confirmed
      && w.windowFirstSize >= this.opts.minStartSize
      && w.tradeVolume >= this.opts.minTradeVolume
      && w.numTrades >= this.opts.minNumTrades
      && absorptionMs <= this.opts.maxAbsorptionMs
      && avgTradeSize >= this.opts.minAvgTradeSize) {
      const netDisplayedChange = w.windowLastSize - w.windowFirstSize;
      // STRICT MODE: require netΔ < 0 — the visible book must have actually
      // depleted, not just churned in place. Without this, normal price churn
      // at a level (orders cancelled + reposted) looks identical to refills.
      if (netDisplayedChange >= 0) return;
      const inferredHidden = w.tradeVolume - Math.max(0, -netDisplayedChange);
      if (inferredHidden >= this.opts.minInferredHidden) {
        w.confirmed = true;
        this.opts.onIceberg({
          ts: now,
          symbol: m.symbol,
          side: m.passiveSide,
          price: m.price,
          windowMs: now - w.windowStartTs,
          tradeVolumeInWindow: w.tradeVolume,
          netDisplayedChange,
          inferredHidden,
          numTrades: w.numTrades,
          firstTradeTs: w.firstTradeTs,
        });
      }
    }
  }

  /** Feed a depth event — updates windowLastSize on relevant levels. */
  onDepth(ev: DepthEvent): void {
    const key = `${ev.symbol}|${ev.side}|${ev.price}`;
    const w = this.byLevel.get(key);
    if (!w) return;
    w.windowLastSize = ev.size;
  }

  /** Bulk eviction of stale windows. Call periodically. */
  evictStale(nowTs: number): void {
    for (const [key, w] of this.byLevel) {
      if (nowTs - w.windowStartTs > this.opts.windowMs * 2) {
        this.byLevel.delete(key);
      }
    }
  }
}
