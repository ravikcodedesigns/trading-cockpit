// mbo-iceberg-detector.ts — Deterministic iceberg detector using MBO order IDs.
//
// PATTERN: a true iceberg order on the exchange replenishes the visible slice
// immediately after each fill. In MBO data this looks like:
//
//   1. Passive order X is sent at (price=P, is_bid=B, size=N).
//   2. Trades fire with passive_order_id=X, accumulating fill_size up to N.
//   3. Order X is cancelled (the exchange removes the filled order).
//   4. Within a small window Δ (sub-100ms), a NEW order Y is sent at the SAME
//      (price=P, is_bid=B). This is the next iceberg slice.
//   5. Repeats until the hidden pool is exhausted.
//
// We label step 4 a CANDIDATE refresh. A CONFIRMED iceberg requires 2+ refresh
// events at the same level within a longer cluster window (default 30s).
//
// L2 LIMITATIONS WE'RE FREE OF:
//   - L2 inference relied on "hidden volume = trade size - book delta", which
//     is noisy on a high-churn book.
//   - MBO sees order-ID continuity directly: filled-then-refilled-at-same-price
//     is unambiguous.
//
// FALSE-POSITIVE GUARD:
//   - Two unrelated traders posting at the same price after a fill look like
//     iceberg refresh. Solution: require 2+ refreshes (single is too weak).
//   - The cluster window is intentionally short (30s) to avoid lumping
//     unrelated activity at the same level later in the session.

import type Database from 'better-sqlite3';

export interface IcebergRefresh {
  symbol: string;
  filledOrderId: string;    // the order that got filled, triggering the refresh
  refillOrderId: string;    // the new order that appeared at the same level
  price: number;
  isBid: boolean;
  fillTs: number;           // when the filled order's last event happened
  refillTs: number;         // when the refresh order was sent
  latencyMs: number;        // refillTs - fillTs
  filledSize: number;       // send_size of the order that was filled
  refillSize: number;       // send_size of the new order
  cumulativeFilled: number; // fill_size of the filled order (should == send_size)
}

export interface IcebergCluster {
  symbol: string;
  side: 'BID' | 'ASK';
  price: number;
  firstRefreshTs: number;
  lastRefreshTs: number;
  refreshCount: number;            // count of refresh events in this cluster
  totalVisibleVolume: number;      // sum of refill sizes
  totalTradedThrough: number;      // sum of fills across all refreshed slices
  orderIds: string[];              // chain of order IDs (in order)
  avgRefreshLatencyMs: number;
}

export interface IcebergDetectorOpts {
  symbol: string;
  /** Max ms between fill and next-send-at-same-level to count as a refresh. Default 100ms. */
  refreshWindowMs?: number;
  /** Max ms between consecutive refreshes to count as the same cluster. Default 30000ms. */
  clusterWindowMs?: number;
  /** Min refresh events for a confirmed iceberg. Default 2. */
  minRefreshes?: number;
  /** Optional: filter to orders with this minimum send_size (filter retail noise). Default 0. */
  minOrderSize?: number;
}

