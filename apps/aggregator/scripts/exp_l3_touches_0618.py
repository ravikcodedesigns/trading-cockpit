#!/usr/bin/env python3
# Experiment: event-driven RS-level TOUCH detection on 2026-06-18 NQ (full-size NQU6),
# L2+L3 book reconstructed event-by-event up to the EXACT touch ts (no lookahead),
# read the mechanics at the touched level, then walk forward from that same ts.
#
# Touch = price enters within TOUCH_TICKS of a level after being >REARM_TICKS away.
# At the touch instant: defend side, L2 wall, L3 size, implied gap, live icebergs,
# 30s tape, CVD. Forward: max favorable / max adverse excursion in the 20 min after.
import duckdb

ROOT = "data/mbo-parquet"
SYM = "NQ"; DAY = "2026-06-18"
TICK = 0.25
def gp(t): return f"'{ROOT}/{t}/symbol={SYM}/date={DAY}/*.parquet'"
con = duckdb.connect()

MID = 1781755200000  # 2026-06-18 00:00:00 ET in ms (verified against data)
def et(off_h): return MID + int(off_h * 3600000)
WIN_LO = et(9.5)      # 09:30 ET — start touch detection at RTH open
WIN_HI = et(12.0)     # 12:00 ET — end detection (his window runs to 11:52)
FWD_MS = 20 * 60000   # 20 min forward walk

# --- 06-18 NQ levels (crucial + key structural near the day's range) ---
LEVELS = {
    "MHP": 30611.1, "ONH/PMH": 30612.5, "QQQ Open": 30594.5, "PDH": 30544.75,
    "LVN_dn": 30527.25, "VAH": 30522, "EM+1s": 30508.68, "onVAH": 30479,
    "POC": 30450, "HP/DDup": 30403.6, "onPOC": 30400, "HVN2": 30624, "IBH": 30643,
}
TOUCH_TICKS = 2     # within 0.5 pt = a touch
REARM_TICKS = 8     # must move 2.0 pt away to re-arm a level
WALL_TICKS = 4      # ±1.0 pt for wall depth

def pi(p): return round(p / TICK)
LV = {k: pi(v) for k, v in LEVELS.items()}

# ---- merged ordered event stream (depth + mbo + trades), 00:00 .. WIN_HI ----
q = f"""
SELECT ts_ms, 'DEP' src, CAST(NULL AS VARCHAR) oid, price_int pi, size sz, is_bid bid, 0 px
  FROM read_parquet({gp('depth')}) WHERE ts_ms <= {WIN_HI}
UNION ALL
SELECT ts_ms, action src, order_id oid, price_int pi, size sz, is_bid bid, 0 px
  FROM read_parquet({gp('mbo')}) WHERE ts_ms <= {WIN_HI}
UNION ALL
SELECT ts_ms, 'T' src, passive_order_id oid, price_int pi, size sz, is_bid_aggressor bid, price px
  FROM read_parquet({gp('trades')}) WHERE size > 0 AND ts_ms <= {WIN_HI}
ORDER BY ts_ms
"""
cur = con.execute(q)

# book state
bidSize = {}; askSize = {}            # L2 price_int -> size
orders = {}                            # oid -> [pi, sz, bid]
maxDisp = {}; cumFill = {}; replUp = set()

def best_bid():
    return max(bidSize) if bidSize else None
def best_ask():
    return min(askSize) if askSize else None

def wall_near(level_pi, side):
    m = bidSize if side == "bid" else askSize
    sz = sum(s for p, s in m.items() if abs(p - level_pi) <= WALL_TICKS)
    return sz

def l3_and_ice(level_pi, side):
    """active L3 size + iceberg orders within ±WALL_TICKS on the defend side."""
    want_bid = (side == "bid")
    l3 = 0; ice = []
    for oid, (p, s, b) in orders.items():
        if b != want_bid: continue
        if abs(p - level_pi) > WALL_TICKS: continue
        l3 += s
        cf = cumFill.get(oid, 0)
        if cf > maxDisp.get(oid, 0) or oid in replUp:
            ice.append((oid, cf, maxDisp.get(oid, 0), s))
    return l3, ice

# touch detector state
armed = {k: True for k in LEVELS}      # ready to register a touch
last_px = None
touches = []                            # list of dicts

