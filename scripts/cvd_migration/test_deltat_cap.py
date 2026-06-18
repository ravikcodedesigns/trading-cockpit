#!/usr/bin/env python3
"""Test CAPPING deltaT on long FLIPs. Baseline requires deltaT>=300; this adds
an upper cap. Diagnostic showed winners have LOWER deltaT (701 vs 898, AUC 0.401).
Reads long_flip_features.json. SANDBOX."""
import json
from pathlib import Path
import numpy as np

P = Path.home() / "trading-cockpit" / "data" / "sandbox-cvd" / "long_flip_features.json"
rows = json.loads(P.read_text())
res = [r for r in rows if r["outcome"] in ("WIN", "LOSS")]
W = [r for r in res if r["outcome"] == "WIN"]; L = [r for r in res if r["outcome"] == "LOSS"]
rng = np.random.default_rng(20260618)


def auc(pos, neg):
    pos, neg = np.array(pos), np.array(neg)
    return sum((pos > n).sum() + 0.5 * (pos == n).sum() for n in neg) / (len(pos) * len(neg))


def stats(keep):
    kr = [r for r in keep if r["outcome"] in ("WIN", "LOSS")]
    w = sum(1 for r in kr if r["outcome"] == "WIN")
    pnl = sum(r["pnl"] for r in keep)
    return len(keep), len(kr), w, (100 * w / len(kr) if kr else 0), pnl, (pnl / len(keep) if keep else 0)


print(f"=== CAP deltaT on long FLIPs (baseline deltaT>=300) ===")
n, nr, w, wr, pnl, ev = stats(rows)
print(f"baseline (no cap): n={n} resolved={nr} WR={wr:.0f}% pnl={pnl:+.0f}pt EV={ev:+.1f}pt/trade\n")

CAPS = [500, 600, 700, 800, 900, 1000, 1200]
print(f"{'cap (300<=dT<=cap)':22}{'n':>4}{'WR':>6}{'pnl':>9}{'EV':>8}   cut(W/L)")
for cap in CAPS:
    keep = [r for r in rows if r["deltaT"] <= cap]
    cut = [r for r in res if r["deltaT"] > cap]
    cw = sum(1 for r in cut if r["outcome"] == "WIN"); cl = sum(1 for r in cut if r["outcome"] == "LOSS")
    n, nr, w, wr, pnl, ev = stats(keep)
    print(f"   deltaT <= {cap:<10}{n:>4}{wr:>5.0f}%{pnl:>+8.0f}{ev:>+7.1f}   {cw}W/{cl}L")

# also the COMPLEMENT — do the high-deltaT longs actually lose?
print("\n── the cut cohort (high deltaT) on its own ──")
for cap in (700, 900):
    hi = [r for r in rows if r["deltaT"] > cap]
    n, nr, w, wr, pnl, ev = stats(hi)
    print(f"   deltaT > {cap}: n={n} WR={wr:.0f}% pnl={pnl:+.0f}pt EV={ev:+.1f}pt/trade")

# ── significance: does deltaT predict outcome at all? (scale-free, no threshold) ──
obs_auc = auc([r["deltaT"] for r in W], [r["deltaT"] for r in L])
labels = np.array([1 if r["outcome"] == "WIN" else 0 for r in res])
dts = np.array([r["deltaT"] for r in res])
obs_dev = abs(obs_auc - 0.5)
cnt = 0; B = 10000
for _ in range(B):
    p = rng.permutation(labels)
    a = auc(list(dts[p == 1]), list(dts[p == 0]))
    if abs(a - 0.5) >= obs_dev:
        cnt += 1
print(f"\n── PERMUTATION ({B}): does deltaT predict long outcome? ──")
print(f"   observed AUC={obs_auc:.3f} (dev {obs_dev:.3f} from 0.5)  two-sided p={(cnt+1)/(B+1):.4f}")

# ── TRAIN(May)/TEST(June) ──
print("\n── TRAIN(May)/TEST(June) ──")
for label, fn in [("baseline", lambda r: True),
                  ("deltaT<=700", lambda r: r["deltaT"] <= 700),
                  ("deltaT<=900", lambda r: r["deltaT"] <= 900)]:
    line = f"   {label:14}"
    for seg, lo, hi in [("MAY", "0", "2026-06-01"), ("JUN", "2026-06-01", "9")]:
        g = [r for r in rows if lo <= r["day"] < hi and fn(r)]
        gr = [r for r in g if r["outcome"] in ("WIN", "LOSS")]
        wn = sum(1 for r in gr if r["outcome"] == "WIN")
        wr = f"{100*wn/len(gr):.0f}%" if gr else "—"
        line += f"  {seg}: n={len(g):3} WR={wr:>4} pnl={sum(r['pnl'] for r in g):+6.0f}"
    print(line)
