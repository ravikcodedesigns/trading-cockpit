#!/usr/bin/env python3
"""
ticks_to_parquet.py — Convert the SQLite ticks.db (L1 trades + L2 depth) into a
columnar Parquet store for fast DuckDB analysis when building NEW strategies.

Why: ticks.db is a 50GB single-file SQLite, slow for analytical scans and in
contention with the live tick-store writer. Parquet + DuckDB is ~20-30x faster
on scan/aggregation queries (measured), with date-partition pruning.

IMPORTANT — this is an ANALYSIS copy, not a replacement:
  - The LIVE pipeline (flips/conts/qualified/tradables, tick-router, cvd-session,
    rules-v2) keeps reading ticks.db (SQLite). Do NOT repoint those.
  - Only NEW strategy/analysis code should query this parquet store.

Reads ticks.db READ-ONLY, per (table, symbol, ET-day) via the (symbol, ts)
index → index-fast and memory-bounded (streams in batches). Never writes ticks.db.

Layout (mirrors data/mbo-parquet/):
  data/ticks-parquet/{trades|depth}/symbol={NQ|ES}/date=YYYY-MM-DD(ET)/data.parquet

Resumable: skips any partition whose final data.parquet already exists. To
refresh recent days (e.g. today, which is still being written live), pass
--redo-from YYYY-MM-DD to re-convert from that ET date onward.

Note: ticks.db also has a `lost_and_found` table (SQLite recovery artifact) —
not converted; salvage separately if ever needed.
"""

import argparse
import os
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pyarrow as pa
import pyarrow.parquet as pq

ET = ZoneInfo("America/New_York")
REPO = Path.home() / "trading-cockpit"
DEFAULT_TICKS = REPO / "data" / "ticks.db"
DEFAULT_OUT = REPO / "data" / "ticks-parquet"
SYMBOLS = ("NQ", "ES")
BATCH = 500_000

# `symbol` is encoded ONLY in the hive partition path (symbol=NQ/), not written
# as a file column — matches the mbo store and avoids a hive/column collision on
# read with hive_partitioning=true. Same for `date`.
SCHEMAS = {
    "trades": pa.schema([
        ("ts", pa.int64()), ("price", pa.float64()),
        ("size", pa.int32()), ("is_bid_aggressor", pa.bool_()),
    ]),
    "depth": pa.schema([
        ("ts", pa.int64()), ("side", pa.int8()),
        ("price", pa.float64()), ("size", pa.int32()), ("is_replace", pa.bool_()),
    ]),
}
COLS = {"trades": ["ts", "price", "size", "is_bid_aggressor"],
        "depth":  ["ts", "side", "price", "size", "is_replace"]}
BOOLCOLS = {"is_bid_aggressor", "is_replace"}


def et_day_bounds(d):
    lo = datetime(d.year, d.month, d.day, tzinfo=ET)
    hi = lo + timedelta(days=1)
    return int(lo.timestamp() * 1000), int(hi.timestamp() * 1000)


def et_date(ts_ms):
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).astimezone(ET).date()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ticks", type=Path, default=DEFAULT_TICKS)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--redo-from", type=str, default=None, help="Re-convert (overwrite) partitions from this ET date (YYYY-MM-DD) onward")
    args = ap.parse_args()

    redo_from = datetime.strptime(args.redo_from, "%Y-%m-%d").date() if args.redo_from else None
    con = sqlite3.connect(f"file:{args.ticks}?mode=ro", uri=True)
    con.execute("PRAGMA query_only=1")

    t0 = time.time()
    grand = 0
    for table in ("trades", "depth"):
        names = COLS[table]
        sel = ", ".join(names)
        for sym in SYMBOLS:
            first = con.execute(f"SELECT ts FROM {table} WHERE symbol=? ORDER BY ts ASC LIMIT 1", (sym,)).fetchone()
            if not first:
                continue
            last = con.execute(f"SELECT ts FROM {table} WHERE symbol=? ORDER BY ts DESC LIMIT 1", (sym,)).fetchone()
            d0, d1 = et_date(first[0]), et_date(last[0])
            day = d0
            while day <= d1:
                ds = day.strftime("%Y-%m-%d")
                part = args.out / table / f"symbol={sym}" / f"date={ds}"
                final = part / "data.parquet"
                if final.exists() and not (redo_from and day >= redo_from):
                    day += timedelta(days=1)
                    continue
                lo, hi = et_day_bounds(day)
                cur = con.execute(
                    f"SELECT {sel} FROM {table} WHERE symbol=? AND ts>=? AND ts<? ORDER BY ts",
                    (sym, lo, hi),
                )
                part.mkdir(parents=True, exist_ok=True)
                tmp = part / ".data.parquet.tmp"
                writer = None
                n = 0
                while True:
                    rows = cur.fetchmany(BATCH)
                    if not rows:
                        break
                    cols = list(zip(*rows))
                    data = {}
                    for i, nm in enumerate(names):
                        vals = list(cols[i])
                        data[nm] = [bool(v) for v in vals] if nm in BOOLCOLS else vals
                    batch_tbl = pa.table(data, schema=SCHEMAS[table])
                    if writer is None:
                        writer = pq.ParquetWriter(str(tmp), SCHEMAS[table], compression="zstd", compression_level=3)
                    writer.write_table(batch_tbl)
                    n += len(rows)
                if writer is not None:
                    writer.close()
                    os.replace(tmp, final)
                    grand += n
                    print(f"  {table:6} {sym} {ds}: {n:,} rows", flush=True)
                else:
                    try:
                        part.rmdir()
                    except OSError:
                        pass
                day += timedelta(days=1)
    print(f"\ndone: {grand:,} rows in {time.time()-t0:.0f}s  ->  {args.out}")


if __name__ == "__main__":
    main()
