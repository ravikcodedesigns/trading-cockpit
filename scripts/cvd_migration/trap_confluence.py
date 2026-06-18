#!/usr/bin/env python3
"""Can trap be a CONFLUENCE/VETO filter for flips & conts? Tag each NQ flip/cont
tradable with trap context (same-dir / opp-dir trap within 30m before entry),
compare WR/PnL. Walk-forward TP/SL per rule, RTH 15:54 close -> DRAW. SANDBOX.
Small-sample exploratory — report counts prominently."""
import json, sqlite3
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict

REPO = Path.home() / "trading-cockpit"
tdb = sqlite3.connect(f"file:{REPO/'data'/'trading.db'}?mode=ro", uri=True)
xdb = sqlite3.connect(f"file:{REPO/'data'/'ticks.db'}?mode=ro", uri=True)
WIN = 30 * 60_000  # trap lookback before entry
TPSL = {"clean-impulse": {"tp": 80, "long": 55, "short": 105},
        "cont-reentry":  {"tp": 80, "long": 70, "short": 70}}

def load(rule):
    out = []
    for ts, payload in tdb.execute("SELECT ts,payload FROM signals WHERE rule_id=? AND symbol='NQ' ORDER BY ts",(rule,)):
        p = json.loads(payload); e, d = p.get("entry"), p.get("direction")
        if e is None or d is None: continue
        out.append((ts, d, e))
    return out

traps = [(ts, json.loads(pl).get("direction")) for ts, pl in
         tdb.execute("SELECT ts,payload FROM signals WHERE rule_id='trap' AND symbol='NQ' ORDER BY ts")]

def rth_close(ts):
    dt = datetime.fromtimestamp(ts/1000-4*3600, timezone.utc)
    return int(datetime(dt.year, dt.month, dt.day, 19, 54, tzinfo=timezone.utc).timestamp()*1000)

def walk(ts, d, entry, tp, sl):
    close = rth_close(ts)
    if ts >= close: return None
    rows = [r[0] for r in xdb.execute("SELECT price FROM trades WHERE symbol='NQ' AND ts>=? AND ts<? ORDER BY ts",(ts,close))]
    if not rows: return None
    last = entry; tpL, slL = (entry+tp, entry-sl) if d=="long" else (entry-tp, entry+sl)
    for px in rows:
        last = px
        if d=="long":
            if px<=slL: return ("L",-sl)
            if px>=tpL: return ("W",tp)
        else:
            if px>=slL: return ("L",-sl)
            if px<=tpL: return ("W",tp)
    return ("D",(last-entry) if d=="long" else (entry-last))

def trap_ctx(ts, d):
    near = [td for tt, td in traps if ts-WIN <= tt <= ts]
    if any(td == d for td in near): return "same"
    if any(td != d for td in near): return "opp"
    return "none"

def show(rule):
    sigs = load(rule)
    buckets = defaultdict(lambda: {"W":0,"L":0,"D":0,"pnl":0.0})
    for ts, d, e in sigs:
        ps = TPSL[rule]; r = walk(ts, d, e, ps["tp"], ps[d])
        if r is None: continue
        ctx = trap_ctx(ts, d)
        for key in (("ALL",), (ctx,), (ctx, d)):
            b = buckets["|".join(key)]; b[r[0]] += 1; b["pnl"] += r[1]
    print(f"\n=== {rule} (NQ) — trap context within {WIN//60000}m before entry ===")
    print(f"  {'bucket':16}{'W/L/D':>10}{'WR':>6}{'net pts':>9}{'$ (MNQ)':>10}")
    def line(name, key):
        b = buckets.get(key)
        if not b: return
        n=b["W"]+b["L"]+b["D"]; wr=100*b["W"]/(b["W"]+b["L"]) if (b["W"]+b["L"]) else 0
        if n==0: return
        print(f"  {name:16}{f'{b[chr(87)]}/{b[chr(76)]}/{b[chr(68)]}':>10}{wr:>5.0f}%{b['pnl']:>+9.0f}{b['pnl']*2:>+10.0f}")
    line("ALL","ALL")
    for ctx in ("same","opp","none"):
        line(f"trap {ctx}", ctx)
        for d in ("long","short"): line(f"  {ctx} {d}", f"{ctx}|{d}")

for rule in ("clean-impulse","cont-reentry"):
    show(rule)
