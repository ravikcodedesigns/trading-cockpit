#!/usr/bin/env python3
"""Trap effect on CONT tradables, by direction — same structure as the flip
analysis but CONFLUENCE framing (for conts the WITH-same-dir-trap group is the
keeper). Tradable book (tradable_signals OPEN cont-reentry NQ). Walk-forward
TP80/SL70, RTH 15:54 -> DRAW. June OOS + permutation. SANDBOX read-only."""
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

conts = [(ts, d, e) for ts, d, e in db.execute(
    "SELECT signal_ts,direction,entry FROM tradable_signals "
    "WHERE action='OPEN' AND rule_id='cont-reentry' AND symbol='NQ' AND entry IS NOT NULL ORDER BY signal_ts")]
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
    recs.append({"o": r[0], "pnl": r[1], "same": any(td==d for td in near), "any": len(near)>0, "mo": mo, "dir": d})

def stat(rs):
    w=sum(1 for r in rs if r["o"]=="W"); l=sum(1 for r in rs if r["o"]=="L"); d=sum(1 for r in rs if r["o"]=="D")
    return len(rs), w, l, d, (100*w/(w+l) if (w+l) else 0), sum(r["pnl"] for r in rs)
def perm_conf(pool, flag):  # confluence: is WITH-trap WR higher than random subset?
    g=[r for r in pool if r[flag]]; nf=len(g)
    if nf==0 or nf==len(pool): return None, nf
    obs=stat(g)[4]
    wins=np.array([1 if r["o"]=="W" else (0 if r["o"]=="L" else -1) for r in pool]); idx=np.arange(len(pool))
    B=10000; ge=0
    for _ in range(B):
        s=rng.choice(idx,nf,replace=False); wl=wins[s][wins[s]>=0]
        if (100*wl.mean() if len(wl) else 0) >= obs: ge+=1
    return (ge+1)/(B+1), nf

for d in ("long","short","BOTH"):
    pool=[r for r in recs if r["dir"]==d] if d!="BOTH" else recs
    if not pool: continue
    nb,w,l,dd,wr,pnl = stat(pool)
    print(f"\n{'='*60}\n=== CONT {d.upper()}  (tradable book: {nb} resolved, {wr:.0f}% WR, {pnl*2:+.0f}$) ===")
    for flag,name in [("same","same-dir trap (confluence)"),("any","any trap")]:
        WITH=[r for r in pool if r[flag]]; WO=[r for r in pool if not r[flag]]
        n1,_,_,_,wr1,p1=stat(WITH); n0,_,_,_,wr0,p0=stat(WO)
        jw=[r for r in pool if r["mo"]=="JUN" and r[flag]]; _,_,_,_,jwr,_=stat(jw)
        pp,nf=perm_conf(pool,flag)
        print(f"  {name}:")
        print(f"    WITH trap (keep) : n={n1:2}  WR={wr1:3.0f}%  {p1*2:+6.0f}$   (June n={len(jw)} WR={jwr:.0f}%)")
        print(f"    WITHOUT          : n={n0:2}  WR={wr0:3.0f}%  {p0*2:+6.0f}$")
        print(f"    permutation: WITH-trap WR vs random p={pp if pp is None else f'{pp:.4f}'} (n={nf})")
