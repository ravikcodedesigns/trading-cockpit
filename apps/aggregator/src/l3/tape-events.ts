// tape-events.ts — CRACKER Phase E: the event detection layer (the VERB layer).
//
// ── FOURTH PRIMITIVE REBUILT UNDER THE 2026-07-07 REBUILD DIRECTIVE ──
// Cracker-owned. Consumes MarketBook (never the legacy order-book); emits
// discrete, timestamped TapeEvents with direction and intensity. This file's
// constants ARE the Phase-E0 PRE-REGISTRATION — frozen 2026-07-07 before any
// event-outcome scan runs. Changing them after outcomes exist is a protocol
// violation (Phase-8 sensitivity sweep is the designated place).
//
// ═══ THE FROZEN EVENT TAXONOMY (E0) ═══
// All triggers are DIMENSIONLESS (z-scores or multiples of trailing medians) —
// no fixed lot sizes or point distances; per-instrument scale enters only via
// NEAR_TICKS (the ±zone around mid, matching the LM tape window: 16 NQ / 4 ES).
//
//   SWEEP — one aggressor execution trading at ≥ SWEEP_MIN_PRICES distinct
//     prices. Grouping = CONTIGUOUS same-aggressor_order_id, same-side trades,
//     closed on id/side change, a >SWEEP_GAP_MS intra-id gap, or a genuine
//     is_execution_end. (E0 amendment 2026-07-07, pre-outcome: the
//     is_execution_start flag is unreliable in the store — set on 81% of rows
//     vs 3.5% ends on the probe day — so starts are NOT trusted as brackets.)
//     Direction = aggressor side. Intensity = distinct prices ×
//     total size (rank-analyzed downstream; any monotone measure suffices).
//     Same-direction sweeps within SWEEP_MERGE_MS merge into one event.
//   ABSORPTION — a WIN_MS window whose traded volume per point of price
//     movement (vol / (range + 1 tick)) is ≥ ABS_MULT × the trailing-median
//     window score. Direction = the ABSORBING side (net aggression is buying
//     but price stalls ⇒ sellers absorb ⇒ dir = sell/bearish-defense, and
//     vice versa). Intensity = score / trailing median.
//   IMBALANCE — the frozen P0.5 size-aware z on the WIN_MS window:
//     z = (buy − sell) / √Σsize² ≥ IMB_MIN_Z. Direction = sign. Intensity = |z|.
//   REPLENISHMENT — ≥ REFILL_MIN fill→repost chains (REFILL_MS, from
//     MarketBook's journal) within ±NEAR_TICKS of mid in WIN_MS. Direction =
//     the refilling side (bid refills = defense below). Intensity = count.
//   WALL-PULL — displayed volume cancelled within ±NEAR_TICKS of mid in
//     WIN_MS ≥ PULL_MULT × trailing-median pull volume. Direction = the pulled
//     side (bid pull = support withdrawn ⇒ bearish). Intensity = multiple.
//
//   REFRACTORY: after an event fires, the same (type, direction) is silent for
//   REFRACTORY_MS — a burst is ONE event, not a row per tick.
//   TRAILING MEDIANS: ring of the last MED_RING window scores (≈30 min),
//   evaluated at TICK_MS cadence; detectors stay silent until the ring holds
//   MED_WARMUP samples (no events from an uncalibrated baseline).
//   COVERAGE: window reads that report covered=false are SKIPPED, never
//   evaluated on partial data (the market-book honesty carried through).
//
// E2 DECLARATION (frozen now): outcomes = direction-signed drift-adjusted
// markouts at {1,5,15,30}m; DECLARED horizons 1m/5m for all five detectors
// (fast information); primary analysis = dose-response (IC of intensity vs
// outcome + top-vs-bottom tercile) on the L2-NQ screen; BH-FDR q=0.10 across
// the five-detector family; ES = sign-consistency; structure-zone proximity
// (within band of an active registry level) recorded as a CONDITIONING flag
// per the F5b finding, never as a filter.

import type { MarketBook } from './market-book.js';

export const TE_CFG = {
  WIN_MS: 10_000,
  TICK_MS: 1_000,
  MED_RING: 180,          // trailing window-score samples (~30 min at TICK_MS)
  MED_WARMUP: 60,         // minimum samples before any median-based trigger arms
  NEAR_TICKS: 16,         // ±zone around mid (NQ; ES override 4)
  SWEEP_MIN_PRICES: 3,
  SWEEP_GAP_MS: 1_000,
  SWEEP_MERGE_MS: 2_000,
  IMB_MIN_Z: 3,
  ABS_MULT: 5,
  PULL_MULT: 5,
  REFILL_MIN: 5,
  REFRACTORY_MS: 30_000,
};
export type TeCfg = typeof TE_CFG;

