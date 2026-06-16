#!/usr/bin/env python3
"""
Out-of-sample test of book_dir (found on June L3) using L2 depth (ticks.db).

book_dir = supportive-side resting size share within +-5pt of entry, snapshot at
entry (180s lookback), from ticks.db depth (side 0=bid,1=ask; size=0=removed).
  - JUNE (discovery month): recompute book_dir from L2, check AUC reproduces the
    L3 result (~0.73) -> validates L2 depth is usable.
  - MAY (TEST, out-of-sample): apply the June threshold and report the confusion
    matrix: winners kept/cut, losers cut/let-through + WR/EV.
No April data exists (capture starts 2026-05-04).
"""
import sqlite3, os
ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
KDB=os.path.join(ROOT,"data","ticks.db"); SDB=os.path.join(ROOT,"data","regime_shadow.db")
SYM="NQ"; BAND=5.0; LB=180_000; THR=float(os.environ.get("THR",0.20))
k=sqlite3.connect(f"file:{KDB}?mode=ro",uri=True); s=sqlite3.connect(f"file:{SDB}?mode=ro",uri=True)

rows=s.execute("""SELECT signal_ts,date,direction,entry,sim_outcome,sim_pnl_pts
  FROM regime_shadow WHERE sim_outcome IN ('WIN','SL') ORDER BY signal_ts""").fetchall()

def book_dir_l2(sts, dirn, entry):
    bk=k.execute("""WITH x AS (SELECT price,side,size,
          row_number() OVER (PARTITION BY price,side ORDER BY ts DESC) rn
        FROM depth WHERE symbol=? AND ts BETWEEN ? AND ? AND price BETWEEN ? AND ?)
      SELECT side, SUM(size) FROM x WHERE rn=1 AND size>0 GROUP BY side""",
      (SYM, sts-LB, sts, entry-BAND, entry+BAND)).fetchall()
    bid=sum(v for sd,v in bk if sd==0); ask=sum(v for sd,v in bk if sd==1)
    if bid+ask==0: return None
    supp = bid if dirn=='long' else ask
    return supp/(bid+ask)

recs=[]
for sts,d,dirn,entry,out,pnl in rows:
    bd=book_dir_l2(sts,dirn,entry)
    if bd is None: continue
    recs.append((d[:7], bd, out=='WIN', pnl))

def auc(rs):
    xs=sorted(((bd,w) for _,bd,w,_ in rs), key=lambda z:z[0]); n=len(xs)
    ranks=[0]*n; i=0
    while i<n:
        j=i
        while j+1<n and xs[j+1][0]==xs[i][0]: j+=1
        for kk in range(i,j+1): ranks[kk]=(i+j)/2+1
        i=j+1
    nw=sum(1 for _,w in xs if w); nl=n-nw
    if not nw or not nl: return 0.5
    Rw=sum(ranks[k2] for k2 in range(n) if xs[k2][1])
    return (Rw-nw*(nw+1)/2)/(nw*nl)

jun=[r for r in recs if r[0]=='2026-06']; may=[r for r in recs if r[0]=='2026-05']
print(f"L2 book_dir — JUNE (discovery, validate vs L3 0.73): n={len(jun)} AUC={auc(jun):.2f}")
print(f"               MAY  (TEST, out-of-sample):           n={len(may)} AUC={auc(may):.2f}")

def confusion(rs, thr):
    wk=[r for r in rs if r[2] and r[1]>=thr]; wc=[r for r in rs if r[2] and r[1]<thr]
    lt=[r for r in rs if not r[2] and r[1]>=thr]; lc=[r for r in rs if not r[2] and r[1]<thr]
    return wk,wc,lt,lc
def line(rs,lbl):
    n=len(rs); w=sum(1 for r in rs if r[2]); pts=sum(r[3] for r in rs)
    print(f"   {lbl:28} n={n:2d} WR={(w/n*100 if n else 0):3.0f}% EV={(pts/n if n else 0):+5.1f} ${pts*2:+6.0f}")

print(f"\n=== MAY out-of-sample, apply book_dir >= {THR} (threshold from June) ===")
wk,wc,lt,lc=confusion(may,THR)
print(f"  CONFUSION MATRIX:")
print(f"    winners KEPT  (saved, correctly traded) : {len(wk)}")
print(f"    winners CUT   (skipped, opportunity lost): {len(wc)}")
print(f"    losers  CUT   (correctly avoided)        : {len(lc)}")
print(f"    losers  LET-THROUGH (still traded, bad)  : {len(lt)}")
print(f"  PERFORMANCE:")
line(may,"MAY baseline (all)")
line(wk+lt,"MAY KEPT (book_dir>=thr)")
line(wc+lc,"MAY DROPPED (book_dir<thr)")
# threshold sweep on MAY for context
print(f"\n=== MAY threshold sensitivity ===")
for thr in (0.10,0.15,0.20,0.25,0.30):
    wk,wc,lt,lc=confusion(may,thr); kept=wk+lt
    kn=len(kept); kw=sum(1 for r in kept if r[2]); kpts=sum(r[3] for r in kept)
    print(f"  >= {thr:.2f}: KEEP n={kn:2d} WR={(kw/kn*100 if kn else 0):3.0f}% EV={(kpts/kn if kn else 0):+5.1f}$  | losers cut={len(lc)} let-through={len(lt)} winners cut={len(wc)}")
