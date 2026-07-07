#!/usr/bin/env python3
"""
dedup_parquet_store.py — Compact + deduplicate the MBO Parquet store.

Why this exists:
  The tail converter crash-looped (pre-fix ff0e465) and re-dumped overlapping
  whole-day files on each restart. Result: partitions 2026-06-14/15/16 carry
  ~25-30x duplicate rows (96%+ of rows are exact full-row copies). Minor 2-file
  overlap also exists on 06-05 / 06-10. This collapses each partition to its
  DISTINCT rows in a single compacted file.

Safety model:
  - DRY-RUN by default. Pass --execute to actually rewrite.
  - Only touches partitions with >= 2 parquet files (clean single-file
    backfills are left untouched — a single backfill pass cannot self-dup).
  - Dedup = SELECT DISTINCT * . Verified safe for trades: distinct-on-full-row
    == distinct-on-trade-key (exact copies, not near-dupes). For depth/mbo the
    same holds in practice (order_id / level identity); the rare legit identical
    no-op row collapses, which is harmless for volume/CVD analysis.
  - Originals are MOVED to <out>/.trash/... (same filesystem rename, instant,
    reversible) — never hard-deleted by this script. Delete .trash manually
    after verifying the deduped store.
  - Compacted output is written to a staging file OUTSIDE the partition, row-
    count-verified, then swapped in. A crash mid-swap leaves either the
    originals or the staging file intact; re-running resumes cleanly.

IMPORTANT: stop the tail converter before --execute so it isn't writing the
live (06-16) partition mid-compaction:
    launchctl stop com.cockpit.mbo-parquet-converter   # or kill the PID
"""

import argparse
import os
import shutil
import sys
import time
from pathlib import Path

import duckdb

DEFAULT_OUT = Path.home() / "trading-cockpit" / "data" / "mbo-parquet"
TABLES = ("trades", "depth", "mbo")
# Every captured instrument MUST be here or its partitions never compact — they
# accumulate ~2000 tail-flush files/day plus at-least-once duplicate rows forever.
# Bug (fixed 2026-06-25): this was ("NQ","ES") only, so MNQ/MES/CL/GC went
# un-compacted from 06-19 on (1,800+ files/partition, 1-6% dup rows). The micros
# are the BIGGEST partitions (80M+ rows) — the incremental path below handles them.
SYMBOLS = ("NQ", "ES", "MNQ", "MES", "CL", "GC")


def partition_dirs(out: Path):
    """Yield (table, symbol, date, dir, parquet_files) for every partition."""
    for table in TABLES:
        for sym in SYMBOLS:
            base = out / table / f"symbol={sym}"
            if not base.is_dir():
                continue
            for d in sorted(base.glob("date=*")):
                if not d.is_dir():
                    continue
                files = sorted(p for p in d.glob("*.parquet") if not p.name.startswith("."))
                date = d.name.replace("date=", "")
                yield table, sym, date, d, files


# Partitions above this row count are deduped incrementally (batched EXCEPT into
# an in-memory accumulator) instead of one-shot DISTINCT — a single 14GB ET-day
# partition is ~2.4B rows / ~190GB uncompressed, which overflows even a 190GiB
# temp spill when deduped in one pass.
INCREMENTAL_ROW_THRESHOLD = 300_000_000
INCREMENTAL_BATCH_FILES = 50


def _sql_list(paths) -> str:
    return "[" + ", ".join("'" + str(p).replace("'", "''") + "'" for p in paths) + "]"


