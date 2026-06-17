#!/usr/bin/env python3
"""
detect.py — failed-auction setups: two distinct variants + walk-forward.

REVFROM (reverse-FROM the failed extreme): a sharp impulse (>=IMPULSE_PTS in
  IMPULSE_WIN) runs into a recent extreme, then rolls over (>=REJECT_PTS off it)
  while the driving aggression flips hard (EXHAUST_WIN delta crosses opposite by
  >=EXHAUST_MIN). Fade the failed push, away from the extreme. Fixed TP/SL.
  Self-rearms when the impulse dissipates (range < REARM_PTS).

REVTO (revert-TO the unaccepted void): from the developing 1-pt volume profile,
  find a low-volume node (LVN, vol <= LVN_FRAC x local median) = a price the
  market skipped/rejected. When price is STRETCHED away from that void (at a
  recent extreme on the far side) and short-window flow flips back toward it,
  enter toward the void. TARGET = the void price itself (magnet); SL fixed beyond
  the extension. Self-rearms when price reaches the void or a new void forms.

Causal (only data <= decision tick). WIN=target hit first, LOSS=stop first,
OPEN=15:54 mark-to-close. $=MNQ $2/pt. Read-only over ticks-parquet.
"""

import argparse
import bisect
import statistics
from collections import deque, defaultdict
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import duckdb
from book_reconstruct import Book, TICKS_PARQUET  # noqa: E402

ET = ZoneInfo("America/New_York")
USD_PER_PT = 2.0
RTH_OPEN, RTH_CLOSE = "09:30", "15:54"
EVAL_MS = 250
MIN_SPACING_MS = 20_000

# REVFROM
IMPULSE_PTS, IMPULSE_WIN_MS = 12.0, 30_000
EXTREME_RECENT_MS, REJECT_PTS = 8_000, 3.0
EXHAUST_WIN_MS, EXHAUST_MIN, REARM_PTS = 10_000, 150, 6.0
RF_TP, RF_SL = 60.0, 30.0          # fixed bracket from entry

# REVTO
PROFILE_WARMUP_MS = 30 * 60_000      # let the developing profile build to ~10:00
VICINITY = 20                        # ±pt for local median
LVN_FRAC = 0.25                      # void bin <= this x local median
MIN_DIST, MAX_DIST = 6.0, 25.0       # void must be this far (and reachable)
EXT_TOL = 2.0                        # price within this of the far-side 30s extreme
RT_BUF = 4.0                         # stop = just beyond the stretch extreme (tight); TP = void price
RT_VOID_COOLDOWN_MS = 90_000         # don't re-fire toward the same void within this


def _ms(date, hm):
    y, m, d = map(int, date.split("-")); h, mi = map(int, hm.split(":"))
    return int(datetime(y, m, d, h, mi, tzinfo=ET).timestamp() * 1000)


def et_str(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).astimezone(ET).strftime("%Y-%m-%d %H:%M:%S")


def load(con, table, symbol, date, lo, hi, cols):
    g = f"{TICKS_PARQUET}/{table}/symbol={symbol}/date={date}/*.parquet"
    return con.execute(f"SELECT {cols} FROM read_parquet('{g}') WHERE ts>={lo} AND ts<{hi} ORDER BY ts").fetchnumpy()


