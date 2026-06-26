"""
06-24 afternoon RS-engine replay — RULE-UPDATED per Ravi (2026-06-25).

New rules vs the prior replay:
  1. resOrange (MHP resilience) was NEGATIVE all afternoon -> EST engine does NOT fire an MHP long
     when resOrange < 0.  (MHP-broken / not-reclaimed also blocks longs: only allow MHP long after a
     1m candle CLOSES above MHP. Moot here since resOrange<0 already vetoes it.)
  2. ONE position at a time. Once a signal opens a position, ALL subsequent signals (same or other
     engine) are ignored until it resolves to WIN/LOSS. Next signal is taken only after the close.
  3. MHP-broken: no long until price has come back and CLOSED above MHP (1m close).
  4. Volatility stop: SL distance = range (high-low) of the LARGEST 1m candle in the TRAILING 60min
     as of entry (causal). Long stop = entry - SLdist. TP unchanged = +40 pts.

Feed: data/ticks.db `trades` (NQ). NEVER cross-reference mbo-parquet by timestamp.
"""
import sqlite3, datetime as dt

DB = "data/ticks.db"
SYM = "NQ"
PROX = 40 / 5            # est-engine proximity = strike/5 = 8 pts
TP = 40.0
ET = dt.timezone(dt.timedelta(hours=-4))   # EDT

def ms(y,mo,d,h,mi,s=0):
    return int(dt.datetime(y,mo,d,h,mi,s,tzinfo=ET).timestamp()*1000)

# 06-24 MarketState (reconstructed; levels exact). resOrange<0 all afternoon.
MHP      = 29395.1
DD_LOWER = 29486.56
BZB      = [29748.2, 29956.0]
BRZT     = [29706.7, 29914.4]

LONG_LEVELS = []
for b in BZB:  LONG_LEVELS.append(("BZB", b))
for b in BRZT: LONG_LEVELS.append(("BrZT", b))
LONG_LEVELS.append(("DD-lower", DD_LOWER))
# MHP omitted: resOrange<0 -> vetoed (rule 1).

T0 = ms(2026,6,24,13,0)
TSTART = ms(2026,6,24,14,18)
TEND = ms(2026,6,24,17,0)

con = sqlite3.connect(DB)
rows = con.execute(
    "SELECT ts, price FROM trades WHERE symbol=? AND ts>=? AND ts<=? ORDER BY ts",
    (SYM, T0, TEND)).fetchall()
con.close()
print(f"loaded {len(rows):,} NQ trades  {dt.datetime.fromtimestamp(rows[0][0]/1000,ET):%H:%M:%S} -> "
      f"{dt.datetime.fromtimestamp(rows[-1][0]/1000,ET):%H:%M:%S}")

candles = {}
for ts, px in rows:
    m = ts - (ts % 60000)
    c = candles.get(m)
    if c is None: candles[m] = [px, px, px, px]
    else:
        c[1] = max(c[1], px); c[2] = min(c[2], px); c[3] = px
mins_sorted = sorted(candles)

def trailing_sl(entry_ts):
    hi = entry_ts - (entry_ts % 60000)
    lo = hi - 60*60000
    rng = [candles[m][1]-candles[m][2] for m in mins_sorted if lo <= m < hi]
    return max(rng) if rng else TP

aft = [(ts,px) for ts,px in rows if ts >= TSTART]
signals = []
inband = {lvl: False for _,lvl in LONG_LEVELS}
for ts, px in aft:
    for pivot, lvl in LONG_LEVELS:
        near = abs(px - lvl) <= PROX
        if near and not inband[lvl]:
            signals.append((ts, pivot, lvl, px))
        inband[lvl] = near
signals.sort()
print(f"fresh long touches (MHP vetoed): {len(signals)}")

positions = []
free_after = TSTART
for (sts, pivot, lvl, entry) in signals:
    if sts < free_after:
        continue
    sl_dist = trailing_sl(sts)
    stop = entry - sl_dist
    tp = entry + TP
    outcome, exit_px, exit_ts = "OPEN", None, None
    for ts, px in aft:
        if ts <= sts: continue
        if px >= tp:
            outcome, exit_px, exit_ts = "WIN", tp, ts; break
        if px <= stop:
            outcome, exit_px, exit_ts = "LOSS", stop, ts; break
    if outcome == "OPEN":
        exit_px, exit_ts = aft[-1][1], aft[-1][0]
    pnl = (exit_px - entry)
    positions.append(dict(open_ts=sts, pivot=pivot, lvl=lvl, entry=entry,
                          sl_dist=sl_dist, stop=stop, tp=tp,
                          outcome=outcome, exit_px=exit_px, exit_ts=exit_ts, pnl=pnl))
    free_after = exit_ts

def hm(t): return dt.datetime.fromtimestamp(t/1000,ET).strftime("%H:%M:%S")
print("\n#  open      pivot     entry     SLdist  stop      tp        out   exit      pnl")
net = 0.0; w=l=o=0
for n,p in enumerate(positions,1):
    net += p["pnl"]
    if p["outcome"]=="WIN": w+=1
    elif p["outcome"]=="LOSS": l+=1
    else: o+=1
    print(f"{n:<2} {hm(p['open_ts'])}  {p['pivot']:<8} {p['entry']:<9.2f} {p['sl_dist']:<6.1f} "
          f"{p['stop']:<9.2f} {p['tp']:<9.2f} {p['outcome']:<5} {hm(p['exit_ts'])}  {p['pnl']:+.1f}")
print(f"\nTOTAL {len(positions)}: {w} WIN / {l} LOSS / {o} open   NET {net:+.1f} pts  (= ${net*2:+.0f} @1 MNQ) gross")