BATCH = 200000
while True:
    rows = cur.fetchmany(BATCH)
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
            cur_px = px
            # passive fill bookkeeping
            if oid and oid in orders:
                cumFill[oid] = cumFill.get(oid, 0) + sz
                o = orders[oid]; o[1] -= sz
                if o[1] <= 0:
                    orders.pop(oid, None); maxDisp.pop(oid, None); cumFill.pop(oid, None); replUp.discard(oid)
            # --- touch detection (RTH window only) ---
            if WIN_LO <= ts <= WIN_HI and last_px is not None:
                for k, lp in LV.items():
                    dist = abs(cur_px - LEVELS[k]) / TICK
                    if armed[k] and dist <= TOUCH_TICKS:
                        # a touch fires
                        from_above = last_px > LEVELS[k]
                        # approach from above -> level is support -> bids defend; from below -> resistance -> asks defend
                        side = "bid" if from_above else "ask"
                        wall = wall_near(lp, side)
                        l3, ice = l3_and_ice(lp, side)
                        touches.append({
                            "ts": ts, "level": k, "lp": LEVELS[k], "approach": "from_above" if from_above else "from_below",
                            "defend": side, "px": cur_px, "bb": (best_bid() or 0) * TICK, "ba": (best_ask() or 0) * TICK,
                            "wall": wall, "l3": l3, "gap": max(0, wall - l3),
                            "ice_n": len(ice), "ice_cf": sum(i[1] for i in ice),
                            "ice_top": sorted(ice, key=lambda x: -x[1])[:3],
                        })
                        armed[k] = False
                    elif not armed[k] and dist >= REARM_TICKS:
                        armed[k] = True
            last_px = cur_px

print(f"detected {len(touches)} touch events 09:30-12:00 ET\n")

# ---- per-touch: CVD, tape, forward walk via duckdb ----
def hhmmss(ts):
    s = (ts - MID) // 1000
    return f"{s//3600:02d}:{(s%3600)//60:02d}:{s%60:02d}"

GT = gp("trades")
def cvd_to(ts):
    r = con.execute(f"SELECT COALESCE(SUM(CASE WHEN is_bid_aggressor THEN size ELSE -size END),0) FROM read_parquet({GT}) WHERE size>0 AND ts_ms BETWEEN {et(9.5)} AND {ts}").fetchone()
    return r[0]
def cvd_window(ts, ms=60000):
    r = con.execute(f"SELECT COALESCE(SUM(CASE WHEN is_bid_aggressor THEN size ELSE -size END),0) FROM read_parquet({GT}) WHERE size>0 AND ts_ms BETWEEN {ts-ms} AND {ts}").fetchone()
    return r[0]
def tape_near(ts, level, ms=30000):
    r = con.execute(f"""SELECT COALESCE(SUM(CASE WHEN is_bid_aggressor THEN size ELSE 0 END),0) buy,
                               COALESCE(SUM(CASE WHEN NOT is_bid_aggressor THEN size ELSE 0 END),0) sell,
                               COUNT(*) n
                        FROM read_parquet({GT}) WHERE size>0 AND ts_ms BETWEEN {ts-ms} AND {ts}
                          AND price BETWEEN {level-1.0} AND {level+1.0}""").fetchone()
    return r
def forward(ts, entry):
    r = con.execute(f"""SELECT MIN(price) lo, MAX(price) hi,
                               arg_min(price,price) , arg_max(price,price)
                        FROM read_parquet({GT}) WHERE size>0 AND ts_ms BETWEEN {ts} AND {ts+FWD_MS}""").fetchone()
    lo, hi = r[0], r[1]
    last = con.execute(f"SELECT price FROM read_parquet({GT}) WHERE size>0 AND ts_ms<={ts+FWD_MS} ORDER BY ts_ms DESC LIMIT 1").fetchone()[0]
    # time to hi / lo
    thi = con.execute(f"SELECT ts_ms FROM read_parquet({GT}) WHERE size>0 AND ts_ms BETWEEN {ts} AND {ts+FWD_MS} AND price={hi} ORDER BY ts_ms LIMIT 1").fetchone()
    tlo = con.execute(f"SELECT ts_ms FROM read_parquet({GT}) WHERE size>0 AND ts_ms BETWEEN {ts} AND {ts+FWD_MS} AND price={lo} ORDER BY ts_ms LIMIT 1").fetchone()
    return lo, hi, last, (thi[0] if thi else None), (tlo[0] if tlo else None)

print(f"{'time':>9} {'level':>9} {'appr':>10} {'def':>3} {'px':>9} | {'wall':>6} {'l3':>6} {'gap':>6} {'iceN':>4} {'iceCF':>6} | {'cvd':>7} {'cvd60':>6} {'tBuy':>5} {'tSell':>5} | {'up+':>6} {'dn-':>6} {'net':>6}")
for t in touches:
    ts = t["ts"]; entry = t["px"]
    cvd = cvd_to(ts); cvd60 = cvd_window(ts)
    tb, tsl, tn = tape_near(ts, t["lp"])
    lo, hi, last, thi, tlo = forward(ts, entry)
    up = round(hi - entry, 2); dn = round(lo - entry, 2); net = round(last - entry, 2)
    print(f"{hhmmss(ts):>9} {t['level']:>9} {t['approach']:>10} {t['defend']:>3} {entry:>9.2f} | "
          f"{t['wall']:>6} {t['l3']:>6} {t['gap']:>6} {t['ice_n']:>4} {t['ice_cf']:>6} | "
          f"{cvd:>7} {cvd60:>6} {tb:>5} {tsl:>5} | {up:>6} {dn:>6} {net:>6}")
    if t["ice_top"]:
        for oid, cf, md, s in t["ice_top"]:
            print(f"          iceberg oid={oid} cumFilled={cf} maxDisplayed={md} stillResting={s}")
