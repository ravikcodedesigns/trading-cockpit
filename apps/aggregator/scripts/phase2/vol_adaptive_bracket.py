#!/usr/bin/env python3
"""
(1) Fit next-day NQ range%% ~ prior-day VXN on 2021-2025 (OOS vs our 2026 signals).
(2) A/B: flat 80/70 brackets vs VXN-scaled brackets (same MEAN bracket, each day
    scaled to predicted range) on FLIP/CONT signals, walked forward in ticks.db.
    Broken by predicted-range tercile to see where vol-scaling helps.

Brackets scale TP & SL by the same factor (vol-normalized R:R constant).
EV reported in points (note: $ would also need size normalization).
"""
import sqlite3, csv, datetime as dt, os, statistics as st
H="/Users/ravikumarbasker/claude-workspace/trading-cockpit/Historicals"
KDB=os.path.expanduser("~/trading-cockpit/data/ticks.db"); SDB=os.path.expanduser("~/trading-cockpit/data/regime_shadow.db")
SYM="NQ"; ET=4
k=sqlite3.connect(f"file:{KDB}?mode=ro",uri=True); s=sqlite3.connect(f"file:{SDB}?mode=ro",uri=True)

def pdate(x):
    x=x.strip().strip('"').lstrip('﻿')
    for f in ("%m/%d/%Y","%Y-%m-%d"):
        try: return dt.datetime.strptime(x,f).date()
        except: pass
def num(x):
    try: return float(x.strip().strip('"').replace(",",""))
    except: return None

# VXN date->close
vxn={}
with open(os.path.join(H,"VXN_History.csv")) as f:
    r=csv.reader(f); next(r)
    for row in r:
        d=pdate(row[0]); v=num(row[4])
        if d and v: vxn[d]=v
vxn_days=sorted(vxn)
def vxn_prev(d):
    prev=[x for x in vxn_days if x<d]
    return vxn[prev[-1]] if prev else None

# NQ daily for predictor fit
NQ={}
with open(os.path.join(H,"Nasdaq 100 Futures Historical Data.csv")) as f:
    r=csv.reader(f); next(r)
    for row in r:
        d=pdate(row[0]); c=num(row[1]); o=num(row[2]); hi=num(row[3]); lo=num(row[4])
        if d and None not in (c,o,hi,lo): NQ[d]=(o,hi,lo,c)
nd=sorted(NQ)

# fit range% ~ VXN_prev on 2021-2025
xs=[];ys=[]
for i in range(1,len(nd)):
    D=nd[i]
    if D.year>=2026: continue
    o,hi,lo,c=NQ[D]; pc=NQ[nd[i-1]][3]; vp=vxn_prev(D)
    if vp and pc>0 and hi>lo:
        xs.append(vp); ys.append((hi-lo)/pc*100)
n=len(xs); xb=sum(xs)/n; yb=sum(ys)/n
b=sum((xs[i]-xb)*(ys[i]-yb) for i in range(n))/sum((x-xb)**2 for x in xs)
a=yb-b*xb
ss_t=sum((y-yb)**2 for y in ys); ss_r=sum((ys[i]-(a+b*xs[i]))**2 for i in range(n))
r2=1-ss_r/ss_t
print(f"predictor (2021-2025, n={n}):  range%% = {a:.3f} + {b:.4f}*VXN   R2={r2:.2f}")
def pred_range_pct(vp): return a+b*vp

# signals (May-June 2026) from regime_shadow
sigs=s.execute("""SELECT signal_ts,date,direction,entry,rule_id FROM regime_shadow
  WHERE sim_outcome IN ('WIN','SL') ORDER BY signal_ts""").fetchall()
dc={}
def day_trades(d):
    if d not in dc:
        import datetime as _dt
        t0=int((_dt.datetime.strptime(d+" 09:30:00","%Y-%m-%d %H:%M:%S")+_dt.timedelta(hours=ET)).replace(tzinfo=_dt.timezone.utc).timestamp()*1000)
        t1=t0+int(6.5*3600*1000)
        dc[d]=k.execute("SELECT ts,price FROM trades WHERE symbol=? AND ts>=? AND ts<? ORDER BY ts",(SYM,t0,t1)).fetchall()
    return dc[d]

def walk(trs, sts, entry, dirn, tp, sl):
    tgt=entry+tp if dirn=='long' else entry-tp; stp=entry-sl if dirn=='long' else entry+sl
    for ts,p in trs:
        if ts<sts: continue
        if ts-sts>120*60000: break
        if dirn=='long':
            if p<=stp: return ('SL',-sl)
            if p>=tgt: return ('WIN',tp)
        else:
            if p>=stp: return ('SL',-sl)
            if p<=tgt: return ('WIN',tp)
    return ('OPEN',0)

# predicted range pts per signal (using entry as price scale)
recs=[]
for sts,d,dirn,entry,rule in sigs:
    D=dt.datetime.strptime(d,"%Y-%m-%d").date(); vp=vxn_prev(D)
    if vp is None or entry is None: continue
    pr_pts=pred_range_pct(vp)/100*entry
    recs.append((sts,d,dirn,entry,rule,vp,pr_pts))
# calibrate adaptive coeffs so mean TP=80, mean SL=70
mean_pr=st.mean(r[6] for r in recs)
c_tp=80/mean_pr; c_sl=70/mean_pr
print(f"signals n={len(recs)}  mean predicted range={mean_pr:.0f}pt  -> c_tp={c_tp:.3f} c_sl={c_sl:.3f}")
print(f"(adaptive TP = {c_tp:.3f}*predRange, SL = {c_sl:.3f}*predRange; flat = 80/70)\n")

def summarize(results,label):
    dec=[r for r in results if r[0] in ('WIN','SL')]
    w=sum(1 for r in dec if r[0]=='WIN'); n=len(dec); pts=sum(r[1] for r in dec)
    print(f"  {label:22} n={n:3d} WR={(w/n*100 if n else 0):3.0f}% EV={(pts/n if n else 0):+5.1f}pt  total={pts:+.0f}pt ${pts*2:+.0f}")

flat=[]; adap=[]
terc=sorted(r[6] for r in recs); lo_c=terc[len(terc)//3]; hi_c=terc[2*len(terc)//3]
bands={'LOW vol (compressed)':[], 'MID':[], 'HIGH vol':[]}
for sts,d,dirn,entry,rule,vp,pr in recs:
    trs=day_trades(d)
    rf=walk(trs,sts,entry,dirn,80,70); flat.append(rf)
    tp=c_tp*pr; sl=c_sl*pr; ra=walk(trs,sts,entry,dirn,tp,sl); adap.append(ra)
    band='LOW vol (compressed)' if pr<=lo_c else ('HIGH vol' if pr>hi_c else 'MID')
    bands[band].append((rf,ra,tp,sl))
print("=== OVERALL ===")
summarize(flat,"FLAT 80/70")
summarize(adap,"ADAPTIVE (VXN-scaled)")
print("\n=== by predicted-range tercile ===")
for band in ['LOW vol (compressed)','MID','HIGH vol']:
    bb=bands[band]
    avgtp=st.mean(x[2] for x in bb); avgsl=st.mean(x[3] for x in bb)
    print(f"-- {band} (n={len(bb)}, adaptive avg TP={avgtp:.0f}/SL={avgsl:.0f}) --")
    summarize([x[0] for x in bb],"  flat 80/70")
    summarize([x[1] for x in bb],"  adaptive")
