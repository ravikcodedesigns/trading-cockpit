#!/usr/bin/env python3
"""
Cross-asset volatility panel -> next-day NQ regime/bias. Properly-powered
(~1,400 daily obs). NO LOOKAHEAD: features are PRIOR-DAY closes (known before
today's open); targets are TODAY's NQ behavior.

Targets (day D):
  nd_range  = (H-L)/prevClose * 100      next-day realized range (volatility)
  nd_eff    = |C-O|/(H-L)                next-day trend-vs-chop (1=trend,0=chop)
  nd_ret_oc = (C-O)/O * 100              next-day open->close return (bias)
Features (day D-1 close): vix, vix_chg, vix_pct252, vvix, vvix_vix, gvz, ovx,
  vxapl, vxazn, vxeem, and NQ's own prior-day range/ret/eff (autocorr baseline).
"""
import csv, datetime as dt, math, os
H="/Users/ravikumarbasker/claude-workspace/trading-cockpit/Historicals"

def pdate(s):
    s=s.strip().strip('"').lstrip('﻿')
    for fmt in ("%m/%d/%Y","%Y-%m-%d"):
        try: return dt.datetime.strptime(s,fmt).date()
        except: pass
    return None
def num(s):
    s=s.strip().strip('"').replace(",","")
    try: return float(s)
    except: return None

def load_close(fname, datecol, valcol):
    d={}
    with open(os.path.join(H,fname)) as f:
        r=csv.reader(f); hdr=next(r)
        for row in r:
            if len(row)<=max(datecol,valcol): continue
            dd=pdate(row[datecol]); v=num(row[valcol])
            if dd and v is not None: d[dd]=v
    return d

# vol panel (date->close)
vix=load_close("VIX_History.csv",0,4); vvix=load_close("VVIX_History.csv",0,1)
gvz=load_close("GVZ_History.csv",0,1); ovx=load_close("OVX_History.csv",0,1)
vxapl=load_close("VXAPL_History.csv",0,4); vxazn=load_close("VXAZN_History.csv",0,4)
vxeem=load_close("VXEEM_History.csv",0,4); vxn=load_close("VXN_History.csv",0,4)

# NQ OHLC
NQ={}
with open(os.path.join(H,"Nasdaq 100 Futures Historical Data.csv")) as f:
    r=csv.reader(f); next(r)
    for row in r:
        dd=pdate(row[0]); c=num(row[1]); o=num(row[2]); hi=num(row[3]); lo=num(row[4])
        if dd and None not in (c,o,hi,lo): NQ[dd]=(o,hi,lo,c)
days=sorted(NQ)
print(f"NQ daily: {len(days)} days  {days[0]} .. {days[-1]}")

# build aligned records
def pctile(series, d, lb=252):
    # percentile of series[d] within trailing lb obs (no lookahead)
    if d not in series: return None
    vd=sorted([x for x in series if x<=d])[-lb:]
    if len(vd)<30: return None
    vals=[series[x] for x in vd]; cur=series[d]
    return sum(1 for v in vals if v<=cur)/len(vals)
def vixpct(d, lb=252): return pctile(vix,d,lb)

