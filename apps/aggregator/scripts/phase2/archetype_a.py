#!/usr/bin/env python3
"""
Archetype A — balance-fade of value-area extremes with mechanical
acceptance/rejection. NO LOOKAHEAD, auto-detected, train/test.

Setup (Market Profile value-area fade / 80% rule):
  - price pokes beyond VAH (or VAL); measure poke depth + time beyond
  - REJECTION  = shallow poke (<=ACCEPT_DIST) AND short time beyond (<=REJECT_TIME)
                 AND price re-enters inside the extreme  -> FADE toward POC
                   VAH poke -> SHORT, target POC ; VAL poke -> LONG, target POC
  - ACCEPTANCE = deep/sustained beyond -> that extreme is "broken" for the day,
                 no further fades there (filters out trend days adaptively)
  - entry = first tick back inside by REENTRY; stop = poke extreme +/- STOP_BUF;
            target = POC. WIN if POC reached first, LOSE if stop first, else OPEN.

Usage: python3 archetype_a.py [train|test]
"""
import sqlite3, datetime as dt, os, sys, json

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
DB = os.path.join(ROOT, "data", "ticks.db")
LEVELS = json.load(open(os.path.join(ROOT, "daily_levels.json")))["days"]
SYM="NQ"; ET=4
ACCEPT_DIST=float(os.environ.get("ACCEPT_DIST",20))   # poke deeper than this = acceptance
REJECT_TIME=float(os.environ.get("REJECT_TIME",180))*1000  # time beyond longer than this = acceptance
REENTRY=float(os.environ.get("REENTRY",2))            # confirm re-entry this far back inside
STOP_BUF=float(os.environ.get("STOP_BUF",12))         # stop beyond the poke extreme (room for noise)
TARGET_MODE=os.environ.get("TARGET_MODE","poc")       # 'poc' | 'r'
RMULT=float(os.environ.get("RMULT",2))                # target = RMULT x risk when TARGET_MODE='r'
MAX_VA_WIDTH=float(os.environ.get("MAX_VA_WIDTH",250))# skip days whose prior-day VA is abnormally wide
ENTRY_CUTOFF="14:30:00"; MAXHOLD_MS=120*60_000
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)

TRAIN=["2026-05-08","2026-05-12","2026-05-14","2026-05-18","2026-05-20","2026-05-27","2026-05-29",
       "2026-06-02","2026-06-04","2026-06-08","2026-06-10"]
TEST =["2026-05-11","2026-05-13","2026-05-15","2026-05-19","2026-05-21","2026-05-26","2026-05-28",
       "2026-06-01","2026-06-03","2026-06-05","2026-06-09","2026-06-11"]

def ms(d,h): return int((dt.datetime.strptime(f"{d} {h}","%Y-%m-%d %H:%M:%S")+dt.timedelta(hours=ET)).replace(tzinfo=dt.timezone.utc).timestamp()*1000)
def et(v): return (dt.datetime.utcfromtimestamp(v/1000)-dt.timedelta(hours=ET)).strftime("%H:%M:%S")
def vlev(d):
    al = LEVELS.get(d,{}).get("levels",[{}])[0].get("additionalLevels",[])
    m={a["label"]:a["price"] for a in al if a.get("label","") in ('VAH','VAL','POC')}
    return m
def rth(d):
    return con.execute("SELECT ts,price,size FROM trades WHERE symbol=? AND ts>=? AND ts<? ORDER BY ts",
                       (SYM, ms(d,"09:30:00"), ms(d,"16:00:00"))).fetchall()

