// market-book.ts — CRACKER: the market-state reconstruction engine.
//
// ── THIRD PRIMITIVE REBUILT UNDER THE 2026-07-07 REBUILD DIRECTIVE ──
// Full replacement for the legacy order-book.ts on every Cracker path (the
// legacy file remains only for pre-Cracker scripts). This is the NOUN layer:
// "what does the market look like right now." Behavioral detection (sweeps,
// absorption, bursts — the VERB layer) lives in tape-events.ts and consumes
// this engine; no detectors are mixed in here.
//
// WHAT THE REBUILD FIXES (audit 2026-07-07, ledger):
//   1. SILENT TRUNCATION — legacy rings were count-capped (~seconds of history
//      at real L3 rates) and windowed queries answered from evicted data with
//      no warning. Here every buffer retains by TIME and every windowed read
//      returns `covered`: false the moment a query reaches past retention.
//   2. HOT-PATH COMPLEXITY — legacy scanned the whole price map per best-price
//      read and re-sorted the book per ladder call. Here each side keeps a
//      sorted price array alongside its size map: best = O(1), ladder = O(n)
//      slice, near-window reads = O(log M + k) binary search. Price-level
//      insert/delete is a splice (rare relative to size updates).
//   3. NO ANOMALY ACCOUNTING — unknown replaces/cancels, trades against
//      unknown passive orders, timestamp regressions, and crossed-book time
//      are now first-class health counters; depth-vs-L3 reconciliation
//      (crossCheck) is retained. Health is an output, not a hope.
//   4. NO TESTS — cracker_mb_accept.ts holds the synthetic ground-truth suite
//      + a real-day PARITY replay against the legacy book (must match).
//
// DESIGN NOTES
//   • Deterministic: pure function of the applied event sequence. No clock,
//     no randomness. Timestamps ride on every event (no caller-set mutable
//     lastTs — the legacy sloppiness that invited ordering bugs).
//   • Integer price grid (price_int = price/tick) for all keys; the tick lives
//     on the instance; float prices only at the API edge.
//   • Two representations, reconciled: the DEPTH ladder (absolute sizes — the
//     reliable "full book") and the L3 order store (per-order lifecycle:
//     displayed vs filled, hidden-size reveals, refill chains). crossCheck()
//     measures their agreement; consumers choose per use.
//   • reset(ts) starts a new session (book/orders/buffers cleared); anomaly
//     counters are CUMULATIVE across resets (health describes the run).
//
// FROZEN CONFIG (MB_CFG): TAPE_RETAIN_MS / JOURNAL_RETAIN_MS 30 min (longer
// than any visit contact window; ~400k trades of memory on NQ), REFILL_MS
// 1500 (the F11 fill→repost chain window, unchanged).

export const MB_CFG = {
  TAPE_RETAIN_MS: 30 * 60_000,
  JOURNAL_RETAIN_MS: 30 * 60_000,
  REFILL_MS: 1_500,
};
export type MbCfg = typeof MB_CFG;

export interface MBLadderLevel { priceInt: number; price: number; size: number; orders: number; }
export interface MBTrade {
  ts: number; priceInt: number; price: number; size: number; buy: boolean;
  aggId: string | null; passId: string | null; execStart: boolean; execEnd: boolean;
}
export interface MBOrder { p: number; s: number; bid: boolean; md: number; cf: number; ru: boolean; }
export interface Windowed<T> { value: T; covered: boolean; }
export interface MBCounters {
  depthEvents: number; mboEvents: number; tradeEvents: number;
  dupSend: number; unknownReplace: number; unknownCancel: number; unknownPassive: number;
  tsRegressions: number; crossedMs: number; resets: number;
}

interface JEntry { ts: number; p: number; s: number; bid: boolean; }

/** Time-retained, ts-ordered journal with honest coverage. */
class Journal<T extends { ts: number }> {
  private buf: T[] = [];
  private head = 0;
  private lastEvictedTs = -Infinity;
  constructor(private retainMs: number) {}
  push(e: T): void {
    this.buf.push(e);
    const cut = e.ts - this.retainMs;
    while (this.head < this.buf.length && this.buf[this.head]!.ts < cut) {
      this.lastEvictedTs = this.buf[this.head]!.ts;
      this.head++;
    }
    if (this.head > 4096 && this.head * 2 > this.buf.length) { this.buf = this.buf.slice(this.head); this.head = 0; }
  }
  /** All entries with ts ≥ since. covered=false if eviction has eaten into [since, now]. */
  since(since: number): Windowed<readonly T[]> {
    let lo = this.head, hi = this.buf.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.buf[m]!.ts < since) lo = m + 1; else hi = m; }
    return { value: this.buf.slice(lo), covered: since > this.lastEvictedTs };
  }
  get size(): number { return this.buf.length - this.head; }
  clear(): void { this.buf = []; this.head = 0; this.lastEvictedTs = -Infinity; }
}

