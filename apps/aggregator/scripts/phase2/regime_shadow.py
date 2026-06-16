#!/usr/bin/env python3
"""
Regime-gate SHADOW scorer (decoupled — does NOT touch live trading).

Reads trading.db + ticks.db READ-ONLY, writes its own data/regime_shadow.db.
For every FLIP/CONT OPEN tradable signal it logs, no-lookahead:
  AC1 (lag-1 autocorr of 1-min returns, prior WINDOW min), VR, ER,
  priorSL (today's earlier FLIP/CONT trades that hit SL & closed before now),
  gate_keep = (AC1>=0 AND priorSL==0),
  sim_outcome / sim_pnl_pts (walk-forward at per-rule TP/SL),
  fresh_oos = 1 if signal date >= DEPLOY_DATE (genuinely out-of-sample).

Idempotent (INSERT OR REPLACE by signal_id). Safe to run daily via launchd or
on demand. Prints recent gate decisions + the fresh-OOS running tally.
"""
import sqlite3, datetime as dt, os, sys

ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
TDB=os.path.join(ROOT,"data","trading.db"); KDB=os.path.join(ROOT,"data","ticks.db")
SDB=os.path.join(ROOT,"data","regime_shadow.db")
SYM="NQ"; ET=4; WINDOW=60; VRK=5
DEPLOY_DATE=os.environ.get("DEPLOY_DATE","2026-06-15")   # signals on/after this = fresh OOS

t=sqlite3.connect(f"file:{TDB}?mode=ro",uri=True); k=sqlite3.connect(f"file:{KDB}?mode=ro",uri=True)
s=sqlite3.connect(SDB)
s.execute("""CREATE TABLE IF NOT EXISTS regime_shadow(
  signal_id INTEGER PRIMARY KEY, signal_ts INTEGER, date TEXT, rule_id TEXT, direction TEXT,
  entry REAL, ac1 REAL, vr REAL, er REAL, prior_sl INTEGER, gate_keep INTEGER,
  sim_outcome TEXT, sim_pnl_pts REAL, fresh_oos INTEGER, scored_at INTEGER)""")

def ms(d,h): return int((dt.datetime.strptime(f"{d} {h}","%Y-%m-%d %H:%M:%S")+dt.timedelta(hours=ET)).replace(tzinfo=dt.timezone.utc).timestamp()*1000)
dc={}
def dtr(d):
    if d not in dc: dc[d]=k.execute("SELECT ts,price FROM trades WHERE symbol=? AND ts>=? AND ts<? ORDER BY ts",(SYM,ms(d,"09:30:00"),ms(d,"16:00:00"))).fetchall()
    return dc[d]
