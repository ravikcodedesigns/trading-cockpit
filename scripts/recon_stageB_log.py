#!/usr/bin/env python3
"""Stage B — BMD .log ↔ mbo-parquet row reconciliation (06-19→today, where .log survives).
Counts raw events per kind by streaming byte-substring counts (fast, no JSON parse),
then compares to parquet row counts. Expectation: parquet <= raw, with a SMALL drop
(corrupt lines + unknown-alias + bad-ts lines the converter legitimately skips).
A LARGE positive Δ (raw >> parquet) = LOSS; parquet > raw = duplication.
"""
import os, re, glob, datetime as dt
from pathlib import Path
from collections import defaultdict
import duckdb

HOME = Path.home()
LOGDIR = HOME / "cockpit-mbo-capture"
MBO_PQ = HOME / "trading-cockpit" / "data" / "mbo-parquet"
TODAY = dt.date.today().isoformat()

PATS = {b'"kind":"trade"': "trades", b'"kind":"depth"': "depth",
        b'"kind":"mbo_send"': "mbo", b'"kind":"mbo_cancel"': "mbo", b'"kind":"mbo_replace"': "mbo"}
MAXLEN = max(len(p) for p in PATS)

def count_log(path):
    """stream-count kind substrings; overlap chunks so a pattern split across a
    chunk boundary is still counted exactly once."""
    counts = defaultdict(int)
    CH = 64 * 1024 * 1024
    tail = b""
    with open(path, "rb") as f:
        while True:
            buf = f.read(CH)
            if not buf:
                break
            data = tail + buf
            for pat, tbl in PATS.items():
                counts[tbl] += data.count(pat)
            tail = data[-(MAXLEN - 1):]
    return counts  # trades/depth/mbo raw event counts

def instr_root(contract):
    m = re.match(r"(M?)(NQ|ES|CL|GC)", contract)
    return (m.group(1) + m.group(2)) if m else contract

con = duckdb.connect()
def pq_count(level, sym, date):
    g = str(MBO_PQ / level / f"symbol={sym}" / f"date={date}" / "*.parquet")
    try:
        return con.execute(f"SELECT COUNT(*) FROM read_parquet('{g}')").fetchone()[0]
    except Exception:
        return 0

print("=" * 92)
print("STAGE B — .log raw events  vs  mbo-parquet rows   (Δ = parquet - raw; small negative is OK)")
print("=" * 92)

files = sorted(glob.glob(str(LOGDIR / "*.log")))
rows = []
for p in files:
    name = os.path.basename(p)
    m = re.match(r"(\d{4}-\d{2}-\d{2})-([A-Z0-9]+)_", name)
    if not m:
        continue
    date, contract = m.group(1), m.group(2)
    if date < "2026-06-19":
        continue
    sym = instr_root(contract)
    mb = os.path.getsize(p) / 1048576
    if mb < 1:   # weekend stub
        continue
    raw = count_log(p)
    line = f"\n{date} {sym:<4} ({mb:,.0f}MB){'  [TODAY-live]' if date==TODAY else ''}"
    print(line)
    for tbl in ("trades", "depth", "mbo"):
        r = raw.get(tbl, 0)
        q = pq_count(tbl, sym, date)
        delta = q - r
        pct = (delta / r * 100) if r else 0.0
        flag = ""
        if date != TODAY:
            if delta < 0 and abs(pct) > 0.5: flag = "  <== LOSS (parquet short)"
            elif delta > 0:                  flag = "  <== DUPLICATION (parquet over)"
        print(f"   {tbl:<7} raw={r:>12,}  parquet={q:>12,}  Δ={delta:>+10,} ({pct:+.3f}%){flag}")
        rows.append((date, sym, tbl, r, q, delta, pct))

print("\n" + "=" * 92)
bad = [x for x in rows if x[0] != TODAY and (x[5] > 0 or (x[3] and abs(x[5]/x[3]) > 0.005))]
if bad:
    print(f"FLAGS ({len(bad)} partition-levels off >0.5% or with duplication):")
    for d, s, t, r, q, dl, pc in bad:
        print(f"   {d} {s} {t}: raw={r:,} pq={q:,} Δ={dl:+,} ({pc:+.3f}%)")
else:
    print("RESULT: ✓ every completed-day partition is within 0.5% (parquet ≤ raw = expected skips, no loss, no dup).")
