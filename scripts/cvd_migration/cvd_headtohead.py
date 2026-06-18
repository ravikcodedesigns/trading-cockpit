#!/usr/bin/env python3
"""
cvd_headtohead.py — does TRUE (MBO) CVD separate winners from losers better
than the INFERRED (live, ticks) CVD at the trigger points?

SANDBOX / read-only. Reads trading.db (signals) + mbo-parquet (true tape).
Writes nothing, touches no live code/data.

For every June NQ clean-impulse / cont-reentry trigger (ALL actions, incl.
SKIP_CVD — the ones the inferred gate rejected):
  - inferred CVD  = tradable_signals.cvd_session (what the live gate used)
  - true CVD      = SUM(signed size) from MBO true aggressor, 09:30 ET -> trigger
  - outcome       = tick-accurate walk-forward on the MBO tape (TP/SL per rule),
                    RTH close 15:54 ET -> DRAW (mark to close). WIN/LOSS only,
                    never MFE/MAE.
Then: for each direction, compare how cleanly each CVD splits W from L
(mean/median by class, and rank-AUC of "CVD predicts win").
"""

from datetime import datetime, timezone
from pathlib import Path
import sqlite3

import duckdb
import numpy as np

REPO = Path.home() / "trading-cockpit"
MBO = REPO / "data" / "mbo-parquet"
DB = REPO / "data" / "trading.db"

TPSL = {  # (tp, sl) points
    ("clean-impulse", "long"): (80, 55),
    ("clean-impulse", "short"): (80, 105),
    ("cont-reentry", "long"): (80, 70),
    ("cont-reentry", "short"): (80, 70),
}


def et_ms(date, hh, mm):
    y, m, d = map(int, date.split("-"))
    # EDT = UTC-4 for June
    return int(datetime(y, m, d, hh + 4, mm, tzinfo=timezone.utc).timestamp() * 1000)


def load_signals():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    rows = con.execute("""
        SELECT signal_ts, rule_id, direction, action, entry, cvd_session
        FROM tradable_signals
        WHERE symbol='NQ' AND rule_id IN ('clean-impulse','cont-reentry')
          AND signal_ts >= strftime('%s','2026-06-01')*1000
          AND entry IS NOT NULL
        ORDER BY signal_ts""").fetchall()
    con.close()
    return rows


def day_tape(con, date):
    g = f"{MBO}/trades/symbol=NQ/date={date}/*.parquet"
    d = con.execute(
        f"SELECT ts_ms, price, size, is_bid_aggressor FROM read_parquet('{g}') "
        f"WHERE price IS NOT NULL AND size IS NOT NULL ORDER BY ts_ms").fetchnumpy()
    ts = d["ts_ms"]
    px = d["price"].astype(float)
    sz = d["size"].astype(float)
    sign = np.where(d["is_bid_aggressor"], sz, -sz)
    cum = np.cumsum(sign)
    return ts, px, cum


def walk_forward(ts, px, entry_idx, entry, direction, tp, sl, close_ms):
    """First touch of TP or SL after entry, else DRAW marked to close price."""
    sl_idx = np.searchsorted(ts, close_ms, side="right")
    seg = slice(entry_idx, sl_idx)
    p = px[seg]
    if len(p) == 0:
        return "DRAW", 0.0
    if direction == "long":
        tp_lvl, sl_lvl = entry + tp, entry - sl
        tp_hit = np.argmax(p >= tp_lvl) if (p >= tp_lvl).any() else None
        sl_hit = np.argmax(p <= sl_lvl) if (p <= sl_lvl).any() else None
    else:
        tp_lvl, sl_lvl = entry - tp, entry + sl
        tp_hit = np.argmax(p <= tp_lvl) if (p <= tp_lvl).any() else None
        sl_hit = np.argmax(p >= sl_lvl) if (p >= sl_lvl).any() else None
    if tp_hit is None and sl_hit is None:
        close_px = p[-1]
        pnl = (close_px - entry) if direction == "long" else (entry - close_px)
        return "DRAW", float(pnl)
    if sl_hit is None or (tp_hit is not None and tp_hit <= sl_hit):
        return "WIN", float(tp)
    return "LOSS", float(-sl)


def auc(pos, neg):
    """P(random winner's CVD > random loser's CVD). 0.5 = no separation."""
    if not pos or not neg:
        return float("nan")
    pos, neg = np.array(pos), np.array(neg)
    wins = sum((pos > n).sum() + 0.5 * (pos == n).sum() for n in neg)
    return wins / (len(pos) * len(neg))