rec=[]
for i in range(1,len(days)):
    D=days[i]; P=days[i-1]   # P = prior trading day (features), D = today (targets)
    o,hi,lo,c=NQ[D]; pc=NQ[P][3]
    if hi<=lo or pc<=0: continue
    nd_range=(hi-lo)/pc*100; nd_eff=abs(c-o)/(hi-lo); nd_ret_oc=(c-o)/o*100
    # prior-day NQ
    po,ph,pl,pcl=NQ[P]; nq_prev_range=(ph-pl)/NQ[days[i-2]][3]*100 if i>=2 else None
    nq_prev_eff=abs(pcl-po)/(ph-pl) if ph>pl else None
    nq_prev_ret=(pcl-po)/po*100
    feat={}
    if P in vix: feat['vix']=vix[P]
    if P in vix and days[i-2] in vix: feat['vix_chg']=vix[P]-vix[days[i-2]]
    vp=vixpct(P); feat['vix_pct252']=vp
    if P in vvix: feat['vvix']=vvix[P]
    if P in vvix and P in vix and vix[P]>0: feat['vvix_vix']=vvix[P]/vix[P]
    if P in gvz: feat['gvz']=gvz[P]
    if P in ovx: feat['ovx']=ovx[P]
    if P in vxapl: feat['vxapl']=vxapl[P]
    if P in vxazn: feat['vxazn']=vxazn[P]
    if P in vxeem: feat['vxeem']=vxeem[P]
    if P in vxn: feat['vxn']=vxn[P]
    if P in vxn and days[i-2] in vxn: feat['vxn_chg']=vxn[P]-vxn[days[i-2]]
    feat['vxn_pct252']=pctile(vxn,P)
    if P in vxn and P in vix and vix[P]>0: feat['vxn_vix']=vxn[P]/vix[P]
    feat['nq_prev_range']=nq_prev_range; feat['nq_prev_eff']=nq_prev_eff; feat['nq_prev_ret']=nq_prev_ret
    rec.append((D,feat,dict(nd_range=nd_range,nd_eff=nd_eff,nd_ret_oc=nd_ret_oc)))

def spearman(pairs):
    pairs=[(a,b) for a,b in pairs if a is not None and b is not None]
    n=len(pairs)
    if n<20: return None,n
    def ranks(vals):
        idx=sorted(range(len(vals)),key=lambda k:vals[k]); rk=[0.0]*len(vals); i=0
        while i<len(vals):
            j=i
            while j+1<len(vals) and vals[idx[j+1]]==vals[idx[i]]: j+=1
            for k in range(i,j+1): rk[idx[k]]=(i+j)/2+1
            i=j+1
        return rk
    xs=ranks([a for a,_ in pairs]); ys=ranks([b for _,b in pairs])
    mx=sum(xs)/n; my=sum(ys)/n
    cov=sum((xs[k]-mx)*(ys[k]-my) for k in range(n))
    sx=math.sqrt(sum((v-mx)**2 for v in xs)); sy=math.sqrt(sum((v-my)**2 for v in ys))
    if sx==0 or sy==0: return None,n
    rho=cov/(sx*sy)
    t=rho*math.sqrt((n-2)/max(1-rho*rho,1e-9))
    return (rho,n,t)

FEATS=['vxn','vxn_chg','vxn_pct252','vxn_vix','vix','vix_chg','vix_pct252','vvix','vvix_vix','gvz','ovx','vxapl','vxazn','vxeem','nq_prev_range','nq_prev_eff','nq_prev_ret']
TGTS=['nd_range','nd_eff','nd_ret_oc']
def run(recs,label):
    print(f"\n===== {label} (n_days={len(recs)}) =====")
    print(f"{'feature':12} " + " ".join(f"{t:>14}" for t in TGTS))
    print(f"{'':12} " + " ".join(f"{'(rho | t)':>14}" for _ in TGTS))
    for fk in FEATS:
        cells=[]
        for tk in TGTS:
            res=spearman([(r[1].get(fk),r[2][tk]) for r in recs])
            if res[0] is None: cells.append(f"{'--':>14}")
            else:
                rho,n,t=res; star='*' if abs(t)>2.6 else (' ' if abs(t)>1.96 else '')
                cells.append(f"{rho:+.3f}|{t:+4.1f}{star:1}".rjust(14))
        print(f"{fk:12} " + " ".join(cells))

run(rec,"FULL PERIOD")
cut=dt.date(2023,1,1)
run([r for r in rec if r[0]>=cut],"RECENT (2023+)")
print("\n* |t|>2.6 (~p<0.01),  (blank but shown) |t|>1.96 (~p<0.05).  rho=Spearman.")
print("targets: nd_range=next-day range%, nd_eff=trend(1)/chop(0), nd_ret_oc=open->close ret%")