def fade_day(trs, vah, val, poc, cutoff):
    """One pass; detect poke->reject fades at VAH (short) and VAL (long)."""
    out=[]; n=len(trs)
    broken={'VAH':False,'VAL':False}
    # state per extreme
    for ext_name, ext, side in (('VAH',vah,'short'),('VAL',val,'long')):
        i=0
        while i<n:
            ts,p,_ = trs[i]
            beyond = (p>ext) if side=='short' else (p<ext)
            if beyond and not broken[ext_name]:
                # poke begins
                pstart=ts; pext=p; j=i
                while j<n:
                    tj,pj,_=trs[j]
                    still=(pj>ext) if side=='short' else (pj<ext)
                    if not still: break
                    pext = max(pext,pj) if side=='short' else min(pext,pj)
                    j+=1
                depth = (pext-ext) if side=='short' else (ext-pext)
                tbeyond = (trs[j-1][0]-pstart) if j>i else 0
                reentered = j<n
                if not reentered: break
                if depth>ACCEPT_DIST or tbeyond>REJECT_TIME:
                    broken[ext_name]=True   # acceptance -> extreme broken for the day
                    i=j; continue
                # REJECTION: enter at re-entry (back inside by REENTRY), within cutoff
                ek=None
                for k in range(j,n):
                    tk,pk,_=trs[k]
                    inside=(pk<=ext-REENTRY) if side=='short' else (pk>=ext+REENTRY)
                    if inside: ek=k; break
                    # if it poked back out deeper, abandon
                    if (pk>pext+2) if side=='short' else (pk<pext-2):
                        ek=None; break
                if ek is None or trs[ek][0]>cutoff:
                    i=j; continue
                ets,epx,_=trs[ek]
                stop = pext+STOP_BUF if side=='short' else pext-STOP_BUF
                risk = abs(stop-epx)
                if TARGET_MODE=='poc':
                    tgt = poc
                    if (side=='short' and epx<=poc) or (side=='long' and epx>=poc):
                        i=ek+1; continue
                else:
                    tgt = epx - RMULT*risk if side=='short' else epx + RMULT*risk
                reward=abs(epx-tgt)
                res="OPEN"
                for m2 in range(ek+1,n):
                    tm,pm,_=trs[m2]
                    if tm-ets>MAXHOLD_MS: break
                    if side=='short':
                        if pm>=stop: res="LOSE"; break
                        if pm<=tgt: res="WIN"; break
                    else:
                        if pm<=stop: res="LOSE"; break
                        if pm>=tgt: res="WIN"; break
                out.append(dict(t=et(ets),ext=ext_name,side=side,epx=round(epx,2),depth=round(depth,1),
                                tbeyond=int(tbeyond/1000),risk=round(risk,1),reward=round(reward,1),res=res))
                # next fade requires a fresh poke beyond the extreme (natural dedup)
                i=ek+1; continue
            i+=1
    return out

def run(days, tag):
    allr=[]
    for d in days:
        v=vlev(d)
        if not all(k in v for k in ('VAH','VAL','POC')):
            print(f"  {d}: missing VA levels {list(v)}"); continue
        if v['VAH']-v['VAL'] > MAX_VA_WIDTH:
            print(f"  {d}: skip — prior VA width {v['VAH']-v['VAL']:.0f}pt > {MAX_VA_WIDTH:.0f}"); continue
        trs=rth(d)
        if not trs: continue
        for r in fade_day(trs, v['VAH'], v['VAL'], v['POC'], ms(d,ENTRY_CUTOFF)):
            r['date']=d; allr.append(r)
    W=sum(1 for r in allr if r['res']=='WIN'); L=sum(1 for r in allr if r['res']=='LOSE')
    O=sum(1 for r in allr if r['res']=='OPEN'); dec=W+L
    wr=(W/dec*100) if dec else 0
    win_pts=sum(r['reward'] for r in allr if r['res']=='WIN')
    loss_pts=sum(r['risk'] for r in allr if r['res']=='LOSE')
    ev=((win_pts-loss_pts)/dec) if dec else 0
    avgR = (sum(r['reward'] for r in allr)/sum(r['risk'] for r in allr)) if sum(r['risk'] for r in allr) else 0
    print(f"\n===== {tag}: Archetype A balance-fade (VA->POC) "
          f"[acc_dist={ACCEPT_DIST:.0f} rej_t={REJECT_TIME/1000:.0f}s stopbuf={STOP_BUF:.0f}] =====")
    print(f"trades={len(allr)}  WIN={W} LOSE={L} OPEN={O}  WR={wr:.0f}%  avgR/R={avgR:.2f}  EV={ev:+.1f}pt  netMNQ=${ev*dec*2:+.0f}")
    for ext in ('VAH','VAL'):
        rr=[r for r in allr if r['ext']==ext]; w=sum(1 for r in rr if r['res']=='WIN'); l=sum(1 for r in rr if r['res']=='LOSE')
        de=w+l; print(f"  {ext}: n={len(rr):2d} W={w} L={l} O={sum(1 for r in rr if r['res']=='OPEN')} WR={((w/de*100) if de else 0):.0f}%")
    return allr

if __name__=="__main__":
    which=sys.argv[1] if len(sys.argv)>1 else "train"
    allr=run(TRAIN if which!="test" else TEST, which.upper())
    print(f"  {'date':11} {'t':9} {'ext':4} {'side':5} {'epx':>9} {'depth':>5} {'tbey':>4} {'risk':>5} {'rew':>5} {'res':>5}")
    for r in allr:
        print(f"  {r['date']:11} {r['t']:9} {r['ext']:4} {r['side']:5} {r['epx']:9.2f} {r['depth']:5.1f} {r['tbeyond']:4d} {r['risk']:5.1f} {r['reward']:5.1f} {r['res']:>5}")