/** One side of the depth book: size/order maps + a sorted price array. */
class Side {
  readonly sizes = new Map<number, number>();
  readonly orders = new Map<number, number>();
  readonly sorted: number[] = [];   // ascending priceInt, exactly the keys of `sizes`
  private idx(pi: number): number {  // insertion index (first ≥ pi)
    let lo = 0, hi = this.sorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.sorted[m]! < pi) lo = m + 1; else hi = m; }
    return lo;
  }
  set(pi: number, size: number): void {
    const had = this.sizes.has(pi);
    if (size <= 0) {
      if (had) { this.sizes.delete(pi); this.sorted.splice(this.idx(pi), 1); }
      return;
    }
    this.sizes.set(pi, size);
    if (!had) this.sorted.splice(this.idx(pi), 0, pi);
  }
  /** [sum(sizes), sum(orders)] over priceInt ∈ [lo, hi]. O(log M + k). */
  rangeSum(lo: number, hi: number): [number, number] {
    let s = 0, o = 0;
    for (let i = this.idx(lo); i < this.sorted.length && this.sorted[i]! <= hi; i++) {
      const pi = this.sorted[i]!;
      s += this.sizes.get(pi)!; o += this.orders.get(pi) ?? 0;
    }
    return [s, o];
  }
  clear(): void { this.sizes.clear(); this.orders.clear(); this.sorted.length = 0; }
}

export class MarketBook {
  readonly symbol: string;
  readonly tick: number;
  private cfg: MbCfg;

  private bid = new Side();
  private ask = new Side();

  // L3 lifecycle
  private ords = new Map<string, MBOrder>();
  private hot = new Map<string, MBOrder>();          // orders that revealed hidden size (cf>md or replace-up)
  private l3Bid = new Map<number, number>();         // priceInt → summed L3 size (reconciliation)
  private l3Ask = new Map<number, number>();
  private recentFill = new Map<number, number>();    // priceInt → ts of last FULL passive fill

  // cumulative traded volume by price (session-scoped, never evicted) — the
  // EXACT basis for visit-absorbed reads: absorbed = cum(close) − cum(open).
  // Windowed tape reads stay available for detectors; this path has no window.
  private cumTraded = new Side();   // sizes map reused as cumulative volume

  // time-retained buffers (coverage-honest)
  private tape: Journal<MBTrade>;
  private adds: Journal<JEntry>;
  private pulls: Journal<JEntry>;
  private refills: Journal<{ ts: number; p: number; bid: boolean }>;

  // health (cumulative across resets)
  readonly counters: MBCounters = {
    depthEvents: 0, mboEvents: 0, tradeEvents: 0,
    dupSend: 0, unknownReplace: 0, unknownCancel: 0, unknownPassive: 0,
    tsRegressions: 0, crossedMs: 0, resets: 0,
  };
  cvd = 0;
  private prevTs = -Infinity;

  constructor(symbol: string, tick: number, cfg: Partial<MbCfg> = {}) {
    this.symbol = symbol;
    this.tick = tick;
    this.cfg = { ...MB_CFG, ...cfg };
    this.tape = new Journal(this.cfg.TAPE_RETAIN_MS);
    this.adds = new Journal(this.cfg.JOURNAL_RETAIN_MS);
    this.pulls = new Journal(this.cfg.JOURNAL_RETAIN_MS);
    this.refills = new Journal(this.cfg.JOURNAL_RETAIN_MS);
  }

  priceFromInt(pi: number): number { return pi * this.tick; }
  intFromPrice(p: number): number { return Math.round(p / this.tick); }

  /** New session: clear market state; anomaly counters persist (run health). */
  reset(): void {
    this.bid.clear(); this.ask.clear();
    this.ords.clear(); this.hot.clear(); this.l3Bid.clear(); this.l3Ask.clear();
    this.cumTraded.clear();
    this.recentFill.clear();
    this.tape.clear(); this.adds.clear(); this.pulls.clear(); this.refills.clear();
    this.cvd = 0; this.prevTs = -Infinity;
    this.counters.resets++;
  }

  private clock(ts: number): void {
    if (ts < this.prevTs) this.counters.tsRegressions++;
    else if (this.prevTs > -Infinity && ts > this.prevTs) {
      const bb = this.bestBid(), ba = this.bestAsk();
      if (bb != null && ba != null && bb >= ba) this.counters.crossedMs += ts - this.prevTs;
    }
    this.prevTs = Math.max(this.prevTs, ts);
  }

