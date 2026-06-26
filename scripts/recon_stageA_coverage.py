#!/usr/bin/env python3
"""Stage A — coverage matrix + gap detection for the capture→parquet pipeline.
Read-only. Reports, per (store, symbol): which dates have partitions, row counts,
whether a source .log still exists, zero-row partitions, and missing-weekday gaps.
"""
import os, re, glob, datetime as dt
from pathlib import Path
from collections import defaultdict
import duckdb

HOME = Path.home()
REPO = HOME / "trading-cockpit"
LOGDIR = HOME / "cockpit-mbo-capture"
MBO_PQ = REPO / "data" / "mbo-parquet"
TICK_PQ = REPO / "data" / "ticks-parquet"

con = duckdb.connect()

def pq_counts(root):
    """row counts per (level, symbol, date) using parquet metadata (fast)."""
    out = defaultdict(dict)  # (level,symbol) -> {date: rows}
    for level in sorted(os.listdir(root)) if root.exists() else []:
        lvl = root / level
        if not lvl.is_dir(): continue
        g = str(lvl / "symbol=*" / "date=*" / "*.parquet")
        try:
            rows = con.execute(
                f"SELECT symbol, date, COUNT(*) c FROM read_parquet('{g}', hive_partitioning=1) GROUP BY symbol, date"
            ).fetchall()
        except Exception as e:
            print(f"  [warn] {level}: {e}"); continue
        for sym, date, c in rows:
            out[(level, str(sym))][str(date)] = c
    return out

# .log inventory: (date, instr-root) -> size_mb   (instr-root = NQ/ES/MNQ/MES/CL/GC)
def instr_root(contract):  # NQU6->NQ, MNQU6->MNQ, CLQ6->CL ...
    m = re.match(r"(M?)(NQ|ES|CL|GC)", contract)
    return (m.group(1)+m.group(2)) if m else contract
logs = {}
for p in glob.glob(str(LOGDIR / "*.log")):
    name = os.path.basename(p)
    m = re.match(r"(\d{4}-\d{2}-\d{2})-([A-Z0-9]+)_", name)
    if not m: continue
    date, contract = m.group(1), m.group(2)
    logs[(date, instr_root(contract))] = os.path.getsize(p)/1048576

def weekday_gaps(dates):
    """missing Mon-Fri between min and max (Sat/Sun excluded — futures weekend is partial)."""
    if not dates: return []
    ds = sorted(dt.date.fromisoformat(d) for d in dates)
    gaps=[]; cur=ds[0]
    while cur <= ds[-1]:
        if cur.weekday() < 5 and cur not in ds: gaps.append(cur.isoformat())
        cur += dt.timedelta(days=1)
    return gaps

print("="*78)
print("STAGE A — COVERAGE MATRIX  (mbo-parquet = BMD via .log;  ticks-parquet = CQG via ticks.db)")
print("="*78)

for label, root, has_log in [("MBO-PARQUET (BMD)", MBO_PQ, True), ("TICKS-PARQUET (CQG)", TICK_PQ, False)]:
    print(f"\n########## {label} ##########")
    cov = pq_counts(root)
    # group by symbol across levels
    syms = sorted({s for (_l, s) in cov})
    for sym in syms:
        levels = {l: cov[(l, sym)] for (l, s) in cov if s == sym}
        all_dates = sorted(set().union(*[set(d) for d in levels.values()]))
        print(f"\n  symbol={sym}   {len(all_dates)} dates  {all_dates[0]} … {all_dates[-1]}")
        # per-date row counts across levels + .log presence
        zero=[]; nolog=[]
        for d in all_dates:
            cells = "  ".join(f"{l}={levels.get(l,{}).get(d,0):>10,}" for l in sorted(levels))
            logmb = logs.get((d, sym))
            tag = ""
            if has_log:
                if logmb is None: tag=" [.log DELETED]"; nolog.append(d)
                elif logmb < 1: tag=f" [.log {logmb:.2f}MB stub]"
                else: tag=f" [.log {logmb:,.0f}MB]"
            if any(levels.get(l,{}).get(d,0)==0 for l in levels): zero.append(d)
            print(f"    {d}  {cells}{tag}")
        g = weekday_gaps(all_dates)
        if g: print(f"    >> MISSING WEEKDAYS: {g}")
        if zero: print(f"    >> ZERO-ROW partitions on: {zero}")
        if has_log and nolog: print(f"    >> .log gone (parquet-only, unverifiable vs source): {nolog}")

# .log files with NO parquet at all (conversion never happened = LOSS risk)
print(f"\n########## .log present but NO mbo-parquet partition (any level) ##########")
mbo = pq_counts(MBO_PQ)
pq_keys = {(s, d) for (_l, s) in mbo for d in mbo[(_l, s)]}
orphans = [(d, s, f"{mb:,.0f}MB") for (d, s), mb in sorted(logs.items()) if (s, d) not in pq_keys and mb >= 1]
print("  (excludes <1MB weekend stubs)")
for d, s, mb in orphans: print(f"    {d} {s} {mb}  -> NO PARQUET")
if not orphans: print("    none — every non-stub .log has at least one parquet partition")
