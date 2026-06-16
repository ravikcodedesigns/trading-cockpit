#!/usr/bin/env python3
"""
Phase 2 mechanical baseline — auto-detect tier-1 FADE touches, no lookahead,
score WIN/LOSS at fixed TP/SL. Establishes the unfiltered edge to beat.

Fade logic (causal):
  - approach within NEAR_TOL of a level -> touch begins; side = above(support)/below(resistance)
  - track running extreme toward the level
  - ENTER at touch+K confirmation (price retraces K from the extreme, fade direction),
    provided the extreme stayed within BREAK_TOL of the level
  - ABANDON if price pierces the level by BREAK_TOL before confirming (= breakout, not fade),
    or if no confirmation within TIMEOUT
  - score strictly forward: TP/SL, else OPEN at session end

Usage: python3 touch_baseline.py [train|test]
"""
import sqlite3, datetime as dt, os, sys, json, statistics as stx

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
DB = os.path.join(ROOT, "data", "ticks.db")
LEVELS = json.load(open(os.path.join(ROOT, "daily_levels.json")))["days"]
SYM="NQ"; ET=4
K=6.0; NEAR_TOL=8.0; BREAK_TOL=15.0; TIMEOUT_MS=8*60_000
TP=float(os.environ.get("TP",40)); SL=float(os.environ.get("SL",15)); MODE=os.environ.get("MODE","fade")
MAXHOLD_MS=120*60_000
ENTRY_CUTOFF="14:30:00"; T1={'PDH','PDL','PDC','POC','VAH','VAL'}
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)

TRAIN=["2026-05-08","2026-05-12","2026-05-14","2026-05-18","2026-05-20","2026-05-27","2026-05-29",
       "2026-06-02","2026-06-04","2026-06-08","2026-06-10"]
TEST =["2026-05-11","2026-05-13","2026-05-15","2026-05-19","2026-05-21","2026-05-26","2026-05-28",
       "2026-06-01","2026-06-03","2026-06-05","2026-06-09","2026-06-11"]

def ms(d,h): return int((dt.datetime.strptime(f"{d} {h}","%Y-%m-%d %H:%M:%S")+dt.timedelta(hours=ET)).replace(tzinfo=dt.timezone.utc).timestamp()*1000)
def et(v): return (dt.datetime.utcfromtimestamp(v/1000)-dt.timedelta(hours=ET)).strftime("%H:%M:%S")

def levels_for(d):
    al = LEVELS.get(d,{}).get("levels",[{}])[0].get("additionalLevels",[])
    return {a["label"]:a["price"] for a in al if a.get("label","") in T1}

def rth_trades(d):
    return con.execute("SELECT ts,price,size,is_bid_aggressor FROM trades WHERE symbol=? AND ts>=? AND ts<? ORDER BY ts",
                       (SYM, ms(d,"09:30:00"), ms(d,"16:00:00"))).fetchall()

def book_defN(d, level, t, defend):
    rows = con.execute("""WITH x AS (SELECT price,side,size,
            row_number() OVER (PARTITION BY price,side ORDER BY ts DESC) rn
          FROM depth WHERE symbol=? AND ts BETWEEN ? AND ? AND price BETWEEN ? AND ?)
       SELECT price,side,size FROM x WHERE rn=1 AND size>0""",
       (SYM, t-180_000, t, level-2.0, level+2.0)).fetchall()
    sd = 0 if defend=='bid' else 1
    return sum(s for p,s2,s in rows if s2==sd and abs(p-level)<=2.0)

