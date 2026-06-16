#!/usr/bin/env python3
"""
Phase 2 L3 feature extractor — June days only (parquet MBO store).

NO LOOKAHEAD: for each labeled level-interaction we anchor at the approach
extreme (the tick of closest approach for fades / the level-cross for breakouts)
within the labeled window, and compute ALL features from data with ts <= anchor.
The forward outcome is the user's hand label (pos/neg); we additionally measure
the realized move strictly AFTER the entry (anchor + 6pt confirmation) for
reference, reported as signed points (not MFE/MAE).

Run:  scripts/.venv-mbo/bin/python apps/aggregator/scripts/phase2/l3_features.py
"""
import duckdb, datetime as dt, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
PQ = os.path.join(ROOT, "data", "mbo-parquet")
ET = 4  # UTC-4
K = 6.0           # confirmation displacement (pts)
WIN_MS = 60_000   # pre-anchor flow window
BOOK_LB = 300_000 # book-snapshot lookback
BAND = 20.0       # price band around level for book/flow (pts)
TICK = 0.25

con = duckdb.connect()

def ms(date, hhmmss):
    d = dt.datetime.strptime(f"{date} {hhmmss}", "%Y-%m-%d %H:%M:%S") + dt.timedelta(hours=ET)
    return int(d.replace(tzinfo=dt.timezone.utc).timestamp() * 1000)

def et(msv):
    return (dt.datetime.utcfromtimestamp(msv/1000) - dt.timedelta(hours=ET)).strftime("%H:%M:%S")

def trades_g(date): return f"{PQ}/trades/symbol=NQ/date={date}/*.parquet"
def depth_g(date):  return f"{PQ}/depth/symbol=NQ/date={date}/*.parquet"
def mbo_g(date):    return f"{PQ}/mbo/symbol=NQ/date={date}/*.parquet"

def load_trades(date, t0, t1):
    return con.execute(
        f"SELECT ts_ms, price, size, is_bid_aggressor FROM read_parquet('{trades_g(date)}') "
        f"WHERE ts_ms BETWEEN ? AND ? ORDER BY ts_ms", [t0, t1]).fetchall()

def resolve_anchor(date, level, direction, setup, t_lo, t_hi):
    """Return (anchor_ms, anchor_price, min_dist_signed). direction long/short."""
    rows = load_trades(date, t_lo, t_hi)
    if not rows: return None
    if setup == "breakout":
        # first tick crossing level by >=0 in trade direction
        for ts, p, *_ in rows:
            if direction == "long" and p >= level:  return ts, p, p - level
            if direction == "short" and p <= level: return ts, p, p - level
        return None
    # fade: closest approach to level (the turning extreme)
    best = min(rows, key=lambda r: abs(r[1] - level))
    return best[0], best[1], best[1] - level

def resolve_entry(date, anchor_ms, anchor_px, direction, t_hi):
    """anchor + K-pt confirmation in trade direction. Returns (entry_ms, entry_px) or None."""
    rows = load_trades(date, anchor_ms, t_hi)
    ref = anchor_px
    for ts, p, *_ in rows:
        if direction == "long":
            ref = min(ref, p)
            if p - ref >= K: return ts, p
        else:
            ref = max(ref, p)
            if ref - p >= K: return ts, p
    return None

def flow_near(date, level, is_bid_def, t0, t1):
    """Resting-liquidity flow on the defend side within +-2pt of level in [t0,t1].
    send size is direct; cancel size is attributed via order_id -> last send/replace
    state (cancel events carry only order_id). Returns (send_sz, cancel_sz, n_cancel)."""
    lo, hi = level - 2.0, level + 2.0
    send_sz = con.execute(
        f"SELECT COALESCE(SUM(size),0) FROM read_parquet('{mbo_g(date)}') "
        f"WHERE action='send' AND is_bid=? AND ts_ms BETWEEN ? AND ? AND price BETWEEN ? AND ?",
        [is_bid_def, t0, t1, lo, hi]).fetchone()[0]
    # cancels in window -> attribute price/side from the order's establishing send + last price
    row = con.execute(f"""
        WITH cx AS (
          SELECT order_id, ts_ms cts FROM read_parquet('{mbo_g(date)}')
          WHERE action='cancel' AND ts_ms BETWEEN ? AND ?),
        sr AS (
          SELECT order_id, ts_ms, action, price, is_bid, size
          FROM read_parquet('{mbo_g(date)}')
          WHERE action IN ('send','replace') AND ts_ms <= ?
            AND order_id IN (SELECT order_id FROM cx)),
        st AS (
          SELECT order_id,
                 arg_max(price, ts_ms) AS px,
                 arg_max(size, ts_ms)  AS sz,
                 any_value(is_bid) FILTER (WHERE action='send') AS is_bid
          FROM sr GROUP BY order_id)
        SELECT COALESCE(SUM(sz),0), COUNT(*)
        FROM cx JOIN st USING(order_id)
        WHERE st.is_bid=? AND st.px BETWEEN ? AND ?
    """, [t0, t1, t1, is_bid_def, lo, hi]).fetchone()
    return int(send_sz), int(row[0]), int(row[1])

