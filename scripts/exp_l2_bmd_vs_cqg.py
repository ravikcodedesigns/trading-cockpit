#!/usr/bin/env python3
# Compare BMD L2 vs CQG L2 for the same instrument (MNQ) and day, to decide whether
# CQG can be retired (BMD L3 already carries L2).
#   BMD = parquet depth symbol=MNQ (from the _BMD.log)
#   CQG = ticks.db depth symbol=NQ   (Ravi: ticks.db micros are the CQG feed)
# Build each book independently, sample best bid/ask + top ladder on a 5s grid, compare.
import duckdb, sqlite3

DAY="2026-06-19"
T0=1781875800000   # 09:30:00 ET
T1=1781877600000   # 10:00:00 ET
GRID=5000          # 5s sample grid

# ---- BMD book updates (parquet) ----
con=duckdb.connect()
g=f"'data/mbo-parquet/depth/symbol=MNQ/date={DAY}/*.parquet'"
bmd=con.execute(f"SELECT ts_ms, is_bid, price, size FROM read_parquet({g}) WHERE ts_ms BETWEEN {T0} AND {T1} ORDER BY ts_ms").fetchall()

# ---- CQG book updates (ticks.db) ----  side 0=bid,1=ask
tk=sqlite3.connect("data/ticks.db")
cqg=tk.execute("SELECT ts, side, price, size FROM depth WHERE symbol='NQ' AND ts BETWEEN ? AND ? ORDER BY ts",(T0,T1)).fetchall()
tk.close()
print(f"BMD updates={len(bmd):,}  CQG updates={len(cqg):,}")

def best(bid,ask):
    bb=max(bid) if bid else None
    ba=min(ask) if ask else None
    return bb,ba

# stream both, snapshot at each grid point (last update <= grid time)
def snapshots(updates, is_bmd):
    bid={}; ask={}; snaps={}; gi=0; grid=T0
    for u in updates:
        if is_bmd: ts,isbid,price,size=u; isbid=bool(isbid)
        else:      ts,side,price,size=u; isbid=(side==0)
        if price is None or ts is None: continue
        while ts>grid:
            snaps[grid]=best(bid,ask); grid+=GRID
            if grid>T1: break
        m=bid if isbid else ask
        if size and size>0: m[price]=size
        else: m.pop(price,None)
    while grid<=T1:
        snaps[grid]=best(bid,ask); grid+=GRID
    return snaps

sB=snapshots(bmd,True)
sC=snapshots(cqg,False)

grids=[g for g in sorted(sB) if g in sC]
TICK=0.25
bid_match=ask_match=both=0; n=0
bid_tol=ask_tol=both_tol=0
crossB=crossC=0
mism=[]
for gt in grids:
    bbB,baB=sB[gt]; bbC,baC=sC[gt]
    if None in (bbB,baB,bbC,baC): continue
    n+=1
    if bbB>=baB: crossB+=1
    if bbC>=baC: crossC+=1
    bm=(bbB==bbC); am=(baB==baC)
    bid_match+=bm; ask_match+=am; both+= (bm and am)
    bmt=abs(bbB-bbC)<=TICK; amt=abs(baB-baC)<=TICK
    bid_tol+=bmt; ask_tol+=amt; both_tol+=(bmt and amt)
    if not(bm and am) and len(mism)<12:
        mism.append((gt,bbB,bbC,baB,baC))

def et(ms):
    s=(ms-1781841600000)//1000; return f"{s//3600:02d}:{(s%3600)//60:02d}:{s%60:02d}"
print(f"\nsamples compared: {n}  (5s grid, 09:30-10:00 ET, {DAY} MNQ)")
print(f"EXACT match  bid {100*bid_match/n:.1f}%  ask {100*ask_match/n:.1f}%  both {100*both/n:.1f}%")
print(f"<=1tick match bid {100*bid_tol/n:.1f}%  ask {100*ask_tol/n:.1f}%  both {100*both_tol/n:.1f}%")
print(f"crossed/stale book samples:  BMD {crossB}/{n} ({100*crossB/n:.1f}%)   CQG {crossC}/{n} ({100*crossC/n:.1f}%)")
print("\nsample mismatches (ET, bidBMD/bidCQG, askBMD/askCQG):")
for gt,bbB,bbC,baB,baC in mism:
    print(f"  {et(gt)}  bid {bbB}/{bbC} ({(bbB-bbC):+.2f})   ask {baB}/{baC} ({(baB-baC):+.2f})")

# side-by-side ladder spot-check at 3 grid points
print("\nspot-check best bid/ask side by side (first 8 grid points):")
print(f"  {'ET':>8}  {'BMD bid/ask':>20}   {'CQG bid/ask':>20}")
for gt in grids[:8]:
    bbB,baB=sB[gt]; bbC,baC=sC[gt]
    print(f"  {et(gt):>8}  {str(bbB)+'/'+str(baB):>20}   {str(bbC)+'/'+str(baC):>20}")
