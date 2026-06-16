#!/usr/bin/env python3
"""
L3 order-flow / absorption separator for June FLIP+CONT winners vs losers.

For each June signal (from regime_shadow.db), compute pre-entry (60s, ts<entry,
NO lookahead) L3 features from the parquet MBO store (contract MNQM6), then rank
features by AUC (Mann-Whitney: P(winner's value > loser's value)). AUC=0.5 = no
separation. Finally a within-June split (early days vs late days) to check the
top feature isn't just an in-sample fit. Discipline: small n=49, report effect
size + split, treat as hypothesis (real validation = forward shadow).
"""
import duckdb, sqlite3, datetime as dt, os

ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
PQ=os.path.join(ROOT,"data","mbo-parquet"); SDB=os.path.join(ROOT,"data","regime_shadow.db")
CONTRACT="MNQM6"; WIN_MS=60_000; BAND=5.0
con=duckdb.connect(); s=sqlite3.connect(f"file:{SDB}?mode=ro",uri=True)

sigs=s.execute("""SELECT signal_ts, date, rule_id, direction, entry, sim_outcome, sim_pnl_pts
  FROM regime_shadow WHERE date BETWEEN '2026-06-02' AND '2026-06-12' AND sim_outcome IN ('WIN','SL')
  ORDER BY signal_ts""").fetchall()

def trades_g(d): return f"{PQ}/trades/symbol=NQ/date={d}/*.parquet"
def depth_g(d):  return f"{PQ}/depth/symbol=NQ/date={d}/*.parquet"
def mbo_g(d):    return f"{PQ}/mbo/symbol=NQ/date={d}/*.parquet"

def feats(sts, d, dirn, entry):
    t0=sts-WIN_MS
    tr=con.execute(f"""SELECT size,is_bid_aggressor,price,ts_ms FROM read_parquet('{trades_g(d)}')
        WHERE contract=? AND ts_ms BETWEEN ? AND ? ORDER BY ts_ms""",[CONTRACT,t0,sts]).fetchall()
    if len(tr)<5: return None
    buy=sum(r[0] for r in tr if r[1]); sell=sum(r[0] for r in tr if not r[1]); tot=buy+sell
    if tot==0: return None
    cvd=buy-sell
    disp=tr[-1][2]-tr[0][2]
    absorp=tot/max(abs(disp),1.0)                 # vol per point moved: high=absorbed
    aggr_imb=cvd/tot
    cvd_dir=cvd if dirn=='long' else -cvd
    # flow vs prior move: was price moving with or against the trade in the window?
    move_dir=1 if disp>0 else -1; tdir=1 if dirn=='long' else -1
    cvd_vs_move = cvd_dir                           # (kept simple)
    nprints=len(tr); maxprint=max(r[0] for r in tr); bigshare=sum(r[0] for r in tr if r[0]>=10)/tot
    # book at entry (latest size per price in band)
    bk=con.execute(f"""WITH x AS (SELECT price,is_bid,size,
            row_number() OVER (PARTITION BY price_int,is_bid ORDER BY ts_ms DESC) rn
          FROM read_parquet('{depth_g(d)}') WHERE contract=? AND ts_ms BETWEEN ? AND ? AND price BETWEEN ? AND ?)
        SELECT is_bid, SUM(size) FROM x WHERE rn=1 AND size>0 GROUP BY is_bid""",
        [CONTRACT,sts-180_000,sts,entry-BAND,entry+BAND]).fetchall()
    bid=sum(v for b,v in bk if b); ask=sum(v for b,v in bk if not b)
    book_imb=bid/(bid+ask) if (bid+ask) else 0.5
    book_dir = (bid/(bid+ask)) if (dirn=='long' and (bid+ask)) else ((ask/(bid+ask)) if (bid+ask) else 0.5)  # supportive-side share
    # replenishment near price: net send-cancel size in window (band) -> >0 stacking, <0 pulling
    fl=con.execute(f"""SELECT action, COALESCE(SUM(size),0) FROM read_parquet('{mbo_g(d)}')
        WHERE contract=? AND ts_ms BETWEEN ? AND ? AND price BETWEEN ? AND ? AND action IN ('send','cancel')
        GROUP BY action""",[CONTRACT,t0,sts,entry-BAND,entry+BAND]).fetchall()
    fm={a:v for a,v in fl}; netliq=fm.get('send',0)-fm.get('cancel',0)
    return dict(cvd=cvd, cvd_dir=cvd_dir, absorp=absorp, aggr_imb=aggr_imb, vol=tot,
                nprints=nprints, maxprint=maxprint, bigshare=bigshare,
                book_imb=book_imb, book_dir=book_dir, netliq=netliq)

