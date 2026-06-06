// depth-replay.ts — streaming engine for orderflow analyses.
//
// Replays depth events from ticks.db in chronological order and maintains
// an in-memory book state per symbol. Exposes a callback-based API so
// downstream analyzers (iceberg detector, sweep classifier, etc.) can react
// to each event with consistent book context.
//
// Data model: each depth event is a single price-level update.
//   size > 0 → that level has size S
//   size = 0 → that level was removed
//
// Notes on the bookmap-addon's emission pattern:
//   - ~450 events/sec during RTH on NQ
//   - is_replace=1 on 100% of events (this is just a marker — they're all
//     state updates, not deltas in the add/cancel/modify sense)
//   - Multiple events at the same ts = a multi-level book change in one snapshot
//
// Memory model:
//   bids: Map<price, size>  (highest price = best bid)
//   asks: Map<price, size>  (lowest price  = best ask)
//
// The book accumulates as we replay. There's no "initial snapshot" event —
// we simply observe state changes over time. For analyses that need to know
// when the book is "warm" (most active levels visible), wait ~30 sec after
// replay start before consuming events.

import Database from 'better-sqlite3';

export type Side = 0 | 1;            // 0 = bid, 1 = ask
export const BID: Side = 0;
export const ASK: Side = 1;

export interface DepthEvent {
  id: number;
  ts: number;
  symbol: string;
  side: Side;
  price: number;
  size: number;       // 0 = level removed
}

/** Per-symbol book state. Both maps keyed by price → size. */
export interface BookState {
  bids: Map<number, number>;
  asks: Map<number, number>;
  /** Last ts that touched this book. */
  lastTs: number;
}

export function createEmptyBook(): BookState {
  return { bids: new Map(), asks: new Map(), lastTs: 0 };
}

/** Apply a single depth event to a book state. Mutates in place. */
export function applyEvent(book: BookState, ev: DepthEvent): void {
  const map = ev.side === BID ? book.bids : book.asks;
  if (ev.size <= 0) {
    map.delete(ev.price);
  } else {
    map.set(ev.price, ev.size);
  }
  book.lastTs = ev.ts;
}

/** Compute the current best bid / best ask from a book state. */
export interface BookTopOfBook {
  bestBid: number | null;
  bestBidSize: number;
  bestAsk: number | null;
  bestAskSize: number;
  spread: number | null;
}

export function topOfBook(book: BookState): BookTopOfBook {
  let bb = -Infinity, bbSize = 0;
  for (const [p, s] of book.bids) {
    if (s > 0 && p > bb) { bb = p; bbSize = s; }
  }
  let ba = Infinity, baSize = 0;
  for (const [p, s] of book.asks) {
    if (s > 0 && p < ba) { ba = p; baSize = s; }
  }
  const bestBid = bb === -Infinity ? null : bb;
  const bestAsk = ba === Infinity  ? null : ba;
  return {
    bestBid, bestBidSize: bb === -Infinity ? 0 : bbSize,
    bestAsk, bestAskSize: ba === Infinity  ? 0 : baSize,
    spread: (bestBid != null && bestAsk != null) ? bestAsk - bestBid : null,
  };
}

/** Top-N levels view of the book. Useful for ladder snapshots. */
export interface LadderLevel { price: number; size: number; }
export interface Ladder {
  bids: LadderLevel[];  // sorted high → low (best bid first)
  asks: LadderLevel[];  // sorted low → high (best ask first)
}
export function ladder(book: BookState, depth = 10): Ladder {
  const bidArr: LadderLevel[] = [...book.bids.entries()]
    .filter(([, s]) => s > 0)
    .map(([price, size]) => ({ price, size }))
    .sort((a, b) => b.price - a.price)
    .slice(0, depth);
  const askArr: LadderLevel[] = [...book.asks.entries()]
    .filter(([, s]) => s > 0)
    .map(([price, size]) => ({ price, size }))
    .sort((a, b) => a.price - b.price)
    .slice(0, depth);
  return { bids: bidArr, asks: askArr };
}

/**
 * Stream depth events from ticks.db. Calls handler for each event.
 * Maintains book state internally so the handler always has fresh context.
 *
 * symbols: which symbols to track (separate book per symbol).
 * fromTs/toTs: time window (inclusive of fromTs, exclusive of toTs).
 * handler: called AFTER applying the event. book reflects post-event state.
 */
export interface ReplayOpts {
  ticksDb: Database.Database;
  symbol: string;
  fromTs: number;
  toTs: number;
  /** Called after each event is applied to the book. */
  onEvent: (ev: DepthEvent, book: BookState) => void;
  /** Optional progress callback. Called every N events. */
  onProgress?: (eventsProcessed: number, currentTs: number) => void;
  progressEvery?: number;  // events between progress callbacks (default 100k)
}

export function replay(opts: ReplayOpts): { eventsProcessed: number; finalBook: BookState } {
  const book = createEmptyBook();
  const progressEvery = opts.progressEvery ?? 100_000;
  const stmt = opts.ticksDb.prepare(`
    SELECT id, ts, symbol, side, price, size FROM depth
    WHERE symbol = ? AND ts >= ? AND ts < ?
    ORDER BY ts ASC, id ASC
  `).raw(true);

  let count = 0;
  const iter = stmt.iterate(opts.symbol, opts.fromTs, opts.toTs) as IterableIterator<[number, number, string, number, number, number]>;
  for (const row of iter) {
    const ev: DepthEvent = {
      id: row[0], ts: row[1], symbol: row[2],
      side: row[3] as Side, price: row[4], size: row[5],
    };
    applyEvent(book, ev);
    opts.onEvent(ev, book);
    count++;
    if (opts.onProgress && count % progressEvery === 0) {
      opts.onProgress(count, ev.ts);
    }
  }
  return { eventsProcessed: count, finalBook: book };
}

/**
 * Replay just for the side effect of warming up the book state to a target ts.
 * Faster than replay() because no per-event callback work.
 */
export function warmupToTs(ticksDb: Database.Database, symbol: string, fromTs: number, toTs: number): BookState {
  const book = createEmptyBook();
  const stmt = ticksDb.prepare(`
    SELECT side, price, size, ts FROM depth
    WHERE symbol = ? AND ts >= ? AND ts < ?
    ORDER BY ts ASC, id ASC
  `).raw(true);
  const iter = stmt.iterate(symbol, fromTs, toTs) as IterableIterator<[number, number, number, number]>;
  for (const row of iter) {
    const side = row[0] as Side, price = row[1], size = row[2], ts = row[3];
    const map = side === BID ? book.bids : book.asks;
    if (size <= 0) map.delete(price);
    else map.set(price, size);
    book.lastTs = ts;
  }
  return book;
}
