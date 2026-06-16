#!/usr/bin/env python3
"""
Regime-gate first cut: per-signal, no-lookahead regime score from statistical
trend/mean-reversion measures + a self-referential circuit breaker, validated
by whether gating FLIP/CONT lifts WR/EV out-of-sample (temporal train/test).

Measures (computed over prior WINDOW min of 1-min closes, ts <= signal):
  ER   efficiency ratio = |net| / path           (1=clean trend, 0=chop)
  AC1  lag-1 autocorr of 1-min returns           (>0 momentum, <0 mean-revert)
  VR   variance ratio Var(k-sum)/(k*Var(1))      (>1 trending, <1 mean-revert)
  priorSL  # of today's earlier FLIP/CONT trades that hit SL & closed before now
"""
import sqlite3, datetime as dt, os, sys, statistics as st

TDB=os.path.expanduser("~/trading-cockpit/data/trading.db")
KDB=os.path.expanduser("~/trading-cockpit/data/ticks.db"); SYM="NQ"; ET=4
WINDOW=int(os.environ.get("WINDOW",60)); VRK=5
t=sqlite3.connect(f"file:{TDB}?mode=ro",uri=True); k=sqlite3.connect(f"file:{KDB}?mode=ro",uri=True)
def ms(d,h): return int((dt.datetime.strptime(f"{d} {h}","%Y-%m-%d %H:%M:%S")+dt.timedelta(hours=ET)).replace(tzinfo=dt.timezone.utc).timestamp()*1000)

sigs=t.execute("""SELECT signal_ts,date(signal_ts/1000,'unixepoch','-4 hours') d,rule_id,direction,entry
 FROM tradable_signals WHERE action='OPEN' AND rule_id IN ('clean-impulse','cont-reentry') ORDER BY signal_ts""").fetchall()
dc={}
def dtr(d):
    if d not in dc: dc[d]=k.execute("SELECT ts,price FROM trades WHERE symbol=? AND ts>=? AND ts<? ORDER BY ts",
                                    (SYM,ms(d,"09:30:00"),ms(d,"16:00:00"))).fetchall()
    return dc[d]
def br(rule,dr): return (80,70) if rule=='cont-reentry' else ((80,55) if dr=='long' else (80,105))