rows=[]
for sts,d,rule,dirn,entry,out,pnl in sigs:
    f=feats(sts,d,dirn,entry)
    if f is None: continue
    f.update(d=d,dirn=dirn,out=out,win=(out=='WIN'),pnl=pnl); rows.append(f)

def auc(rows,key):
    xs=[(r[key],r['win']) for r in rows]
    xs.sort(key=lambda z:z[0])
    # Mann-Whitney U via ranks (avg ranks for ties)
    n=len(xs); ranks=[0]*n; i=0
    while i<n:
        j=i
        while j+1<n and xs[j+1][0]==xs[i][0]: j+=1
        avg=(i+j)/2+1
        for kk in range(i,j+1): ranks[kk]=avg
        i=j+1
    nw=sum(1 for _,w in xs if w); nl=n-nw
    if nw==0 or nl==0: return 0.5
    Rw=sum(ranks[k] for k in range(n) if xs[k][1])
    U=Rw-nw*(nw+1)/2
    return U/(nw*nl)

import statistics as st
keys=['cvd','cvd_dir','absorp','aggr_imb','vol','nprints','maxprint','bigshare','book_imb','book_dir','netliq']
print(f"n={len(rows)}  W={sum(r['win'] for r in rows)} L={sum(1 for r in rows if not r['win'])}\n")
print(f"{'feature':10} {'AUC':>6} {'|AUC-.5|':>8} {'WIN med':>10} {'LOSE med':>10}")
ranked=sorted(keys,key=lambda kk:-abs(auc(rows,kk)-0.5))
for kk in ranked:
    a=auc(rows,kk)
    wm=st.median([r[kk] for r in rows if r['win']]); lm=st.median([r[kk] for r in rows if not r['win']])
    print(f"{kk:10} {a:6.2f} {abs(a-0.5):8.2f} {wm:10.2f} {lm:10.2f}")

# within-June split on the top feature
top=ranked[0]
days=sorted(set(r['d'] for r in rows)); half=days[:len(days)//2]
tr=[r for r in rows if r['d'] in half]; te=[r for r in rows if r['d'] not in half]
print(f"\nTOP feature '{top}' — within-June split check:")
print(f"  EARLY days {half[0]}..{half[-1]}: AUC={auc(tr,top):.2f} (n={len(tr)})")
print(f"  LATE  days {[d for d in days if d not in half][0]}..{days[-1]}: AUC={auc(te,top):.2f} (n={len(te)})")
print(f"\n(AUC 0.5=no separation; ~0.7+ = decent. n={len(rows)} -> hypothesis only, multiple features tested.)")

# per-direction AUC of top feature (confound check)
print(f"\n'{top}' AUC within each direction:")
for dd in ('long','short'):
    sub=[r for r in rows if r['dirn']==dd]
    print(f"  {dd:5}: AUC={auc(sub,top):.2f} (n={len(sub)}, W={sum(r['win'] for r in sub)})")

# illustrative threshold sweep on top feature (IN-SAMPLE — caveat)
print(f"\n'{top}' threshold sweep (IN-SAMPLE, illustrative):")
for thr in (0.10,0.15,0.20,0.25,0.30):
    keep=[r for r in rows if r[top]>=thr]; drop=[r for r in rows if r[top]<thr]
    def wev(rs):
        w=sum(1 for r in rs if r['win']);n=len(rs);pts=sum(r['pnl'] for r in rs)
        return f"n={n:2d} WR={(w/n*100 if n else 0):3.0f}% EV={(pts/n if n else 0):+5.1f} ${pts*2:+6.0f}"
    print(f"  >={thr:.2f}: KEEP {wev(keep)}  | DROP {wev(drop)}")
