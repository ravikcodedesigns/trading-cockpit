#!/usr/bin/env python3
"""
VWAP CONTINUATION (breakout) — the opposite direction to the reversal, same 50/20.
Setup: prior bar closed on one side of session VWAP, current bar CLOSES THROUGH to
the other side (a VWAP cross) -> enter in the break direction. TP+50/SL-20
(BE 28.6%). No lookahead (entry at cross-bar close, outcome from next bar).
Temporal 60/40 train/test. Counterpart to vwap_reversal.py.
"""
import sqlite3, datetime as dt, os, statistics as st
KDB=os.path.expanduser("~/trading-cockpit/data/ticks.db"); SYM="NQ"; ET=4
MARGIN=2.0; TP=50.0; SL=20.0; MAXHOLD=120
k=sqlite3.connect(f"file:{KDB}?mode=ro",uri=True)
def ms(d,h): return int((dt.datetime.strptime(f"{d} {h}","%Y-%m-%d %H:%M:%S")+dt.timedelta(hours=ET)).replace(tzinfo=dt.timezone.utc).timestamp()*1000)
def daterange(a,b):
    d=a
    while d<=b:
        if d.weekday()<5: yield d.isoformat()
        d+=dt.timedelta(days=1)
def day_minutes(d):
    t0=ms(d,"09:30:00"); t1=ms(d,"16:00:00")
    rows=k.execute("SELECT ts,price,size,is_bid_aggressor FROM trades WHERE symbol=? AND ts>=? AND ts<? ORDER BY ts",(SYM,t0,t1)).fetchall()
    if len(rows)<100: return None
    cpv=0.0;cv=0.0;ccvd=0;bars={}
    for ts,p,sz,a in rows:
        cpv+=p*sz;cv+=sz;ccvd+= sz if a else -sz; m=ts//60000
        b=bars.get(m)
        if not b: b={'o':p,'h':p,'l':p,'c':p,'v':0,'cvd':0}; bars[m]=b
        b['h']=max(b['h'],p); b['l']=min(b['l'],p); b['c']=p; b['v']+=sz; b['cvd']+= sz if a else -sz
        b['vwap']=cpv/cv
    out=[]
    for i,m in enumerate(sorted(bars)):
        b=bars[m]; b['min']=i; b['ts']=m*60000; out.append(b)
    return out
def detect(bars):
    res=[]; n=len(bars)
    for i in range(5,n):
        b=bars[i]; vw=b['vwap']; prev=bars[i-1]; pside=prev['c']-prev['vwap']
        short_sig=(pside>0) and (b['c']<=vw-MARGIN)   # was above, broke DOWN through VWAP
        long_sig =(pside<0) and (b['c']>=vw+MARGIN)   # was below, broke UP through VWAP
        if not (long_sig or short_sig): continue
        dirn='long' if long_sig else 'short'
        entry=b['c']; tgt=entry+TP if dirn=='long' else entry-TP; stp=entry-SL if dirn=='long' else entry+SL
        out="OPEN"
        for j in range(i+1,n):
            if bars[j]['ts']-b['ts']>MAXHOLD*60000: break
            hi,lo=bars[j]['h'],bars[j]['l']
            if dirn=='long':
                if lo<=stp: out="SL";break
                if hi>=tgt: out="WIN";break
            else:
                if hi>=stp: out="SL";break
                if lo<=tgt: out="WIN";break
        if out=="OPEN": continue
        vwap_slope=(b['vwap']-bars[i-30]['vwap']) if i>=30 else (b['vwap']-bars[0]['vwap'])
        cvd30=sum(bars[j]['cvd'] for j in range(max(0,i-30),i+1)); cvd_dir=cvd30 if dirn=='long' else -cvd30
        res.append(dict(dir=dirn,out=out,win=(out=="WIN"),tod=b['min'],
                        vwap_slope_dir=(vwap_slope if dirn=='long' else -vwap_slope),
                        cvd_dir=cvd_dir, vol=b['v']))
    return res
allrows=[];daymap={}
for d in daterange(dt.date(2026,5,4), dt.date(2026,6,13)):
    bars=day_minutes(d)
    if not bars: continue
    r=detect(bars)
    for x in r: x['day']=d
    daymap[d]=r; allrows+=r
days=sorted(daymap)
def stat(rs):
    w=sum(1 for r in rs if r['win']); n=len(rs); pts=sum((TP if r['win'] else -SL) for r in rs)
    return f"n={n:3d} WR={(w/n*100 if n else 0):3.0f}% EV={(pts/n if n else 0):+5.1f}pt tot={pts:+.0f}"
print(f"days={len(days)}  total VWAP-continuation events={len(allrows)}")
print("BASELINE all (TP50/SL20, BE=28.6%):", stat(allrows))
cut=days[int(len(days)*0.6)]
TR=[r for r in allrows if r['day']<cut]; TE=[r for r in allrows if r['day']>=cut]
print(f"split @ {cut}:  TRAIN {stat(TR)}   TEST {stat(TE)}")
# direction split
for dd in ('long','short'):
    print(f"  {dd:5}: ALL {stat([r for r in allrows if r['dir']==dd])}")
def auc(rs,key):
    xs=sorted(((r[key],r['win']) for r in rs),key=lambda z:z[0]); n=len(xs)
    if n<8: return 0.5
    rk=[0]*n;i=0
    while i<n:
        j=i
        while j+1<n and xs[j+1][0]==xs[i][0]: j+=1
        for c in range(i,j+1): rk[c]=(i+j)/2+1
        i=j+1
    nw=sum(1 for _,w in xs if w);nl=n-nw
    return 0.5 if (not nw or not nl) else (sum(rk[c] for c in range(n) if xs[c][1])-nw*(nw+1)/2)/(nw*nl)
print("\nTRAIN feature AUC:")
for fk in ['vwap_slope_dir','cvd_dir','tod','vol']:
    print(f"  {fk:14} AUC={auc(TR,fk):.2f}")
