#!/usr/bin/env python3
"""Validate the trap fast-scalp: (1) OOS May/June, (2) LATENCY — enter 0/30/60s
after the signal (the flush may be gone by the time you can act), (3) random-entry
placebo. Fixed brackets only. NQ. SANDBOX read-only."""
import json, sqlite3
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict
import numpy as np

REPO = Path.home() / "trading-cockpit"
db = sqlite3.connect(f"file:{REPO/'data'/'trading.db'}?mode=ro", uri=True)
xdb = sqlite3.connect(f"file:{REPO/'data'/'ticks.db'}?mode=ro", uri=True)
rng = np.random.default_rng(20260618)
HZ = 5*60_000

traps = []
for ts, payload in db.execute("SELECT ts,payload FROM signals WHERE rule_id='trap' AND symbol='NQ' ORDER BY ts"):
    p = json.loads(payload); e, d = p.get("entry"), p.get("direction")
    if e is None or d is None: continue
    mo = "MAY" if datetime.fromtimestamp(ts/1000-4*3600,timezone.utc).month==5 else "JUN"
    traps.append((ts, d, mo))

def outcome(ts, d, delay_ms, tp, sl):
    e0 = ts + delay_ms
    rows = [r[0] for r in xdb.execute("SELECT price FROM trades WHERE symbol='NQ' AND ts>=? AND ts<? ORDER BY ts",(e0, e0+HZ))]
    if len(rows) < 2: return None
    entry = rows[0]; tpL, slL = (entry+tp, entry-sl) if d=="long" else (entry-tp, entry+sl)
    for px in rows[1:]:
        if d=="long":
            if px<=slL: return -sl
            if px>=tpL: return tp
        else:
            if px>=slL: return -sl
            if px<=tpL: return tp
    return (rows[-1]-entry) if d=="long" else (entry-rows[-1])

def agg(results):  # list of (mo, dir, pnl)
    o=defaultdict(lambda:{"n":0,"pnl":0.0,"w":0})
    for mo,d,p in results:
        for k in (("ALL",),("mo",mo),("dir",d)):
            key="|".join(k); o[key]["n"]+=1; o[key]["pnl"]+=p
            if p>0: o[key]["w"]+=1
    return o

for tp,sl in [(15,15),(20,20)]:
    print(f"\n{'='*60}\n=== trap scalp {tp}/{sl}, 5-min horizon ===")
    for delay_s in (0,30,60):
        res=[]
        for ts,d,mo in traps:
            p=outcome(ts,d,delay_s*1000,tp,sl)
            if p is not None: res.append((mo,d,p))
        o=agg(res)
        def cell(k):
            x=o.get(k);
            return f"n={x['n']:3} EV={x['pnl']/x['n']:+5.1f} ${x['pnl']*2:+6.0f}" if x and x['n'] else "—"
        print(f"  delay {delay_s:2}s:  ALL {cell('ALL')}")
        print(f"            MAY {cell('mo|MAY')}   JUN(OOS) {cell('mo|JUN')}")
        print(f"            LONG {cell('dir|long')}   SHORT {cell('dir|short')}")

# placebo: random RTH entries (same n, random dir) at 0 delay, 20/20
print(f"\n=== placebo: random RTH entries vs trap (20/20, 0s) ===")
obs=[outcome(ts,d,0,20,20) for ts,d,_ in traps]; obs=[x for x in obs if x is not None]
obs_ev=sum(obs)/len(obs)
# build random entry pool: random ts within RTH on trap days
days=sorted({datetime.fromtimestamp(ts/1000-4*3600,timezone.utc).strftime("%Y-%m-%d") for ts,_,_ in traps})
def rth_span(day):
    y,m,dd=map(int,day.split('-'));
    return int(datetime(y,m,dd,13,30,tzinfo=timezone.utc).timestamp()*1000), int(datetime(y,m,dd,19,54,tzinfo=timezone.utc).timestamp()*1000)
spans=[rth_span(d) for d in days]
B=2000; ge=0; evs=[]
for _ in range(B):
    s=[]
    for _ in range(len(obs)):
        lo,hi=spans[rng.integers(len(spans))]; rts=int(rng.integers(lo,hi)); rd="long" if rng.random()<0.5 else "short"
        p=outcome(rts,rd,0,20,20)
        if p is not None: s.append(p)
    if s:
        ev=sum(s)/len(s); evs.append(ev)
        if ev>=obs_ev: ge+=1
evs=np.array(evs)
print(f"  trap EV={obs_ev:+.2f}pt  vs random-entry EV={evs.mean():+.2f}pt (sd {evs.std():.2f})  p={(ge+1)/(B+1):.4f}")