def main():
    con = duckdb.connect(); con.execute("PRAGMA threads=4")
    sigs = load_signals()
    # group by ET date
    by_date = {}
    for r in sigs:
        date = datetime.fromtimestamp(r["signal_ts"] / 1000, timezone.utc).astimezone(
            timezone.utc).strftime("%Y-%m-%d")
        # convert to ET date (UTC-4)
        date = datetime.fromtimestamp(r["signal_ts"] / 1000 - 4 * 3600, timezone.utc).strftime("%Y-%m-%d")
        by_date.setdefault(date, []).append(r)

    recs = []
    for date in sorted(by_date):
        gpath = MBO / "trades" / "symbol=NQ" / f"date={date}"
        if not gpath.exists():
            print(f"  (skip {date}: no MBO tape)")
            continue
        ts, px, cum = day_tape(con, date)
        open_ms = et_ms(date, 9, 30)
        close_ms = et_ms(date, 15, 54)
        oi = np.searchsorted(ts, open_ms, side="left")
        cum_open = cum[oi - 1] if oi > 0 else 0.0
        for r in by_date[date]:
            tp, sl = TPSL[(r["rule_id"], r["direction"])]
            sig_ms = r["signal_ts"]
            si = np.searchsorted(ts, sig_ms, side="right") - 1
            if si < 0:
                continue
            true_cvd = float(cum[si] - cum_open)
            ei = np.searchsorted(ts, sig_ms, side="right")
            outcome, pnl = walk_forward(ts, px, ei, r["entry"], r["direction"], tp, sl, close_ms)
            recs.append({
                "date": date, "rule": r["rule_id"], "dir": r["direction"],
                "action": r["action"], "inferred": r["cvd_session"], "true": true_cvd,
                "outcome": outcome, "pnl": pnl,
            })

    # ── report ──
    print(f"\n=== CVD head-to-head — {len(recs)} June NQ flip/cont triggers ===\n")
    for direction in ("long", "short"):
        d = [x for x in recs if x["dir"] == direction and x["outcome"] in ("WIN", "LOSS")]
        if not d:
            continue
        W = [x for x in d if x["outcome"] == "WIN"]
        L = [x for x in d if x["outcome"] == "LOSS"]
        print(f"── {direction.upper()}  (resolved {len(d)}: {len(W)}W / {len(L)}L) ──")
        for src in ("inferred", "true"):
            wv = [x[src] for x in W if x[src] is not None]
            lv = [x[src] for x in L if x[src] is not None]
            if not wv or not lv:
                print(f"   {src:9}: insufficient ({len(wv)}W/{len(lv)}L have value)"); continue
            a = auc(wv, lv)
            print(f"   {src:9}: WIN med={np.median(wv):+8.0f}  LOSS med={np.median(lv):+8.0f}"
                  f"   AUC={a:.3f}  (sep={'higher-CVD wins' if a>0.5 else 'lower-CVD wins' if a<0.5 else 'none'})")
        print()

    # confusion vs the live gate (longs only — that's what cvdLongFloor gates)
    print("── live cvdLongFloor=-1000 vs TRUE CVD (longs) ──")
    longs = [x for x in recs if x["dir"] == "long" and x["outcome"] in ("WIN", "LOSS")
             and x["inferred"] is not None]
    for label, lo, hi in [("inf<-1000 (gate SKIPS)", None, -1000), ("inf>=-1000 (gate OPENS)", -1000, None)]:
        grp = [x for x in longs if (hi is None or x["inferred"] < hi) and (lo is None or x["inferred"] >= lo)]
        if grp:
            w = sum(1 for x in grp if x["outcome"] == "WIN")
            tw = sum(1 for x in grp if x["true"] >= -1000)
            print(f"   {label:26} n={len(grp):2}  WR={100*w/len(grp):4.0f}%  "
                  f"(of these, {tw} have TRUE CVD>=-1000)")

    # Does a TRUE-CVD gate add value ON TOP of the inferred gate?  Take the longs
    # the inferred gate already OPENS, then split by true CVD.
    print("\n── among inferred-OPENED longs (inf>=-1000), split by TRUE CVD ──")
    opened = [x for x in longs if x["inferred"] >= -1000]
    for thr in (-1000, -3000, -5000):
        keep = [x for x in opened if x["true"] >= thr]
        drop = [x for x in opened if x["true"] < thr]
        kw = sum(1 for x in keep if x["outcome"] == "WIN")
        dw = sum(1 for x in drop if x["outcome"] == "WIN")
        kp = sum(x["pnl"] for x in keep); dp = sum(x["pnl"] for x in drop)
        print(f"   true>= {thr:>6}: KEEP n={len(keep):2} WR={100*kw/max(1,len(keep)):3.0f}% pnl={kp:+7.0f}pt"
              f"   |  DROP n={len(drop):2} WR={100*dw/max(1,len(drop)):3.0f}% pnl={dp:+7.0f}pt")

    # Pure TRUE-CVD long gate sweep (rank-based threshold on true scale)
    print("\n── ALL resolved longs: WR/pnl above a TRUE-CVD floor ──")
    alllong = [x for x in longs]
    base_w = sum(1 for x in alllong if x["outcome"] == "WIN"); base_p = sum(x["pnl"] for x in alllong)
    print(f"   baseline (no gate): n={len(alllong)} WR={100*base_w/len(alllong):.0f}% pnl={base_p:+.0f}pt")
    for thr in (-1000, -3000, -5000, -8000):
        keep = [x for x in alllong if x["true"] >= thr]
        w = sum(1 for x in keep if x["outcome"] == "WIN"); p = sum(x["pnl"] for x in keep)
        print(f"   true>= {thr:>6}: n={len(keep):2} WR={100*w/max(1,len(keep)):3.0f}% pnl={p:+7.0f}pt "
              f"(cuts {len(alllong)-len(keep)})")


if __name__ == "__main__":
    main()