export type TapeEventType = 'sweep' | 'absorption' | 'imbalance' | 'replenishment' | 'wallpull';

export interface TapeEvent {
  ts: number;
  type: TapeEventType;
  dir: 1 | -1;              // +1 bullish-pressure/bullish-defense, −1 bearish
  intensity: number;        // detector-specific, monotone (rank-analyzed)
  priceInt: number;         // anchor price (mid at emission; sweep = last price)
  meta: Record<string, number>;
}

interface WTrade { ts: number; priceInt: number; size: number; buy: boolean; }

/** Trailing-median ring (deterministic, O(n log n) per read on ≤ MED_RING items). */
class MedianRing {
  private buf: number[] = [];
  constructor(private cap: number) {}
  push(v: number): void { this.buf.push(v); if (this.buf.length > this.cap) this.buf.shift(); }
  get n(): number { return this.buf.length; }
  median(): number {
    const s = [...this.buf].sort((a, b) => a - b);
    return s.length ? s[s.length >> 1]! : NaN;
  }
}

export class TapeEventEngine {
  private cfg: TeCfg;
  private win: WTrade[] = [];                       // WIN_MS rolling trade window
  private head = 0;
  private lastTick = -Infinity;
  private absMed = new MedianRing(TE_CFG.MED_RING);
  private pullMed = new MedianRing(TE_CFG.MED_RING);
  private refractory = new Map<string, number>();   // `${type}|${dir}` → last emit ts
  // sweep grouping state
  private curAgg: { id: string; ts: number; prices: Set<number>; size: number; buy: boolean; lastPi: number } | null = null;
  private lastSweep: { ts: number; dir: 1 | -1; prices: Set<number>; size: number; lastPi: number } | null = null;

  constructor(cfg: Partial<TeCfg> = {}) { this.cfg = { ...TE_CFG, ...cfg }; }

  /** Feed EVERY trade (aggressor id + execution brackets when available). */
  onTrade(t: { ts: number; priceInt: number; size: number; buy: boolean; aggId?: string | null; execStart?: boolean; execEnd?: boolean }, out: TapeEvent[]): void {
    this.win.push({ ts: t.ts, priceInt: t.priceInt, size: t.size, buy: t.buy });
    const cut = t.ts - this.cfg.WIN_MS;
    while (this.head < this.win.length && this.win[this.head]!.ts < cut) this.head++;
    if (this.head > 4096 && this.head * 2 > this.win.length) { this.win = this.win.slice(this.head); this.head = 0; }

    // ── sweep grouping: contiguous same-aggressor trades = one execution ──
    const id = t.aggId ?? null;
    if (this.curAgg && (id !== this.curAgg.id || t.buy !== this.curAgg.buy || t.ts - this.curAgg.ts > this.cfg.SWEEP_GAP_MS)) this.closeAgg(out);
    if (!this.curAgg && id != null) this.curAgg = { id, ts: t.ts, prices: new Set(), size: 0, buy: t.buy, lastPi: t.priceInt };
    if (this.curAgg && id === this.curAgg.id && t.buy === this.curAgg.buy) {
      this.curAgg.prices.add(t.priceInt);
      this.curAgg.size += t.size;
      this.curAgg.lastPi = t.priceInt;
      this.curAgg.ts = t.ts;
      if (t.execEnd) this.closeAgg(out);
    }
  }

  private closeAgg(out: TapeEvent[]): void {
    const a = this.curAgg;
    this.curAgg = null;
    if (!a || a.prices.size < this.cfg.SWEEP_MIN_PRICES) { this.flushMergedSweep(out, a?.ts ?? Infinity); return; }
    const dir: 1 | -1 = a.buy ? 1 : -1;
    // merge with a recent same-direction sweep instead of double-emitting
    if (this.lastSweep && this.lastSweep.dir === dir && a.ts - this.lastSweep.ts <= this.cfg.SWEEP_MERGE_MS) {
      for (const p of a.prices) this.lastSweep.prices.add(p);
      this.lastSweep.size += a.size;
      this.lastSweep.ts = a.ts;
      this.lastSweep.lastPi = a.lastPi;
      return;
    }
    this.flushMergedSweep(out, a.ts);
    this.lastSweep = { ts: a.ts, dir, prices: new Set(a.prices), size: a.size, lastPi: a.lastPi };
  }

  private flushMergedSweep(out: TapeEvent[], nowTs: number): void {
    const s = this.lastSweep;
    if (!s || nowTs - s.ts <= this.cfg.SWEEP_MERGE_MS) return;
    this.lastSweep = null;
    this.emit(out, { ts: s.ts, type: 'sweep', dir: s.dir, intensity: s.prices.size * s.size, priceInt: s.lastPi, meta: { prices: s.prices.size, size: s.size } });
  }

