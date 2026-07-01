#!/usr/bin/env python3
"""Verify rs-context-history.db raw_json captures every data point after the 2026-06-30 refactor.
Run during/after RTH (fields only populate while the feed is live):  python3 scripts/verify_rawjson.py
Checks the latest NQ + ES row for today and confirms the 8 globals that were previously MISSED are now
present in raw_json, plus that the split pipeline is healthy (mm_bullish / lm_code / dd / vx live)."""
import sqlite3, json, os, datetime
from zoneinfo import ZoneInfo

DB = os.path.expanduser('~/trading-cockpit/data/rs-context-history.db')
DAY = datetime.datetime.now(ZoneInfo('America/New_York')).strftime('%Y-%m-%d')
NOW = datetime.datetime.now(ZoneInfo('America/New_York')).strftime('%H:%M:%S ET')
# the 8 globals that had NO column and were absent from the old per-symbol raw_json
NEEDED = ['irrational', 'spyMhp', 'qqqMhp', 'spyPrev', 'qqqPrev', 'uvxy', 'vxGammaHp', 'vxGammaMhp']

print(f"raw_json verification — {DAY} {NOW}\n  DB: {DB}\n")
con = sqlite3.connect(DB)
all_ok = True
for sym in ('NQ', 'ES'):
    row = con.execute(
        "SELECT ts_ms, raw_json, mm_bullish, lm_code, dd_ratio, mhp_res, vx, vvix "
        "FROM rs_context_ts WHERE symbol=? AND trading_day=? ORDER BY ts_ms DESC LIMIT 1",
        (sym, DAY)).fetchone()
    if not row:
        print(f"=== {sym}: NO ROWS yet for {DAY} (feed not flowing / pre-open?) ===\n")
        all_ok = False
        continue
    ts, raw, mm, lm, dd, mhp, vx, vvix = row
    et = datetime.datetime.fromtimestamp(ts / 1000, ZoneInfo('America/New_York')).strftime('%H:%M:%S')
    d = json.loads(raw) if raw else {}
    print(f"=== {sym}  (latest row {et} ET) ===")
    print(f"  pipeline health: mm_bullish={mm}  lm_code={lm}  dd_ratio={dd}  mhp_res={mhp}  vx={vx}  vvix={vvix}")
    print(f"  the 8 previously-missed globals in raw_json:")
    for f in NEEDED:
        present = f in d
        flag = '✓' if present else '✗ MISSING'
        if not present:
            all_ok = False
        val = d.get(f)
        val_s = (json.dumps(val)[:55]) if present else ''
        print(f"    {flag:<10} {f:<12} {val_s}")
    print()

print("RESULT:", "✅ all fields present — raw_json is complete" if all_ok
      else "⚠️  some fields missing/no-rows — see above (if pre-open or feed down, re-run after 09:40 ET)")
