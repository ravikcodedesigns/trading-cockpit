#!/usr/bin/env python3
"""
quote_rule.py — corrected per-trade aggressor via L2 quote rule (Lee-Ready).

Phase 1 of the CVD migration. SANDBOX / read-only: reads the parquet stores,
writes nothing, touches no live code or data.

Method: replay L2 depth into a live book; for each trade classify by the quote
rule against the book JUST BEFORE the trade:
  price >= best_ask -> BUY aggressor (+)
  price <= best_bid -> SELL aggressor (-)
  strictly inside   -> tick-rule fallback (up=BUY, down=SELL, flat=carry)
best_bid/ask are anchored to the trade price (max bid<=price / min ask>=price
within a band) so stale far levels can't produce a crossed inside.

VALIDATION (this file's CLI): run on the MBO store, which has BOTH the L2 depth
AND the exchange's TRUE aggressor flag, so we can score the quote rule against
ground truth — per-trade agreement and CVD match — on June.
"""

import argparse
from datetime import datetime, timezone
from pathlib import Path

import duckdb

REPO = Path.home() / "trading-cockpit"
MBO = REPO / "data" / "mbo-parquet"
TICKS = REPO / "data" / "ticks-parquet"
BID, ASK = 0, 1
BAND = 10.0          # +-pt anchor window for the inside
PRUNE_EVERY = 200_000
PRUNE_KEEP = 50.0


class Book:
    __slots__ = ("bid", "ask")

    def __init__(self):
        self.bid: dict[float, int] = {}
        self.ask: dict[float, int] = {}

    def apply(self, side, price, size):
        d = self.bid if side == BID else self.ask
        if size == 0:
            d.pop(price, None)
        else:
            d[price] = size

    def inside(self, price, band=BAND):
        bb = max((p for p in self.bid if price - band <= p <= price), default=None)
        ba = min((p for p in self.ask if price <= p <= price + band), default=None)
        return bb, ba

    def prune(self, anchor, keep=PRUNE_KEEP):
        for d in (self.bid, self.ask):
            for p in [p for p in d if abs(p - anchor) > keep]:
                del d[p]


def classify_day(depth, trades):
    """depth/trades are dicts of numpy arrays sorted by ts. Yields per-trade
    (ts, price, size, quote_class) where quote_class: 1=BUY, 0=SELL."""
    dts, dsd, dpx, dsz = depth["ts"].tolist(), depth["side"].tolist(), depth["price"].tolist(), depth["size"].tolist()
    tts, tpx, tsz = trades["ts"].tolist(), trades["price"].tolist(), trades["size"].tolist()
    book = Book()
    di, nd = 0, len(dts)
    last_px = None
    last_c = 1
    n_quote = n_tick = 0
    out = []
    for i in range(len(tts)):
        ts, price, size = tts[i], tpx[i], tsz[i]
        # Classify against the book STRICTLY BEFORE the trade — depth events at
        # the trade's own ts are the trade's effect (the consumed level being
        # removed); applying them first would erase the level we need to read.
        while di < nd and dts[di] < ts:
            book.apply(dsd[di], dpx[di], dsz[di]); di += 1
        if di % PRUNE_EVERY == 0 and di:
            book.prune(price)
        bb, ba = book.inside(price)
        # Lee-Ready: clean non-crossed inside required; classify vs MIDPOINT.
        # A degenerate inside (stale level at the trade price → bb>=ba) falls to
        # the tick rule rather than mis-firing on the stale side.
        if bb is not None and ba is not None and bb < ba and price != (bb + ba) / 2:
            c = 1 if price > (bb + ba) / 2 else 0
            n_quote += 1
        else:  # inside spread / degenerate / no book → tick rule
            if last_px is None or price == last_px:
                c = last_c
            else:
                c = 1 if price > last_px else 0
            n_tick += 1
        last_px, last_c = price, c
        out.append((ts, price, size, c))
    return out, n_quote, n_tick


def load(con, store, table, date, contract, cols):
    g = f"{store}/{table}/symbol=NQ/date={date}/*.parquet"
    where = "WHERE price IS NOT NULL AND size IS NOT NULL"
    if contract:
        where += f" AND contract='{contract}'"
    return con.execute(f"SELECT {cols} FROM read_parquet('{g}') {where} ORDER BY ts").fetchnumpy()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", required=True)
    ap.add_argument("--contract", default="MNQU6", help="MBO contract to validate (front month for the date)")
    args = ap.parse_args()
    con = duckdb.connect(); con.execute("PRAGMA threads=4")

    # MBO store schema: ts_ms, is_bid (depth) / is_bid_aggressor (trades). Alias
    # to the (ts, side) shape classify_day expects. side: 0=bid, 1=ask.
    depth = load(con, MBO, "depth", args.date, args.contract,
                 "ts_ms AS ts, CASE WHEN is_bid THEN 0 ELSE 1 END AS side, price, size")
    trades = load(con, MBO, "trades", args.date, args.contract,
                  "ts_ms AS ts, price, size, is_bid_aggressor")
    truth = trades["is_bid_aggressor"].tolist()

    out, n_quote, n_tick = classify_day(depth, trades)
    n = len(out)
    if n == 0:
        print(f"no MBO trades for NQ {args.date} contract={args.contract}"); return

    agree = sum(1 for k in range(n) if out[k][3] == (1 if truth[k] else 0))
    cvd_quote = sum(size if c == 1 else -size for (_, _, size, c) in out)
    cvd_true = sum(size if truth[k] else -size for k, (_, _, size, _) in enumerate(out))
    # agreement on the inside-spread (tick-fallback) subset only
    print(f"\n=== quote-rule vs TRUE aggressor — NQ {args.date} ({args.contract}) ===")
    print(f"trades: {n:,}")
    print(f"classified by quote rule: {100*n_quote/n:.1f}%   by tick fallback: {100*n_tick/n:.1f}%")
    print(f"per-trade agreement vs true aggressor: {100*agree/n:.2f}%")
    print(f"CVD (quote-rule): {cvd_quote:+,}")
    print(f"CVD (true MBO):   {cvd_true:+,}")
    diff = cvd_quote - cvd_true
    print(f"CVD diff: {diff:+,}  ({100*abs(diff)/max(1,abs(cvd_true)):.1f}% of true)")


if __name__ == "__main__":
    main()
