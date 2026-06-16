#!/usr/bin/env python3
"""
Do Choppiness Index + ADX (computed at each signal's entry, 1-min bars,
NO-lookahead) separate FLIP/CONT winners from losers? Same discipline as before:
AUC + WR buckets. TV gives only live values, so we compute the standard formulas
ourselves and cross-check the 'now' value vs TV's live read (CHOP 52.65/ADX 12.36).
"""
import sqlite3, datetime as dt, os, math, statistics as st
KDB=os.path.expanduser("~/trading-cockpit/data/ticks.db"); SDB=os.path.expanduser("~/trading-cockpit/data/regime_shadow.db")
SYM="NQ"; ET=4; N=14; LB_MIN=90
k=sqlite3.connect(f"file:{KDB}?mode=ro",uri=True); s=sqlite3.connect(f"file:{SDB}?mode=ro",uri=True)

def bars1m(t0,t1):
    rows=k.execute("SELECT ts,price FROM trades WHERE symbol=? AND ts>=? AND ts<? ORDER BY ts",(SYM,t0,t1)).fetchall()
    b={}
    for ts,p in rows:
        m=ts//60000
        if m not in b: b[m]=[p,p,p,p]
        b[m][1]=max(b[m][1],p); b[m][2]=min(b[m][2],p); b[m][3]=p
    return [b[m] for m in sorted(b)]  # list of [O,H,L,C]

def chop(bars,n=N):
    if len(bars)<n+1: return None
    seg=bars[-(n+1):]
    trs=[]
    for i in range(1,len(seg)):
        H,L,Cp=seg[i][1],seg[i][2],seg[i-1][3]
        trs.append(max(H-L,abs(H-Cp),abs(L-Cp)))
    sumtr=sum(trs)
    HH=max(x[1] for x in seg[1:]); LL=min(x[2] for x in seg[1:])
    if HH-LL<=0 or sumtr<=0: return None
    return 100*math.log10(sumtr/(HH-LL))/math.log10(n)

def adx(bars,n=N):
    if len(bars)<2*n+1: return None
    TR=[];PDM=[];NDM=[]
    for i in range(1,len(bars)):
        H,L=bars[i][1],bars[i][2]; pH,pL,pC=bars[i-1][1],bars[i-1][2],bars[i-1][3]
        up=H-pH; dn=pL-L
        PDM.append(up if (up>dn and up>0) else 0.0)
        NDM.append(dn if (dn>up and dn>0) else 0.0)
        TR.append(max(H-L,abs(H-pC),abs(L-pC)))
    # Wilder smoothing
    def wilder(x):
        s0=sum(x[:n]); out=[s0]
        for i in range(n,len(x)): out.append(out[-1]-out[-1]/n+x[i])
        return out
    tr=wilder(TR); pdm=wilder(PDM); ndm=wilder(NDM)
    DX=[]
    for i in range(len(tr)):
        if tr[i]==0: DX.append(0); continue
        pdi=100*pdm[i]/tr[i]; ndi=100*ndm[i]/tr[i]
        DX.append(100*abs(pdi-ndi)/(pdi+ndi) if (pdi+ndi)>0 else 0)
    if len(DX)<n: return None
    a=sum(DX[:n])/n
    for i in range(n,len(DX)): a=(a*(n-1)+DX[i])/n
    return a

def ms(d,h): return int((dt.datetime.strptime(f"{d} {h}","%Y-%m-%d %H:%M:%S")+dt.timedelta(hours=ET)).replace(tzinfo=dt.timezone.utc).timestamp()*1000)

# cross-check today
import datetime as _dt
nowms=int(_dt.datetime.now(_dt.timezone.utc).timestamp()*1000)
tb=bars1m(nowms-LB_MIN*60000, nowms)
print(f"CROSS-CHECK now: my CHOP={chop(tb)}  my ADX={adx(tb)}   (TV live: CHOP 52.65, ADX 12.36)")

sigs=s.execute("""SELECT signal_ts,date,direction,entry,sim_outcome,sim_pnl_pts FROM regime_shadow
  WHERE sim_outcome IN ('WIN','SL') ORDER BY signal_ts""").fetchall()
rows=[]
for sts,d,dirn,entry,out,pnl in sigs:
    bb=bars1m(sts-LB_MIN*60000, sts)   # strictly before entry
    c=chop(bb); a=adx(bb)
    if c is None or a is None: continue
    rows.append(dict(chop=c,adx=a,win=(out=='WIN'),pnl=pnl))

def auc(rs,key):
    xs=sorted(((r[key],r['win']) for r in rs),key=lambda z:z[0]); n=len(xs)
    rk=[0]*n;i=0
    while i<n:
        j=i
        while j+1<n and xs[j+1][0]==xs[i][0]: j+=1
        for c in range(i,j+1): rk[c]=(i+j)/2+1
        i=j+1
    nw=sum(1 for _,w in xs if w);nl=n-nw
    if not nw or not nl: return 0.5
    return (sum(rk[c] for c in range(n) if xs[c][1])-nw*(nw+1)/2)/(nw*nl)

print(f"\nn={len(rows)}  W={sum(r['win'] for r in rows)} L={sum(1 for r in rows if not r['win'])}")
print(f"CHOP: AUC={auc(rows,'chop'):.2f}  (WIN med {st.median(r['chop'] for r in rows if r['win']):.1f} / LOSE med {st.median(r['chop'] for r in rows if not r['win']):.1f})")
print(f"ADX : AUC={auc(rows,'adx'):.2f}  (WIN med {st.median(r['adx'] for r in rows if r['win']):.1f} / LOSE med {st.median(r['adx'] for r in rows if not r['win']):.1f})")

def bucket(rs,key,bands):
    print(f"\n{key} buckets:")
    for lab,lo,hi in bands:
        sub=[r for r in rs if lo<=r[key]<hi]; w=sum(1 for r in sub if r['win']); n=len(sub)
        pts=sum(r['pnl'] for r in sub)
        print(f"  {lab:20} n={n:3d} WR={(w/n*100 if n else 0):3.0f}% EV={(pts/n if n else 0):+5.1f}")
bucket(rows,'chop',[("trend <38.2",0,38.2),("mid 38.2-61.8",38.2,61.8),("chop >61.8",61.8,999)])
bucket(rows,'adx',[("range <20",0,20),("20-25",20,25),("trend >25",25,999)])
