#!/usr/bin/env python3
"""
cross_validate_ticks.py — go/no-go for the May source.

Phase-1 follow-up. The earlier validation ran the quote rule on MBO-parquet depth
(which conveniently has the true aggressor). But MAY will use TICKS-parquet depth
(a different capture). This runs the SAME quote-rule classifier on ticks-parquet
depth+trades for June and compares the resulting CVD to:
  - TRUE-MBO CVD (ground truth, front contract), and
  - the current INFERRED CVD (ticks is_bid_aggressor — what the live gate uses).
All over the RTH window (09:30–16:00 ET), the period the cvdSession gate cares about.

If quote-rule-on-ticks ≈ true-MBO, May (ticks-only) is viable. SANDBOX / read-only.
"""

import argparse
from datetime import datetime, timezone

import duckdb
from quote_rule import classify_day, MBO, TICKS


def rth_bounds(date):
    y, m, d = map(int, date.split("-"))
    lo = int(datetime(y, m, d, 13, 30, tzinfo=timezone.utc).timestamp() * 1000)  # 09:30 ET (EDT)
    hi = int(datetime(y, m, d, 20, 0, tzinfo=timezone.utc).timestamp() * 1000)   # 16:00 ET
    return lo, hi


def run(con, date, contract):
    lo, hi = rth_bounds(date)
    tg = f"{TICKS}"
    depth = con.execute(
        f"SELECT ts, side, price, size FROM read_parquet('{tg}/depth/symbol=NQ/date={date}/*.parquet') "
        f"WHERE ts>={lo} AND ts<{hi} AND price IS NOT NULL AND size IS NOT NULL ORDER BY ts").fetchnumpy()
    trades = con.execute(
        f"SELECT ts, price, size, is_bid_aggressor FROM read_parquet('{tg}/trades/symbol=NQ/date={date}/*.parquet') "
        f"WHERE ts>={lo} AND ts<{hi} AND price IS NOT NULL ORDER BY ts").fetchnumpy()
    if len(trades["ts"]) == 0:
        print(f"{date}: no ticks-parquet trades"); return
    out, nq, nt = classify_day(depth, trades)
    sizes = trades["size"].tolist()
    infer = trades["is_bid_aggressor"].tolist()
    cvd_quote = sum(size if c == 1 else -size for (_, _, size, c) in out)
    cvd_infer = sum(sizes[k] if infer[k] == 1 else -sizes[k] for k in range(len(out)))
    true = con.execute(
        f"SELECT SUM(CASE WHEN is_bid_aggressor THEN size ELSE -size END) "
        f"FROM read_parquet('{MBO}/trades/symbol=NQ/date={date}/*.parquet') "
        f"WHERE contract='{contract}' AND price IS NOT NULL AND ts_ms>={lo} AND ts_ms<{hi}").fetchone()[0] or 0
    eq = lambda v: f"{100*abs(v-true)/max(1,abs(true)):.0f}%"
    print(f"{date} ({contract}): trades={len(out):,}  quote/tick {100*nq/len(out):.0f}/{100*nt/len(out):.0f}")
    print(f"   TRUE-MBO CVD:   {true:+,}")
    print(f"   quote-rule:     {cvd_quote:+,}   (off {eq(cvd_quote)})")
    print(f"   inferred(live): {cvd_infer:+,}   (off {eq(cvd_infer)})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs", nargs="+", default=[
        "2026-06-09:MNQM6", "2026-06-11:MNQM6", "2026-06-12:MNQM6",
        "2026-06-15:MNQU6", "2026-06-16:MNQU6"])
    args = ap.parse_args()
    con = duckdb.connect(); con.execute("PRAGMA threads=4")
    print("=== quote-rule on TICKS-parquet depth vs TRUE-MBO vs INFERRED (RTH) ===")
    for p in args.pairs:
        date, contract = p.split(":")
        run(con, date, contract)


if __name__ == "__main__":
    main()
