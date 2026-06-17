#!/usr/bin/env python3
"""
train_test.py — failed-auction (revfrom + revto) across the Phase-1 day split.

Detection params are PRE-REGISTERED in detect.py (no per-day tuning here — a
single config evaluated on TRAIN vs TEST vs HOLDOUT vs fresh OOS, so a real edge
must show consistency, not curve-fit). Reports per variant per split: n, W/L/Open,
WR, Wilson 95% CI, total PnL $, expectancy $/trade.

Detection is the same causal, no-lookahead engine validated earlier. ~40s/day.
"""

import math
from detect import detect_day, walk  # noqa: E402

USD_PER_PT = 2.0

# Phase-1 stratified split (apps/aggregator/scripts/phase1/days.ts)
TRAIN = ['2026-05-06','2026-05-08','2026-05-12','2026-05-14','2026-05-18','2026-05-20',
         '2026-05-22','2026-05-27','2026-05-29','2026-06-02','2026-06-04','2026-06-08','2026-06-10']
TEST = ['2026-05-11','2026-05-13','2026-05-15','2026-05-19','2026-05-21','2026-05-26',
        '2026-05-28','2026-06-01','2026-06-03','2026-06-05','2026-06-09','2026-06-11']
HOLDOUT = ['2026-06-12']
OOS = ['2026-06-15', '2026-06-16']   # fresh — defined after the phase-1 split
SPLITS = [('TRAIN', TRAIN), ('TEST', TEST), ('HOLDOUT', HOLDOUT), ('OOS', OOS)]


def wilson(w, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = w / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (100 * (c - h), 100 * (c + h))


def agg(rows):
    n = len(rows)
    W = sum(r["reason"] == "WIN" for r in rows)
    L = sum(r["reason"] == "LOSS" for r in rows)
    O = sum(r["reason"] == "OPEN" for r in rows)
    pnl = sum(r["pnl"] for r in rows) * USD_PER_PT
    wr = 100 * W / (W + L) if (W + L) else 0.0
    lo, hi = wilson(W, W + L)
    exp = pnl / n if n else 0.0
    return n, W, L, O, wr, lo, hi, pnl, exp


def main():
    # detect once per day (expensive), tag outcomes by split
    by_split = {name: [] for name, _ in SPLITS}
    for name, days in SPLITS:
        for date in days:
            setups, trades, rth_close = detect_day("NQ", date)
            out = walk(setups, trades, rth_close)
            for r in out:
                r["day"] = date
            by_split[name] += out
            print(f"  [{name}] {date}: {len(out)} setups", flush=True)

    print("\n" + "=" * 96)
    print("FAILED-AUCTION TRAIN/TEST — NQ  (pre-registered config, no per-day tuning)")
    print("=" * 96)
    for variant in ("revfrom", "revto"):
        print(f"\n■ {variant.upper()}")
        print(f"{'split':8} {'days':>4} {'n':>4} {'W':>4} {'L':>4} {'O':>3} {'WR':>7} {'Wilson95':>15} {'PnL$':>9} {'exp$/t':>8}")
        allrows = []
        for name, days in SPLITS:
            rows = [r for r in by_split[name] if r["variant"] == variant]
            allrows += rows
            n, W, L, O, wr, lo, hi, pnl, exp = agg(rows)
            print(f"{name:8} {len(days):>4} {n:>4} {W:>4} {L:>4} {O:>3} {wr:>6.1f}% [{lo:>4.0f},{hi:>4.0f}]% {pnl:>+8.0f} {exp:>+7.1f}")
        n, W, L, O, wr, lo, hi, pnl, exp = agg(allrows)
        print(f"{'ALL':8} {'':>4} {n:>4} {W:>4} {L:>4} {O:>3} {wr:>6.1f}% [{lo:>4.0f},{hi:>4.0f}]% {pnl:>+8.0f} {exp:>+7.1f}")


if __name__ == "__main__":
    main()
