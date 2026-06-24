// Live L3 order book — Phase A of the live-tape RS-signal initiative.
//
// Reconstructs a per-symbol book from the Bookmap MBO capture stream (the same
// .log the parquet converter reads). Two representations are maintained:
//
//   • L2 ladder (bidSize/askSize)  ← the `depth` stream. Each depth event is the
//     ABSOLUTE size at a price level (size 0 = level cleared). Self-sufficient and
//     robust to starting mid-session — this is the reliable "full depth" ladder.
//
//   • L3 aggregates (bidL3/askL3 + order counts) ← the `mbo_send/replace/cancel`
//     stream, tracking each order_id. Used for order-count, iceberg-refill and
//     pull detection (Phase B). Forward-looking: incomplete until the book churns,
//     then converges to the depth ladder — which crossCheck() measures.
//
// price_int is the price in ticks (NQ & ES tick = 0.25): price = price_int * 0.25.
// We key every level map on price_int (integer) to avoid float-key issues.

const TICK = 0.25;
export const priceFromInt = (pi: number) => pi * TICK;

export interface Level {
  priceInt: number;
  price: number;
  size: number;   // depth-stream (L2) size at this level
  orders: number; // L3 order count at this level (from MBO)
}

export interface TapePrint {
  ts: number;
  price: number;
  size: number;
  buy: boolean;   // is_bid_aggressor — true = buyer lifted the offer
  aggId?: string | null;   // aggressor order_id — for sweep + aggressor-clustering
}

export interface CrossCheck {
  levels: number;     // total occupied levels (depth)
  matched: number;    // levels where depth size == reconstructed L3 size
  diverged: number;   // levels where they differ (pre-session orders not tracked)
  sizeDeltaAbs: number; // sum |depthSize - l3Size| across levels
}

// md = max displayed size ever, cf = cumulative size filled against it,
// ru = displayed size was bumped up via replace. cf>md or ru ⇒ refilling iceberg.
type Order = { p: number; s: number; bid: boolean; md: number; cf: number; ru: boolean };

export class OrderBook {
  readonly symbol: string;

  // L2 ladder (from depth stream) — price_int -> absolute size
  private bidSize = new Map<number, number>();
  private askSize = new Map<number, number>();

  // L3 (from mbo stream)
  private orders = new Map<string, Order>();
  private bidOrders = new Map<number, number>(); // price_int -> order count
  private askOrders = new Map<number, number>();
  private bidL3 = new Map<number, number>();     // price_int -> summed order size
  private askL3 = new Map<number, number>();

  // tape
  private tape: TapePrint[] = [];
  private tapeCap = 8000;

  // ── order-flow DYNAMICS rings (the power of MBO over time). Capped for memory;
  //    accessors filter by ts window. Track liquidity being ADDED / PULLED, and
  //    the fill→quick-resend refill chain that = synthetic-iceberg replenishment.
  private cancels: Array<{ ts: number; p: number; s: number; bid: boolean }> = [];
  private adds: Array<{ ts: number; p: number; s: number; bid: boolean }> = [];
  private eventCap = 20000;
  private recentFill = new Map<number, number>();          // price_int → ts of last FULL passive fill there
  private refills: Array<{ ts: number; p: number }> = [];  // a new order posted at a just-fully-filled price = refill link
  private refillMs = 1500;

  cvd = 0;
  lastTs = 0;
  depthEvents = 0;
  mboEvents = 0;
  tradeEvents = 0;

  constructor(symbol: string) {
    this.symbol = symbol;
  }

  // ── L2 from depth ────────────────────────────────────────────────────────
  applyDepth(d: { is_bid: boolean; size: number; price_int: number }): void {
    this.depthEvents++;
    const m = d.is_bid ? this.bidSize : this.askSize;
    if (!d.size) m.delete(d.price_int);
    else m.set(d.price_int, d.size);
  }

  // ── L3 from mbo ──────────────────────────────────────────────────────────
  private bumpCount(bid: boolean, p: number, delta: number): void {
    const m = bid ? this.bidOrders : this.askOrders;
    const v = (m.get(p) ?? 0) + delta;
    if (v <= 0) m.delete(p); else m.set(p, v);
  }
  private bumpSize(bid: boolean, p: number, delta: number): void {
    const m = bid ? this.bidL3 : this.askL3;
    const v = (m.get(p) ?? 0) + delta;
    if (v <= 0) m.delete(p); else m.set(p, v);
  }

  applySend(d: { order_id: string; price_int: number; size: number; is_bid: boolean }): void {
    this.mboEvents++;
    const prev = this.orders.get(d.order_id);
    if (prev) { this.bumpCount(prev.bid, prev.p, -1); this.bumpSize(prev.bid, prev.p, -prev.s); }
    this.orders.set(d.order_id, { p: d.price_int, s: d.size, bid: d.is_bid, md: d.size, cf: 0, ru: false });
    this.bumpCount(d.is_bid, d.price_int, +1);
    this.bumpSize(d.is_bid, d.price_int, +d.size);
    // stacking ring + synthetic-iceberg refill detection (new order at a just-filled price)
    this.adds.push({ ts: this.lastTs, p: d.price_int, s: d.size, bid: d.is_bid });
    if (this.adds.length > this.eventCap) this.adds.shift();
    const ft = this.recentFill.get(d.price_int);
    if (ft != null && this.lastTs - ft <= this.refillMs) {
      this.refills.push({ ts: this.lastTs, p: d.price_int });
      if (this.refills.length > this.eventCap) this.refills.shift();
    }
  }

