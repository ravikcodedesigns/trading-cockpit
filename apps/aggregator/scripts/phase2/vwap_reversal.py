#!/usr/bin/env python3
"""
VWAP reversal strategy. Session-anchored VWAP (from 09:30 ET). Setup: a 1-min bar
WICKS to VWAP (within TOL) and CLOSES back on its origin side (the reversal) ->
enter at that close; TP +50 / SL -20 (break-even WR 28.6%). Approach-from-above =
long bounce, from-below = short rejection. NO lookahead (entry at reversal-bar
close; outcome walked from the NEXT bar). Temporal train/test: learn the
separating pattern on train, test once on held-out days.
"""
import sqlite3, datetime as dt, os, statistics as st
KDB=os.path.expanduser("~/trading-cockpit/data/ticks.db"); SYM="NQ"; ET=4
TOL=3.0; MARGIN=2.0; TP=50.0; SL=20.0; MAXHOLD=120; EXT_MIN=8.0
k=sqlite3.connect(f"file:{KDB}?mode=ro",uri=True)

def ms(d,h): return int((dt.datetime.strptime(f"{d} {h}","%Y-%m-%d %H:%M:%S")+dt.timedelta(hours=ET)).replace(tzinfo=dt.timezone.utc).timestamp()*1000)
def daterange(a,b):
    d=a
    while d<=b:
        if d.weekday()<5: yield d.isoformat()
        d+=dt.timedelta(days=1)

def day_minutes(d):
    """Return list of per-minute dicts with OHLC, vwap(at close), cvd cum, since-open."""
    t0=ms(d,"09:30:00"); t1=ms(d,"16:00:00")
    rows=k.execute("SELECT ts,price,size,is_bid_aggressor FROM trades WHERE symbol=? AND ts>=? AND ts<? ORDER BY ts",(SYM,t0,t1)).fetchall()
    if len(rows)<100: return None
    cum_pv=0.0; cum_v=0.0; cum_cvd=0; bars={}
    for ts,p,sz,a in rows:
        cum_pv+=p*sz; cum_v+=sz; cum_cvd+= sz if a else -sz
        m=ts//60000
        b=bars.get(m)
        if not b: b={'o':p,'h':p,'l':p,'c':p,'v':0,'cvd':0}; bars[m]=b
        b['h']=max(b['h'],p); b['l']=min(b['l'],p); b['c']=p; b['v']+=sz
        b['cvd']+= sz if a else -sz
        b['vwap']=cum_pv/cum_v; b['cumcvd']=cum_cvd
    out=[]
    keys=sorted(bars)
    for i,m in enumerate(keys):
        b=bars[m]; b['min']=i; b['ts']=m*60000; out.append(b)
    return out

def detect(bars):
    """Yield reversal trades with pre-entry features + outcome."""
    res=[]; n=len(bars)
    for i in range(5,n):
        b=bars[i]; vw=b['vwap']
        prev=bars[i-1]; pside = prev['c']-prev['vwap']   # origin side (prior bar)
        long_sig = (pside>0) and (b['l']<=vw+TOL) and (b['c']>=vw+MARGIN)
        short_sig= (pside<0) and (b['h']>=vw-TOL) and (b['c']<=vw-MARGIN)
        if not (long_sig or short_sig): continue
        dirn='long' if long_sig else 'short'
        # require recent extension from VWAP (genuine approach), as feature too
        ext=max(abs(bars[j]['c']-bars[j]['vwap']) for j in range(max(0,i-30),i+1))
        if ext<EXT_MIN: continue
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
        # features (no lookahead, <= bar i)
        vwap_slope=(b['vwap']-bars[i-30]['vwap']) if i>=30 else (b['vwap']-bars[0]['vwap'])
        cvd30=sum(bars[j]['cvd'] for j in range(max(0,i-30),i+1))
        cvd_dir=cvd30 if dirn=='long' else -cvd30
        rng_so_far=max(x['h'] for x in bars[:i+1])-min(x['l'] for x in bars[:i+1])
        prior_touch=sum(1 for j in range(0,i) if abs(bars[j]['l']-bars[j]['vwap'])<=TOL or abs(bars[j]['h']-bars[j]['vwap'])<=TOL)
        res.append(dict(dir=dirn,out=out,win=(out=="WIN"),tod=b['min'],ext=ext,
                        vwap_slope=vwap_slope, vwap_slope_dir=(vwap_slope if dirn=='long' else -vwap_slope),
                        cvd_dir=cvd_dir, vol=b['v'], rng=rng_so_far, ptouch=prior_touch))
    return res

# collect all days
allrows=[]; daymap={}
for d in daterange(dt.date(2026,5,4), dt.date(2026,6,13)):
    bars=day_minutes(d)
    if not bars: continue
    r=detect(bars)
    for x in r: x['day']=d
    daymap[d]=r; allrows+=r
days=sorted(daymap)
print(f"days={len(days)}  total VWAP-reversal events={len(allrows)}")
def stat(rs):
    w=sum(1 for r in rs if r['win']); n=len(rs); pts=sum((TP if r['win'] else -SL) for r in rs)
    return f"n={n:3d} WR={(w/n*100 if n else 0):3.0f}% EV={(pts/n if n else 0):+5.1f}pt tot={pts:+.0f}"
print("BASELINE all events (TP50/SL20, BE=28.6%):", stat(allrows))

# temporal split 60/40
cut=days[int(len(days)*0.6)]
TR=[r for r in allrows if r['day']<cut]; TE=[r for r in allrows if r['day']>=cut]
print(f"\nsplit @ {cut}:  TRAIN {stat(TR)}   TEST {stat(TE)}")

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
    if not nw or not nl: return 0.5
    return (sum(rk[c] for c in range(n) if xs[c][1])-nw*(nw+1)/2)/(nw*nl)

FEATS=['vwap_slope_dir','ext','tod','cvd_dir','vol','rng','ptouch']
print("\n=== TRAIN: feature separation (AUC vs win) ===")
for fk in sorted(FEATS,key=lambda kk:-abs(auc(TR,kk)-0.5)):
    a=auc(TR,fk); wm=st.median([r[fk] for r in TR if r['win']] or [0]); lm=st.median([r[fk] for r in TR if not r['win']] or [0])
    print(f"  {fk:16} AUC={a:.2f}  WIN med {wm:+9.1f}  LOSE med {lm:+9.1f}")

# test candidate patterns from TRAIN on TEST
import statistics as _st
ext_med=_st.median(r['ext'] for r in TR)
print(f"\n=== candidate rules (train-derived) applied TRAIN vs TEST ===  [train ext median={ext_med:.0f}]")
rules={
  'low ext (<=median)': lambda r: r['ext']<=ext_med,
  'cvd_dir>0':          lambda r: r['cvd_dir']>0,
  'low ext AND cvd>0':  lambda r: r['ext']<=ext_med and r['cvd_dir']>0,
  'low ext AND flat vwap': lambda r: r['ext']<=ext_med and abs(r['vwap_slope'])<5,
}
for name,g in rules.items():
    tr=[r for r in TR if g(r)]; te=[r for r in TE if g(r)]
    print(f"  {name:24}  TRAIN {stat(tr)}   |  TEST {stat(te)}")
