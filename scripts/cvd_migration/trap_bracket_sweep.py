#!/usr/bin/env python3
"""Trap (J) bracket sweep — ignore native scalp-stop, test wider TP/SL like the
flip/cont SL-sustainability analysis. Walk-forward: TP first→WIN, SL first→LOSS,
RTH 15:54 ET close→DRAW (mark-to-close, counted in net). SANDBOX read-only."""
import json, sqlite3
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict

REPO = Path.home() / "trading-cockpit"
tdb = sqlite3.connect(f"file:{REPO/'data'/'trading.db'}?mode=ro", uri=True)
xdb = sqlite3.connect(f"file:{REPO/'data'/'ticks.db'}?mode=ro", uri=True)

sigs = []
for ts, sym, payload in tdb.execute("SELECT ts, symbol, payload FROM signals WHERE rule_id='trap' ORDER BY ts"):
    p = json.loads(payload); e, d = p.get("entry"), p.get("direction")
    if e is None or d is None: continue
    sigs.append((ts, sym, d, e))
xsyms = {r[0] for r in xdb.execute("SELECT DISTINCT symbol FROM trades")}

def rth_close(ts):
    dt = datetime.fromtimestamp(ts/1000 - 4*3600, timezone.utc)  # ET date
    return int(datetime(dt.year, dt.month, dt.day, 19, 54, tzinfo=timezone.utc).timestamp()*1000)

# preload prices per signal once (entry→close window), reuse across the grid
cache = {}
for i,(ts,sym,d,e) in enumerate(sigs):
    if sym not in xsyms: cache[i]=None; continue
    close = rth_close(ts)
    if ts >= close: cache[i]=None; continue
    cache[i] = [r[0] for r in xdb.execute("SELECT price FROM trades WHERE symbol=? AND ts>=? AND ts<? ORDER BY ts",(sym,ts,close))]

def walk(prices, d, entry, tp, sl):
    if not prices: return None
    last = entry
    tpL, slL = (entry+tp, entry-sl) if d=="long" else (entry-tp, entry+sl)
    for px in prices:
        last = px
        if d=="long":
            if px<=slL: return ("L",-sl)
            if px>=tpL: return ("W",tp)
        else:
            if px>=slL: return ("L",-sl)
            if px<=tpL: return ("W",tp)
    return ("D",(last-entry) if d=="long" else (entry-last))

print(f"trap signals with usable price data: {sum(1 for v in cache.values() if v)} / {len(sigs)}\n")
print(f"{'TP/SL':10}{'NQ W/L/D':>12}{'NQ WR':>7}{'NQ net$':>10}{'ES W/L/D':>12}{'ES WR':>7}{'ES pts':>8}{'tot WR':>8}")
for tp in (80,100):
    for sl in (55,70,100,140):
        by=defaultdict(lambda:{"W":0,"L":0,"D":0,"pnl":0.0})
        for i,(ts,sym,d,e) in enumerate(sigs):
            r=walk(cache[i],d,e,tp,sl)
            if r is None: continue
            o,pnl=r; by[sym][o]+=1; by[sym]["pnl"]+=pnl
        nq,es=by["NQ"],by["ES"]
        nwr=100*nq["W"]/(nq["W"]+nq["L"]) if (nq["W"]+nq["L"]) else 0
        ewr=100*es["W"]/(es["W"]+es["L"]) if (es["W"]+es["L"]) else 0
        tw=nq["W"]+es["W"]; tl=nq["L"]+es["L"]; twr=100*tw/(tw+tl) if (tw+tl) else 0
        print(f"{str(tp)+'/'+str(sl):10}"
              f"{f'{nq[chr(87)]}/{nq[chr(76)]}/{nq[chr(68)]}':>12}{nwr:>6.0f}%{nq['pnl']*2:>+10.0f}"
              f"{f'{es[chr(87)]}/{es[chr(76)]}/{es[chr(68)]}':>12}{ewr:>6.0f}%{es['pnl']:>+8.0f}{twr:>7.0f}%")