def detect_day(symbol, date):
    con = duckdb.connect(); con.execute("PRAGMA threads=4")
    lo, hi = _ms(date, RTH_OPEN), _ms(date, RTH_CLOSE)
    d = load(con, "depth", symbol, date, lo - 60_000, hi, "ts, side, price, size")
    t = load(con, "trades", symbol, date, lo - 60_000, hi, "ts, price, size, is_bid_aggressor")
    dts, dsd, dpx, dsz = d["ts"].tolist(), d["side"].tolist(), d["price"].tolist(), d["size"].tolist()
    tts, tpx, tsz, tag = t["ts"].tolist(), t["price"].tolist(), t["size"].tolist(), t["is_bid_aggressor"].tolist()

    book = Book()
    pxw = deque(); flw = deque()
    vol = defaultdict(float)         # developing 1-pt volume profile (RTH)
    setups = []
    di, nd, nt = 0, len(dts), len(tts)
    next_eval = lo
    rf_arm_s = rf_arm_l = True
    last = {"revfrom": -10**12, "revto": -10**12}
    last_void_px, last_void_ts = None, -10**12

    for ti in range(nt):
        ts = tts[ti]
        while di < nd and dts[di] <= ts:
            book.apply(dsd[di], dpx[di], dsz[di]); di += 1
        if di % 200_000 == 0 and di:
            book.prune(tpx[ti], 60.0)
        price = tpx[ti]
        if ts >= lo:
            vol[round(price)] += tsz[ti]
        pxw.append((ts, price))
        while pxw and pxw[0][0] < ts - IMPULSE_WIN_MS:
            pxw.popleft()
        flw.append((ts, tsz[ti] if tag[ti] == 1 else -tsz[ti]))
        while flw and flw[0][0] < ts - EXHAUST_WIN_MS:
            flw.popleft()
        if ts < lo or ts < next_eval:
            continue
        next_eval = ts + EVAL_MS

        hi_p = lo_p = price; t_hi = t_lo = ts
        for (q, p) in pxw:
            if p > hi_p: hi_p, t_hi = p, q
            if p < lo_p: lo_p, t_lo = p, q
        rng = hi_p - lo_p
        ex10 = sum(s for (q, s) in flw if q >= ts - EXHAUST_WIN_MS)
        f5 = sum(s for (q, s) in flw if q >= ts - 5_000)

        # ── REVFROM ──
        if rng < REARM_PTS:
            rf_arm_s = rf_arm_l = True
        if ts - last["revfrom"] >= MIN_SPACING_MS:
            up = rng >= IMPULSE_PTS and t_hi > t_lo and (ts - t_hi) <= EXTREME_RECENT_MS
            dn = rng >= IMPULSE_PTS and t_lo > t_hi and (ts - t_lo) <= EXTREME_RECENT_MS
            if rf_arm_s and up and price <= hi_p - REJECT_PTS and ex10 <= -EXHAUST_MIN:
                setups.append(dict(variant="revfrom", direction="short", ts=ts, entry=price,
                                   target=price - RF_TP, stop=price + RF_SL))
                rf_arm_s = False; last["revfrom"] = ts
            elif rf_arm_l and dn and price >= lo_p + REJECT_PTS and ex10 >= EXHAUST_MIN:
                setups.append(dict(variant="revfrom", direction="long", ts=ts, entry=price,
                                   target=price + RF_TP, stop=price - RF_SL))
                rf_arm_l = False; last["revfrom"] = ts

        # ── REVTO ──
        if ts >= lo + PROFILE_WARMUP_MS and ts - last["revto"] >= MIN_SPACING_MS:
            b = round(price)
            local = [vol[k] for k in range(b - VICINITY, b + VICINITY + 1) if vol.get(k, 0) > 0]
            if len(local) >= 8:
                med = statistics.median(local)
                # nearest LVN void within reach
                best = None
                for dist in range(int(MIN_DIST), int(MAX_DIST) + 1):
                    for k in (b - dist, b + dist):
                        v = vol.get(k, 0)
                        if 0 < v <= LVN_FRAC * med:
                            best = k; break
                    if best is not None:
                        break
                if best is not None:
                    V = float(best)
                    fresh_void = not (last_void_px is not None and abs(V - last_void_px) < 1.0
                                      and ts - last_void_ts < RT_VOID_COOLDOWN_MS)
                    toward_short = V < price          # void below → short toward it
                    # stretched away from V (at far-side recent extreme) + flow flipping toward V,
                    # stop just beyond the stretch extreme (tight risk), target = the void
                    if fresh_void and toward_short and abs(price - hi_p) <= EXT_TOL and f5 < 0:
                        setups.append(dict(variant="revto", direction="short", ts=ts, entry=price,
                                           target=V, stop=hi_p + RT_BUF))
                        last["revto"] = ts; last_void_px, last_void_ts = V, ts
                    elif fresh_void and (not toward_short) and abs(price - lo_p) <= EXT_TOL and f5 > 0:
                        setups.append(dict(variant="revto", direction="long", ts=ts, entry=price,
                                           target=V, stop=lo_p - RT_BUF))
                        last["revto"] = ts; last_void_px, last_void_ts = V, ts

    return setups, (tts, tpx), hi


def walk(setups, trades, rth_close):
    tts, tpx = trades
    out = []
    for s in setups:
        d, entry, tgt, stp = s["direction"], s["entry"], s["target"], s["stop"]
        i = bisect.bisect_right(tts, s["ts"]); reason, cl = "OPEN", None
        while i < len(tts) and tts[i] <= rth_close:
            p = tpx[i]
            if d == "long":
                if p >= tgt: reason, cl = "WIN", tgt; break
                if p <= stp: reason, cl = "LOSS", stp; break
            else:
                if p <= tgt: reason, cl = "WIN", tgt; break
                if p >= stp: reason, cl = "LOSS", stp; break
            i += 1
        if reason == "OPEN":
            j = bisect.bisect_right(tts, rth_close) - 1
            cl = tpx[j] if j >= 0 else entry
        pnl = (cl - entry) if d == "long" else (entry - cl)
        out.append({**s, "reason": reason, "close": cl, "pnl": pnl})
    return out


def summarize(out, show=True):
    for variant in ("revfrom", "revto"):
        rows = [t for t in out if t["variant"] == variant]
        if not rows:
            print(f"\n{variant.upper()}: (no setups)"); continue
        W = sum(t["reason"] == "WIN" for t in rows); L = sum(t["reason"] == "LOSS" for t in rows)
        O = sum(t["reason"] == "OPEN" for t in rows); pnl = sum(t["pnl"] for t in rows)
        wr = f"{100*W/(W+L):.1f}%" if (W + L) else "—"
        print(f"\n{variant.upper()}: n={len(rows)}  WIN={W} LOSS={L} OPEN={O}  WR={wr}  PnL={pnl:+.1f}pts ${pnl*USD_PER_PT:+.0f}")
        if show:
            for t in rows:
                print(f"   {et_str(t['ts'])}  {t['direction']:5} entry={t['entry']:.2f} tgt={t['target']:.2f} {t['reason']:4} close={t['close']:.2f} pnl={t['pnl']:+.1f}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--symbol", default="NQ")
    ap.add_argument("--dates", nargs="+", required=True)
    ap.add_argument("--no-trades", action="store_true")
    args = ap.parse_args()
    out = []
    for date in args.dates:
        setups, trades, rth_close = detect_day(args.symbol, date)
        out += walk(setups, trades, rth_close)
    print(f"\n════ failed-auction (revfrom + revto) — {args.symbol} {','.join(args.dates)} ════")
    print(f"revfrom: impulse {IMPULSE_PTS}pt/{IMPULSE_WIN_MS//1000}s, reject {REJECT_PTS}, flip {EXHAUST_MIN}, TP/SL {RF_TP}/{RF_SL}")
    print(f"revto: LVN<={LVN_FRAC}xmed, dist {MIN_DIST}-{MAX_DIST}, target=void, stop=extreme+{RT_BUF}")
    summarize(out, show=not args.no_trades)


if __name__ == "__main__":
    main()
