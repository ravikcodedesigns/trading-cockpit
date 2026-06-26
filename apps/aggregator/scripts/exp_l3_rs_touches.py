#!/usr/bin/env python3
# RS-level touch experiment, tick-by-tick, exact-ms touch detection (RS levels ONLY,
# no structural). L2+L3 book reconstructed event-by-event up to the exact touch ms
# (no lookahead). At the touch: L3 read -> short/long decision -> walk forward 30 min
# -> direction-adjusted max gain / max loss (in points for the chosen direction).
#
#   scripts/.venv-mbo/bin/python apps/aggregator/scripts/exp_l3_rs_touches.py
import duckdb

# ---- per-day config (RS levels only) ----
DAY = "2026-06-17"
MID = 1781668800000               # 2026-06-17 00:00:00 ET in ms
RS_LEVELS = {"MHP": 29890.6, "HP": 29993.3}

ROOT = "data/mbo-parquet"; SYM = "NQ"; TICK = 0.25
def gp(t): return f"'{ROOT}/{t}/symbol={SYM}/date={DAY}/*.parquet'"
def et(off_h): return MID + int(off_h * 3600000)
WIN_LO = et(9.5)     # 09:30 ET
WIN_HI = et(16.0)    # 16:00 ET — detect touches across the RTH session
FWD_MS = 30 * 60000  # 30-min forward walk (per request)
TOUCH_TICKS = 2; REARM_TICKS = 8; WALL_TICKS = 4
def pi(p): return round(p / TICK)
LV = {k: pi(v) for k, v in RS_LEVELS.items()}
con = duckdb.connect()

# ---- decision rule (at the touch, no lookahead) ----
# Default = FADE the RS level (the framework premise: levels bounce):
#   approach from above -> level=support -> LONG ;  from below -> resistance -> SHORT.
# BREAK override: if the defending wall is thin AND aggressive flow + CVD strongly
#   push through the level, trade the break instead.
def decide(from_above, wall, cvd60, tbuy, tsell):
    if from_above:                       # support test, defenders = bids
        if wall < 10 and cvd60 < -150 and tsell > 2 * max(1, tbuy) and tsell > 20:
            return "SHORT", "break-down (thin bid + sellers + CVD60 neg)"
        return "LONG", "fade (support holds)"
    else:                                # resistance test, defenders = asks
        if wall < 10 and cvd60 > 150 and tbuy > 2 * max(1, tsell) and tbuy > 20:
            return "LONG", "break-up (thin ask + buyers + CVD60 pos)"
        return "SHORT", "fade (resistance holds)"

# ---- merged ordered event stream ----
q = f"""
SELECT ts_ms,'DEP' src,CAST(NULL AS VARCHAR) oid,price_int pi,size sz,is_bid bid,0.0 px
  FROM read_parquet({gp('depth')}) WHERE ts_ms<={WIN_HI}
UNION ALL SELECT ts_ms,action src,order_id oid,price_int pi,size sz,is_bid bid,0.0 px
  FROM read_parquet({gp('mbo')}) WHERE ts_ms<={WIN_HI}
UNION ALL SELECT ts_ms,'T' src,passive_order_id oid,price_int pi,size sz,is_bid_aggressor bid,price px
  FROM read_parquet({gp('trades')}) WHERE size>0 AND ts_ms<={WIN_HI}
ORDER BY ts_ms"""
cur = con.execute(q)

bidSize = {}; askSize = {}; orders = {}; maxDisp = {}; cumFill = {}; replUp = set()
def best_bid(): return max(bidSize) if bidSize else None
def best_ask(): return min(askSize) if askSize else None
def wall_near(lp, side):
    m = bidSize if side == "bid" else askSize
    return sum(s for p, s in m.items() if abs(p - lp) <= WALL_TICKS)
def l3_ice(lp, side):
    want = (side == "bid"); l3 = 0; ice = []
    for oid, (p, s, b) in orders.items():
        if b != want or abs(p - lp) > WALL_TICKS: continue
        l3 += s
        if cumFill.get(oid, 0) > maxDisp.get(oid, 0) or oid in replUp:
            ice.append((oid, cumFill.get(oid, 0), maxDisp.get(oid, 0), s))
    return l3, ice

