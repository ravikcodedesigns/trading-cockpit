// trade-book-matcher.ts — M1.2 of Phase A.
//
// Streams depth + trade events together in chronological order, maintaining
// book state per symbol, and emits a MatchedTrade per trade tick with the
// book context (pre-trade depth at price, expected vs actual depletion).
//
// The output stream is the foundation for the iceberg detector (M1.3) and
// other orderflow analyses (sweep classifier, hidden-liquidity heatmap).
//
// IMPORTANT — L2 limitations:
//   On L2 (CQG / aggregated depth) we can't see individual order IDs. The
//   "hidden volume" we infer here is COMPUTED by correlating trade flow vs
//   depth diffs over a short window. False positives are real — a price
//   level can have many small fresh orders posted that look like a refresh.
//   When MBO data arrives, we'll swap the data source and the same matcher
//   logic produces deterministic results because we'll see order IDs.

import Database from 'better-sqlite3';
import {
  type BookState, type Side, BID, ASK,
  createEmptyBook, applyEvent,
} from './depth-replay.js';

// ── Event types ──────────────────────────────────────────────────────────

export type DepthRow = {
  kind: 'depth';
  ts: number; id: number; symbol: string;
  side: Side; price: number; size: number;
};

export type TradeRow = {
  kind: 'trade';
  ts: number; id: number; symbol: string;
  price: number; size: number;
  isBidAggressor: 0 | 1;   // 1 = BUY aggressor (eats ASK)
};

export type Event = DepthRow | TradeRow;

// ── Matched-trade output ─────────────────────────────────────────────────
//
// For each trade we emit a record with book context. Downstream analyzers
// consume this stream and don't need to know how it was assembled.

export interface MatchedTrade {
  ts: number;
  symbol: string;
  price: number;
  size: number;
  isBidAggressor: 0 | 1;

  // The "passive side" — for a BUY-aggressor trade this is the ASK side
  // (someone's ASK got hit). For SELL-aggressor it's the BID side.
  passiveSide: Side;

  // Book state at this price immediately BEFORE the trade.
  preSizeAtPrice: number;

  // Book state at this price immediately AFTER the trade (sampled from the
  // very next depth event that touches this price-side combo, if any).
  postSizeAtPrice: number | null;

  // If postSizeAtPrice is null because no depth event followed within the
  // matching window, we report "stale" so downstream knows to be cautious.
  staleAfter: boolean;

  // Implied depletion: pre − post. Will equal trade.size if displayed
  // liquidity fully absorbed the aggression.
  impliedDepletion: number | null;

  // Difference between expected and actual depletion. Positive means LESS
  // visible book got eaten than the trade volume — i.e. hidden liquidity
  // must have provided some of the fill.
  hiddenVolumeEstimate: number | null;
}

// ── Streaming join over depth + trades ───────────────────────────────────
//
// SQLite query that merges depth and trades into a single time-ordered
// stream using UNION ALL + ORDER BY. Faster than two separate iterators
// + manual merge in JS, because SQLite does the sort efficiently with
// the existing (symbol, ts) indexes on both tables.

export function* streamEvents(
  ticksDb: Database.Database,
  symbol: string,
  fromTs: number,
  toTs: number,
): IterableIterator<Event> {
  // UNION ALL preserves duplicates and is faster than UNION (no dedup pass).
  const sql = `
    SELECT 'D' AS kind, ts, id, symbol, side, price, size, NULL AS is_bid_aggressor
      FROM depth WHERE symbol = ? AND ts >= ? AND ts < ?
    UNION ALL
    SELECT 'T' AS kind, ts, id, symbol, NULL AS side, price, size, is_bid_aggressor
      FROM trades WHERE symbol = ? AND ts >= ? AND ts < ?
    ORDER BY ts ASC, kind DESC, id ASC
  `;
  // Note: kind DESC means 'T' before 'D' at the same ts. This matters because
  // a trade typically executes against pre-existing book state — we want the
  // trade to be processed BEFORE depth-update events that happen at the same
  // ts (which represent the book's reaction to the trade).
  const stmt = ticksDb.prepare(sql).raw(true);
  const iter = stmt.iterate(symbol, fromTs, toTs, symbol, fromTs, toTs) as IterableIterator<
    [string, number, number, string, number | null, number, number, number | null]
  >;
  for (const r of iter) {
    if (r[0] === 'D') {
      yield {
        kind: 'depth',
        ts: r[1], id: r[2], symbol: r[3],
        side: r[4] as Side, price: r[5], size: r[6],
      };
    } else {
      yield {
        kind: 'trade',
        ts: r[1], id: r[2], symbol: r[3],
        price: r[5], size: r[6], isBidAggressor: r[7] as 0 | 1,
      };
    }
  }
}

