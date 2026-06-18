#!/usr/bin/env python3
"""Diagnostic + gated-variant test for the LONG-FLIP mirror features
(priorImpulseDown, lowerWick). Reads long_flip_features.json."""
import json
from pathlib import Path
import numpy as np

P = Path.home() / "trading-cockpit" / "data" / "sandbox-cvd" / "long_flip_features.json"
rows = json.loads(P.read_text())
res = [r for r in rows if r["outcome"] in ("WIN", "LOSS")]
W = [r for r in res if r["outcome"] == "WIN"]
L = [r for r in res if r["outcome"] == "LOSS"]
allpnl = sum(r["pnl"] for r in rows)


def auc(pos, neg):
    if not pos or not neg: return float("nan")
    pos, neg = np.array(pos), np.array(neg)
    return sum((pos > n).sum() + 0.5 * (pos == n).sum() for n in neg) / (len(pos) * len(neg))


def split_dt(day):  # May = train, June = test
    return "MAY" if day < "2026-06-01" else "JUN"


print(f"=== baseline tradable LONGs: {len(rows)} (resolved {len(res)}: {len(W)}W/{len(L)}L, "
      f"{len(rows)-len(res)}D)  WR={100*len(W)/max(1,len(res)):.0f}%  pnl={allpnl:+.0f}pt ===")

print("\n── DIAGNOSTIC: do the features separate winners from losers? ──")
for feat, hi_wins in [("priorImpulseDown", False), ("lowerWick", True), ("strictLowerWick", True), ("deltaT", True)]:
    wv = [r[feat] for r in W]; lv = [r[feat] for r in L]
    a = auc(wv, lv)
    # direction we expect to help
    exp = "more-negative→win" if not hi_wins else "larger→win"
    sep = "higher-wins" if a > 0.5 else "lower-wins" if a < 0.5 else "none"
    print(f"   {feat:17} WIN med={np.median(wv):+8.1f}  LOSS med={np.median(lv):+8.1f}  AUC={a:.3f} ({sep}; want {exp})")


def report(name, keep):
    kr = [r for r in keep if r["outcome"] in ("WIN", "LOSS")]
    w = sum(1 for r in kr if r["outcome"] == "WIN")
    cut = [r for r in res if r not in keep]
    cw = sum(1 for r in cut if r["outcome"] == "WIN"); cl = sum(1 for r in cut if r["outcome"] == "LOSS")
    pnl = sum(r["pnl"] for r in keep)
    wr = f"{100*w/len(kr):.0f}%" if kr else "—"
    print(f"   {name:34} n={len(keep):3} WR={wr:>4} pnl={pnl:+6.0f}pt  | cut {len(cut)} ({cw}W/{cl}L)")


print("\n── GATED VARIANTS (added on top of baseline) ──")
report("baseline (no extra gate)", rows)
print("  + prior-impulse-down <= thr:")
for thr in (-500, -800, -1400, -2000):
    report(f"    priorImpulseDown <= {thr}", [r for r in rows if r["priorImpulseDown"] <= thr])
print("  + lower-wick (close-low) >= thr:")
for thr in (5, 10, 15, 20):
    report(f"    lowerWick >= {thr}", [r for r in rows if r["lowerWick"] >= thr])
print("  + strict lower-wick (min(o,c)-low) >= thr:")
for thr in (3, 5, 8):
    report(f"    strictLowerWick >= {thr}", [r for r in rows if r["strictLowerWick"] >= thr])
print("  + BOTH:")
for pi, lw in [(-800, 10), (-1400, 15)]:
    report(f"    pid<={pi} & lw>={lw}", [r for r in rows if r["priorImpulseDown"] <= pi and r["lowerWick"] >= lw])

print("\n── TRAIN(May)/TEST(June) for the most promising gate ──")
for r in rows: r["_s"] = split_dt(r["day"])
for label, fn in [("baseline", lambda r: True),
                  ("lowerWick>=10", lambda r: r["lowerWick"] >= 10),
                  ("priorImpulseDown<=-800", lambda r: r["priorImpulseDown"] <= -800)]:
    for seg in ("MAY", "JUN"):
        g = [r for r in rows if r["_s"] == seg and fn(r)]
        gr = [r for r in g if r["outcome"] in ("WIN", "LOSS")]
        w = sum(1 for r in gr if r["outcome"] == "WIN")
        wr = f"{100*w/len(gr):.0f}%" if gr else "—"
        print(f"   {label:24} {seg}: n={len(g):3} resolved={len(gr):3} WR={wr:>4} pnl={sum(r['pnl'] for r in g):+6.0f}pt")