  // ── depth stream (absolute sizes) ──────────────────────────────────────────
  applyDepth(e: { ts: number; priceInt: number; size: number; isBid: boolean }): void {
    this.clock(e.ts);
    this.counters.depthEvents++;
    (e.isBid ? this.bid : this.ask).set(e.priceInt, e.size);
  }

  // ── L3 order lifecycle ─────────────────────────────────────────────────────
  private bumpL3(bid: boolean, p: number, dCount: number, dSize: number): void {
    const side = bid ? this.bid : this.ask;
    const oc = (side.orders.get(p) ?? 0) + dCount;
    if (oc <= 0) side.orders.delete(p); else side.orders.set(p, oc);
    const m = bid ? this.l3Bid : this.l3Ask;
    const v = (m.get(p) ?? 0) + dSize;
    if (v <= 0) m.delete(p); else m.set(p, v);
  }

  applySend(e: { ts: number; orderId: string; priceInt: number; size: number; isBid: boolean }): void {
    this.clock(e.ts);
    this.counters.mboEvents++;
    const prev = this.ords.get(e.orderId);
    if (prev) { this.counters.dupSend++; this.bumpL3(prev.bid, prev.p, -1, -prev.s); this.hot.delete(e.orderId); }
    this.ords.set(e.orderId, { p: e.priceInt, s: e.size, bid: e.isBid, md: e.size, cf: 0, ru: false });
    this.bumpL3(e.isBid, e.priceInt, +1, +e.size);
    this.adds.push({ ts: e.ts, p: e.priceInt, s: e.size, bid: e.isBid });
    const ft = this.recentFill.get(e.priceInt);
    if (ft != null) {
      if (e.ts - ft <= this.cfg.REFILL_MS) this.refills.push({ ts: e.ts, p: e.priceInt, bid: e.isBid });
      else this.recentFill.delete(e.priceInt);       // stale — GC on touch
    }
  }

  applyReplace(e: { ts: number; orderId: string; priceInt: number; size: number }): void {
    this.clock(e.ts);
    this.counters.mboEvents++;
    const o = this.ords.get(e.orderId);
    if (!o) { this.counters.unknownReplace++; return; }
    this.bumpL3(o.bid, o.p, -1, -o.s);
    if (e.size > o.s) { o.ru = true; this.hot.set(e.orderId, o); }
    if (e.size > o.md) o.md = e.size;
    o.p = e.priceInt; o.s = e.size;
    this.bumpL3(o.bid, o.p, +1, +o.s);
  }

  applyCancel(e: { ts: number; orderId: string }): void {
    this.clock(e.ts);
    this.counters.mboEvents++;
    const o = this.ords.get(e.orderId);
    if (!o) { this.counters.unknownCancel++; return; }
    this.bumpL3(o.bid, o.p, -1, -o.s);
    this.pulls.push({ ts: e.ts, p: o.p, s: o.s, bid: o.bid });
    this.ords.delete(e.orderId);
    this.hot.delete(e.orderId);
  }

  applyTrade(e: { ts: number; priceInt: number; size: number; isBuy: boolean; aggId?: string | null; passId?: string | null; execStart?: boolean; execEnd?: boolean }): void {
    this.clock(e.ts);
    this.counters.tradeEvents++;
    this.cvd += e.isBuy ? e.size : -e.size;
    this.cumTraded.set(e.priceInt, (this.cumTraded.sizes.get(e.priceInt) ?? 0) + e.size);
    this.tape.push({
      ts: e.ts, priceInt: e.priceInt, price: this.priceFromInt(e.priceInt), size: e.size, buy: e.isBuy,
      aggId: e.aggId ?? null, passId: e.passId ?? null, execStart: !!e.execStart, execEnd: !!e.execEnd,
    });
    if (!e.passId) return;
    const o = this.ords.get(e.passId);
    if (!o) { this.counters.unknownPassive++; return; }
    o.cf += e.size;
    if (o.cf > o.md) this.hot.set(e.passId, o);
    if (o.s <= e.size) {
      this.bumpL3(o.bid, o.p, -1, -o.s);
      this.ords.delete(e.passId);
      this.hot.delete(e.passId);
      this.recentFill.set(o.p, e.ts);
    } else {
      o.s -= e.size;
      this.bumpL3(o.bid, o.p, 0, -e.size);
    }
  }

  // ── state reads ────────────────────────────────────────────────────────────
  bestBid(): number | null { return this.bid.sorted.length ? this.bid.sorted[this.bid.sorted.length - 1]! : null; }
  bestAsk(): number | null { return this.ask.sorted.length ? this.ask.sorted[0]! : null; }
  mid(): number | null {
    const bb = this.bestBid(), ba = this.bestAsk();
    return bb != null && ba != null && bb < ba ? (this.priceFromInt(bb) + this.priceFromInt(ba)) / 2 : null;
  }
  twoSided(): boolean { const bb = this.bestBid(), ba = this.bestAsk(); return bb != null && ba != null && bb < ba; }