export function findRefreshes(db: Database.Database, opts: IcebergDetectorOpts): IcebergRefresh[] {
  const refreshWindowMs = opts.refreshWindowMs ?? 100;
  const minOrderSize = opts.minOrderSize ?? 0;

  // For each filled order, find the next mbo_send at same (price, is_bid) within window.
  // We use a correlated subquery; a window-function approach is also possible if perf is an issue.
  const rows = db.prepare(`
    SELECT
      o.order_id    AS filled_order_id,
      o.is_bid      AS is_bid,
      o.last_price  AS price,
      o.send_size   AS filled_size,
      o.fill_size   AS cumulative_filled,
      o.last_ts_ms  AS fill_ts,
      (
        SELECT e.order_id FROM mbo_events e
        WHERE e.symbol  = o.symbol
          AND e.kind    = 'send'
          AND e.is_bid  = o.is_bid
          AND e.price   = o.last_price
          AND e.ts_ms   > o.last_ts_ms
          AND e.ts_ms   <= o.last_ts_ms + ?
        ORDER BY e.ts_ms ASC
        LIMIT 1
      ) AS refill_order_id,
      (
        SELECT e.ts_ms FROM mbo_events e
        WHERE e.symbol  = o.symbol
          AND e.kind    = 'send'
          AND e.is_bid  = o.is_bid
          AND e.price   = o.last_price
          AND e.ts_ms   > o.last_ts_ms
          AND e.ts_ms   <= o.last_ts_ms + ?
        ORDER BY e.ts_ms ASC
        LIMIT 1
      ) AS refill_ts,
      (
        SELECT e.size FROM mbo_events e
        WHERE e.symbol  = o.symbol
          AND e.kind    = 'send'
          AND e.is_bid  = o.is_bid
          AND e.price   = o.last_price
          AND e.ts_ms   > o.last_ts_ms
          AND e.ts_ms   <= o.last_ts_ms + ?
        ORDER BY e.ts_ms ASC
        LIMIT 1
      ) AS refill_size
    FROM mbo_orders o
    WHERE o.symbol = ?
      AND o.status = 'filled'
      AND o.send_size >= ?
  `).all(refreshWindowMs, refreshWindowMs, refreshWindowMs, opts.symbol, minOrderSize) as Array<{
    filled_order_id: string;
    is_bid: number;
    price: number;
    filled_size: number;
    cumulative_filled: number;
    fill_ts: number;
    refill_order_id: string | null;
    refill_ts: number | null;
    refill_size: number | null;
  }>;

  const refreshes: IcebergRefresh[] = [];
  for (const r of rows) {
    if (!r.refill_order_id || !r.refill_ts) continue;
    refreshes.push({
      symbol: opts.symbol,
      filledOrderId: r.filled_order_id,
      refillOrderId: r.refill_order_id,
      price: r.price,
      isBid: r.is_bid === 1,
      fillTs: r.fill_ts,
      refillTs: r.refill_ts,
      latencyMs: r.refill_ts - r.fill_ts,
      filledSize: r.filled_size,
      refillSize: r.refill_size ?? 0,
      cumulativeFilled: r.cumulative_filled,
    });
  }
  return refreshes;
}

/**
 * Cluster refresh events into confirmed icebergs.
 * Same (symbol, is_bid, price), consecutive refreshes within clusterWindowMs.
 */
export function clusterRefreshes(
  refreshes: IcebergRefresh[],
  opts: IcebergDetectorOpts,
): IcebergCluster[] {
  const clusterWindowMs = opts.clusterWindowMs ?? 30_000;
  const minRefreshes = opts.minRefreshes ?? 2;

  // Group by (is_bid, price) → array of refreshes sorted by fill_ts
  const byLevel = new Map<string, IcebergRefresh[]>();
  for (const r of refreshes) {
    const key = `${r.isBid ? 'B' : 'A'}|${r.price}`;
    let arr = byLevel.get(key);
    if (!arr) { arr = []; byLevel.set(key, arr); }
    arr.push(r);
  }

  const clusters: IcebergCluster[] = [];
  for (const [, arr] of byLevel) {
    arr.sort((a, b) => a.fillTs - b.fillTs);
    let current: IcebergRefresh[] = [];
    for (const r of arr) {
      if (current.length === 0 || r.fillTs - current[current.length - 1]!.refillTs <= clusterWindowMs) {
        current.push(r);
      } else {
        flush(current);
        current = [r];
      }
    }
    flush(current);
  }
  return clusters;

  function flush(group: IcebergRefresh[]): void {
    if (group.length < minRefreshes) return;
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const orderIds: string[] = [];
    for (const r of group) {
      if (orderIds.length === 0) orderIds.push(r.filledOrderId);
      orderIds.push(r.refillOrderId);
    }
    const totalVisible = group.reduce((s, r) => s + r.refillSize, 0) + first.filledSize;
    const totalTradedThrough = group.reduce((s, r) => s + r.cumulativeFilled, 0);
    const avgLatency = group.reduce((s, r) => s + r.latencyMs, 0) / group.length;
    clusters.push({
      symbol: opts.symbol,
      side: first.isBid ? 'BID' : 'ASK',
      price: first.price,
      firstRefreshTs: first.fillTs,
      lastRefreshTs: last.refillTs,
      refreshCount: group.length,
      totalVisibleVolume: totalVisible,
      totalTradedThrough,
      orderIds,
      avgRefreshLatencyMs: avgLatency,
    });
  }
}
