#!/usr/bin/env python3
"""Trap bracket validation — is the wide-stop NQ profit real or regime/direction/
in-sample artifact? Decompose by direction + month, then a FAST direction-shuffle
permutation (precompute both-direction outcomes once). SANDBOX read-only."""
import json, sqlite3, sys
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict
import numpy as np

REPO = Path.home() / "trading-cockpit"
tdb = sqlite3.connect(f"file:{REPO/'data'/'trading.db'}?mode=ro", uri=True)
xdb = sqlite3.connect(f"file:{REPO/'data'/'ticks.db'}?mode=ro", uri=True)
rng = np.random.default_rng(20260618)

sigs = []
for ts, payload in tdb.execute("SELECT ts,payload FROM signals WHERE rule_id='trap' AND symbol='NQ' ORDER BY ts"):
    p = json.loads(payload); e, d = p.get("entry"), p.get("direction")
    if e is None: continue
    et = datetime.fromtimestamp(ts/1000-4*3600, timezone.utc)
    sigs.append((ts, d, e, "MAY" if et.month == 5 else "JUN"))

def rth_close(ts):
    dt = datetime.fromtimestamp(ts/1000-4*3600, timezone.utc)
    return int(datetime(dt.year, dt.month, dt.day, 19, 54, tzinfo=timezone.utc).timestamp()*1000)

cache = {}
for i,(ts,d,e,mo) in enumerate(sigs):
    close = rth_close(ts)
    cache[i] = None if ts>=close else [r[0] for r in xdb.execute("SELECT price FROM trades WHERE symbol='NQ' AND ts>=? AND ts<? ORDER BY ts",(ts,close))]

def walk(prices,d,entry,tp,sl):
    if not prices: return None
    last=entry; tpL,slL=(entry+tp,entry-sl) if d=="long" else (entry-tp,entry+sl)
    for px in prices:
        last=px
        if d=="long":
            if px<=slL: return ("L",-sl)
            if px>=tpL: return ("W",tp)
        else:
            if px>=slL: return ("L",-sl)
            if px<=tpL: return ("W",tp)
    return ("D",(last-entry) if d=="long" else (entry-last))

for tp,sl in [(80,70),(100,70)]:
    cells=defaultdict(lambda:{"W":0,"L":0,"D":0,"pnl":0.0})
    both=[]  # (pnl_long, pnl_short, actual_dir)
    for i,(ts,d,e,mo) in enumerate(sigs):
        if cache[i] is None: continue
        rl=walk(cache[i],"long",e,tp,sl); rs=walk(cache[i],"short",e,tp,sl)
        act=walk(cache[i],d,e,tp,sl)
        both.append((rl[1],rs[1],d))
        for key in [("ALL","ALL"),("dir",d),("mo",mo),(d,mo)]:
            c=cells[key]; c[act[0]]+=1; c["pnl"]+=act[1]
    print(f"\n=== NQ trap {tp}/{sl} ===  ({len(both)} signals w/ data)")
    print(f"  {'cohort':14}{'W/L/D':>10}{'WR':>6}{'net$':>9}")
    def line(name,key):
        c=cells[key]; wr=100*c["W"]/(c["W"]+c["L"]) if (c["W"]+c["L"]) else 0
        print(f"  {name:14}{f'{c[chr(87)]}/{c[chr(76)]}/{c[chr(68)]}':>10}{wr:>5.0f}%{c['pnl']*2:>+9.0f}")
    line("ALL","ALL")
    for d in ("long","short"): line(f"  {d}",("dir",d))
    for mo in ("MAY","JUN"): line(f"  {mo}",("mo",mo))
    for d in ("long","short"):
        for mo in ("MAY","JUN"): line(f"  {d} {mo}",(d,mo))
    # FAST permutation: randomize entry direction per signal, sum precomputed pnl
    pl=np.array([b[0] for b in both]); ps=np.array([b[1] for b in both])
    obs=sum(b[0] if b[2]=="long" else b[1] for b in both)
    B=10000; ge=0
    for _ in range(B):
        pick=rng.random(len(both))<0.5
        tot=np.where(pick,pl,ps).sum()
        if tot>=obs: ge+=1
    print(f"  permutation (shuffle entry direction {B}x): observed net=${obs*2:+.0f}  p={(ge+1)/(B+1):.4f}")
    sys.stdout.flush()