def detect_and_score(trs, level, cutoff_ms, day_open):
    """Yield dicts of fade trades for one level over the day's trades trs=[(ts,price)]."""
    out=[]; n=len(trs); i=0; cooldown_until_away=False
    while i < n:
        ts,p = trs[i][0], trs[i][1]
        d2 = abs(p-level)
        if cooldown_until_away:
            if d2 > NEAR_TOL: cooldown_until_away=False
            i+=1; continue
        if d2 <= NEAR_TOL:
            # touch begins; side from the tick just before
            prev = trs[i-1][1] if i>0 else p
            side = 'above' if prev >= level else 'below'   # support / resistance
            ext = p; j = i; entered=False; t_start=ts
            while j < n:
                tj,pj = trs[j][0], trs[j][1]
                if tj - t_start > TIMEOUT_MS: break          # abandon: too slow
                if MODE=='fade':
                    if side=='above':
                        ext = min(ext,pj)
                        if pj < level - BREAK_TOL: break          # abandon: broke support
                        if ext >= level - BREAK_TOL and pj >= ext + K:
                            entered=True; break
                    else:
                        ext = max(ext,pj)
                        if pj > level + BREAK_TOL: break          # abandon: broke resistance
                        if ext <= level + BREAK_TOL and pj <= ext - K:
                            entered=True; break
                else:  # breakout: continuation through the level
                    if side=='below':                              # resistance -> break up
                        if pj <= level - BREAK_TOL: break          # abandon: rejected away
                        if pj >= level + K: entered=True; break
                    else:                                          # support -> break down
                        if pj >= level + BREAK_TOL: break
                        if pj <= level - K: entered=True; break
                j += 1
            if entered and tj <= cutoff_ms:
                if MODE=='fade':
                    direction = 'long' if side=='above' else 'short'
                else:
                    direction = 'long' if side=='below' else 'short'
                epx = pj; ets = tj
                tp = epx+TP if direction=='long' else epx-TP
                sl = epx-SL if direction=='long' else epx+SL
                res="OPEN"; xts=None
                for k in range(j+1,n):
                    tk,pk = trs[k][0], trs[k][1]
                    if tk-ets > MAXHOLD_MS: break
                    if direction=='long':
                        if pk<=sl: res="LOSE"; xts=tk; break
                        if pk>=tp: res="WIN"; xts=tk; break
                    else:
                        if pk>=sl: res="LOSE"; xts=tk; break
                        if pk<=tp: res="WIN"; xts=tk; break
                # cheap pre-entry features from in-memory trades (60s window)
                cvd=0
                for k in range(j,-1,-1):
                    if trs[k][0] < ets-60_000: break
                    cvd += trs[k][2] if trs[k][3] else -trs[k][2]
                cvd_dir = cvd if direction=='long' else -cvd
                tod = int((ets - day_open)/60000)
                out.append(dict(ts=ets,t=et(ets),dir=direction,side=side,epx=epx,ext=ext,
                                dist=ext-level,res=res,cvd_dir=cvd_dir,tod=tod,defend=('bid' if direction=='long' else 'ask')))
                cooldown_until_away=True
                # advance past entry
                i = j+1; continue
            else:
                cooldown_until_away=True
                i = j+1; continue
        i += 1
    return out

def run(days, tag):
    allr=[]
    for d in days:
        lv = levels_for(d)
        trs = rth_trades(d)
        if not trs: print(f"  {d}: no trades"); continue
        cutoff = ms(d, ENTRY_CUTOFF); dopen = ms(d,"09:30:00")
        for lab,price in lv.items():
            for r in detect_and_score(trs, price, cutoff, dopen):
                r["date"]=d; r["lvl"]=lab; r["price"]=price; allr.append(r)
    W=sum(1 for r in allr if r["res"]=="WIN"); L=sum(1 for r in allr if r["res"]=="LOSE")
    O=sum(1 for r in allr if r["res"]=="OPEN"); dec=W+L
    wr=(W/dec*100) if dec else 0
    ev=((W*TP - L*SL)/dec) if dec else 0
    print(f"\n===== {tag}: UNFILTERED tier-1 {MODE.upper()} baseline (TP={TP:.0f}/SL={SL:.0f}, K={K:.0f}, BE-WR={SL/(TP+SL)*100:.0f}%) =====")
    print(f"touches entered={len(allr)}  WIN={W} LOSE={L} OPEN={O}  WR={wr:.0f}%  EV/trade={ev:+.1f}pt  netMNQ=${ev*dec*2:+.0f}")
    # by level
    print(f"  {'lvl':5} {'n':>3} {'W':>3} {'L':>3} {'O':>3} {'WR%':>5} {'EV':>6}")
    for lab in ['PDH','PDL','PDC','POC','VAH','VAL']:
        rr=[r for r in allr if r["lvl"]==lab]
        w=sum(1 for r in rr if r["res"]=="WIN"); l=sum(1 for r in rr if r["res"]=="LOSE"); o=sum(1 for r in rr if r["res"]=="OPEN")
        de=w+l; print(f"  {lab:5} {len(rr):3d} {w:3d} {l:3d} {o:3d} {((w/de*100) if de else 0):5.0f} {(((w*TP-l*SL)/de) if de else 0):+6.1f}")
    return allr

def stat(rows, name):
    W=sum(1 for r in rows if r["res"]=="WIN"); L=sum(1 for r in rows if r["res"]=="LOSE")
    dec=W+L; wr=(W/dec*100) if dec else 0; ev=((W*TP-L*SL)/dec) if dec else 0
    print(f"  {name:34} n={dec:4d}  WR={wr:4.0f}%  EV={ev:+5.1f}pt  net=${ev*dec*2:+7.0f}")
    return ev,dec

def filter_eval(allr, tag):
    print(f"\n===== {tag}: FILTER evaluation (break-even WR={SL/(TP+SL)*100:.0f}%) =====")
    stat(allr, "baseline (all touches)")
    f1=[r for r in allr if r["tod"]>=30]
    stat(f1, "time>=10:00")
    f2=[r for r in f1 if r["cvd_dir"]<=-300]
    stat(f2, "time + exhaustion(cvd_dir<=-300)")
    # defN only on the f2 survivors (limits depth queries)
    for r in f2:
        r["defN"]=book_defN(r["date"], r["price"], r["ts"], r["defend"])
    for thr in (100,150,200):
        f3=[r for r in f2 if r.get("defN",0)>=thr]
        stat(f3, f"time + exhaustion + defN>={thr}")

if __name__=="__main__":
    which = sys.argv[1] if len(sys.argv)>1 else "train"
    allr = run(TRAIN if which!="test" else TEST, which.upper())
    filter_eval(allr, which.upper())