def dedup_incremental(con, files, stage_file) -> int:
    """Dedup a huge partition without materializing it all. acc holds only the
    running DISTINCT set (≈ one ET-day, fits in memory); each file-batch's new
    rows are found via EXCEPT and appended."""
    con.execute("DROP TABLE IF EXISTS acc")
    b = INCREMENTAL_BATCH_FILES
    con.execute(f"CREATE TABLE acc AS SELECT DISTINCT * FROM read_parquet({_sql_list(files[:b])}, union_by_name=true)")
    for i in range(b, len(files), b):
        grp = files[i:i + b]
        con.execute("DROP TABLE IF EXISTS newrows")
        # EXCEPT returns rows in the batch not already in acc (and is itself
        # set-distinct, so batch-internal dups collapse too).
        con.execute(
            f"CREATE TEMP TABLE newrows AS "
            f"SELECT * FROM read_parquet({_sql_list(grp)}, union_by_name=true) EXCEPT SELECT * FROM acc"
        )
        con.execute("INSERT INTO acc SELECT * FROM newrows")
        con.execute("DROP TABLE newrows")
    # ORDER-SAFE rewrite (2026-07-06): capture order IS meaning for book replay —
    # depth updates carry absolute sizes, so same-ms same-price updates are
    # order-dependent. Write back in (ts_ms, seq) order, always.
    con.execute(f"COPY (SELECT * FROM acc ORDER BY ts_ms, seq) TO '{stage_file}' (FORMAT PARQUET, COMPRESSION zstd, COMPRESSION_LEVEL 3)")
    n = con.execute("SELECT count(*) FROM acc").fetchone()[0]
    con.execute("DROP TABLE acc")
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="Parquet store root")
    ap.add_argument("--execute", action="store_true", help="Actually rewrite (default: dry-run)")
    ap.add_argument("--min-files", type=int, default=2, help="Only compact partitions with >= this many parquet files")
    ap.add_argument("--only-date", type=str, default=None, help="Restrict to a single date=YYYY-MM-DD")
    args = ap.parse_args()

    out = args.out.resolve()
    trash = out / ".trash"
    staging = out / ".compaction"
    tmpdir = out / ".duckdb_tmp"
    tmpdir.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute("PRAGMA threads=4")
    # Deduping a single 14GB partition means a DISTINCT over ~2.8B rows, which
    # spills the input to temp for out-of-core hash aggregation (~150GB). Give
    # DuckDB a big in-memory budget and point temp at the data volume with a cap
    # below free disk so it can't fill the drive.
    con.execute("PRAGMA memory_limit='96GB'")
    con.execute(f"PRAGMA temp_directory='{tmpdir}'")
    con.execute("PRAGMA max_temp_directory_size='190GiB'")

    mode = "EXECUTE" if args.execute else "DRY-RUN"
    print(f"[{mode}] dedup parquet store at {out}\n")

    hdr = f"{'table':7} {'sym':3} {'date':12} {'files':>6} {'total_rows':>14} {'distinct':>14} {'dup%':>6}  {'size':>8}"
    print(hdr)
    print("-" * len(hdr))

    tot_before = tot_after = 0
    n_part = 0

    for table, sym, date, d, files in partition_dirs(out):
        if args.only_date and date != args.only_date:
            continue
        if len(files) < args.min_files:
            continue

        glob = str(d / "*.parquet")
        total = con.execute(f"SELECT count(*) FROM read_parquet('{glob}', union_by_name=true)").fetchone()[0]
        size = sum(p.stat().st_size for p in files)

        if not args.execute:
            # Dry-run: report the distinct count (one heavy pass, read-only).
            distinct = con.execute(f"SELECT count(*) FROM (SELECT DISTINCT * FROM read_parquet('{glob}', union_by_name=true))").fetchone()[0]
            dup_pct = 100 * (total - distinct) / total if total else 0
            tot_before += total
            tot_after += distinct
            n_part += 1
            print(f"{table:7} {sym:3} {date:12} {len(files):6d} {total:14,d} {distinct:14,d} {dup_pct:5.1f}%  {size/1e6:7.0f}M")
            continue

        # --- EXECUTE: single distinct pass via COPY, verify the (small) output, swap in ---
        # No separate pre-count (that would double the expensive distinct over
        # billions of rows).
        #
        # ⚠ ORDER-SAFE REWRITE REQUIRED (2026-07-06, Cracker data-integrity finding):
        # the previous "no ORDER BY" version rewrote partitions in ARBITRARY row
        # order, destroying capture order — order books replayed from those files
        # were permanently corrupted (94–99% displaced rows). Depth updates carry
        # absolute sizes: same-ms same-price update order IS meaning. Therefore:
        #   • partitions WITHOUT a seq column (pre-fix legacy) are SKIPPED, never
        #     rewritten — their small-file layout is the only order they have left;
        #   • rewrites always ORDER BY (ts_ms, seq).
        cols = {r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{glob}', union_by_name=true)").fetchall()}
        if "seq" not in cols:
            print(f"{table:7} {sym:3} {date:12} {len(files):6d} {total:14,d}  SKIPPED (no seq column — legacy partition, order not rewritable)", flush=True)
            continue
        staging.mkdir(parents=True, exist_ok=True)
        stage_file = staging / f"{table}_{sym}_{date}.parquet"
        if stage_file.exists():
            stage_file.unlink()
        if total > INCREMENTAL_ROW_THRESHOLD:
            print(f"{table:7} {sym:3} {date:12} {len(files):6d} {total:14,d}  (incremental dedup, {len(files)} files in batches of {INCREMENTAL_BATCH_FILES})", flush=True)
            dedup_incremental(con, files, stage_file)
        else:
            con.execute(
                f"COPY (SELECT DISTINCT * FROM read_parquet('{glob}', union_by_name=true) ORDER BY ts_ms, seq) "
                f"TO '{stage_file}' (FORMAT PARQUET, COMPRESSION zstd, COMPRESSION_LEVEL 3)"
            )
        # Verify on the small deduped output: non-empty, not larger than input,
        # and internally dup-free (cheap — staging is the collapsed set).
        sg = str(stage_file)
        staged = con.execute(f"SELECT count(*) FROM read_parquet('{sg}', union_by_name=true)").fetchone()[0]
        staged_distinct = con.execute(f"SELECT count(*) FROM (SELECT DISTINCT * FROM read_parquet('{sg}', union_by_name=true))").fetchone()[0]
        if staged == 0 or staged > total or staged != staged_distinct:
            print(f"   !! ABORT {table}/{sym}/{date}: staged={staged:,} total={total:,} "
                  f"staged_distinct={staged_distinct:,}; leaving partition untouched")
            stage_file.unlink(missing_ok=True)
            continue

        dup_pct = 100 * (total - staged) / total if total else 0
        tot_before += total
        tot_after += staged
        n_part += 1
        print(f"{table:7} {sym:3} {date:12} {len(files):6d} {total:14,d} {staged:14,d} {dup_pct:5.1f}%  {size/1e6:7.0f}M")

        # Move originals to .trash (reversible), then move staging into partition
        tdir = trash / table / f"symbol={sym}" / f"date={date}"
        tdir.mkdir(parents=True, exist_ok=True)
        for p in files:
            shutil.move(str(p), str(tdir / p.name))
        final = d / f"compact-{date}.parquet"
        shutil.move(str(stage_file), str(final))
        print(f"   -> compacted to {final.name}  ({staged:,} rows); {len(files)} originals moved to .trash")

    print("-" * len(hdr))
    saved = tot_before - tot_after
    pct = 100 * saved / tot_before if tot_before else 0
    print(f"\n{n_part} partition(s) {'compacted' if args.execute else 'to compact'}: "
          f"{tot_before:,} -> {tot_after:,} rows  (-{saved:,}, {pct:.1f}% removed)")
    if not args.execute:
        print("\nDRY-RUN only — nothing changed. Re-run with --execute (stop the converter first).")
    else:
        print(f"\nDone. Originals preserved under {trash} (delete after verification).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
