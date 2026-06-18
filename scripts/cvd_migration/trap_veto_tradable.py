#!/usr/bin/env python3
"""Confirm the FLIP veto on the ACTUAL tradable book (tradable_signals action=OPEN,
clean-impulse, NQ) — not the raw flip set. Same walk-forward + train/test +
permutation. SANDBOX read-only."""
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
            if px<=slL: return ("L", -sl)
            if px>=tpL: return ("W", TP)
        else:
            if px>=slL: return ("L", -sl)
            if px<=tpL: return ("W", TP)
    return ("D", (last-entry) if d=="long" else (entry-last))

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

print(f"=== FLIP veto on TRADABLE book (NQ OPEN clean-impulse, {len(recs)} resolved) ===")
print(f"  ({sum(1 for r in recs if r['dir']=='long')} long / {sum(1 for r in recs if r['dir']=='short')} short)\n")
for flag, name in [("same","SAME-dir trap veto"), ("any","ANY trap veto")]:
    print(f"── {name} ──")
    print(f"  {'set':22}{'n':>4}{'W/L/D':>10}{'WR':>6}{'net pts':>9}{'$ MNQ':>9}")
    for label, sub in [("baseline (all OPEN)", recs),
                       ("VETOED book (kept)", [r for r in recs if not r[flag]]),
                       ("dropped (flagged)", [r for r in recs if r[flag]])]:
        n,w,l,dd,wr,pnl = stat(sub)
        print(f"  {label:22}{n:>4}{f'{w}/{l}/{dd}':>10}{wr:>5.0f}%{pnl:>+9.0f}{pnl*2:>+9.0f}")
    for mo in ("MAY","JUN"):
        base=[r for r in recs if r["mo"]==mo]; kept=[r for r in base if not r[flag]]
        nb,*_,wb,pb=stat(base); nk,*_,wk,pk=stat(kept)
        print(f"    {mo}: baseline n={nb} WR={wb:.0f}% pnl={pb:+.0f}  →  vetoed n={nk} WR={wk:.0f}% pnl={pk:+.0f}")
    flagged=[r for r in recs if r[flag]]; nf=len(flagged)
    if nf:
        obs_wr=stat(flagged)[4]; obs_pnl=stat(flagged)[5]
        pnls=np.array([r["pnl"] for r in recs]); wins=np.array([1 if r["o"]=="W" else (0 if r["o"]=="L" else -1) for r in recs])
        idx=np.arange(len(recs)); B=10000; lew=lep=0
        for _ in range(B):
            s=rng.choice(idx,nf,replace=False); wl=wins[s][wins[s]>=0]
            if (100*wl.mean() if len(wl) else 0)<=obs_wr: lew+=1
            if pnls[s].sum()<=obs_pnl: lep+=1
        print(f"  permutation ({B}x, n={nf}): flagged WR={obs_wr:.0f}% p={(lew+1)/(B+1):.4f}  flagged pnl={obs_pnl:+.0f} p={(lep+1)/(B+1):.4f}")
    print()
