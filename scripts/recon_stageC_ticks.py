#!/usr/bin/env python3
"""Stage C — ticks.db (CQG source-of-record) ↔ ticks-parquet row reconciliation.
Per (symbol, table, ET-day): compare SQLite row count vs parquet row count.
Read-only on both. ET-day via machine localtime (this box is ET) to mirror
ticks_to_parquet's ZoneInfo('America/New_York') partitioning.
"""
import sqlite3, datetime as dt
from pathlib import Path
from collections import defaultdict
import duckdb

REPO = Path.home() / "trading-cockpit"
TICKS = REPO / "data" / "ticks.db"
TICK_PQ = REPO / "data" / "ticks-parquet"
TODAY = dt.date.today().isoformat()

con = duckdb.connect()
def pq_day_counts(level, sym):
    g = str(TICK_PQ / level / f"symbol={sym}" / "date=*" / "*.parquet")
    try:
        return {str(d): c for d, c in con.execute(
            f"SELECT date, COUNT(*) FROM read_parquet('{g}', hive_partitioning=1) GROUP BY date").fetchall()}
    except Exception:
        return {}

sq = sqlite3.connect(f"file:{TICKS}?mode=ro", uri=True)
def db_day_counts(table, sym):
    # ET calendar day from epoch-ms ts, machine-localtime (ET)
    cur = sq.execute(
        f"SELECT date(ts/1000,'unixepoch','localtime') d, COUNT(*) "
        f"FROM {table} WHERE symbol=? GROUP BY d", (sym,))
    return {d: c for d, c in cur.fetchall() if d}

print("="*72)
print("STAGE C — ticks.db (CQG) ↔ ticks-parquet   [DB vs PARQUET per ET-day]")
print("="*72)
grand = []
for sym in ("NQ", "ES"):
    for table in ("trades", "depth"):
        db = db_day_counts(table, sym)
        pq = pq_day_counts(table, sym)
        days = sorted(set(db) | set(pq))
        mism = []
        for d in days:
            a, b = db.get(d, 0), pq.get(d, 0)
            if a != b:
                mism.append((d, a, b, b - a))
        tot_db, tot_pq = sum(db.values()), sum(pq.values())
        print(f"\n## {sym} {table}:  db_days={len(db)} pq_days={len(pq)}  "
              f"db_rows={tot_db:,}  pq_rows={tot_pq:,}  Δ={tot_pq-tot_db:+,}")
        if not mism:
            print("   ✓ every day matches exactly")
        for d, a, b, delta in mism:
            flag = "  <-- TODAY (live/partial, expected)" if d == TODAY else \
                   ("  <-- DB-only (parquet MISSING)" if b == 0 else
                    "  <-- PARQUET-only (db empty?)" if a == 0 else "  <-- MISMATCH")
            print(f"   {d}  db={a:>12,}  pq={b:>12,}  Δ={delta:+,}{flag}")
            if d != TODAY:
                grand.append((sym, table, d, a, b, delta))

print("\n" + "="*72)
if grand:
    print(f"NON-TODAY MISMATCHES: {len(grand)} (investigate)")
    for r in grand: print("  ", r)
else:
    print("RESULT: ✓ ticks.db and ticks-parquet agree on every day except today (live).")
