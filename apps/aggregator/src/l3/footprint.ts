// footprint.ts — STAGE 2 of the orderflow spine: the footprint engine.
//
// A footprint = per-price volume split into BUY-aggressor (lifted the offer) vs
// SELL-aggressor (hit the bid). From it we read POC, delta, diagonal imbalances,
// stacked imbalances, aggressor pressure, value area — the auction at each price.
//
// Design (locked):
//   • Incremental — one O(1) tally per trade; runs live and in replay unchanged.
//   • BOOK-RELATIVE aggressor — classify from the reconstructed best bid/ask
//     (trade ≥ ask = buy, ≤ bid = sell), NOT the ~3.5×-off CQG flag.
//   • Per-instrument BINNING — NQ bins 4 ticks (thin top-of-book fragments per-tick),
//     ES runs at 1 tick.
//   • SIGNIFICANCE-BASED imbalance — a diagonal is flagged when the buy/sell split
//     is ≥ minZ std-errs from 50/50, NOT a folk 3:1/4:1. This makes each cell
//     statistically meaningful regardless of bin size (thin cells need a bigger
//     skew to flag), achieving the "meaningful cell" goal without shifting bins.
//   • TRADE-SIZE-AWARE variance (Cracker 0.5, frozen) — the null model is "each
//     TRADE's side is a fair coin," not each contract: a single 200-lot is ONE
//     observation, not 200. Var(buyVol − sellVol) = Σ size² over the contributing
//     trades, so z = (a − b) / √(Σs²). With all 1-lots this reduces exactly to
//     the old binomial (a − b)/√(a + b); with clumpy sizes it stops a lone block
//     trade from minting a fake "significant" imbalance. (Kish n_eff, exact form.)
//
// Reusable at TWO scopes: a session-cumulative Footprint (volume profile / birth
// context) and a fresh per-VISIT Footprint (the auction during one test of a level).

export interface FootCell { buy: number; sell: number; buySq: number; sellSq: number; }   // vol + Σsize² per side (variance for the size-aware z)

export interface Imbalance { price: number; side: 'buy' | 'sell'; z: number; buy: number; sell: number; }
export interface StackedImbalance { loPrice: number; hiPrice: number; side: 'buy' | 'sell'; count: number; }

export interface FootprintSnapshot {
  binPts: number;
  cells: { price: number; buy: number; sell: number; vol: number }[];   // ascending by price
  poc: number;                     // price (bin low) of max total vol
  totalBuy: number; totalSell: number; totalVol: number; delta: number;
  aggressorRatio: number;          // delta / totalVol  ∈ [-1, 1]  (+ = buyers initiating)
  valueLow: number; valueHigh: number;   // 70%-of-volume band around POC
  imbalances: Imbalance[];
  stacked: StackedImbalance[];
}

export interface FpCfg { tickSize: number; binTicks: number; minZ: number; minStack: number; valueAreaPct: number; }
export const FP_CFG: Record<string, FpCfg> = {
  NQ: { tickSize: 0.25, binTicks: 4, minZ: 2.0, minStack: 3, valueAreaPct: 0.70 },
  ES: { tickSize: 0.25, binTicks: 1, minZ: 2.0, minStack: 3, valueAreaPct: 0.70 },
};

export class Footprint {
  private cells = new Map<number, FootCell>();   // key = bin index
  private cfg: FpCfg;
  constructor(cfg: FpCfg) { this.cfg = cfg; }

  private binOf(price: number): number {
    return Math.floor(Math.round(price / this.cfg.tickSize) / this.cfg.binTicks);
  }
  private binPrice(bin: number): number { return bin * this.cfg.binTicks * this.cfg.tickSize; }

  /** Ingest one trade. `bidPx`/`askPx` = best bid/ask AT the trade (from the book). */
  onTrade(price: number, size: number, bidPx: number, askPx: number): void {
    // book-relative aggressor: lift (≥ ask) = buy, hit (≤ bid) = sell, inside spread = split
    let side: 'buy' | 'sell' | 'mid';
    if (price >= askPx) side = 'buy';
    else if (price <= bidPx) side = 'sell';
    else side = 'mid';
    const bin = this.binOf(price);
    let c = this.cells.get(bin);
    if (!c) { c = { buy: 0, sell: 0, buySq: 0, sellSq: 0 }; this.cells.set(bin, c); }
    if (side === 'buy') { c.buy += size; c.buySq += size * size; }
    else if (side === 'sell') { c.sell += size; c.sellSq += size * size; }
    else { c.buy += size / 2; c.sell += size / 2; c.buySq += (size / 2) ** 2; c.sellSq += (size / 2) ** 2; }   // mid: split (rare)
  }