  /** Top-n per side, best-first. O(n) — no sorting at read time. */
  ladder(n: number): { bids: MBLadderLevel[]; asks: MBLadderLevel[] } {
    const mk = (side: Side, pis: number[]): MBLadderLevel[] =>
      pis.map((pi) => ({ priceInt: pi, price: this.priceFromInt(pi), size: side.sizes.get(pi)!, orders: side.orders.get(pi) ?? 0 }));
    return {
      bids: mk(this.bid, this.bid.sorted.slice(-n).reverse()),
      asks: mk(this.ask, this.ask.sorted.slice(0, n)),
    };
  }

  /** Resting depth within ±ticks of a price on one side. O(log M + k). */
  depthNear(priceInt: number, ticks: number, side: 'bid' | 'ask'): { size: number; orders: number } {
    const [size, orders] = (side === 'bid' ? this.bid : this.ask).rangeSum(priceInt - ticks, priceInt + ticks);
    return { size, orders };
  }

  /** CUMULATIVE traded volume within ±ticks of a price since session start.
   *  Exact and unevictable — callers difference two reads to get the volume
   *  absorbed over any span (visit-length independent). */
  tradedNear(priceInt: number, ticks: number): number {
    return this.cumTraded.rangeSum(priceInt - ticks, priceInt + ticks)[0];
  }

  /** Active hidden-size orders (filled beyond displayed, or replaced-up) near a price. */
  icebergsNear(priceInt: number, ticks: number, side: 'bid' | 'ask'): { count: number; cumFilled: number } {
    const want = side === 'bid';
    let count = 0, cumFilled = 0;
    for (const o of this.hot.values()) {
      if (o.bid !== want || Math.abs(o.p - priceInt) > ticks) continue;
      count++; cumFilled += o.cf;
    }
    return { count, cumFilled };
  }

  // ── windowed reads (coverage-honest) ──────────────────────────────────────
  tapeSince(since: number): Windowed<readonly MBTrade[]> { return this.tape.since(since); }

  absorbedNear(priceInt: number, ticks: number, since: number): Windowed<number> {
    const w = this.tape.since(since);
    let s = 0;
    for (const t of w.value) if (Math.abs(t.priceInt - priceInt) <= ticks) s += t.size;
    return { value: s, covered: w.covered };
  }

  private jNear(j: Journal<JEntry>, priceInt: number, ticks: number, side: 'bid' | 'ask', since: number): Windowed<number> {
    const want = side === 'bid';
    const w = j.since(since);
    let s = 0;
    for (const e of w.value) if (e.bid === want && Math.abs(e.p - priceInt) <= ticks) s += e.s;
    return { value: s, covered: w.covered };
  }
  addsNear(priceInt: number, ticks: number, side: 'bid' | 'ask', since: number): Windowed<number> { return this.jNear(this.adds, priceInt, ticks, side, since); }
  pullsNear(priceInt: number, ticks: number, side: 'bid' | 'ask', since: number): Windowed<number> { return this.jNear(this.pulls, priceInt, ticks, side, since); }
  refillsNear(priceInt: number, ticks: number, since: number): Windowed<number> {
    const w = this.refills.since(since);
    let n = 0;
    for (const e of w.value) if (Math.abs(e.p - priceInt) <= ticks) n++;
    return { value: n, covered: w.covered };
  }

  // ── health ────────────────────────────────────────────────────────────────
  /** Depth-vs-L3 reconciliation (levels where the two representations agree). */
  crossCheck(): { levels: number; matched: number; diverged: number; sizeDeltaAbs: number } {
    let levels = 0, matched = 0, diverged = 0, sizeDeltaAbs = 0;
    const cmp = (side: Side, l3: Map<number, number>) => {
      for (const [pi, ds] of side.sizes) {
        levels++;
        const ls = l3.get(pi) ?? 0;
        if (ls === ds) matched++; else { diverged++; sizeDeltaAbs += Math.abs(ds - ls); }
      }
    };
    cmp(this.bid, this.l3Bid);
    cmp(this.ask, this.l3Ask);
    return { levels, matched, diverged, sizeDeltaAbs };
  }

  health(): { counters: MBCounters; liveOrders: number; hotOrders: number; tapeSize: number; twoSided: boolean; crossCheck: ReturnType<MarketBook['crossCheck']> } {
    return {
      counters: { ...this.counters }, liveOrders: this.ords.size, hotOrders: this.hot.size,
      tapeSize: this.tape.size, twoSided: this.twoSided(), crossCheck: this.crossCheck(),
    };
  }
}
