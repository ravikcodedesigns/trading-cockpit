#!/usr/bin/env python3
"""Trap (J) signal performance May-Jun. Silenced rule → no stored outcomes, so
walk-forward each from ticks.db. As-designed bracket: SL = signal's own stop
(spike extreme), TP = T1 (±20) and T2 (±40). Mark-to-last if neither hit in 4h.
WIN/LOSS/DRAW only. SANDBOX read-only."""
import json, sqlite3
from pathlib import Path
from collections import defaultdict

REPO = Path.home() / "trading-cockpit"
tdb = sqlite3.connect(f"file:{REPO/'data'/'trading.db'}?mode=ro", uri=True)
xdb = sqlite3.connect(f"file:{REPO/'data'/'ticks.db'}?mode=ro", uri=True)
HORIZON = 4 * 3600_000

sigs = []
for ts, sym, payload in tdb.execute("SELECT ts, symbol, payload FROM signals WHERE rule_id='trap' ORDER BY ts"):
    p = json.loads(payload)
    e, sl, d = p.get("entry"), p.get("stopLevel"), p.get("direction")
    if e is None or sl is None: continue
    sigs.append((ts, sym, d, e, sl))

xsyms = {r[0] for r in xdb.execute("SELECT DISTINCT symbol FROM trades")}

def walk(ts, sym, d, entry, sl, tp_pts):
    tp = entry + tp_pts if d == "long" else entry - tp_pts
    rows = xdb.execute("SELECT price FROM trades WHERE symbol=? AND ts>=? AND ts<? ORDER BY ts",
                       (sym, ts, ts + HORIZON)).fetchall()
    if not rows: return None
    last = entry
    for (px,) in rows:
        last = px
        if d == "long":
            if px <= sl: return ("LOSS", sl - entry)
            if px >= tp: return ("WIN", tp_pts)
        else:
            if px >= sl: return ("LOSS", entry - sl)
            if px <= tp: return ("WIN", tp_pts)
    return ("DRAW", (last - entry) if d == "long" else (entry - last))

for tp_pts, name in [(20, "T1=±20"), (40, "T2=±40")]:
    print(f"\n=== TRAP perf — {name}, SL=own stop (spike extreme), 4h horizon ===")
    agg = defaultdict(lambda: {"W":0,"L":0,"D":0,"pnl":0.0,"nodata":0})
    for ts, sym, d, e, sl in sigs:
        if sym not in xsyms:
            agg[(sym,d)]["nodata"]+=1; continue
        r = walk(ts, sym, d, e, sl, tp_pts)
        if r is None: agg[(sym,d)]["nodata"]+=1; continue
        o, pnl = r
        agg[(sym,d)]["W" if o=="WIN" else "L" if o=="LOSS" else "D"] += 1
        agg[(sym,d)]["pnl"] += pnl
    print(f"  {'cohort':12}{'W':>4}{'L':>4}{'D':>4}{'WR':>6}{'net pts':>9}{'EV/sig':>8}")
    tot = {"W":0,"L":0,"D":0,"pnl":0.0}
    for (sym,d) in sorted(agg):
        a = agg[(sym,d)]; n = a["W"]+a["L"]+a["D"]
        if n==0: continue
        wr = 100*a["W"]/(a["W"]+a["L"]) if (a["W"]+a["L"]) else 0
        print(f"  {sym+' '+d:12}{a['W']:>4}{a['L']:>4}{a['D']:>4}{wr:>5.0f}%{a['pnl']:>+9.0f}{a['pnl']/n:>+8.1f}"
              + (f"  (+{a['nodata']} no-data)" if a['nodata'] else ""))
        for k in ("W","L","D"): tot[k]+=a[k]
        tot["pnl"]+=a["pnl"]
    n = tot["W"]+tot["L"]+tot["D"]; wr = 100*tot["W"]/(tot["W"]+tot["L"]) if (tot["W"]+tot["L"]) else 0
    print(f"  {'TOTAL':12}{tot['W']:>4}{tot['L']:>4}{tot['D']:>4}{wr:>5.0f}%{tot['pnl']:>+9.0f}{tot['pnl']/max(1,n):>+8.1f}")
    # NQ-only $ (MNQ $2/pt)
    nq = sum(agg[(s,d)]["pnl"] for (s,d) in agg if s=="NQ")
    print(f"  NQ net: {nq:+.0f} pts → ${nq*2:+,.0f} (MNQ $2/pt)")