  /** True if any volume has been recorded. */
  hasData(): boolean { return this.cells.size > 0; }

  /** Snapshot the footprint over an optional price band [loPrice, hiPrice]. */
  snapshot(loPrice?: number, hiPrice?: number): FootprintSnapshot | null {
    const binPts = this.cfg.binTicks * this.cfg.tickSize;
    const loBin = loPrice != null ? this.binOf(loPrice) : -Infinity;
    const hiBin = hiPrice != null ? this.binOf(hiPrice) : Infinity;
    const entries = [...this.cells.entries()].filter(([b]) => b >= loBin && b <= hiBin).sort((a, b) => a[0] - b[0]);
    if (!entries.length) return null;

    const cells = entries.map(([b, c]) => ({ price: this.binPrice(b), buy: c.buy, sell: c.sell, vol: c.buy + c.sell }));
    let totalBuy = 0, totalSell = 0, poc = cells[0]!.price, pocVol = -1;
    for (const c of cells) { totalBuy += c.buy; totalSell += c.sell; if (c.vol > pocVol) { pocVol = c.vol; poc = c.price; } }
    const totalVol = totalBuy + totalSell, delta = totalBuy - totalSell;

    // value area: expand out from POC until 70% of volume is covered
    const pocIdx = cells.findIndex((c) => c.price === poc);
    let lo = pocIdx, hi = pocIdx, covered = cells[pocIdx]!.vol;
    const target = totalVol * this.cfg.valueAreaPct;
    while (covered < target && (lo > 0 || hi < cells.length - 1)) {
      const below = lo > 0 ? cells[lo - 1]!.vol : -1;
      const above = hi < cells.length - 1 ? cells[hi + 1]!.vol : -1;
      if (above >= below) { hi++; covered += cells[hi]!.vol; } else { lo--; covered += cells[lo]!.vol; }
    }

    // diagonal imbalances (significance test vs 50/50), map by bin for adjacency
    const byBin = new Map(entries.map(([b, c]) => [b, c]));
    const bins = entries.map(([b]) => b);
    const imbalances: Imbalance[] = [];
    const flag = new Map<number, 'buy' | 'sell'>();
    for (const b of bins) {
      const cur = byBin.get(b)!;
      const below = byBin.get(b - 1), above = byBin.get(b + 1);
      // buy imbalance: ask-vol here vs bid-vol one below (size-aware variance)
      if (below) { const z = zvar(cur.buy, below.sell, cur.buySq + below.sellSq); if (z >= this.cfg.minZ) { imbalances.push({ price: this.binPrice(b), side: 'buy', z: +z.toFixed(2), buy: cur.buy, sell: below.sell }); flag.set(b, 'buy'); } }
      // sell imbalance: bid-vol here vs ask-vol one above (size-aware variance)
      if (above) { const z = zvar(cur.sell, above.buy, cur.sellSq + above.buySq); if (z >= this.cfg.minZ && flag.get(b) !== 'buy') { imbalances.push({ price: this.binPrice(b), side: 'sell', z: +z.toFixed(2), buy: above.buy, sell: cur.sell }); flag.set(b, 'sell'); } }
    }
    // stacked = runs of ≥ minStack consecutive bins flagged same side
    const stacked: StackedImbalance[] = [];
    let run: number[] = [], runSide: 'buy' | 'sell' | null = null;
    const flush = () => { if (run.length >= this.cfg.minStack && runSide) stacked.push({ loPrice: this.binPrice(Math.min(...run)), hiPrice: this.binPrice(Math.max(...run)), side: runSide, count: run.length }); run = []; };
    for (const b of bins) { const s = flag.get(b) ?? null; if (s && s === runSide) run.push(b); else { flush(); run = s ? [b] : []; runSide = s; } }
    flush();

    return {
      binPts, cells, poc, totalBuy, totalSell, totalVol, delta,
      aggressorRatio: totalVol ? delta / totalVol : 0,
      valueLow: cells[lo]!.price, valueHigh: cells[hi]!.price, imbalances, stacked,
    };
  }
}

/** signed size-aware z of volume `a` vs `b`: (a-b)/sqrt(Σsize²) — the exact null
 *  variance when each TRADE (not each contract) is a fair coin. Reduces to the
 *  binomial (a-b)/√(a+b) when all trades are 1-lots. +z = a-dominant. */
function zvar(a: number, b: number, sumSq: number): number { return sumSq > 0 ? (a - b) / Math.sqrt(sumSq) : 0; }
