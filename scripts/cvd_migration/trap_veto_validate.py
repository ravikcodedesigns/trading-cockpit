#!/usr/bin/env python3
"""Validate the FLIP veto: skip flips when a SAME-direction trap fired within 30m
before entry. Train/test (May/June) + permutation (does the trap flag identify
losing flips better than a random flag of equal size?). NQ. SANDBOX read-only."""
import json, sqlite3
from datetime import datetime, timezone
from pathlib import Path
import numpy as np

REPO = Path.home() / "trading-cockpit"
tdb = sqlite3.connect(f"file:{REPO/'data'/'trading.db'}?mode=ro", uri=True)
xdb = sqlite3.connect(f"file:{REPO/'data'/'ticks.db'}?mode=ro", uri=True)
rng = np.random.default_rng(20260618)
WIN = 30 * 60_000
TP, SL = 80, {"long": 55, "short": 105}

flips = []
for ts, payload in tdb.execute("SELECT ts,payload FROM signals WHERE rule_id='clean-impulse' AND symbol='NQ' ORDER BY ts"):
    p = json.loads(payload); e, d = p.get("entry"), p.get("direction")
    if e is None or d is None: continue
    flips.append((ts, d, e))
traps = [(ts, json.loads(pl).get("direction")) for ts, pl in
         tdb.execute("SELECT ts,payload FROM signals WHERE rule_id='trap' AND symbol='NQ' ORDER BY ts")]

def rth_close(ts):
    dt = datetime.fromtimestamp(ts/1000-4*3600, timezone.utc)
    return int(datetime(dt.year, dt.month, dt.day, 19, 54, tzinfo=timezone.utc).timestamp()*1000)

def walk(ts, d, entry):
    close = rth_close(ts)
    if ts >= close: return None
    rows = [r[0] for r in xdb.execute("SELECT price FROM trades WHERE symbol='NQ' AND ts>=? AND ts<? ORDER BY ts",(ts,close))]
    if not rows: return None
    sl = SL[d]; last = entry; tpL, slL = (entry+TP, entry-sl) if d=="long" else (entry-TP, entry+sl)
    for px in rows:
        last = px
        if d=="long":
            if px<=slL: return ("L", -sl)
            if px>=tpL: return ("W", TP)
        else:
            if px>=slL: return ("L", -sl)
            if px<=tpL: return ("W", TP)
    return ("D", (last-entry) if d=="long" else (entry-last))

recs = []
for ts, d, e in flips:
    r = walk(ts, d, e)
    if r is None: continue
    near = [td for tt, td in traps if ts-WIN <= tt <= ts]
    same = any(td == d for td in near)
    anyt = len(near) > 0
    mo = "MAY" if datetime.fromtimestamp(ts/1000-4*3600, timezone.utc).month == 5 else "JUN"
    recs.append({"o": r[0], "pnl": r[1], "same": same, "any": anyt, "mo": mo})

def stat(rs):
    w = sum(1 for r in rs if r["o"]=="W"); l = sum(1 for r in rs if r["o"]=="L")
    d = sum(1 for r in rs if r["o"]=="D"); pnl = sum(r["pnl"] for r in rs)
    wr = 100*w/(w+l) if (w+l) else 0
    return len(rs), w, l, d, wr, pnl

print(f"=== FLIP veto validation (NQ, {len(recs)} resolved flips) ===\n")
for flag, name in [("same","SAME-dir trap veto"), ("any","ANY trap veto")]:
    print(f"── {name} ──")
    print(f"  {'set':22}{'n':>4}{'W/L/D':>10}{'WR':>6}{'net pts':>9}")
    for label, sub in [("baseline (all flips)", recs),
                       ("VETOED book (kept)", [r for r in recs if not r[flag]]),
                       ("dropped (flagged)", [r for r in recs if r[flag]])]:
        n,w,l,dd,wr,pnl = stat(sub)
        print(f"  {label:22}{n:>4}{f'{w}/{l}/{dd}':>10}{wr:>5.0f}%{pnl:>+9.0f}")
    # train/test
    print(f"  train/test (kept book):")
    for mo in ("MAY","JUN"):
        base = [r for r in recs if r["mo"]==mo]; kept = [r for r in base if not r[flag]]
        nb,_,_,_,wb,pb = stat(base); nk,_,_,_,wk,pk = stat(kept)
        print(f"    {mo}: baseline n={nb} WR={wb:.0f}% pnl={pb:+.0f}  →  vetoed n={nk} WR={wk:.0f}% pnl={pk:+.0f}")
    # permutation: does the flag pick losers better than a random flag of same size?
    flagged = [r for r in recs if r[flag]]
    nf = len(flagged); obs_wr = stat(flagged)[4]; obs_pnl = stat(flagged)[5]
    res = [r for r in recs]; B = 10000; lew = lep = 0
    pnls = np.array([r["pnl"] for r in res]); wins = np.array([1 if r["o"]=="W" else (0 if r["o"]=="L" else -1) for r in res])
    idx = np.arange(len(res))
    for _ in range(B):
        s = rng.choice(idx, nf, replace=False)
        wl = wins[s][wins[s]>=0]
        rwr = 100*wl.mean() if len(wl) else 0
        rpnl = pnls[s].sum()
        if rwr <= obs_wr: lew += 1
        if rpnl <= obs_pnl: lep += 1
    print(f"  permutation ({B}x, random flag of n={nf}): flagged WR={obs_wr:.0f}% p={ (lew+1)/(B+1):.4f}  |  "
          f"flagged pnl={obs_pnl:+.0f} p={(lep+1)/(B+1):.4f}\n")