def book_snapshot(date, level, t):
    """Latest resting size per price in band, as of t (last BOOK_LB ms). Returns dict."""
    rows = con.execute(f"""
        WITH d AS (
          SELECT price, is_bid, size, ts_ms,
                 row_number() OVER (PARTITION BY price_int, is_bid ORDER BY ts_ms DESC) rn
          FROM read_parquet('{depth_g(date)}')
          WHERE ts_ms BETWEEN ? AND ? AND price BETWEEN ? AND ?)
        SELECT price, is_bid, size FROM d WHERE rn=1 AND size>0
    """, [t - BOOK_LB, t, level - BAND, level + BAND]).fetchall()
    bid = {p: s for p, b, s in rows if b}
    ask = {p: s for p, b, s in rows if not b}
    return bid, ask

def features(date, ev):
    level, direction, setup = ev["level"], ev["dir"], ev["setup"]
    a = resolve_anchor(date, level, direction, setup, ms(date, ev["lo"]), ms(date, ev["hi"]))
    if not a: return None
    anchor_ms, anchor_px, mindist = a
    t0 = anchor_ms - WIN_MS
    # --- price action (pre-anchor window) ---
    rows = load_trades(date, t0, anchor_ms)
    if len(rows) < 5: return None
    px0 = rows[0][1]; vol = sum(r[2] for r in rows)
    hi = max(r[1] for r in rows); lo = min(r[1] for r in rows)
    ret_pre = anchor_px - px0
    # definitive CVD (signed by aggressor) in window
    cvd = sum((r[2] if r[3] else -r[2]) for r in rows)
    # absorption: aggressive vol at level band vs displacement there
    # --- L3 book snapshot at anchor (defending side) ---
    bid, ask = book_snapshot(date, level, anchor_ms)
    near = lambda d: {p: s for p, s in d.items() if abs(p - level) <= 2.0}
    bid_near = sum(near(bid).values()); ask_near = sum(near(ask).values())
    bid_band = sum(bid.values()); ask_band = sum(ask.values())
    # defending side: support(long off level from above / breakout up)=bid; resistance=ask
    # For a fade, defender is the side the price is bouncing off:
    if setup == "fade":
        defend = "bid" if direction == "long" else "ask"
    else:  # breakout: the side being broken THROUGH is the opposite of continuation
        defend = "ask" if direction == "long" else "bid"
    defend_near = bid_near if defend == "bid" else ask_near
    # --- L3 order-flow in window near level (stacking vs pulling on defend side) ---
    is_bid_def = (defend == "bid")
    send_sz, cancel_sz, n_cancel = flow_near(date, level, is_bid_def, t0, anchor_ms)
    net_liq = send_sz - cancel_sz  # >0 stacking/defending, <0 pulling/abandoning
    tot = send_sz + cancel_sz
    pull = (cancel_sz / tot) if tot else 0.0  # fraction of activity that is pulling
    # entry (anchor + K confirmation) for reference timing only (no excursion / no MFE)
    e = resolve_entry(date, anchor_ms, anchor_px, direction, ms(date, ev["hi"]) + 1_800_000)
    return dict(t=et(anchor_ms), dist=mindist, ret=ret_pre, vol=vol, cvd=cvd,
                defend=defend, defN=defend_near, bidN=bid_near, askN=ask_near,
                send=send_sz, cancel=cancel_sz, netliq=net_liq, pull=pull,
                entry=(et(e[0]) if e else "-"), outcome=ev["out"], lbl=ev["lbl"])

