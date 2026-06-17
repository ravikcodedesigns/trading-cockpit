#!/usr/bin/env python3
"""
book_reconstruct.py — event-replay L2 order book for failed-auction research.

Reconstructs the instantaneous limit-order book by replaying ticks-parquet depth
events in timestamp order. Feed semantics (verified 2026-06-17 on the capture):
  - each depth event is an ABSOLUTE size at (side, price); is_replace is always true
  - size == 0  => that price level is removed
  - only ~16% of events are removals, so DISTANT levels go stale and are never
    zeroed. A windowed `arg_max(size)` per price therefore yields a CROSSED book
    (bids above asks spanning the whole session range). Sequential replay +
    near-touch anchoring to the last trade price gives the correct inside.

Trust band: only the near-touch ladder (±TRUST_PTS of the last trade) is reliable;
far levels may be stale. Failed-auction detection (voids/exhaustion) is entirely
near-touch, so this is sufficient.

This module is the shared foundation for both failed-auction variants
(void-revert and touch-exhaustion). It is READ-ONLY over the parquet store.

CLI runs a validation gate over a date/time window:
  python scripts/failed_auction/book_reconstruct.py --date 2026-06-16
"""

import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import duckdb

ET = ZoneInfo("America/New_York")
REPO = Path.home() / "trading-cockpit"
TICKS_PARQUET = REPO / "data" / "ticks-parquet"
BID, ASK = 0, 1


class Book:
    """Instantaneous L2 ladder maintained by event replay."""

    def __init__(self):
        self.bid: dict[float, int] = {}   # price -> size
        self.ask: dict[float, int] = {}

    def apply(self, side: int, price: float, size: int) -> None:
        d = self.bid if side == BID else self.ask
        if size == 0:
            d.pop(price, None)
        else:
            d[price] = size

    def inside(self, anchor: float, band: float):
        """Best bid (<=anchor) and best ask (>=anchor) within ±band of the
        anchor (last trade). Anchoring is what avoids stale far levels."""
        bb = max((p for p in self.bid if anchor - band <= p <= anchor), default=None)
        ba = min((p for p in self.ask if anchor <= p <= anchor + band), default=None)
        return bb, ba

    def levels_near(self, anchor: float, band: float):
        nb = sum(1 for p, s in self.bid.items() if anchor - band <= p <= anchor and s > 0)
        na = sum(1 for p, s in self.ask.items() if anchor <= p <= anchor + band and s > 0)
        return nb, na

    def size_at(self, side: int, price: float) -> int:
        return (self.bid if side == BID else self.ask).get(price, 0)

    def prune(self, anchor: float, keep: float) -> None:
        """Drop levels far from the anchor to bound memory + stale-level drift."""
        for d in (self.bid, self.ask):
            for p in [p for p in d if abs(p - anchor) > keep]:
                del d[p]


def _ms(et_dt: datetime) -> int:
    return int(et_dt.replace(tzinfo=ET).timestamp() * 1000)


def load(con, table: str, symbol: str, date: str, lo: int, hi: int, cols: str):
    g = f"{TICKS_PARQUET}/{table}/symbol={symbol}/date={date}/*.parquet"
    return con.execute(
        f"SELECT {cols} FROM read_parquet('{g}') WHERE ts>={lo} AND ts<{hi} ORDER BY ts"
    ).fetchnumpy()


def replay(symbol: str, date: str, lo: int, hi: int, *, band=12.0, keep=50.0,
           prune_every=200_000, on_checkpoint=None, check_ms=1000):
    """Replay depth events, advancing the trade-price anchor; call on_checkpoint
    (book, anchor_ts, anchor_px) every check_ms of market time. Returns the Book."""
    con = duckdb.connect(); con.execute("PRAGMA threads=4")
    d = load(con, "depth", symbol, date, lo, hi, "ts, side, price, size")
    t = load(con, "trades", symbol, date, lo, hi, "ts, price")
    dts = d["ts"].tolist(); dside = d["side"].tolist(); dpx = d["price"].tolist(); dsz = d["size"].tolist()
    tts = t["ts"].tolist(); tpx = t["price"].tolist()

    book = Book()
    anchor = tpx[0] if tpx else None
    ti = 0; ntrades = len(tts)
    next_check = lo
    for i in range(len(dts)):
        ts = dts[i]
        while ti < ntrades and tts[ti] <= ts:
            anchor = tpx[ti]; ti += 1
        book.apply(dside[i], dpx[i], dsz[i])
        if i % prune_every == 0 and anchor is not None:
            book.prune(anchor, keep)
        if on_checkpoint is not None and anchor is not None and ts >= next_check:
            on_checkpoint(book, ts, anchor, band)
            next_check = ts + check_ms
    return book


def validate(symbol: str, date: str, lo: int, hi: int, band=10.0):
    n = crossed = deep = 0
    spreads, levels = [], []
    worst = []

    def cb(book: Book, ts: int, anchor: float, _band: float):
        nonlocal n, crossed, deep
        bb, ba = book.inside(anchor, band)
        nb, na = book.levels_near(anchor, band)
        n += 1
        if bb is not None and ba is not None:
            if bb >= ba:
                crossed += 1
                if len(worst) < 5:
                    worst.append((ts, anchor, bb, ba))
            else:
                spreads.append(round((ba - bb) / 0.25))  # ticks
        if nb >= 5 and na >= 5:
            deep += 1
        levels.append(min(nb, na))

    replay(symbol, date, lo, hi, band=band, on_checkpoint=cb, check_ms=1000)
    spreads.sort(); levels.sort()
    med = lambda a: a[len(a) // 2] if a else None
    et = lambda ms: datetime.fromtimestamp(ms / 1000, tz=timezone.utc).astimezone(ET).strftime("%H:%M:%S")
    print(f"\n=== book reconstruction validation — {symbol} {date} ===")
    print(f"checkpoints (1/s of market time): {n:,}")
    print(f"crossed inside (anchored):        {crossed}  ({100*crossed/n:.2f}%)   ← want ≈0")
    print(f"median spread:                    {med(spreads)} ticks")
    print(f"median levels/side near ±{band:.0f}pt:    {med(levels)}")
    print(f"book ≥5 levels BOTH sides:        {100*deep/n:.1f}% of checkpoints   ← multi-level if high")
    if worst:
        print("sample crossed checkpoints (anchor gaps / thin overnight):")
        for ts, a, bb, ba in worst:
            print(f"   {et(ts)} anchor={a} bb={bb} ba={ba}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--symbol", default="NQ")
    ap.add_argument("--date", required=True, help="ET date YYYY-MM-DD")
    ap.add_argument("--from-et", default="09:30")
    ap.add_argument("--to-et", default="16:00")
    ap.add_argument("--band", type=float, default=10.0)
    args = ap.parse_args()
    y, m, dd = map(int, args.date.split("-"))
    fh, fm = map(int, args.from_et.split(":"))
    th, tm = map(int, args.to_et.split(":"))
    lo = _ms(datetime(y, m, dd, fh, fm))
    hi = _ms(datetime(y, m, dd, th, tm))
    validate(args.symbol, args.date, lo, hi, band=args.band)


if __name__ == "__main__":
    main()