  /** Evaluate window detectors at TICK_MS cadence. Call from the replay/live loop. */
  tick(book: MarketBook, ts: number, out: TapeEvent[]): void {
    if (ts - this.lastTick < this.cfg.TICK_MS) return;
    this.lastTick = ts;
    this.flushMergedSweep(out, ts);
    // E0 amendment #3 (pre-outcome, 2026-07-07): evaluate only on a SANE book —
    // two-sided with spread ≤ NEAR_TICKS. Early-session/thin books whose best
    // is far GTC junk produced garbage mid anchors (found in E1 QA: imbalance
    // dist-to-level averaging hundreds of points while trade-anchored events sat
    // at ~1-5pt). Detectors that lacked a warmup gate were the ones affected.
    const bb = book.bestBid(), ba = book.bestAsk();
    if (bb == null || ba == null || ba <= bb || ba - bb > this.cfg.NEAR_TICKS) return;
    const mid = Math.round((bb + ba) / 2);

    // window stats over the trade buffer
    let vol = 0, delta = 0, sumSq = 0, hi = -Infinity, lo = Infinity;
    for (let i = this.head; i < this.win.length; i++) {
      const w = this.win[i]!;
      vol += w.size; delta += w.buy ? w.size : -w.size; sumSq += w.size * w.size;
      if (w.priceInt > hi) hi = w.priceInt; if (w.priceInt < lo) lo = w.priceInt;
    }
    if (vol > 0) {
      // ── absorption: volume per tick of give, vs trailing median ──
      const score = vol / (hi - lo + 1);
      const med = this.absMed.median();
      if (this.absMed.n >= this.cfg.MED_WARMUP && isFinite(med) && med > 0 && score >= this.cfg.ABS_MULT * med) {
        const dir: 1 | -1 = delta > 0 ? -1 : 1;   // buyers absorbed ⇒ sell-side defense wins ⇒ bearish
        this.emit(out, { ts, type: 'absorption', dir, intensity: score / med, priceInt: mid, meta: { vol, rangeTicks: hi - lo, netDelta: delta } });
      }
      this.absMed.push(score);
      // ── imbalance: frozen Kish z ──
      const z = delta / Math.sqrt(Math.max(sumSq, 1));
      if (Math.abs(z) >= this.cfg.IMB_MIN_Z) {
        this.emit(out, { ts, type: 'imbalance', dir: z > 0 ? 1 : -1, intensity: Math.abs(z), priceInt: mid, meta: { z, vol } });
      }
    }

    // ── replenishment: refill chains near mid (coverage-honest) ──
    const rf = book.refillsNear(mid, this.cfg.NEAR_TICKS, ts - this.cfg.WIN_MS);
    if (rf.covered && rf.value >= this.cfg.REFILL_MIN) {
      // direction = the majority refilling side (bid refills ⇒ defense below ⇒ bullish)
      const bidRf = book.refillsNear(mid, this.cfg.NEAR_TICKS, ts - this.cfg.WIN_MS, 'bid');
      const dir: 1 | -1 = bidRf.value * 2 >= rf.value ? 1 : -1;
      this.emit(out, { ts, type: 'replenishment', dir, intensity: rf.value, priceInt: mid, meta: { refills: rf.value } });
    }

    // ── wall-pull: cancelled volume near mid vs trailing median ──
    const pb = book.pullsNear(mid, this.cfg.NEAR_TICKS, 'bid', ts - this.cfg.WIN_MS);
    const pa = book.pullsNear(mid, this.cfg.NEAR_TICKS, 'ask', ts - this.cfg.WIN_MS);
    if (pb.covered && pa.covered) {
      const total = pb.value + pa.value;
      const med = this.pullMed.median();
      if (this.pullMed.n >= this.cfg.MED_WARMUP && isFinite(med) && med > 0 && total >= this.cfg.PULL_MULT * med) {
        const dir: 1 | -1 = pb.value >= pa.value ? -1 : 1;   // bid pull = support withdrawn ⇒ bearish
        this.emit(out, { ts, type: 'wallpull', dir, intensity: total / med, priceInt: mid, meta: { pulledBid: pb.value, pulledAsk: pa.value } });
      }
      this.pullMed.push(total);
    }
  }

  private emit(out: TapeEvent[], e: TapeEvent): void {
    const key = `${e.type}|${e.dir}`;
    const last = this.refractory.get(key) ?? -Infinity;
    if (e.ts - last < this.cfg.REFRACTORY_MS) return;
    this.refractory.set(key, e.ts);
    out.push(e);
  }
}