# ── validated labeled events (June L3 days) ──
EVENTS = {
 "2026-06-02": [
   dict(lbl="POC long fade", level=30430, dir="long", setup="fade", lo="09:40:00", hi="09:42:00", out="WIN"),
 ],
 "2026-06-04": [
   dict(lbl="PDL breakout up", level=30495.5, dir="long", setup="breakout", lo="13:23:00", hi="13:27:00", out="WIN"),
 ],
 "2026-06-08": [   # POC chop — all losers
   dict(lbl="POC touch", level=29432, dir="long", setup="fade", lo="09:33:00", hi="09:34:00", out="LOSE"),
   dict(lbl="POC touch", level=29432, dir="long", setup="fade", lo="09:39:00", hi="09:41:00", out="LOSE"),
   dict(lbl="POC touch", level=29432, dir="long", setup="fade", lo="09:50:00", hi="09:51:00", out="LOSE"),
   dict(lbl="POC touch", level=29432, dir="short",setup="fade", lo="09:56:00", hi="09:58:00", out="LOSE"),
   dict(lbl="POC touch", level=29432, dir="long", setup="fade", lo="10:02:00", hi="10:03:00", out="LOSE"),
   dict(lbl="POC touch", level=29432, dir="long", setup="fade", lo="10:14:00", hi="10:15:00", out="LOSE"),
 ],
 "2026-06-10": [
   dict(lbl="POC breakout up", level=28860, dir="long", setup="breakout", lo="09:34:30", hi="09:36:00", out="WIN"),
   dict(lbl="POC retest", level=28860, dir="long", setup="fade", lo="09:41:00", hi="09:42:00", out="WIN"),
   dict(lbl="PDC touch (chop)", level=29116.25, dir="short", setup="fade", lo="09:48:00", hi="09:49:30", out="LOSE"),
   dict(lbl="PDC touch (chop)", level=29116.25, dir="short", setup="fade", lo="10:10:00", hi="10:12:00", out="LOSE"),
   dict(lbl="PDC touch (chop)", level=29116.25, dir="short", setup="fade", lo="10:33:00", hi="10:35:00", out="LOSE"),
   dict(lbl="PDC breakout down", level=29116.25, dir="short", setup="breakout", lo="10:43:30", hi="10:45:00", out="WIN"),
   dict(lbl="POC breakout down", level=28860, dir="short", setup="breakout", lo="11:06:00", hi="11:09:00", out="WIN"),
   dict(lbl="POC reject", level=28860, dir="short", setup="fade", lo="11:24:00", hi="11:26:00", out="WIN"),
   dict(lbl="POC reject", level=28860, dir="short", setup="fade", lo="11:44:00", hi="11:47:00", out="WIN"),
   dict(lbl="POC reject", level=28860, dir="short", setup="fade", lo="11:58:00", hi="12:00:30", out="WIN"),
   dict(lbl="POC reject(miss)", level=28860, dir="short", setup="fade", lo="12:36:00", hi="12:38:00", out="WIN"),
   dict(lbl="POC reject(miss)", level=28860, dir="short", setup="fade", lo="14:03:00", hi="14:05:00", out="WIN"),
 ],
}

hdr = f"{'date':10} {'time':8} {'label':18} {'out':5} {'dir':5} {'set':8} {'dist':>6} {'ret':>6} {'vol':>7} {'cvd':>7} {'def':>4} {'defN':>6} {'send':>7} {'cancel':>7} {'netliq':>8} {'pull%':>5}"
print(hdr); print("-"*len(hdr))
for date, evs in EVENTS.items():
    for ev in evs:
        f = features(date, ev)
        if not f:
            print(f"{date:10} (no data) {ev['lbl']}"); continue
        print(f"{date:10} {f['t']:8} {f['lbl'][:18]:18} {f['outcome']:5} {ev['dir']:5} {ev['setup']:8} "
              f"{f['dist']:+6.1f} {f['ret']:+6.1f} {f['vol']:7d} {f['cvd']:+7d} {f['defend']:>4} {f['defN']:6d} "
              f"{f['send']:7d} {f['cancel']:7d} {f['netliq']:+8d} {f['pull']*100:5.0f}")
