// iceberg-detector.ts — M1.3 of Phase A.
//
// Consumes the MatchedTrade stream from trade-book-matcher.ts and emits
// IcebergEvents when a price level exhibits the iceberg signature:
//
//   1. A level absorbs aggressive trades (hidden volume hints from M1.2)
//   2. Within a short window (~15s), displayed size at that level RECOVERS
//      to ≥80% of its pre-depletion peak.
//   3. This refill→absorb cycle repeats ≥2 times → CONFIRMED iceberg.
//
// L2 LIMITS (vs MBO):
//   On L2 we infer refill from displayed-size dynamics. False positives
//   come from "new order placed at same price right after a trade" — looks
//   identical to an iceberg refresh from outside. Filtering reduces but
//   doesn't eliminate noise. MBO would resolve these deterministically.
//
// We filter aggressively by:
//   - Requiring pre-trade size > MIN_PRE_SIZE (cuts timing-noise candidates)
//   - Requiring at least MIN_REFILLS (default 2) refill events at the level
//   - Decaying state on silence > LEVEL_TTL_MS
//
// Output: a stream of IcebergEvent records, each describing a level that
// passed all confirmation criteria.

import type { MatchedTrade } from './trade-book-matcher.js';
import { type Side } from './depth-replay.js';

export interface IcebergEvent {
  /** When the iceberg was CONFIRMED (i.e. on the Nth refill that crossed the threshold). */
  ts: number;
  symbol: string;
  side: Side;
  price: number;

  // Confirmation stats:
  refillCount: number;
  totalHiddenVolume: number;     // sum of all hidden_volume estimates at this level
  totalDisplayedAbsorbed: number; // sum of displayed-size depletion contributions
  firstSeenTs: number;            // ts of first iceberg-candidate event at this level
  lastTradeAt: number;
  // Median / max refill latency in ms (how fast does it refresh?)
  avgRefillLatencyMs: number;
}

export interface IcebergDetectorOpts {
  /** Pre-trade displayed size threshold below which we discard the event as timing noise. */
  minPreSize?: number;          // default 5

  /** Number of refill events needed to confirm. */
  minRefills?: number;          // default 2

  /** Minimum cumulative hidden volume across refills to confirm. */
  minTotalHidden?: number;      // default 30 (NQ contracts)

  /** Hidden volume per individual event must exceed this to count as a refill. */
  minPerEventHidden?: number;   // default 5

  /** Levels with no activity for longer than this are evicted. */
  levelTtlMs?: number;          // default 60_000 (1 minute)

  /** Called when a level is confirmed. Fires ONCE per level confirmation. */
  onIceberg: (e: IcebergEvent) => void;
}

interface LevelState {
  side: Side;
  price: number;
  symbol: string;
  firstSeenTs: number;
  lastActivityTs: number;
  refillCount: number;
  totalHiddenVolume: number;
  totalDisplayedAbsorbed: number;
  refillLatencies: number[];   // ms between successive refill events
  lastEventTs: number;
  confirmed: boolean;          // once true, we still update but don't re-fire
}

export class IcebergDetector {
  private opts: Required<Omit<IcebergDetectorOpts, 'onIceberg'>> & { onIceberg: IcebergDetectorOpts['onIceberg'] };
  private byLevel = new Map<string, LevelState>();

  constructor(opts: IcebergDetectorOpts) {
    this.opts = {
      minPreSize:       opts.minPreSize        ?? 5,
      minRefills:       opts.minRefills        ?? 2,
      minTotalHidden:   opts.minTotalHidden    ?? 30,
      minPerEventHidden: opts.minPerEventHidden ?? 5,
      levelTtlMs:       opts.levelTtlMs        ?? 60_000,
      onIceberg:        opts.onIceberg,
    };
  }

