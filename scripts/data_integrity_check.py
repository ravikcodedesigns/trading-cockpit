#!/usr/bin/env python3
"""Daily data-integrity verifier — the CHEAP recurring check (vs the full Stage A-D
150GB scan). Looks only at the last few COMPLETED ET-days and uses parquet metadata
+ small distinct counts, so it runs in seconds. Flags:

  • COMPACTION_BEHIND  — a completed-day partition still has >1 file (the 06-19 micro bug)
  • DUPLICATES         — total rows > distinct rows above threshold (at-least-once residue)
  • CAPTURE_GAP        — a >90min gap between consecutive trades (capture outage; the
                         daily ~17:00-18:00 ET maintenance halt is excluded)
  • CQG_DRIFT          — ticks.db day-count != ticks-parquet day-count
  • CONVERTER_CRASH    — new tracebacks in the converter log in the window

Exit code: 0 = all clear, 1 = at least one flag (launchd captures the report; set
DISCORD_WEBHOOK_URL to also push an alert). Run: data_integrity_check.py [--days N]
"""
import os, sys, glob, json, argparse, datetime as dt, urllib.request
from pathlib import Path
import duckdb

REPO = Path.home() / "trading-cockpit"
MBO_PQ = REPO / "data" / "mbo-parquet"
TICK_PQ = REPO / "data" / "ticks-parquet"
TICKS_DB = REPO / "data" / "ticks.db"
CONV_LOG = Path.home() / "Library" / "Logs" / "cockpit-mbo-parquet.log"

DUP_PCT_MAX = 0.10        # >0.1% dup on a compacted day is suspicious
GAP_MIN_MAX = 90          # minutes; >90 = real outage (excludes 60min maint halt)
DISTINCT_COLS = {
    "trades": "ts_ms, contract, price_int, size, aggressor_order_id",
    "depth":  "ts_ms, contract, price_int, size, is_bid",
    "mbo":    "ts_ms, contract, action, order_id, price_int, size",
}
con = duckdb.connect()
flags = []

def discover_symbols():
    d = MBO_PQ / "depth"
    return sorted(p.name.replace("symbol=", "") for p in d.glob("symbol=*")) if d.exists() else []

def part_files(table, sym, date):
    d = MBO_PQ / table / f"symbol={sym}" / f"date={date}"
    return [p for p in d.glob("*.parquet") if not p.name.startswith(".")] if d.exists() else []

def check_mbo(days):
    syms = discover_symbols()
    print(f"\n## mbo-parquet  symbols={syms}  last {len(days)} completed days: {days[0]}…{days[-1]}")
    for sym in syms:
        for date in days:
            for table in ("trades", "depth", "mbo"):
                files = part_files(table, sym, date)
                if not files:
                    continue  # symbol/instrument simply not captured that day
                nf = len(files)
                if nf > 1:
                    flags.append(f"COMPACTION_BEHIND {sym} {table} {date}: {nf} files")
                # dup check only worth it on micro-row partitions; cheap on 1 compacted file
                g = str(MBO_PQ / table / f"symbol={sym}" / f"date={date}" / "*.parquet")
                tot = con.execute(f"SELECT COUNT(*) FROM read_parquet('{g}')").fetchone()[0]
                if tot == 0:
                    flags.append(f"EMPTY {sym} {table} {date}")
                    continue
                dis = con.execute(
                    f"SELECT COUNT(*) FROM (SELECT DISTINCT {DISTINCT_COLS[table]} FROM read_parquet('{g}'))").fetchone()[0]
                duppct = (tot - dis) / tot * 100
                tag = ""
                if duppct > DUP_PCT_MAX:
                    flags.append(f"DUPLICATES {sym} {table} {date}: {tot-dis:,} ({duppct:.2f}%)")
                    tag = "  <-- DUP"
                if table == "trades":
                    gap = con.execute(f"""
                        SELECT COALESCE(MAX(gap_min),0) FROM (
                          SELECT (ts_ms - LAG(ts_ms) OVER (ORDER BY ts_ms))/60000.0 gap_min
                          FROM read_parquet('{g}'))
                        WHERE gap_min > {GAP_MIN_MAX}""").fetchone()[0]
                    if gap and gap > GAP_MIN_MAX:
                        flags.append(f"CAPTURE_GAP {sym} trades {date}: {gap:.0f}min gap")
                        tag += f"  <-- GAP {gap:.0f}min"
                print(f"   {sym:<4} {table:<6} {date}  files={nf:<4} rows={tot:>12,} dup={duppct:4.2f}%{tag}")

def check_cqg(days):
    print(f"\n## CQG ticks.db ↔ ticks-parquet  last {len(days)} days")
    import sqlite3
    sq = sqlite3.connect(f"file:{TICKS_DB}?mode=ro", uri=True)
    for sym in ("NQ", "ES"):
        for table in ("trades", "depth"):
            for date in days:
                a = sq.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE symbol=? "
                    f"AND date(ts/1000,'unixepoch','localtime')=?", (sym, date)).fetchone()[0]
                g = str(TICK_PQ / table / f"symbol={sym}" / f"date={date}" / "*.parquet")
                try:
                    b = con.execute(f"SELECT COUNT(*) FROM read_parquet('{g}')").fetchone()[0]
                except Exception:
                    b = 0
                if a != b:
                    flags.append(f"CQG_DRIFT {sym} {table} {date}: db={a:,} pq={b:,} Δ={b-a:+,}")
                    print(f"   {sym} {table:<6} {date}  db={a:>12,} pq={b:>12,}  <-- DRIFT")
                else:
                    print(f"   {sym} {table:<6} {date}  db={a:>12,} pq={b:>12,}  ok")

def check_converter(days):
    if not CONV_LOG.exists():
        return
    txt = CONV_LOG.read_text(errors="ignore")
    n = txt.count("Traceback (most recent call last)")
    # only the tail matters for "recent"; cheap heuristic: count tracebacks after the last day's marker
    recent = txt.rsplit(days[0], 1)[-1].count("Traceback (most recent call last)") if days[0] in txt else 0
    print(f"\n## converter log: {n} total tracebacks (lifetime), {recent} since {days[0]}")
    if recent:
        flags.append(f"CONVERTER_CRASH: {recent} tracebacks since {days[0]}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=3, help="completed ET days to check")
    args = ap.parse_args()
    today = dt.date.today()
    days = [(today - dt.timedelta(days=i)).isoformat() for i in range(1, args.days + 1)][::-1]

    print("=" * 78)
    print(f"DATA INTEGRITY CHECK  (completed days {days[0]}…{days[-1]})")
    print("=" * 78)
    check_mbo(days)
    check_cqg(days)
    check_converter(days)

    print("\n" + "=" * 78)
    if flags:
        print(f"RESULT: {len(flags)} FLAG(S)")
        for f in flags:
            print("  ✗ " + f)
        hook = os.environ.get("DISCORD_WEBHOOK_URL")
        if hook:
            body = json.dumps({"content": f"⚠️ data-integrity: {len(flags)} flag(s)\n" + "\n".join(flags[:20])}).encode()
            try:
                urllib.request.urlopen(urllib.request.Request(hook, data=body,
                    headers={"Content-Type": "application/json"}), timeout=10)
            except Exception as e:
                print(f"  (discord post failed: {e})")
        sys.exit(1)
    print("RESULT: ✓ ALL CLEAR — no compaction backlog, no dups, no gaps, no CQG drift.")
    sys.exit(0)

if __name__ == "__main__":
    main()
