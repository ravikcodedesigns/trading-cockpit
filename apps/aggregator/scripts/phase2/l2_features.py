#!/usr/bin/env python3
"""
Phase 2 L2 feature extractor — ticks.db (trades + L2 depth), ALL days.

Discovery runs on TRAIN days only. NO LOOKAHEAD: anchor = approach extreme
(closest approach for fades / level-cross for breakouts) within the labeled
window; every feature uses data with ts <= anchor. Outcome = user's hand label.

Run:  python3 apps/aggregator/scripts/phase2/l2_features.py
"""
import sqlite3, datetime as dt, os, statistics as st

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
DB = os.path.join(ROOT, "data", "ticks.db")
SYM = "NQ"; ET = 4; K = 6.0
WIN = 60_000; BOOK_LB = 180_000; BAND = 20.0
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)

def ms(date, hhmmss):
    d = dt.datetime.strptime(f"{date} {hhmmss}", "%Y-%m-%d %H:%M:%S") + dt.timedelta(hours=ET)
    return int(d.replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
def et(v): return (dt.datetime.utcfromtimestamp(v/1000) - dt.timedelta(hours=ET)).strftime("%H:%M:%S")
def open0930(date): return ms(date, "09:30:00")

def trades(t0, t1):
    return con.execute("SELECT ts,price,size,is_bid_aggressor FROM trades WHERE symbol=? AND ts>=? AND ts<=? ORDER BY ts",
                       (SYM, t0, t1)).fetchall()

def anchor(date, level, direction, setup, lo, hi):
    rows = trades(ms(date, lo), ms(date, hi))
    if not rows: return None
    if setup == "breakout":
        for ts, p, *_ in rows:
            if direction == "long" and p >= level: return ts, p
            if direction == "short" and p <= level: return ts, p
        return None
    best = min(rows, key=lambda r: abs(r[1] - level))
    return best[0], best[1]

def book_near(date, level, t):
    """defend/bid/ask resting size within 2pt of level as of t (last BOOK_LB ms)."""
    rows = con.execute("""
       WITH d AS (SELECT price, side, size,
            row_number() OVER (PARTITION BY price, side ORDER BY ts DESC) rn
          FROM depth WHERE symbol=? AND ts BETWEEN ? AND ? AND price BETWEEN ? AND ?)
       SELECT price, side, size FROM d WHERE rn=1 AND size>0""",
       (SYM, t - BOOK_LB, t, level - 2.0, level + 2.0)).fetchall()
    bid = sum(s for p, sd, s in rows if sd == 0 and abs(p - level) <= 2.0)
    ask = sum(s for p, sd, s in rows if sd == 1 and abs(p - level) <= 2.0)
    return bid, ask

def prior_touches(date, level, t):
    o = open0930(date)
    rows = con.execute("SELECT price FROM trades WHERE symbol=? AND ts>=? AND ts<? ", (SYM, o, t)).fetchall()
    # count distinct ~minute touches within 3pt
    n = 0; prev = False
    for (p,) in rows:
        near = abs(p - level) <= 3.0
        if near and not prev: n += 1
        prev = near
    return n

def crossings(date, level, t, lookback=1_800_000):
    """# of times price crossed the level in [t-lookback, t] (local whipsaw/chop)."""
    rows = con.execute("SELECT price FROM trades WHERE symbol=? AND ts>=? AND ts<? ORDER BY ts",
                       (SYM, t - lookback, t)).fetchall()
    n = 0; side = None
    for (p,) in rows:
        s = p >= level
        if side is not None and s != side: n += 1
        side = s
    return n

def feat(date, ev):
    level, direction, setup = ev["level"], ev["dir"], ev["setup"]
    a = anchor(date, level, direction, setup, ev["lo"], ev["hi"])
    if not a: return None
    am, ap = a
    t0 = am - WIN
    rows = trades(t0, am)
    if len(rows) < 5: return None
    px0 = rows[0][1]; vol = sum(r[2] for r in rows)
    cvd = sum((r[2] if r[3] else -r[2]) for r in rows)  # inferred
    ret = ap - px0
    bid, ask = book_near(date, level, am)
    bid0, ask0 = book_near(date, level, t0)
    defend = "bid" if ((setup == "fade" and direction == "long") or (setup == "breakout" and direction == "short")) else "ask"
    defN = bid if defend == "bid" else ask
    defN0 = bid0 if defend == "bid" else ask0
    bookd = defN - defN0  # >0 stacking, <0 pulling
    imb = bid / (bid + ask) if (bid + ask) else 0.5
    # regime / context
    o = open0930(date); orow = trades(o, o + 1000)
    op = orow[0][1] if orow else px0
    day = trades(o, am)
    trend = ap - op
    rng = (max(r[1] for r in day) - min(r[1] for r in day)) if day else 0
    tod = int((am - o) / 60000)
    pt = prior_touches(date, level, am - 2000)
    xc = crossings(date, level, am - 2000)
    # cvd aligned to trade direction (positive = flow WITH trade dir; exhaustion = negative)
    cvd_dir = cvd if direction == "long" else -cvd
    return dict(t=et(am), dist=ap - level, ret=ret, vol=vol, cvd=cvd, cvd_dir=cvd_dir,
                defend=defend, defN=defN, bookd=bookd, imb=imb, trend=trend, rng=rng,
                tod=tod, pt=pt, xc=xc, out=ev["out"], lbl=ev["lbl"], dir=direction, setup=setup)

# ── TRAIN labeled events (validated against tape). FLAGGED items excluded. ──
E = {
 "2026-05-08": [dict(lbl="PDH long",level=28945,dir="long",setup="fade",lo="09:40:00",hi="09:42:00",out="WIN")],
 "2026-05-12": [dict(lbl="PDL short rej",level=29247,dir="short",setup="fade",lo="09:52:00",hi="09:54:00",out="WIN")],
 "2026-05-14": [
   dict(lbl="POC/PDC long",level=29480,dir="long",setup="fade",lo="09:29:00",hi="09:31:00",out="WIN"),
   dict(lbl="PDH fail",level=29565.25,dir="short",setup="fade",lo="09:58:00",hi="10:01:00",out="LOSE"),
 ],
 "2026-05-18": [
   dict(lbl="POC break dn",level=29320,dir="short",setup="breakout",lo="09:31:00",hi="09:33:00",out="WIN"),
   dict(lbl="POC rej",level=29320,dir="short",setup="fade",lo="09:55:00",hi="09:57:00",out="WIN"),
   dict(lbl="PDL break dn",level=29089.5,dir="short",setup="breakout",lo="10:32:00",hi="10:34:00",out="WIN"),
   dict(lbl="PDL rej",level=29089.5,dir="short",setup="fade",lo="10:42:00",hi="10:44:00",out="WIN"),
   dict(lbl="PDL rej",level=29089.5,dir="short",setup="fade",lo="10:52:00",hi="10:54:00",out="LOSE"),
   dict(lbl="PDL rej",level=29089.5,dir="short",setup="fade",lo="10:59:00",hi="11:01:00",out="WIN"),
   dict(lbl="PDL rej",level=29089.5,dir="short",setup="fade",lo="11:11:00",hi="11:13:00",out="WIN"),
   dict(lbl="PDL rej",level=29089.5,dir="short",setup="fade",lo="11:37:00",hi="11:39:00",out="LOSE"),
   dict(lbl="PDL rej",level=29089.5,dir="short",setup="fade",lo="12:20:00",hi="12:22:00",out="WIN"),
   dict(lbl="PDL rej",level=29089.5,dir="short",setup="fade",lo="12:52:00",hi="12:54:00",out="LOSE"),
   dict(lbl="PDL rej",level=29089.5,dir="short",setup="fade",lo="13:05:00",hi="13:08:00",out="LOSE"),
   dict(lbl="PDL rej",level=29089.5,dir="short",setup="fade",lo="13:09:00",hi="13:12:00",out="LOSE"),
   dict(lbl="PDL rej",level=29089.5,dir="short",setup="fade",lo="13:42:00",hi="13:45:00",out="LOSE"),
   dict(lbl="PDL rej",level=29089.5,dir="short",setup="fade",lo="15:01:00",hi="15:03:00",out="WIN"),
 ],
 "2026-05-20": [
   dict(lbl="PDH chop",level=29126.25,dir="long",setup="fade",lo="09:31:00",hi="09:35:00",out="LOSE"),
   dict(lbl="PDH chop",level=29126.25,dir="long",setup="fade",lo="09:41:00",hi="09:54:00",out="LOSE"),
   dict(lbl="PDH rej",level=29126.25,dir="short",setup="fade",lo="10:00:00",hi="10:02:00",out="WIN"),
   dict(lbl="PDH retest",level=29126.25,dir="long",setup="fade",lo="10:24:00",hi="10:26:00",out="WIN"),
 ],
 "2026-05-27": [
   dict(lbl="PDH break dn",level=30119,dir="short",setup="breakout",lo="09:34:00",hi="09:36:00",out="WIN"),
   dict(lbl="VAH fade",level=30062.5,dir="long",setup="fade",lo="09:37:00",hi="09:39:00",out="LOSE"),
   dict(lbl="POC break up",level=30000,dir="long",setup="breakout",lo="09:44:00",hi="09:46:00",out="LOSE"),
   dict(lbl="VAL long",level=29933,dir="long",setup="fade",lo="09:46:00",hi="09:48:00",out="WIN"),
   dict(lbl="POC long",level=30000,dir="long",setup="fade",lo="09:55:00",hi="09:57:00",out="WIN"),
   dict(lbl="PDC short",level=30079,dir="short",setup="fade",lo="10:02:00",hi="10:04:00",out="WIN"),
   dict(lbl="POC fail",level=30000,dir="long",setup="fade",lo="10:11:00",hi="10:13:00",out="LOSE"),
   dict(lbl="POC short",level=30000,dir="short",setup="fade",lo="10:19:00",hi="10:21:00",out="WIN"),
   dict(lbl="chop",level=30000,dir="long",setup="fade",lo="10:39:00",hi="10:55:00",out="LOSE"),
   dict(lbl="VAL chop",level=29933,dir="long",setup="fade",lo="10:57:00",hi="12:05:00",out="LOSE"),
   dict(lbl="VAL long",level=29933,dir="long",setup="fade",lo="12:05:00",hi="12:07:00",out="WIN"),
   dict(lbl="POC break dn",level=30000,dir="short",setup="breakout",lo="12:55:00",hi="12:57:00",out="WIN"),
   dict(lbl="POC break up",level=30000,dir="long",setup="breakout",lo="14:16:00",hi="14:18:00",out="WIN"),
 ],
 "2026-05-29": [
   dict(lbl="PDH long",level=30342,dir="long",setup="fade",lo="10:25:00",hi="10:27:00",out="WIN"),
   dict(lbl="POC long",level=30306.75,dir="long",setup="fade",lo="10:49:00",hi="10:51:00",out="WIN"),
   dict(lbl="POC fail",level=30306.75,dir="long",setup="fade",lo="11:19:00",hi="11:21:00",out="LOSE"),
   dict(lbl="chop",level=30306.75,dir="long",setup="fade",lo="12:20:00",hi="12:40:00",out="LOSE"),
   dict(lbl="POC long",level=30306.75,dir="long",setup="fade",lo="13:59:00",hi="14:01:00",out="WIN"),
   dict(lbl="POC long",level=30306.75,dir="long",setup="fade",lo="14:57:00",hi="14:59:00",out="WIN"),
 ],
 "2026-06-02": [dict(lbl="POC long",level=30430,dir="long",setup="fade",lo="09:40:00",hi="09:42:00",out="WIN")],
 "2026-06-04": [dict(lbl="PDL break up",level=30495.5,dir="long",setup="breakout",lo="13:23:00",hi="13:27:00",out="WIN")],
 "2026-06-08": [
   dict(lbl="POC touch",level=29432,dir="long",setup="fade",lo="09:33:00",hi="09:34:00",out="LOSE"),
   dict(lbl="POC touch",level=29432,dir="long",setup="fade",lo="09:39:00",hi="09:41:00",out="LOSE"),
   dict(lbl="POC touch",level=29432,dir="long",setup="fade",lo="09:50:00",hi="09:51:00",out="LOSE"),
   dict(lbl="POC touch",level=29432,dir="short",setup="fade",lo="09:56:00",hi="09:58:00",out="LOSE"),
   dict(lbl="POC touch",level=29432,dir="long",setup="fade",lo="10:02:00",hi="10:03:00",out="LOSE"),
   dict(lbl="POC touch",level=29432,dir="long",setup="fade",lo="10:14:00",hi="10:15:00",out="LOSE"),
 ],
 "2026-06-10": [
   dict(lbl="POC break up",level=28860,dir="long",setup="breakout",lo="09:34:30",hi="09:36:00",out="WIN"),
   dict(lbl="POC retest",level=28860,dir="long",setup="fade",lo="09:41:00",hi="09:42:00",out="WIN"),
   dict(lbl="PDC chop",level=29116.25,dir="short",setup="fade",lo="09:48:00",hi="09:49:30",out="LOSE"),
   dict(lbl="PDC chop",level=29116.25,dir="short",setup="fade",lo="10:10:00",hi="10:12:00",out="LOSE"),
   dict(lbl="PDC chop",level=29116.25,dir="short",setup="fade",lo="10:33:00",hi="10:35:00",out="LOSE"),
   dict(lbl="PDC break dn",level=29116.25,dir="short",setup="breakout",lo="10:43:30",hi="10:45:00",out="WIN"),
   dict(lbl="POC break dn",level=28860,dir="short",setup="breakout",lo="11:06:00",hi="11:09:00",out="WIN"),
   dict(lbl="POC reject",level=28860,dir="short",setup="fade",lo="11:24:00",hi="11:26:00",out="WIN"),
   dict(lbl="POC reject",level=28860,dir="short",setup="fade",lo="11:44:00",hi="11:47:00",out="WIN"),
   dict(lbl="POC reject",level=28860,dir="short",setup="fade",lo="11:58:00",hi="12:00:30",out="WIN"),
   dict(lbl="POC rej miss",level=28860,dir="short",setup="fade",lo="12:36:00",hi="12:38:00",out="WIN"),
   dict(lbl="POC rej miss",level=28860,dir="short",setup="fade",lo="14:03:00",hi="14:05:00",out="WIN"),
 ],
}

rows_out = []
hdr = f"{'date':10} {'time':8} {'lbl':14} {'out':4} {'dir':5} {'set':8} {'dist':>6} {'ret':>6} {'cvdDir':>7} {'def':>3} {'defN':>6} {'bookΔ':>6} {'imb':>4} {'trend':>6} {'rng':>5} {'tod':>4} {'pt':>3}"
print(hdr); print("-"*len(hdr))
for date, evs in E.items():
    for ev in evs:
        f = feat(date, ev)
        if not f: print(f"{date} (no data) {ev['lbl']}"); continue
        rows_out.append(f)
        print(f"{date:10} {f['t']:8} {f['lbl'][:14]:14} {f['out']:4} {f['dir']:5} {f['setup']:8} "
              f"{f['dist']:+6.1f} {f['ret']:+6.1f} {f['cvd_dir']:+7d} {f['defend']:>3} {f['defN']:6d} "
              f"{f['bookd']:+6d} {f['imb']:.2f} {f['trend']:+6.0f} {f['rng']:5.0f} {f['tod']:4d} {f['pt']:3d}")

# ── win vs lose comparison ──
def summ(rows, key):
    w = [r[key] for r in rows if r['out'] == 'WIN']
    l = [r[key] for r in rows if r['out'] == 'LOSE']
    return st.median(w), st.median(l)
print("\n=== WIN vs LOSE medians (TRAIN) ===")
nW = sum(1 for r in rows_out if r['out']=='WIN'); nL = sum(1 for r in rows_out if r['out']=='LOSE')
print(f"n: WIN={nW} LOSE={nL}")
for k in ['dist','ret','cvd_dir','defN','bookd','imb','trend','rng','tod','pt','xc']:
    mw, ml = summ(rows_out, k)
    print(f"  {k:8}  WIN={mw:+9.2f}   LOSE={ml:+9.2f}")

# crossings detail: win/lose split by local chop
print("\n=== local level-crossings (prior 30min) by outcome ===")
for lab, lo, hi in [("calm (xc<=8)",0,8),("med (9-20)",9,20),("chop (>20)",21,9999)]:
    w=sum(1 for r in rows_out if r['out']=='WIN' and lo<=r['xc']<=hi)
    l=sum(1 for r in rows_out if r['out']=='LOSE' and lo<=r['xc']<=hi)
    tot=w+l; wr=(w/tot*100) if tot else 0
    print(f"  {lab:14} W={w:2d} L={l:2d}  WR={wr:4.0f}%")