  applyReplace(d: { order_id: string; price_int: number; size: number }): void {
    this.mboEvents++;
    const prev = this.orders.get(d.order_id); // side persists from the send
    if (!prev) return; // order placed before we started tailing — can't resolve side
    // move the order from its old level to the new one (handles size and/or price change)
    this.bumpCount(prev.bid, prev.p, -1); this.bumpSize(prev.bid, prev.p, -prev.s);
    if (d.size > prev.s) prev.ru = true;          // displayed size bumped up = refill
    if (d.size > prev.md) prev.md = d.size;
    prev.p = d.price_int; prev.s = d.size;
    this.bumpCount(prev.bid, prev.p, +1); this.bumpSize(prev.bid, prev.p, +prev.s);
  }

  applyCancel(d: { order_id: string }): void {
    this.mboEvents++;
    const prev = this.orders.get(d.order_id);
    if (!prev) return;
    this.bumpCount(prev.bid, prev.p, -1);
    this.bumpSize(prev.bid, prev.p, -prev.s);
    // pull ring — displayed size yanked (spoof / fade as price approaches)
    this.cancels.push({ ts: this.lastTs, p: prev.p, s: prev.s, bid: prev.bid });
    if (this.cancels.length > this.eventCap) this.cancels.shift();
    this.orders.delete(d.order_id);
  }

  // ── tape from trade ──────────────────────────────────────────────────────
  applyTrade(d: {
    price_int: number; price: number; size: number;
    is_bid_aggressor: boolean; passive_order_id?: string | null; aggressor_order_id?: string | null;
  }): void {
    this.tradeEvents++;
    this.tape.push({ ts: this.lastTs, price: d.price, size: d.size, buy: d.is_bid_aggressor, aggId: d.aggressor_order_id });
    if (this.tape.length > this.tapeCap) this.tape.shift();
    this.cvd += d.is_bid_aggressor ? d.size : -d.size;
    // decrement the resting (passive) order the aggressor hit
    if (d.passive_order_id) {
      const p = this.orders.get(d.passive_order_id);
      if (p) {
        p.cf += d.size;   // cumulative filled against this resting order (iceberg signal)
        if (p.s <= d.size) { // fully filled
          this.bumpCount(p.bid, p.p, -1);
          this.bumpSize(p.bid, p.p, -p.s);
          this.orders.delete(d.passive_order_id);
          this.recentFill.set(p.p, this.lastTs);   // arm synthetic-iceberg refill detection at this price
        } else {
          p.s -= d.size;
          this.bumpSize(p.bid, p.p, -d.size); // size shrinks, order remains
        }
      }
    }
  }

  // ── accessors ────────────────────────────────────────────────────────────
  bestBid(): number | null {
    let best = -Infinity;
    for (const pi of this.bidSize.keys()) if (pi > best) best = pi;
    return best === -Infinity ? null : best;
  }
  bestAsk(): number | null {
    let best = Infinity;
    for (const pi of this.askSize.keys()) if (pi < best) best = pi;
    return best === Infinity ? null : best;
  }

