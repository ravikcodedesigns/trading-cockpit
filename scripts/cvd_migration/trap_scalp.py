#!/usr/bin/env python3
"""Trap as a FAST SCALP (the trapped-trader flush), not a swing/veto. Enter at the
trap signal in the fade direction; tight TP/SL; SHORT horizon (the flush is
immediate). WIN/LOSS at fixed brackets only (no MFE/MAE). Split by direction — a
real microstructure edge should work BOTH ways, not just shorts (regime). NQ.
SANDBOX read-only."""
import json, sqlite3
from pathlib import Path
from collections import defaultdict

REPO = Path.home() / "trading-cockpit"
db = sqlite3.connect(f"file:{REPO/'data'/'trading.db'}?mode=ro", uri=True)
xdb = sqlite3.connect(f"file:{REPO/'data'/'ticks.db'}?mode=ro", uri=True)

traps = []
for ts, payload in db.execute("SELECT ts,payload FROM signals WHERE rule_id='trap' AND symbol='NQ' ORDER BY ts"):
    p = json.loads(payload); e, d = p.get("entry"), p.get("direction")
    if e is None or d is None: continue
    traps.append((ts, d, e))

def walk(ts, d, entry, tp, sl, horizon_ms):
    rows = [(r[0]) for r in xdb.execute(
        "SELECT price FROM trades WHERE symbol='NQ' AND ts>=? AND ts<? ORDER BY ts",(ts, ts+horizon_ms))]
    if not rows: return None
    last = entry; tpL, slL = (entry+tp, entry-sl) if d=="long" else (entry-tp, entry+sl)
    for px in rows:
        last = px
        if d=="long":
            if px<=slL: return ("L",-sl)
            if px>=tpL: return ("W",tp)
        else:
            if px>=slL: return ("L",-sl)
            if px<=tpL: return ("W",tp)
    return ("D",(last-entry) if d=="long" else (entry-last))

BRACKETS = [(8,8),(10,8),(10,10),(15,10),(15,15),(20,15),(20,20)]
for hz in (5, 15):
    hms = hz*60_000
    print(f"\n=== trap SCALP — {hz}-min horizon (NQ, {len(traps)} traps) ===")
    print(f"  {'TP/SL':8}{'n':>4}{'WR':>6}{'EV/t':>7}{'net$':>8} | {'LONG WR/EV':>13} | {'SHORT WR/EV':>13}")
    for tp, sl in BRACKETS:
        agg = defaultdict(lambda: {"W":0,"L":0,"D":0,"pnl":0.0})
        for ts, d, e in traps:
            r = walk(ts, d, e, tp, sl, hms)
            if r is None: continue
            agg[d][r[0]]+=1; agg[d]["pnl"]+=r[1]; agg["ALL"][r[0]]+=1; agg["ALL"]["pnl"]+=r[1]
        a=agg["ALL"]; n=a["W"]+a["L"]+a["D"]; wr=100*a["W"]/(a["W"]+a["L"]) if (a["W"]+a["L"]) else 0
        ev=a["pnl"]/n if n else 0
        def de(k):
            x=agg[k]; m=x["W"]+x["L"]+x["D"]; w=100*x["W"]/(x["W"]+x["L"]) if (x["W"]+x["L"]) else 0
            return f"{w:3.0f}%/{(x['pnl']/m if m else 0):+5.1f}"
        print(f"  {f'{tp}/{sl}':8}{n:>4}{wr:>5.0f}%{ev:>+6.1f}{a['pnl']*2:>+8.0f} | {de('long'):>13} | {de('short'):>13}")