armed = {k: True for k in RS_LEVELS}; last_px = None; touches = []
while True:
    rows = cur.fetchmany(200000)
    if not rows: break
    for ts, src, oid, p, sz, bid, px in rows:
        if src == "DEP":
            m = bidSize if bid else askSize
            if sz and sz > 0: m[p] = sz
            else: m.pop(p, None)
        elif src == "send":
            orders[oid] = [p, sz, bid]; maxDisp[oid] = sz; cumFill[oid] = 0
        elif src == "replace":
            o = orders.get(oid)
            if o is not None:
                if sz > o[1]: replUp.add(oid)
                o[0] = p; o[1] = sz
                if sz > maxDisp.get(oid, 0): maxDisp[oid] = sz
        elif src == "cancel":
            orders.pop(oid, None); maxDisp.pop(oid, None); cumFill.pop(oid, None); replUp.discard(oid)
        elif src == "T":
            cpx = px
            if oid and oid in orders:
                cumFill[oid] = cumFill.get(oid, 0) + sz
                o = orders[oid]; o[1] -= sz
                if o[1] <= 0:
                    orders.pop(oid, None); maxDisp.pop(oid, None); cumFill.pop(oid, None); replUp.discard(oid)
            if WIN_LO <= ts <= WIN_HI and last_px is not None:
                for k, lp in LV.items():
                    dist = abs(cpx - RS_LEVELS[k]) / TICK
                    if armed[k] and dist <= TOUCH_TICKS:
                        fa = last_px > RS_LEVELS[k]
                        side = "bid" if fa else "ask"
                        wall = wall_near(lp, side); l3, ice = l3_ice(lp, side)
                        touches.append(dict(ts=ts, lvl=k, lp=RS_LEVELS[k], fa=fa, side=side, px=cpx,
                                            wall=wall, l3=l3, gap=max(0, wall - l3),
                                            iceN=len(ice), iceCF=sum(i[1] for i in ice)))
                        armed[k] = False
                    elif not armed[k] and dist >= REARM_TICKS:
                        armed[k] = True
            last_px = cpx

# ---- post: CVD, tape, forward (direction-adjusted) ----
GT = gp("trades")
def cvd_to(ts):
    return con.execute(f"SELECT COALESCE(SUM(CASE WHEN is_bid_aggressor THEN size ELSE -size END),0) FROM read_parquet({GT}) WHERE size>0 AND ts_ms BETWEEN {WIN_LO} AND {ts}").fetchone()[0]
def cvd_win(ts, ms=60000):
    return con.execute(f"SELECT COALESCE(SUM(CASE WHEN is_bid_aggressor THEN size ELSE -size END),0) FROM read_parquet({GT}) WHERE size>0 AND ts_ms BETWEEN {ts-ms} AND {ts}").fetchone()[0]
def tape(ts, lvl, ms=30000):
    return con.execute(f"""SELECT COALESCE(SUM(CASE WHEN is_bid_aggressor THEN size ELSE 0 END),0),
        COALESCE(SUM(CASE WHEN NOT is_bid_aggressor THEN size ELSE 0 END),0)
        FROM read_parquet({GT}) WHERE size>0 AND ts_ms BETWEEN {ts-ms} AND {ts} AND price BETWEEN {lvl-1.0} AND {lvl+1.0}""").fetchone()
def fwd(ts):
    r = con.execute(f"SELECT MIN(price),MAX(price) FROM read_parquet({GT}) WHERE size>0 AND ts_ms BETWEEN {ts} AND {ts+FWD_MS}").fetchone()
    last = con.execute(f"SELECT price FROM read_parquet({GT}) WHERE size>0 AND ts_ms<={ts+FWD_MS} ORDER BY ts_ms DESC LIMIT 1").fetchone()[0]
    return r[0], r[1], last

def hhmmss(ts):
    s = (ts - MID) // 1000; return f"{s//3600:02d}:{(s%3600)//60:02d}:{s%60:02d}.{(ts-MID)%1000:03d}"

# collapse to one touch per RS level per visit (>=120s)
last = {}; keep = []
for t in touches:
    if t["lvl"] not in last or t["ts"] - last[t["lvl"]] >= 120000:
        keep.append(t); last[t["lvl"]] = t["ts"]

print(f"{DAY} — RS levels {RS_LEVELS} — {len(touches)} raw touches -> {len(keep)} visits\n")
print(f"{'time(ms)':>13} {'lvl':>4} {'appr':>6} {'px':>9} | {'wall':>4} {'l3':>4} {'gap':>3} {'ice':>3} {'cvd':>6} {'c60':>5} {'tBuy':>4} {'tSel':>4} | {'CALL':>5} | {'gain':>6} {'loss':>6} {'net':>6} | reason")
for t in keep:
    ts = t["ts"]; entry = t["px"]
    c = cvd_to(ts); c60 = cvd_win(ts); tb, tsl = tape(ts, t["lp"])
    lo, hi, lastp = fwd(ts)
    call, reason = decide(t["fa"], t["wall"], c60, tb, tsl)
    if call == "LONG":
        gain = round(hi - entry, 2); loss = round(lo - entry, 2); net = round(lastp - entry, 2)
    else:
        gain = round(entry - lo, 2); loss = round(entry - hi, 2); net = round(entry - lastp, 2)
    print(f"{hhmmss(ts):>13} {t['lvl']:>4} {'above' if t['fa'] else 'below':>6} {entry:>9.2f} | "
          f"{t['wall']:>4} {t['l3']:>4} {t['gap']:>3} {t['iceN']:>3} {c:>6} {c60:>5} {tb:>4} {tsl:>4} | "
          f"{call:>5} | {gain:>6} {loss:>6} {net:>6} | {reason}")
