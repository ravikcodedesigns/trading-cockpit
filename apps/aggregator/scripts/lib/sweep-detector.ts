// sweep-detector.ts — port of cockpit_addon.py's burst tracker for offline
// historical analysis. A sweep is a burst of consecutive same-aggressor
// trades crossing >= MIN_LEVELS distinct prices within MAX_GAP_MS gaps.
//
// Convention: is_bid_aggressor=1 means BUYER was aggressor (lifted ask).
// Verified empirically in memory feedback_aggressor_convention.md.

export interface SweepEvent {
  startTs: number;
  endTs: number;
  symbol: string;
  /** 'long' = aggressive buys (lifting asks), 'short' = aggressive sells (hitting bids) */
  direction: 'long' | 'short';
  levels: number;        // count of distinct prices crossed
  volume: number;
  durationMs: number;
  startPrice: number;
  endPrice: number;
  numTrades: number;
}

export interface SweepDetectorOpts {
  minLevels?: number;     // default 3
  minVolume?: number;     // default 50
  maxGapMs?: number;      // default 500
  symbol: string;
  onSweep: (e: SweepEvent) => void;
}

interface BurstState {
  active: boolean;
  isBidAggressor: boolean;  // 1 = buyer aggressor; aligns with ticks.db column
  startMs: number;
  lastTradeMs: number;
  firstPrice: number;
  lastPrice: number;
  distinctPrices: Set<number>;
  totalVolume: number;
  numTrades: number;
}

export class SweepDetector {
  private opts: Required<Omit<SweepDetectorOpts, 'onSweep'|'symbol'>> & { symbol: string; onSweep: SweepDetectorOpts['onSweep'] };
  private burst: BurstState;

  constructor(opts: SweepDetectorOpts) {
    this.opts = {
      minLevels: opts.minLevels ?? 3,
      minVolume: opts.minVolume ?? 50,
      maxGapMs:  opts.maxGapMs  ?? 500,
      symbol:    opts.symbol,
      onSweep:   opts.onSweep,
    };
    this.burst = this.fresh();
  }

  private fresh(): BurstState {
    return {
      active: false, isBidAggressor: false,
      startMs: 0, lastTradeMs: 0,
      firstPrice: 0, lastPrice: 0,
      distinctPrices: new Set(),
      totalVolume: 0, numTrades: 0,
    };
  }

  private evaluate(): void {
    const b = this.burst;
    if (b.distinctPrices.size >= this.opts.minLevels && b.totalVolume >= this.opts.minVolume) {
      this.opts.onSweep({
        startTs: b.startMs,
        endTs: b.lastTradeMs,
        symbol: this.opts.symbol,
        direction: b.isBidAggressor ? 'long' : 'short',
        levels: b.distinctPrices.size,
        volume: b.totalVolume,
        durationMs: Math.max(1, b.lastTradeMs - b.startMs),
        startPrice: b.firstPrice,
        endPrice: b.lastPrice,
        numTrades: b.numTrades,
      });
    }
  }

  ingest(ts: number, price: number, size: number, isBidAggressor: boolean): void {
    const b = this.burst;
    let burstEnded = false;
    if (b.active) {
      if (b.isBidAggressor !== isBidAggressor) burstEnded = true;
      else if (ts - b.lastTradeMs > this.opts.maxGapMs) burstEnded = true;
    }
    if (burstEnded) {
      this.evaluate();
      this.burst = this.fresh();
    }
    const cur = this.burst;
    if (!cur.active) {
      cur.active = true;
      cur.isBidAggressor = isBidAggressor;
      cur.startMs = ts;
      cur.firstPrice = price;
    }
    cur.lastTradeMs = ts;
    cur.lastPrice = price;
    cur.distinctPrices.add(price);
    cur.totalVolume += size;
    cur.numTrades += 1;
  }

  /** Call when the input stream ends so any in-flight burst is flushed. */
  flush(): void {
    if (this.burst.active) this.evaluate();
    this.burst = this.fresh();
  }
}
