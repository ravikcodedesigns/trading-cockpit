#!/usr/bin/env python3
"""Compare the inferred-tape vs true-tape funnel runs (cvd_scan_funnel.ts output)."""
import json
from pathlib import Path
from collections import Counter

SB = Path.home() / "trading-cockpit" / "data" / "sandbox-cvd"
a0 = json.loads((SB / "arm0_inferred.json").read_text())   # live ticks.db / inferred
a1 = json.loads((SB / "arm1_true.json").read_text())       # MBO-true

STAGES = ["raw", "raw_tod_blocked", "raw_hourly_blocked", "raw_cooldown",
          "detected", "silenced", "cont_delta_blocked", "qualified", "skip_cvd", "tradable"]

def funnel(recs, label):
    print(f"\n── {label}: stage counts ──")
    c = Counter(r["stage"] for r in recs)
    for s in STAGES:
        if c[s]:
            print(f"   {s:22} {c[s]}")
    tr = [r for r in recs if r["stage"] == "tradable"]
    print(f"   {'TRADABLE total':22} {len(tr)}")

funnel(a0, "ARM0 inferred (live ticks.db)")
funnel(a1, "ARM1 true (MBO tape)")

def key(r): return (r["day"], r["rule"], r["dir"], r["barTs"])
t0 = {key(r): r for r in a0 if r["stage"] == "tradable"}
t1 = {key(r): r for r in a1 if r["stage"] == "tradable"}
k0, k1 = set(t0), set(t1)

def wl(recs):
    w = sum(1 for r in recs if r.get("outcome") == "WIN")
    l = sum(1 for r in recs if r.get("outcome") == "LOSS")
    d = sum(1 for r in recs if r.get("outcome") == "DRAW")
    pnl = sum(r.get("pnl", 0) or 0 for r in recs)
    return w, l, d, pnl

print("\n\n=== TRADABLE confusion: inferred → true ===")
survived = [t1[k] for k in (k0 & k1)]
lost = [t0[k] for k in (k0 - k1)]      # tradable on inferred, NOT on true
new = [t1[k] for k in (k1 - k0)]       # tradable on true, NOT on inferred
for label, recs in [("SURVIVED (tradable both)", survived),
                    ("LOST (inferred-only — true would drop)", lost),
                    ("NEW (true-only — inferred missed)", new)]:
    w, l, d, pnl = wl(recs)
    wr = f"{100*w/(w+l):.0f}%" if (w + l) else "—"
    print(f"\n  {label}: n={len(recs)}  W/L/D={w}/{l}/{d}  WR={wr}  pnl={pnl:+.0f}pt")
    for r in sorted(recs, key=lambda x: (x['day'], x['barTs'])):
        cv = r.get("cvdSession")
        cvs = f"{cv:+.0f}" if cv is not None else "?"
        print(f"     {r['day']} {r['rule'][:5]:5} {r['dir']:5} cvd={cvs:>8} {r.get('outcome','?'):5} {r.get('pnl',0):+.0f}")

print("\n\n=== NET tradable book per arm ===")
for label, t in [("inferred", t0.values()), ("true", t1.values())]:
    w, l, d, pnl = wl(list(t))
    wr = f"{100*w/(w+l):.0f}%" if (w + l) else "—"
    print(f"  {label:9}: n={len(list(t)) if False else len(t)}  W/L/D={w}/{l}/{d}  WR={wr}  pnl={pnl:+.0f}pt")

# delta-scale confound check: compare raw deltaT / delta15 magnitude across tapes
print("\n=== delta-scale check (raw FLIP detections, median |deltaT|,|delta15|) ===")
import statistics as st
for label, recs in [("inferred", a0), ("true", a1)]:
    f = [r for r in recs if r["rule"] == "clean-impulse" and "deltaT" in r]
    if f:
        dt = st.median(abs(r["deltaT"]) for r in f)
        d15 = st.median(abs(r["delta15"]) for r in f)
        print(f"   {label:9}: n={len(f)}  median|deltaT|={dt:.0f}  median|delta15|={d15:.0f}")
