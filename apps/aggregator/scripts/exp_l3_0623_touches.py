#!/usr/bin/env python3
# Reconstruct the NQ L2+L3 book event-by-event on 2026-06-23 and read it at each
# touch of BrZT / QQQ Open / BZB (the near-price RS zones). No lookahead at the
# read; then walk forward 40/40 for BOTH a bounce and a break trade to see which
# would have closed at TP. Book from parquet (full-size NQ); fwd/cvd/tape via duckdb.
import duckdb

ROOT="data/mbo-parquet"; SYM="NQ"; DAY="2026-06-23"; TICK=0.25
def gp(t): return f"'{ROOT}/{t}/symbol={SYM}/date={DAY}/*.parquet'"
MID=1782187200000  # 2026-06-23 00:00 ET
def et(h): return MID+int(h*3600000)
WIN_LO=et(9.5); WIN_HI=et(12.0)
LEVELS={"BrZT":29688.0,"QQQ Open":29718.75,"BZB":29729.5}
TOUCH_TICKS=2; REARM_TICKS=8; WALL_TICKS=4; FWD_MS=30*60000; BRACKET=40
def pii(p): return round(p/TICK)
LV={k:pii(v) for k,v in LEVELS.items()}
con=duckdb.connect()

q=f"""
SELECT ts_ms,'DEP' src,CAST(NULL AS VARCHAR) oid,price_int pi,size sz,is_bid bid,0.0 px
  FROM read_parquet({gp('depth')}) WHERE ts_ms<={WIN_HI}
UNION ALL SELECT ts_ms,action src,order_id oid,price_int pi,size sz,is_bid bid,0.0 px
  FROM read_parquet({gp('mbo')}) WHERE ts_ms<={WIN_HI}
UNION ALL SELECT ts_ms,'T' src,passive_order_id oid,price_int pi,size sz,is_bid_aggressor bid,price px
  FROM read_parquet({gp('trades')}) WHERE size>0 AND ts_ms<={WIN_HI}
ORDER BY ts_ms"""
cur=con.execute(q)
bidSize={}; askSize={}; orders={}; maxDisp={}; cumFill={}; replUp=set()
def bb(): return max(bidSize) if bidSize else None
def ba(): return min(askSize) if askSize else None
def wall(lp,side):
    m=bidSize if side=="bid" else askSize
    return sum(s for p,s in m.items() if abs(p-lp)<=WALL_TICKS)
def l3ice(lp,side):
    want=(side=="bid"); l3=0; ice=0
    for oid,(p,s,b) in orders.items():
        if b!=want or abs(p-lp)>WALL_TICKS: continue
        l3+=s
        if cumFill.get(oid,0)>maxDisp.get(oid,0) or oid in replUp: ice+=1
    return l3,ice
armed={k:True for k in LEVELS}; last_px=None; touches=[]
while True:
    rows=cur.fetchmany(200000)
    if not rows: break
    for ts,src,oid,p,sz,bid,px in rows:
        if p is None and src!='T':
            if src=='cancel' and oid in orders: orders.pop(oid,None);maxDisp.pop(oid,None);cumFill.pop(oid,None);replUp.discard(oid)
            continue
        if src=="DEP":
            m=bidSize if bid else askSize
            if sz and sz>0: m[p]=sz
            else: m.pop(p,None)
        elif src=="send": orders[oid]=[p,sz or 0,bid]; maxDisp[oid]=sz or 0; cumFill[oid]=0
        elif src=="replace":
            o=orders.get(oid)
            if o is not None and sz is not None:
                if sz>o[1]: replUp.add(oid)
                o[0]=p; o[1]=sz
                if sz>maxDisp.get(oid,0): maxDisp[oid]=sz
        elif src=="cancel": orders.pop(oid,None);maxDisp.pop(oid,None);cumFill.pop(oid,None);replUp.discard(oid)
        elif src=="T":
            cpx=px
            if oid and oid in orders:
                cumFill[oid]=cumFill.get(oid,0)+sz; o=orders[oid]; o[1]-=sz
                if o[1]<=0: orders.pop(oid,None);maxDisp.pop(oid,None);cumFill.pop(oid,None);replUp.discard(oid)
            if WIN_LO<=ts<=WIN_HI and last_px is not None:
                for k,lp in LV.items():
                    dist=abs(cpx-LEVELS[k])/TICK
                    if armed[k] and dist<=TOUCH_TICKS:
                        fa=last_px>LEVELS[k]; side="bid" if fa else "ask"
                        w=wall(lp,side); l3,ice=l3ice(lp,side)
                        touches.append(dict(ts=ts,lvl=k,lp=LEVELS[k],fa=fa,px=cpx,side=side,wall=w,l3=l3,gap=max(0,w-l3),ice=ice))
                        armed[k]=False
                    elif not armed[k] and dist>=REARM_TICKS: armed[k]=True
            last_px=cpx

