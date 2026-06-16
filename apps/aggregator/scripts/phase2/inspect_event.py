#!/usr/bin/env python3
"""
Phase 2 event inspector — LABELING / LOCATING aid only (uses full-day info,
which is fine for locating a touch; feature extraction lives elsewhere and is
strictly pre-entry).

Prints 1-minute OHLCV bars built from ticks.db trades for a date/time window,
with the min distance of each bar's high/low to a set of named levels.

Usage:
  inspect_event.py YYYY-MM-DD HH:MM HH:MM LABEL:PRICE [LABEL:PRICE ...]
    (times are ET; window is inclusive of both minutes)
"""
import sqlite3, sys, datetime as dt, os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
DB = os.path.join(ROOT, "data", "ticks.db")
SYM = "NQ"
ET_OFFSET = 4  # EDT = UTC-4 for May/June 2026

def et_to_ms(date, hh, mm):
    d = dt.datetime.strptime(f"{date} {hh}:{mm}:00", "%Y-%m-%d %H:%M:%S")
    d = d + dt.timedelta(hours=ET_OFFSET)  # ET -> UTC
    return int(d.replace(tzinfo=dt.timezone.utc).timestamp() * 1000)

def main():
    date = sys.argv[1]
    sh, sm = sys.argv[2].split(":")
    eh, em = sys.argv[3].split(":")
    levels = []
    for a in sys.argv[4:]:
        lab, px = a.split(":")
        levels.append((lab, float(px)))
    s = et_to_ms(date, sh, sm)
    e = et_to_ms(date, eh, em) + 60000  # include end minute
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    rows = con.execute(
        "SELECT ts, price, size FROM trades WHERE symbol=? AND ts>=? AND ts<? ORDER BY ts",
        (SYM, s, e)).fetchall()
    if not rows:
        print("(no trades)"); return
    bars = {}
    for ts, price, size in rows:
        b = ts // 60000
        if b not in bars:
            bars[b] = {"o": price, "h": price, "l": price, "c": price, "v": 0}
        bb = bars[b]
        bb["h"] = max(bb["h"], price); bb["l"] = min(bb["l"], price)
        bb["c"] = price; bb["v"] += size
    lvtxt = "  ".join(f"{l}={p:g}" for l, p in levels)
    print(f"# {date} {SYM}  levels: {lvtxt}")
    print(f"{'time_ET':>9} {'open':>9} {'high':>9} {'low':>9} {'close':>9} {'vol':>7}  nearest-level(dist of H or L)")
    for b in sorted(bars):
        t = dt.datetime.utcfromtimestamp(b * 60) - dt.timedelta(hours=ET_OFFSET)
        bb = bars[b]
        # nearest level to the bar (min over H and L distances)
        best = None
        for lab, p in levels:
            dh = bb["h"] - p; dl = bb["l"] - p
            # signed distance of whichever extreme is closest to the level
            d = dh if abs(dh) < abs(dl) else dl
            if best is None or abs(d) < abs(best[1]):
                best = (lab, d)
        bt = f"{best[0]}{best[1]:+.2f}" if best else ""
        print(f"{t.strftime('%H:%M:%S'):>9} {bb['o']:>9g} {bb['h']:>9g} {bb['l']:>9g} {bb['c']:>9g} {bb['v']:>7d}  {bt}")

if __name__ == "__main__":
    main()