  /** Top-n levels per side from the depth ladder, best-first. */
  ladder(n = 10): { bids: Level[]; asks: Level[] } {
    const mk = (m: Map<number, number>, ords: Map<number, number>, desc: boolean): Level[] =>
      [...m.entries()]
        .sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0]))
        .slice(0, n)
        .map(([priceInt, size]) => ({ priceInt, price: priceFromInt(priceInt), size, orders: ords.get(priceInt) ?? 0 }));
    return { bids: mk(this.bidSize, this.bidOrders, true), asks: mk(this.askSize, this.askOrders, false) };
  }

  /** Total resting depth (L2) within ±ticks of a price, on the given side. */
  depthNear(priceInt: number, ticks: number, side: 'bid' | 'ask'): { size: number; orders: number } {
    const sz = side === 'bid' ? this.bidSize : this.askSize;
    const od = side === 'bid' ? this.bidOrders : this.askOrders;
    let size = 0, orders = 0;
    for (const [pi, s] of sz) if (Math.abs(pi - priceInt) <= ticks) { size += s; orders += od.get(pi) ?? 0; }
    return { size, orders };
  }

  /** Total MBO-reconstructed order size within ±ticks of a price, on the given
   *  side. The gap (depthNear.size − l3Near) is untracked/implied liquidity. */
  l3Near(priceInt: number, ticks: number, side: 'bid' | 'ask'): number {
    const sz = side === 'bid' ? this.bidL3 : this.askL3;
    let size = 0;
    for (const [pi, s] of sz) if (Math.abs(pi - priceInt) <= ticks) size += s;
    return size;
  }

  /** Active iceberg orders within ±ticks on the given side: a resting order filled
   *  for MORE than it ever displayed (cf>md) or whose displayed size was bumped up
   *  (replace-up) — i.e. it's refilling = real, holding absorption at the level. */
  icebergsNear(priceInt: number, ticks: number, side: 'bid' | 'ask'): { count: number; cumFilled: number } {
    const want = side === 'bid';
    let count = 0, cumFilled = 0;
    for (const o of this.orders.values()) {
      if (o.bid !== want || Math.abs(o.p - priceInt) > ticks) continue;
      if (o.cf > o.md || o.ru) { count++; cumFilled += o.cf; }
    }
    return { count, cumFilled };
  }

  /** Displayed size CANCELLED near a price on a side since a timestamp. High vs the
   *  resting wall (and vs executed volume) = liquidity being PULLED — spoof / fade. */
  pullNear(priceInt: number, ticks: number, side: 'bid' | 'ask', sinceMs = 0): number {
    const want = side === 'bid';
    let s = 0;
    for (const c of this.cancels) if (c.bid === want && c.ts >= sinceMs && Math.abs(c.p - priceInt) <= ticks) s += c.s;
    return s;
  }

  /** Displayed size ADDED near a price on a side since a timestamp = stacking/conviction. */
  addsNear(priceInt: number, ticks: number, side: 'bid' | 'ask', sinceMs = 0): number {
    const want = side === 'bid';
    let s = 0;
    for (const a of this.adds) if (a.bid === want && a.ts >= sinceMs && Math.abs(a.p - priceInt) <= ticks) s += a.s;
    return s;
  }

  /** Count of fill→quick-resend refill links near a price = synthetic-iceberg / algo
   *  replenishment (new order_ids cycling at the level). Pairs with the native
   *  icebergsNear (same-id) — together = "hidden size repeatedly absorbing here". */
  syntheticRefillsNear(priceInt: number, ticks: number, sinceMs = 0): number {
    let n = 0;
    for (const r of this.refills) if (r.ts >= sinceMs && Math.abs(r.p - priceInt) <= ticks) n++;
    return n;
  }

  /** SWEEP: a single aggressor order_id clearing ≥3 distinct price levels near here in
   *  the window → urgency / a break in motion. Returns the biggest single-aggressor span. */
  sweepNear(priceInt: number, ticks: number, sinceMs = 0): { swept: boolean; dir: 'buy' | 'sell' | null; size: number; levels: number } {
    const byAgg = new Map<string, { sz: number; prices: Set<number>; buy: boolean }>();
    for (const t of this.tape) {
      if (!t.aggId || t.ts < sinceMs || Math.abs(Math.round(t.price / TICK) - priceInt) > ticks) continue;
      let e = byAgg.get(t.aggId);
      if (!e) { e = { sz: 0, prices: new Set(), buy: t.buy }; byAgg.set(t.aggId, e); }
      e.sz += t.size; e.prices.add(Math.round(t.price / TICK));
    }
    let best = { swept: false, dir: null as 'buy' | 'sell' | null, size: 0, levels: 0 };
    for (const e of byAgg.values())
      if (e.prices.size >= 3 && e.prices.size > best.levels) best = { swept: true, dir: e.buy ? 'buy' : 'sell', size: e.sz, levels: e.prices.size };
    return best;
  }

  /** Aggressor CLUSTERING near here: the single most-active aggressor's volume vs the
   *  total → one committed player (high dominance) vs diffuse retail noise. */
  aggressorClusterNear(priceInt: number, ticks: number, sinceMs = 0): { topSize: number; total: number; dominance: number } {
    const byAgg = new Map<string, number>();
    let total = 0;
    for (const t of this.tape) {
      if (!t.aggId || t.ts < sinceMs || Math.abs(Math.round(t.price / TICK) - priceInt) > ticks) continue;
      byAgg.set(t.aggId, (byAgg.get(t.aggId) ?? 0) + t.size); total += t.size;
    }
    let top = 0;
    for (const v of byAgg.values()) if (v > top) top = v;
    return { topSize: top, total, dominance: total ? top / total : 0 };
  }

  /** Recent tape prints near a price (within ±ticks) since a timestamp. */
  tapeNear(priceInt: number, ticks: number, sinceMs = 0): TapePrint[] {
    const lo = priceFromInt(priceInt - ticks), hi = priceFromInt(priceInt + ticks);
    return this.tape.filter((t) => t.ts >= sinceMs && t.price >= lo && t.price <= hi);
  }

  /** Health: how well the MBO-reconstructed sizes match the depth ladder. */
  crossCheck(): CrossCheck {
    let levels = 0, matched = 0, diverged = 0, sizeDeltaAbs = 0;
    const cmp = (depth: Map<number, number>, l3: Map<number, number>) => {
      for (const [pi, ds] of depth) {
        levels++;
        const ls = l3.get(pi) ?? 0;
        if (ls === ds) matched++; else { diverged++; sizeDeltaAbs += Math.abs(ds - ls); }
      }
    };
    cmp(this.bidSize, this.bidL3);
    cmp(this.askSize, this.askL3);
    return { levels, matched, diverged, sizeDeltaAbs };
  }
}
