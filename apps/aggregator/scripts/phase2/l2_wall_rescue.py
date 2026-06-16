#!/usr/bin/env python3
"""
Can a 2nd signal (opposing-wall dynamics) rescue the WINNERS that book_dir cuts,
while still cutting the LOSERS? Tests the asymmetry directly.

book_dir = supportive-side resting share at entry (L2 depth, +-5pt).
wall_delta = opposing-side resting size at entry MINUS 60s earlier (L2 depth).
  <0 = opposing wall shrinking/pulling (price can break -> winner-like)
  >0 = opposing wall growing/refilling (absorbs -> loser-like)

Rule tested: KEEP if book_dir>=THR  OR  (book_dir<THR AND wall_delta<0).
Reports, for June (validate) and May (OOS): within the low-book_dir region,
does wall_delta separate W/L (AUC); and the confusion matrix of the rescue rule.
"""
import sqlite3, os
ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
KDB=os.path.join(ROOT,"data","ticks.db"); SDB=os.path.join(ROOT,"data","regime_shadow.db")
SYM="NQ"; BAND=5.0; LB=180_000; THR=0.20
k=sqlite3.connect(f"file:{KDB}?mode=ro",uri=True); s=sqlite3.connect(f"file:{SDB}?mode=ro",uri=True)

def book(sts,entry):
    r=k.execute("""WITH x AS (SELECT price,side,size,row_number() OVER (PARTITION BY price,side ORDER BY ts DESC) rn
        FROM depth WHERE symbol=? AND ts BETWEEN ? AND ? AND price BETWEEN ? AND ?)
      SELECT side,SUM(size) FROM x WHERE rn=1 AND size>0 GROUP BY side""",
      (SYM,sts-LB,sts,entry-BAND,entry+BAND)).fetchall()
    bid=sum(v for sd,v in r if sd==0); ask=sum(v for sd,v in r if sd==1)
    return bid,ask

rows=s.execute("""SELECT signal_ts,date,direction,entry,sim_outcome,sim_pnl_pts
  FROM regime_shadow WHERE sim_outcome IN ('WIN','SL') ORDER BY signal_ts""").fetchall()
recs=[]
for sts,d,dirn,entry,out,pnl in rows:
    bid,ask=book(sts,entry)
    if bid+ask==0: continue
    bd=(bid if dirn=='long' else ask)/(bid+ask)
    b0,a0=book(sts-60_000,entry)            # opposing wall 60s earlier
    opp_now = ask if dirn=='long' else bid
    opp_then= a0 if dirn=='long' else b0
    wall_delta = opp_now-opp_then
    recs.append((d[:7],bd,wall_delta,out=='WIN',pnl))

def auc(rs):
    xs=sorted(((v,w) for v,w in rs),key=lambda z:z[0]); n=len(xs)
    if n<3: return 0.5
    rk=[0]*n;i=0
    while i<n:
        j=i
        while j+1<n and xs[j+1][0]==xs[i][0]: j+=1
        for c in range(i,j+1): rk[c]=(i+j)/2+1
        i=j+1
    nw=sum(1 for _,w in xs if w);nl=n-nw
    if not nw or not nl: return 0.5
    return (sum(rk[c] for c in range(n) if xs[c][1])-nw*(nw+1)/2)/(nw*nl)

for mo in ('2026-06','2026-05'):
    M=[r for r in recs if r[0]==mo]; tag='JUNE(validate)' if mo=='2026-06' else 'MAY (OOS)'
    low=[r for r in M if r[1]<THR]
    # within low-book_dir: does wall_delta (negative=pull) separate? winner should have lower wall_delta -> AUC on -wall_delta
    a=auc([(-r[2],r[3]) for r in low])
    lw=sum(1 for r in low if r[3]); ll=len(low)-lw
    print(f"\n=== {tag}  (n={len(M)}) ===")
    print(f"  low-book_dir region (the trades book_dir cuts): n={len(low)}  winners={lw} losers={ll}")
    print(f"  wall_delta separation within that region: AUC={a:.2f}  (>0.5 = pulling-wall predicts winner)")
    # rescue rule confusion
    def kept(r): return r[1]>=THR or (r[1]<THR and r[2]<0)
    K=[r for r in M if kept(r)]; D=[r for r in M if not kept(r)]
    def stat(rs):
        n=len(rs);w=sum(1 for r in rs if r[3]);pts=sum(r[4] for r in rs)
        return f"n={n:2d} WR={(w/n*100 if n else 0):3.0f}% EV={(pts/n if n else 0):+5.1f} ${pts*2:+6.0f}"
    print(f"  RESCUE rule (keep if book_dir>={THR} OR wall pulling):")
    print(f"    KEPT    {stat(K)}")
    print(f"    DROPPED {stat(D)}")
    wc=sum(1 for r in M if r[3] and not kept(r)); lc=sum(1 for r in M if not r[3] and not kept(r))
    lt=sum(1 for r in M if not r[3] and kept(r)); wk=sum(1 for r in M if r[3] and kept(r))
    print(f"    confusion: winners kept={wk} cut={wc} | losers cut={lc} let-through={lt}")
