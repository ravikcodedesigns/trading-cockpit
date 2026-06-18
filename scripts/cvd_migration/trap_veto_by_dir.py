#!/usr/bin/env python3
"""FLIP veto split by direction (long vs short) — decide longs-only vs both.
Tradable book (tradable_signals OPEN clean-impulse NQ). Same walk-forward +
train/test + permutation, per direction, both variants. SANDBOX read-only."""
import json, sqlite3
from datetime import datetime, timezone
from pathlib import Path
import numpy as np

REPO = Path.home() / "trading-cockpit"
tdb = sqlite3.connect(f"file:{REPO/'data'/'trading.db'}?mode=ro", uri=True)
xdb = sqlite3.connect(f"file:{REPO/'data'/'ticks.db'}?mode=ro", uri=True)
rng = np.random.default_rng(20260618)
WIN = 30 * 60_000
TP, SL = 80, {"long": 55, "short": 105}

flips = [(ts, d, e) for ts, d, e in tdb.execute(
    "SELECT signal_ts,direction,entry FROM tradable_signals "
    "WHERE action='OPEN' AND rule_id='clean-impulse' AND symbol='NQ' AND entry IS NOT NULL ORDER BY signal_ts")]
traps = [(ts, json.loads(pl).get("direction")) for ts, pl in
         tdb.execute("SELECT ts,payload FROM signals WHERE rule_id='trap' AND symbol='NQ' ORDER BY ts")]

def rth_close(ts):
    dt = datetime.fromtimestamp(ts/1000-4*3600, timezone.utc)
    return int(datetime(dt.year, dt.month, dt.day, 19, 54, tzinfo=timezone.utc).timestamp()*1000)

def walk(ts, d, entry):
    close = rth_close(ts)
    if ts >= close: return None
    rows = [r[0] for r in xdb.execute("SELECT price FROM trades WHERE symbol='NQ' AND ts>=? AND ts<? ORDER BY ts",(ts,close))]
    if not rows: return None
    sl = SL[d]; last = entry; tpL, slL = (entry+TP, entry-sl) if d=="long" else (entry-TP, entry+sl)
    for px in rows:
        last = px
        if d=="long":
            if px<=slL: return ("L",-sl)
            if px>=tpL: return ("W",TP)
        else:
            if px>=slL: return ("L",-sl)
            if px<=tpL: return ("W",TP)
    return ("D",(last-entry) if d=="long" else (entry-last))

recs = []
for ts, d, e in flips:
    r = walk(ts, d, e)
    if r is None: continue
    near = [td for tt, td in traps if ts-WIN <= tt <= ts]
    mo = "MAY" if datetime.fromtimestamp(ts/1000-4*3600, timezone.utc).month == 5 else "JUN"
    recs.append({"o": r[0], "pnl": r[1], "same": any(td==d for td in near), "any": len(near)>0, "mo": mo, "dir": d})

def stat(rs):
    w=sum(1 for r in rs if r["o"]=="W"); l=sum(1 for r in rs if r["o"]=="L"); d=sum(1 for r in rs if r["o"]=="D")
    return len(rs), w, l, d, (100*w/(w+l) if (w+l) else 0), sum(r["pnl"] for r in rs)

def perm(pool, flag):
    flagged=[r for r in pool if r[flag]]; nf=len(flagged)
    if nf==0 or nf==len(pool): return None, None, nf
    obs_wr=stat(flagged)[4]; obs_pnl=stat(flagged)[5]
    pnls=np.array([r["pnl"] for r in pool]); wins=np.array([1 if r["o"]=="W" else (0 if r["o"]=="L" else -1) for r in pool])
    idx=np.arange(len(pool)); B=10000; lew=lep=0
    for _ in range(B):
        s=rng.choice(idx,nf,replace=False); wl=wins[s][wins[s]>=0]
        if (100*wl.mean() if len(wl) else 0)<=obs_wr: lew+=1
        if pnls[s].sum()<=obs_pnl: lep+=1
    return (lew+1)/(B+1), (lep+1)/(B+1), nf

for d in ("long","short"):
    pool=[r for r in recs if r["dir"]==d]
    nb,w,l,dd,wr,pnl=stat(pool)
    print(f"\n{'='*64}\n=== FLIP {d.upper()}  (tradable book: {nb} resolved, baseline {wr:.0f}% WR / {pnl*2:+.0f}$) ===")
    for flag,name in [("same","same-dir veto"),("any","any-trap veto")]:
        kept=[r for r in pool if not r[flag]]; drop=[r for r in pool if r[flag]]
        nk,*_,wk,pk=stat(kept); nd,_,_,_,wd,pd=stat(drop)
        jb=[r for r in pool if r["mo"]=="JUN"]; jk=[r for r in jb if not r[flag]]
        _,_,_,_,jbw,_=stat(jb); _,_,_,_,jkw,_=stat(jk)
        pw,pp,nf=perm(pool,flag)
        print(f"\n  {name}:")
        print(f"    kept book : {nk} trades, {wk:.0f}% WR, {pk*2:+.0f}$")
        print(f"    dropped   : {nd} @ {wd:.0f}% WR ({pd*2:+.0f}$)")
        print(f"    June OOS  : {jbw:.0f}% → {jkw:.0f}%   (n {len(jb)}→{len(jk)})")
        print(f"    perm      : WR p={pw if pw is None else f'{pw:.4f}'} | pnl p={pp if pp is None else f'{pp:.4f}'}  (flagged n={nf})")