def bars1m(sts):
    rows=k.execute("SELECT ts,price FROM trades WHERE symbol=? AND ts>=? AND ts<=? ORDER BY ts",
                   (SYM,sts-WINDOW*60000,sts)).fetchall()
    b={}
    for ts,p in rows: b[ts//60000]=p
    return [b[x] for x in sorted(b)]

def measures(cl):
    if len(cl)<12: return None
    r=[cl[i]-cl[i-1] for i in range(1,len(cl))]
    net=abs(cl[-1]-cl[0]); path=sum(abs(x) for x in r)
    ER=net/path if path else 0
    mu=sum(r)/len(r)
    var1=sum((x-mu)**2 for x in r)/(len(r)-1) if len(r)>1 else 0
    # AC1
    num=sum((r[i]-mu)*(r[i-1]-mu) for i in range(1,len(r)))
    den=sum((x-mu)**2 for x in r)
    AC1=num/den if den else 0
    # VR(k) overlapping biased
    m=len(r)
    if m>VRK and var1>0:
        ys=[sum(r[i:i+VRK]) for i in range(0,m-VRK+1)]
        muk=VRK*mu
        vark=sum((y-muk)**2 for y in ys)/(len(ys)-1)
        VR=(vark/VRK)/var1
    else: VR=1.0
    return ER,AC1,VR

# build rows with outcomes + exit ts (for circuit breaker) chronologically
recs=[]
for sts,d,rule,dirn,entry in sigs:
    trs=dtr(d)
    if not trs: continue
    epx=entry or next((pr for ts,pr in trs if ts>=sts),None)
    if epx is None: continue
    tp,sl=br(rule,dirn); tgt=epx+tp if dirn=='long' else epx-tp; stp=epx-sl if dirn=='long' else epx+sl
    res="OPEN"; xts=None
    for ts,pr in trs:
        if ts<sts: continue
        if ts-sts>120*60000: break
        if dirn=='long':
            if pr<=stp: res,xts="SL",ts;break
            if pr>=tgt: res,xts="WIN",ts;break
        else:
            if pr>=stp: res,xts="SL",ts;break
            if pr<=tgt: res,xts="WIN",ts;break
    if res=="OPEN": continue
    mm=measures(bars1m(sts))
    if mm is None: continue
    ER,AC1,VR=mm
    recs.append(dict(sts=sts,d=d,rule=rule,dir=dirn,res=res,xts=xts,pnl=(tp if res=="WIN" else -sl),ER=ER,AC1=AC1,VR=VR))

# circuit breaker: prior SL today closed before this signal
for i,r in enumerate(recs):
    r['priorSL']=sum(1 for q in recs if q['d']==r['d'] and q['xts'] and q['xts']<r['sts'] and q['res']=='SL')

# temporal split
days=sorted(set(r['d'] for r in recs)); cut=days[int(len(days)*0.6)]
TR=[r for r in recs if r['d']<cut]; TE=[r for r in recs if r['d']>=cut]
def wrev(rs):
    w=sum(1 for r in rs if r['res']=='WIN');l=len(rs)-w;pts=sum(r['pnl'] for r in rs)
    return w,l,(w/len(rs)*100 if rs else 0),pts,(pts/len(rs) if rs else 0)
print(f"n={len(recs)}  days={len(days)}  split @ {cut}: TRAIN={len(TR)} TEST={len(TE)}  WINDOW={WINDOW}m")
def show(rs,name):
    w,l,wr,pts,ev=wrev(rs); print(f"  {name:30} n={len(rs):3d} W={w:3d} L={l:3d} WR={wr:4.0f}% EV={ev:+5.1f} ${pts*2:+7.0f}")
print("\n=== TRAIN: WR by each measure (find separation) ===")
for nm,key,cuts in [("ER",'ER',[(0,.3),(.3,.5),(.5,2)]),("AC1",'AC1',[(-1,0),(0,.1),(.1,1)]),("VR",'VR',[(0,.9),(.9,1.1),(1.1,9)]),("priorSL",'priorSL',[(0,1),(1,2),(2,9)])]:
    print(f" {nm}:")
    for lo,hi in cuts:
        rs=[r for r in TR if lo<=r[key]<hi]; show(rs,f"  [{lo},{hi})")
print("\n=== candidate gate: (ER>=0.3 OR AC1>=0) AND priorSL<2 ===")
def gate(r): return (r['ER']>=0.30 or r['AC1']>=0.0) and r['priorSL']<2
for nm,rs in [("TRAIN all",TR),("TRAIN kept",[r for r in TR if gate(r)]),("TRAIN dropped",[r for r in TR if not gate(r)]),
              ("TEST all",TE),("TEST kept",[r for r in TE if gate(r)]),("TEST dropped",[r for r in TE if not gate(r)])]:
    show(rs,nm)

print("\n=== ISOLATED GATES (train/test) ===")
def ev(rs):
    w=sum(1 for r in rs if r['res']=='WIN');l=len(rs)-w;pts=sum(r['pnl'] for r in rs)
    return f"n={len(rs):3d} W={w:3d} L={l:3d} WR={(w/len(rs)*100 if rs else 0):4.0f}% EV={(pts/len(rs) if rs else 0):+5.1f} ${pts*2:+7.0f}"
for name,g in [("priorSL==0 (stop after 1st SL)", lambda r:r['priorSL']==0),
               ("priorSL<2 (stop after 2nd SL)",  lambda r:r['priorSL']<2),
               ("AC1>=0 AND priorSL==0",           lambda r:r['AC1']>=0 and r['priorSL']==0),
               ("baseline (no gate)",              lambda r:True)]:
    print(f" {name}")
    print(f"   TRAIN {ev([r for r in TR if g(r)])}")
    print(f"   TEST  {ev([r for r in TE if g(r)])}")

import json as _json
_json.dump([{kk:r[kk] for kk in ('sts','d','rule','dir','res','pnl','ER','AC1','VR','priorSL')} for r in recs],
           open('/tmp/recs.json','w'))
print(f"\n[dumped {len(recs)} recs to /tmp/recs.json]")
