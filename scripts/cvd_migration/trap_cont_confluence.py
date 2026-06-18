#!/usr/bin/env python3
"""CONT + trap as CONFLUENCE (not veto), split by direction. For a continuation
trade a same-direction trap CONFIRMS the trend resuming -> hypothesis: conts WITH
a same-dir trap in the prior 30m outperform. Require-confluence = keep only the
WITH-trap group. Raw cont-reentry signals (signals table) for max sample, NQ.
Walk-forward TP80/SL70, RTH 15:54 DRAW. SANDBOX. Tiny samples — exploratory."""
import json, sqlite3
from datetime import datetime, timezone
from pathlib import Path
import numpy as np

REPO = Path.home() / "trading-cockpit"
db = sqlite3.connect(f"file:{REPO/'data'/'trading.db'}?mode=ro", uri=True)
xdb = sqlite3.connect(f"file:{REPO/'data'/'ticks.db'}?mode=ro", uri=True)
rng = np.random.default_rng(20260618)
WIN = 30 * 60_000
TP, SL = 80, 70

conts = []
for ts, payload in db.execute("SELECT ts,payload FROM signals WHERE rule_id='cont-reentry' AND symbol='NQ' ORDER BY ts"):
    p = json.loads(payload); e, d = p.get("entry"), p.get("direction")
    if e is None or d is None: continue
    conts.append((ts, d, e))
traps = [(ts, json.loads(pl).get("direction")) for ts, pl in
         db.execute("SELECT ts,payload FROM signals WHERE rule_id='trap' AND symbol='NQ' ORDER BY ts")]

def rth_close(ts):
    dt = datetime.fromtimestamp(ts/1000-4*3600, timezone.utc)
    return int(datetime(dt.year, dt.month, dt.day, 19, 54, tzinfo=timezone.utc).timestamp()*1000)

def walk(ts, d, entry):
    close = rth_close(ts)
    if ts >= close: return None
    rows = [r[0] for r in xdb.execute("SELECT price FROM trades WHERE symbol='NQ' AND ts>=? AND ts<? ORDER BY ts",(ts,close))]
    if not rows: return None
    last = entry; tpL, slL = (entry+TP, entry-SL) if d=="long" else (entry-TP, entry+SL)
    for px in rows:
        last = px
        if d=="long":
            if px<=slL: return ("L",-SL)
            if px>=tpL: return ("W",TP)
        else:
            if px>=slL: return ("L",-SL)
            if px<=tpL: return ("W",TP)
    return ("D",(last-entry) if d=="long" else (entry-last))

recs = []
for ts, d, e in conts:
    r = walk(ts, d, e)
    if r is None: continue
    near = [td for tt, td in traps if ts-WIN <= tt <= ts]
    mo = "MAY" if datetime.fromtimestamp(ts/1000-4*3600, timezone.utc).month == 5 else "JUN"
    recs.append({"o": r[0], "pnl": r[1], "same": any(td==d for td in near),
                 "any": len(near)>0, "mo": mo, "dir": d})

def stat(rs):
    w=sum(1 for r in rs if r["o"]=="W"); l=sum(1 for r in rs if r["o"]=="L"); dd=sum(1 for r in rs if r["o"]=="D")
    return len(rs), w, l, dd, (100*w/(w+l) if (w+l) else 0), sum(r["pnl"] for r in rs)

print(f"=== CONT + trap CONFLUENCE (raw cont-reentry NQ, {len(recs)} resolved) ===")
for d in ("long","short","BOTH"):
    pool = recs if d=="BOTH" else [r for r in recs if r["dir"]==d]
    if not pool: continue
    nb,w,l,dd,wr,pnl = stat(pool)
    print(f"\n── CONT {d.upper()}  (baseline {nb}: {w}/{l}/{dd}, {wr:.0f}% WR, {pnl*2:+.0f}$) ──")
    conf = [r for r in pool if r["same"]]; none = [r for r in pool if not r["same"]]
    for label, sub in [("WITH same-dir trap (confluence)", conf), ("WITHOUT (no same-dir trap)", none)]:
        n,w,l,dd,wr,p = stat(sub)
        print(f"   {label:34} n={n:2}  {w}/{l}/{dd}  WR={wr:3.0f}%  {p*2:+6.0f}$")
    # train/test for confluence group
    for mo in ("MAY","JUN"):
        c=[r for r in conf if r["mo"]==mo]
        if c:
            n,w,l,dd,wr,p = stat(c)
            print(f"     confluence {mo}: n={n} {w}/{l}/{dd} WR={wr:.0f}% {p*2:+.0f}$")
    # permutation: is the confluence-group WR HIGHER than a random subset of same size?
    nf=len(conf)
    if nf and nf<len(pool):
        obs=stat(conf)[4]
        wins=np.array([1 if r["o"]=="W" else (0 if r["o"]=="L" else -1) for r in pool]); idx=np.arange(len(pool))
        B=10000; ge=0
        for _ in range(B):
            s=rng.choice(idx,nf,replace=False); wl=wins[s][wins[s]>=0]
            if (100*wl.mean() if len(wl) else 0) >= obs: ge+=1
        print(f"   permutation: confluence WR={obs:.0f}% vs random p={(ge+1)/(B+1):.4f} (n={nf})")
