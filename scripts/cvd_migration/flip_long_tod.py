#!/usr/bin/env python3
"""Flip-long tradables split by ET hour of signal trigger. Walk-forward TP80/SL55,
RTH 15:54 close -> DRAW. tradable_signals OPEN clean-impulse NQ long. SANDBOX.
Small per-hour samples — ToD filters overfit easily; descriptive only."""
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict

REPO = Path.home() / "trading-cockpit"
db = sqlite3.connect(f"file:{REPO/'data'/'trading.db'}?mode=ro", uri=True)
xdb = sqlite3.connect(f"file:{REPO/'data'/'ticks.db'}?mode=ro", uri=True)
TP, SL = 80, 55

longs = db.execute(
    "SELECT signal_ts, entry FROM tradable_signals "
    "WHERE action IN ('OPEN','SKIP_TRAP_VETO') AND rule_id='clean-impulse' AND symbol='NQ' "
    "AND direction='long' AND entry IS NOT NULL ORDER BY signal_ts").fetchall()

def et(ts): return datetime.fromtimestamp(ts/1000-4*3600, timezone.utc)
def rth_close(ts):
    d = et(ts); return int(datetime(d.year,d.month,d.day,19,54,tzinfo=timezone.utc).timestamp()*1000)
def walk(ts, entry):
    close = rth_close(ts)
    if ts >= close: return None
    rows = [r[0] for r in xdb.execute("SELECT price FROM trades WHERE symbol='NQ' AND ts>=? AND ts<? ORDER BY ts",(ts,close))]
    if not rows: return None
    last = entry
    for px in rows:
        last = px
        if px >= entry+TP: return ("W",TP)
        if px <= entry-SL: return ("L",-SL)
    return ("D", last-entry)

buckets = defaultdict(lambda: {"W":0,"L":0,"D":0,"pnl":0.0})
half = defaultdict(lambda: {"W":0,"L":0,"D":0,"pnl":0.0})
for ts, e in longs:
    r = walk(ts, e)
    if r is None: continue
    h = et(ts); hr = h.hour; hh = f"{h.hour:02d}:{'30' if h.minute>=30 else '00'}"
    for tgt, key in ((buckets, hr), (half, hh)):
        tgt[key][r[0]] += 1; tgt[key]["pnl"] += r[1]

def row(label, b):
    n = b["W"]+b["L"]+b["D"]; wr = 100*b["W"]/(b["W"]+b["L"]) if (b["W"]+b["L"]) else 0
    return f"  {label:8}{n:>4}{b['W']:>4}{b['L']:>4}{b['D']:>4}{wr:>6.0f}%{b['pnl']:>+9.0f}{b['pnl']*2:>+9.0f}"

tot = {"W":0,"L":0,"D":0,"pnl":0.0}
print(f"=== Flip-long tradables by ET HOUR (NQ, {sum(v['W']+v['L']+v['D'] for v in buckets.values())} resolved) ===")
print(f"  {'hour':8}{'n':>4}{'W':>4}{'L':>4}{'D':>4}{'WR':>7}{'netpts':>9}{'$MNQ':>9}")
for hr in sorted(buckets):
    print(row(f"{hr:02d}:00", buckets[hr]))
    for k in ("W","L","D"): tot[k]+=buckets[hr][k]
    tot["pnl"]+=buckets[hr]["pnl"]
print(row("TOTAL", tot))
print(f"\n=== half-hour buckets ===")
print(f"  {'slot':8}{'n':>4}{'W':>4}{'L':>4}{'D':>4}{'WR':>7}{'netpts':>9}{'$MNQ':>9}")
for hh in sorted(half):
    print(row(hh, half[hh]))
