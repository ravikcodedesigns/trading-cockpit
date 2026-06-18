#!/usr/bin/env python3
"""Reconciliation: does the LIVE gate logic flag exactly the flips the validated
backtest flagged? Replays the live decision rule (db.lastSignalTsBefore +
windowMs, using the signals.direction COLUMN like the live code) over the
historical tradable longs, and compares to the backtest's flag set (payload
direction). Must match before trusting the live gate. SANDBOX read-only."""
import json, sqlite3
from datetime import datetime, timezone
from pathlib import Path

REPO = Path.home() / "trading-cockpit"
db = sqlite3.connect(f"file:{REPO/'data'/'trading.db'}?mode=ro", uri=True)
xdb = sqlite3.connect(f"file:{REPO/'data'/'ticks.db'}?mode=ro", uri=True)
WIN = 30 * 60_000
TP, SLL = 80, 55

longs = [(ts, e) for ts, e in db.execute(
    "SELECT signal_ts, entry FROM tradable_signals "
    "WHERE action IN ('OPEN','SKIP_TRAP_VETO') AND rule_id='clean-impulse' AND symbol='NQ' "
    "AND direction='long' AND entry IS NOT NULL ORDER BY signal_ts")]

def live_gate_flags(signal_ts):
    """Mirror of signal-pipeline live gate: db.lastSignalTsBefore('trap','NQ','long',ts)
    via the direction COLUMN, then age<=window."""
    row = db.execute("SELECT MAX(ts) FROM signals WHERE rule_id='trap' AND symbol='NQ' "
                     "AND direction='long' AND ts <= ?", (signal_ts,)).fetchone()
    last = row[0] or 0
    if last <= 0: return False
    age = signal_ts - last
    return 0 <= age <= WIN

def backtest_flags(signal_ts):
    """Original backtest method: any same-dir trap in (ts-WIN, ts] via payload direction."""
    rows = db.execute("SELECT ts, payload FROM signals WHERE rule_id='trap' AND symbol='NQ' "
                      "AND ts >= ? AND ts <= ?", (signal_ts-WIN, signal_ts)).fetchall()
    return any(json.loads(pl).get("direction") == "long" for _, pl in rows)

def rth_close(ts):
    dt = datetime.fromtimestamp(ts/1000-4*3600, timezone.utc)
    return int(datetime(dt.year, dt.month, dt.day, 19, 54, tzinfo=timezone.utc).timestamp()*1000)

def outcome(ts, entry):
    close = rth_close(ts)
    if ts >= close: return None
    for (px,) in xdb.execute("SELECT price FROM trades WHERE symbol='NQ' AND ts>=? AND ts<? ORDER BY ts",(ts,close)):
        if px >= entry+TP: return "W"
        if px <= entry-SLL: return "L"
    return "D"

live_set, bt_set, mism = [], [], []
for ts, e in longs:
    lg, bg = live_gate_flags(ts), backtest_flags(ts)
    if lg: live_set.append(ts)
    if bg: bt_set.append(ts)
    if lg != bg: mism.append((ts, lg, bg))

print(f"=== Trap-veto reconciliation (NQ flip-longs, n={len(longs)}) ===")
print(f"  live-gate flags : {len(live_set)}")
print(f"  backtest flags  : {len(bt_set)}")
print(f"  mismatches      : {len(mism)}")
if mism:
    print("  ⚠️  MISMATCH — live gate diverges from backtest:")
    for ts, lg, bg in mism:
        print(f"     {datetime.fromtimestamp(ts/1000-4*3600,timezone.utc):%Y-%m-%d %H:%M}  live={lg} backtest={bg}")
else:
    print("  ✓ IDENTICAL — live gate reproduces the validated backtest exactly.")
# WR of the live-flagged (vetoed) cohort — should match the backtest's ~33%
flagged = [(ts,e) for ts,e in longs if live_gate_flags(ts)]
res = [outcome(ts,e) for ts,e in flagged]; res=[r for r in res if r in ("W","L")]
w = res.count("W")
print(f"  vetoed cohort WR: {100*w/len(res):.0f}% ({w}W/{len(res)-w}L of {len(flagged)} flagged) — expect ~33%")