// ── Matcher ──────────────────────────────────────────────────────────────
//
// Maintains a book per symbol. For each trade, captures pre-state, then
// peeks forward to find the first depth event that touches the same
// price/side — that becomes "postSizeAtPrice". If no such event arrives
// within MATCH_WINDOW_MS, we mark the match as stale.

const MATCH_WINDOW_MS = 250;  // generous; depth events typically follow trades within ~10ms

export interface MatchOpts {
  ticksDb: Database.Database;
  symbol: string;
  fromTs: number;
  toTs: number;
  onMatch: (m: MatchedTrade) => void;
  /** Optional progress callback fired every N events. */
  onProgress?: (eventsProcessed: number, currentTs: number) => void;
  progressEvery?: number;
}

export function matchTrades(opts: MatchOpts): {
  eventsProcessed: number;
  tradesMatched: number;
  staleMatches: number;
} {
  const book: BookState = createEmptyBook();

  // Pending trades awaiting their post-state depth event. Keyed by
  // composite "side|price". A trade adds itself here; subsequent depth
  // events resolve and remove pending trades.
  interface PendingTrade {
    trade: TradeRow;
    preSize: number;
    deadline: number;       // ts beyond which the match is stale
    passiveSide: Side;
  }
  const pendingByKey = new Map<string, PendingTrade[]>();
  const keyOf = (side: Side, price: number) => `${side}|${price}`;

  let eventsProcessed = 0;
  let tradesMatched = 0;
  let staleMatches = 0;

  const flushStale = (currentTs: number) => {
    for (const [key, list] of pendingByKey) {
      while (list.length > 0 && list[0]!.deadline < currentTs) {
        const p = list.shift()!;
        staleMatches++;
        opts.onMatch({
          ts: p.trade.ts, symbol: p.trade.symbol,
          price: p.trade.price, size: p.trade.size,
          isBidAggressor: p.trade.isBidAggressor,
          passiveSide: p.passiveSide,
          preSizeAtPrice: p.preSize,
          postSizeAtPrice: null,
          staleAfter: true,
          impliedDepletion: null,
          hiddenVolumeEstimate: null,
        });
      }
      if (list.length === 0) pendingByKey.delete(key);
    }
  };

  for (const ev of streamEvents(opts.ticksDb, opts.symbol, opts.fromTs, opts.toTs)) {
    eventsProcessed++;

    // Flush pending trades whose deadline has passed
    if (eventsProcessed % 100 === 0) flushStale(ev.ts);

    if (ev.kind === 'trade') {
      // Capture pre-state. For a BUY aggressor, the passive side is ASK.
      // The "price" of the trade should match a level on the passive side.
      const passiveSide: Side = ev.isBidAggressor === 1 ? ASK : BID;
      const map = passiveSide === BID ? book.bids : book.asks;
      const preSize = map.get(ev.price) ?? 0;

      const key = keyOf(passiveSide, ev.price);
      const list = pendingByKey.get(key) ?? [];
      list.push({
        trade: ev,
        preSize,
        deadline: ev.ts + MATCH_WINDOW_MS,
        passiveSide,
      });
      pendingByKey.set(key, list);
      tradesMatched++;
      // We don't apply the trade to the book — only depth events change
      // book state. The book's reaction to a trade arrives as the next
      // depth event on the same (side, price).
      continue;
    }

    // ev.kind === 'depth'
    applyEvent(book, ev);

    // Resolve any pending trades on this (side, price)
    const key = keyOf(ev.side, ev.price);
    const list = pendingByKey.get(key);
    if (!list || list.length === 0) {
      if (opts.onProgress && eventsProcessed % (opts.progressEvery ?? 100_000) === 0) {
        opts.onProgress(eventsProcessed, ev.ts);
      }
      continue;
    }
    // The earliest pending trade for this key — match the new size.
    const pending = list.shift()!;
    if (list.length === 0) pendingByKey.delete(key);
    const postSize = ev.size;
    const impliedDepletion = pending.preSize - postSize;
    const hidden = pending.trade.size - impliedDepletion;
    opts.onMatch({
      ts: pending.trade.ts, symbol: pending.trade.symbol,
      price: pending.trade.price, size: pending.trade.size,
      isBidAggressor: pending.trade.isBidAggressor,
      passiveSide: pending.passiveSide,
      preSizeAtPrice: pending.preSize,
      postSizeAtPrice: postSize,
      staleAfter: false,
      impliedDepletion,
      hiddenVolumeEstimate: hidden,
    });

    if (opts.onProgress && eventsProcessed % (opts.progressEvery ?? 100_000) === 0) {
      opts.onProgress(eventsProcessed, ev.ts);
    }
  }

  // Final flush: anything still pending at end of window is stale.
  flushStale(Number.MAX_SAFE_INTEGER);

  return { eventsProcessed, tradesMatched, staleMatches };
}