def br(rule,dr): return (80,70) if rule=='cont-reentry' else ((80,55) if dr=='long' else (80,105))
def bars1m(sts):
    rows=k.execute("SELECT ts,price FROM trades WHERE symbol=? AND ts>=? AND ts<=? ORDER BY ts",(SYM,sts-WINDOW*60000,sts)).fetchall()
    b={}
    for ts,p in rows: b[ts//60000]=p
    return [b[x] for x in sorted(b)]
def measures(cl):
    if len(cl)<12: return None
    r=[cl[i]-cl[i-1] for i in range(1,len(cl))]
    net=abs(cl[-1]-cl[0]); path=sum(abs(x) for x in r); ER=net/path if path else 0
    mu=sum(r)/len(r); den=sum((x-mu)**2 for x in r)
    var1=den/(len(r)-1) if len(r)>1 else 0
    AC1=(sum((r[i]-mu)*(r[i-1]-mu) for i in range(1,len(r)))/den) if den else 0
    m=len(r)
    if m>VRK and var1>0:
        ys=[sum(r[i:i+VRK]) for i in range(0,m-VRK+1)]; muk=VRK*mu
        VR=(sum((y-muk)**2 for y in ys)/(len(ys)-1)/VRK)/var1
    else: VR=1.0
    return ER,AC1,VR

sigs=t.execute("""SELECT signal_id,signal_ts,date(signal_ts/1000,'unixepoch','-4 hours') d,rule_id,direction,entry
 FROM tradable_signals WHERE action='OPEN' AND rule_id IN ('clean-impulse','cont-reentry') ORDER BY signal_ts""").fetchall()
# group by day to compute priorSL with exit times
byday={}
for sid,sts,d,rule,dirn,entry in sigs: byday.setdefault(d,[]).append((sid,sts,rule,dirn,entry))
now=int(dt.datetime.now(dt.timezone.utc).timestamp()*1000)
rows=[]
for d,lst in byday.items():
    trs=dtr(d)
    if not trs: continue
    scored=[]
    for sid,sts,rule,dirn,entry in lst:
        epx=entry or next((pr for ts,pr in trs if ts>=sts),None)
        if epx is None: continue
        tp,sl=br(rule,dirn); tgt=epx+tp if dirn=='long' else epx-tp; stp=epx-sl if dirn=='long' else epx+sl
        res="OPEN"; xts=None; pnl=None
        for ts,pr in trs:
            if ts<sts: continue
            if ts-sts>120*60000: break
            if dirn=='long':
                if pr<=stp: res,xts,pnl="SL",ts,-sl;break
                if pr>=tgt: res,xts,pnl="WIN",ts,tp;break
            else:
                if pr>=stp: res,xts,pnl="SL",ts,-sl;break
                if pr<=tgt: res,xts,pnl="WIN",ts,tp;break
        scored.append((sid,sts,rule,dirn,epx,res,xts,pnl))
    for sid,sts,rule,dirn,epx,res,xts,pnl in scored:
        priorSL=sum(1 for q in scored if q[6] and q[6]<sts and q[5]=='SL')
        mm=measures(bars1m(sts));
        if mm is None: continue
        ER,AC1,VR=mm
        keep=1 if (AC1>=0 and priorSL==0) else 0
        fresh=1 if d>=DEPLOY_DATE else 0
        rows.append((sid,sts,d,rule,dirn,round(epx,2),round(AC1,4),round(VR,3),round(ER,3),priorSL,keep,res,pnl,fresh,now))
s.executemany("INSERT OR REPLACE INTO regime_shadow VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
s.commit()
print(f"scored {len(rows)} signals -> {SDB}")

# report: recent days' decisions
print("\n=== recent gate decisions (last 8 days) ===")
for r in s.execute("""SELECT date,time(signal_ts/1000,'unixepoch','-4 hours'),rule_id,direction,ac1,prior_sl,gate_keep,sim_outcome,fresh_oos
  FROM regime_shadow WHERE date >= date('now','-8 days') ORDER BY signal_ts""").fetchall():
    d,tm,rule,dirn,ac1,psl,keep,out,fresh=r
    print(f"  {d} {tm} {rule:13} {dirn:5} AC1={ac1:+.3f} pSL={psl} -> {'KEEP ' if keep else 'SKIP '}{'(OOS)' if fresh else '':5} outcome={out or '-'}")

def tally(where,label):
    rs=s.execute(f"SELECT gate_keep,sim_outcome,sim_pnl_pts FROM regime_shadow WHERE sim_outcome IN ('WIN','SL') AND {where}").fetchall()
    def st(sub):
        w=sum(1 for g,o,p in sub if o=='WIN');n=len(sub);pts=sum(p for g,o,p in sub)
        return f"n={n:3d} WR={(w/n*100 if n else 0):4.0f}% EV={(pts/n if n else 0):+5.1f} ${pts*2:+7.0f}"
    print(f"  {label}: ALL {st(rs)}  | KEPT {st([x for x in rs if x[0]])}  | SKIP {st([x for x in rs if not x[0]])}")
print("\n=== tally ===")
tally("1=1","full history ")
tally(f"fresh_oos=1","FRESH OOS    ")
print(f"\n(fresh OOS = signals on/after {DEPLOY_DATE}; grows as live days accrue)")