  /** Feed a MatchedTrade into the detector. Side-effect: may fire onIceberg. */
  ingest(m: MatchedTrade): void {
    // Ignore stale matches (no post-event) — we can't tell hidden volume.
    if (m.staleAfter) return;
    const hidden = m.hiddenVolumeEstimate ?? 0;
    const depletion = m.impliedDepletion ?? 0;

    // Filter out timing noise:
    //   1. Pre-trade displayed size must be meaningful — small pre size means
    //      the book had nothing visible to absorb the trade; a "hidden volume"
    //      inference from a near-zero starting point is unreliable.
    if (m.preSizeAtPrice < this.opts.minPreSize) return;

    //   2. Implied depletion must be NON-NEGATIVE. If depletion < 0, the book
    //      actually GREW between pre and post — that's a new order being posted
    //      at the same price concurrent with the trade, not an iceberg refresh.
    if (depletion < 0) return;

    //   3. Hidden volume must materially exceed the noise floor for a single
    //      event to count as a refill.
    if (hidden < this.opts.minPerEventHidden) return;

    //   4. A real iceberg refresh should preserve MOST of the displayed size.
    //      Require post-size >= 50% of pre-size — i.e. the level still looks
    //      like a wall after the trade. Filters out depleting-then-vanishing
    //      walls (which are just being eaten through normally).
    if (m.postSizeAtPrice == null) return;
    if (m.postSizeAtPrice < m.preSizeAtPrice * 0.5) return;

    const key = `${m.symbol}|${m.passiveSide}|${m.price}`;
    let st = this.byLevel.get(key);

    // Evict stale entries opportunistically when we touch a new level.
    if (this.byLevel.size > 5000) this.evictStale(m.ts);

    if (!st || (m.ts - st.lastActivityTs) > this.opts.levelTtlMs) {
      // Fresh state — either new level or previous activity expired
      st = {
        side: m.passiveSide,
        price: m.price,
        symbol: m.symbol,
        firstSeenTs: m.ts,
        lastActivityTs: m.ts,
        refillCount: 0,
        totalHiddenVolume: 0,
        totalDisplayedAbsorbed: 0,
        refillLatencies: [],
        lastEventTs: m.ts,
        confirmed: false,
      };
      this.byLevel.set(key, st);
    }

    // Record refill
    if (st.refillCount > 0) {
      const dt = m.ts - st.lastEventTs;
      st.refillLatencies.push(dt);
    }
    st.refillCount++;
    st.totalHiddenVolume += hidden;
    st.totalDisplayedAbsorbed += (m.impliedDepletion ?? 0);
    st.lastActivityTs = m.ts;
    st.lastEventTs = m.ts;

    // Confirmation check
    if (!st.confirmed
      && st.refillCount >= this.opts.minRefills
      && st.totalHiddenVolume >= this.opts.minTotalHidden) {
      st.confirmed = true;
      const avgLat = st.refillLatencies.length
        ? st.refillLatencies.reduce((a, b) => a + b, 0) / st.refillLatencies.length
        : 0;
      this.opts.onIceberg({
        ts: m.ts,
        symbol: m.symbol,
        side: m.passiveSide,
        price: m.price,
        refillCount: st.refillCount,
        totalHiddenVolume: st.totalHiddenVolume,
        totalDisplayedAbsorbed: st.totalDisplayedAbsorbed,
        firstSeenTs: st.firstSeenTs,
        lastTradeAt: m.ts,
        avgRefillLatencyMs: avgLat,
      });
    }
  }

  /** Remove level entries that haven't seen activity in levelTtlMs. */
  private evictStale(nowTs: number): void {
    for (const [key, st] of this.byLevel) {
      if (nowTs - st.lastActivityTs > this.opts.levelTtlMs) {
        this.byLevel.delete(key);
      }
    }
  }

  /** For diagnostics. */
  snapshot(): { activeLevels: number; confirmedSoFar: number } {
    let confirmed = 0;
    for (const st of this.byLevel.values()) if (st.confirmed) confirmed++;
    return { activeLevels: this.byLevel.size, confirmedSoFar: confirmed };
  }
}
