#!/usr/bin/env python3
"""Cracker capture-order repair — acceptance check for re-converted partitions.

For every (table, symbol, date) partition in the refill staging dir:
  1. ORDER INTEGRITY: walking rows in seq order, ts_ms must be (near-)monotone —
     displaced rows (>5s behind the running max) must be ~0. This is the exact
     check that exposed the corruption (94–99% displaced on compacted days).
  2. COMPLETENESS: trades row count vs the ORIGINAL store for the same
     partition (original was DISTINCT-deduped, so staging ≈ original within a
     small tolerance; big deficits = a conversion problem).

Usage: .venv-mbo/bin/python scripts/verify_refill_order.py [--refill DIR] [--orig DIR]
Exit 0 = all partitions pass; 1 = failures listed.
"""
import argparse
import sys
from pathlib import Path

import duckdb

REPO = Path("/Users/ravikumarbasker/trading-cockpit")


def partitions(root: Path):
    for table_dir in sorted(root.iterdir()):
        if not table_dir.is_dir() or table_dir.name.startswith("."):
            continue
        for sym_dir in sorted(table_dir.glob("symbol=*")):
            for date_dir in sorted(sym_dir.glob("date=*")):
                if any(date_dir.glob("*.parquet")):
                    yield table_dir.name, sym_dir.name[7:], date_dir.name[5:], date_dir


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refill", type=Path, default=REPO / "data/mbo-parquet-refill")
    ap.add_argument("--orig", type=Path, default=REPO / "data/mbo-parquet")
    args = ap.parse_args()

    con = duckdb.connect()
    con.execute("PRAGMA threads=4")
    con.execute("PRAGMA memory_limit='24GB'")

    failures = []
    hdr = f"{'table':7} {'sym':4} {'date':11} {'rows':>12} {'displaced':>10} {'back':>7} {'vs-orig':>9}  verdict"
    print(hdr)
    print("-" * len(hdr))

    for table, sym, date, d in partitions(args.refill):
        glob = str(d / "*.parquet")
        # 1) order integrity in seq order WITHIN EACH SOURCE FILE — seq is a byte
        #    offset, unique only per source log; a partition can legitimately hold
        #    rows from two logs (midnight-boundary spillover), whose seqs collide.
        #    Replays sort by (ts_ms, seq) so cross-file collisions are harmless;
        #    what must hold is per-file monotonicity (capture order preserved).
        n, disp, back = con.execute(
            f"""WITH t AS (SELECT ts_ms,
                                  MAX(ts_ms) OVER (PARTITION BY filename ORDER BY seq ROWS UNBOUNDED PRECEDING) runmax,
                                  LAG(ts_ms) OVER (PARTITION BY filename ORDER BY seq) prev
                           FROM read_parquet('{glob}', filename=true))
                SELECT COUNT(*),
                       SUM(CASE WHEN ts_ms < runmax - 5000 THEN 1 ELSE 0 END),
                       SUM(CASE WHEN prev IS NOT NULL AND ts_ms < prev THEN 1 ELSE 0 END)
                FROM t"""
        ).fetchone()
        disp = disp or 0
        back = back or 0
        # 2) completeness vs original (trades only — the table our studies reconciled)
        delta_txt = "-"
        ok_complete = True
        if table == "trades":
            orig_dir = args.orig / table / f"symbol={sym}" / f"date={date}"
            if any(orig_dir.glob("*.parquet")):
                o = con.execute(f"SELECT COUNT(*) FROM read_parquet('{orig_dir}/*.parquet', union_by_name=true)").fetchone()[0]
                delta = (n - o) / o * 100 if o else 0.0
                delta_txt = f"{delta:+.2f}%"
                ok_complete = n >= o * 0.99  # staging must not lose >1% vs original
        ok_order = disp <= max(10, n * 1e-6)  # essentially zero displaced rows
        verdict = "PASS" if (ok_order and ok_complete) else "FAIL"
        if verdict == "FAIL":
            failures.append((table, sym, date, disp, delta_txt))
        print(f"{table:7} {sym:4} {date:11} {n:12,d} {disp:10,d} {back:7,d} {delta_txt:>9}  {verdict}")

    print()
    if failures:
        print(f"{len(failures)} FAILING partition(s):")
        for f in failures:
            print(f"  {f}")
        return 1
    print("ALL PARTITIONS PASS — capture order intact, completeness within tolerance.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