GT=gp("trades")
def hhmm(ts): s=(ts-MID)//1000; return f"{s//3600:02d}:{(s%3600)//60:02d}:{s%60:02d}"
def cvd_to(ts): return con.execute(f"SELECT COALESCE(SUM(CASE WHEN is_bid_aggressor THEN size ELSE -size END),0) FROM read_parquet({GT}) WHERE size>0 AND ts_ms BETWEEN {WIN_LO} AND {ts}").fetchone()[0]
def cvd_w(ts,ms=60000): return con.execute(f"SELECT COALESCE(SUM(CASE WHEN is_bid_aggressor THEN size ELSE -size END),0) FROM read_parquet({GT}) WHERE size>0 AND ts_ms BETWEEN {ts-ms} AND {ts}").fetchone()[0]
def tape(ts,lvl,ms=30000):
    return con.execute(f"SELECT COALESCE(SUM(CASE WHEN is_bid_aggressor THEN size ELSE 0 END),0),COALESCE(SUM(CASE WHEN NOT is_bid_aggressor THEN size ELSE 0 END),0) FROM read_parquet({GT}) WHERE size>0 AND ts_ms BETWEEN {ts-ms} AND {ts} AND price BETWEEN {lvl-1.0} AND {lvl+1.0}").fetchone()
def fwd_outcome(ts,entry,direction):
    tp = entry+BRACKET if direction=="long" else entry-BRACKET
    sl = entry-BRACKET if direction=="long" else entry+BRACKET
    if direction=="long":
        tpt=con.execute(f"SELECT MIN(ts_ms) FROM read_parquet({GT}) WHERE size>0 AND ts_ms>{ts} AND price>={tp}").fetchone()[0]
        slt=con.execute(f"SELECT MIN(ts_ms) FROM read_parquet({GT}) WHERE size>0 AND ts_ms>{ts} AND price<={sl}").fetchone()[0]
    else:
        tpt=con.execute(f"SELECT MIN(ts_ms) FROM read_parquet({GT}) WHERE size>0 AND ts_ms>{ts} AND price<={tp}").fetchone()[0]
        slt=con.execute(f"SELECT MIN(ts_ms) FROM read_parquet({GT}) WHERE size>0 AND ts_ms>{ts} AND price>={sl}").fetchone()[0]
    if tpt and (slt is None or tpt<slt): return f"TP({hhmm(tpt)})"
    if slt: return f"SL({hhmm(slt)})"
    return "open"

# dedupe to first touch per level per visit (>=90s)
last={}; keep=[]
for t in touches:
    if t["lvl"] not in last or t["ts"]-last[t["lvl"]]>=90000:
        keep.append(t); last[t["lvl"]]=t["ts"]
print(f"{len(touches)} raw touches -> {len(keep)} visits, 09:30-12:00\n")
print(f"{'time':>9} {'level':>9} {'appr':>6} {'px':>9} {'def':>3} | {'wall':>5} {'gap':>4} {'ice':>3} {'cvd':>7} {'c60':>6} {'tBuy':>5} {'tSel':>5} | {'BOUNCE':>14} {'BREAK':>14}")
for t in keep:
    ts=t["ts"]; entry=t["px"]; appr="above" if t["fa"] else "below"
    c=cvd_to(ts); c60=cvd_w(ts); tb,tsl=tape(ts,t["lp"])
    # bounce = fade the level (from above->long, from below->short); break = continuation
    bounce_dir = "long" if t["fa"] else "short"
    break_dir  = "short" if t["fa"] else "long"
    bo=fwd_outcome(ts,entry,bounce_dir); br=fwd_outcome(ts,entry,break_dir)
    print(f"{hhmm(ts):>9} {t['lvl']:>9} {appr:>6} {entry:>9.2f} {t['side']:>3} | {t['wall']:>5} {t['gap']:>4} {t['ice']:>3} {c:>7} {c60:>6} {tb:>5} {tsl:>5} | {bounce_dir+' '+bo:>14} {break_dir+' '+br:>14}")
