#!/usr/bin/env python3
"""
verify_dedup.py — Prove the deduped parquet store equals DISTINCT(originals).

For every partition that was compacted (i.e. has originals preserved under
data/mbo-parquet/.trash), compare the originals against the partition's
`compact-<date>.parquet` file:

  1. COMPLETENESS (nothing lost): every original row exists in compact.
     `count(originals ANTI JOIN compact) == 0`. Streams originals, builds the
     hash on the small compact side -> feasible even on 2.6B-row partitions.
  2. CLEAN: compact has no residual dupes (count == count(DISTINCT)).
  3. NO FABRICATION: compact ⊆ originals. Guaranteed by the dedup algorithm
     (DISTINCT/EXCEPT/COPY only copy rows); independently spot-checked with a
     full two-way set-equality on partitions small enough to afford it.

PASS for a partition = completeness ok AND clean AND (fabrication ok or skipped).
If every partition PASSes, .trash is safe to delete.
"""
import sys
from pathlib import Path
import duckdb

OUT = Path("data/mbo-parquet")
TRASH = OUT / ".trash"
# Below this original-row count, also run the full two-way set-equality check.
SPOT_CHECK_MAX_ROWS = 150_000_000

con = duckdb.connect()
con.execute("PRAGMA threads=4")
con.execute("PRAGMA memory_limit='96GB'")
tmp = OUT / ".duckdb_tmp"; tmp.mkdir(parents=True, exist_ok=True)
con.execute(f"PRAGMA temp_directory='{tmp}'")
con.execute("PRAGMA max_temp_directory_size='180GiB'")


def q1(sql):
    return con.execute(sql).fetchone()[0]


hdr = f"{'table':6} {'sym':3} {'date':12} {'orig_rows':>15} {'compact':>12} {'lost':>6} {'clean':>6} {'no_fab':>7}  {'verdict'}"
print(hdr); print("-" * len(hdr))

# Optional substring filters (argv): only check partitions whose
# "table/sym/date" contains any given filter, e.g. `mbo/ES/2026-06-15`.
filters = [a for a in sys.argv[1:] if not a.startswith("-")]

all_pass = True
n = 0
for tdir in sorted(p for p in TRASH.iterdir() if p.is_dir()):
    table = tdir.name
    for sdir in sorted(p for p in tdir.iterdir() if p.is_dir()):
        sym = sdir.name.replace("symbol=", "")
        for ddir in sorted(p for p in sdir.iterdir() if p.is_dir()):
            date = ddir.name.replace("date=", "")
            tag = f"{table}/{sym}/{date}"
            if filters and not any(f in tag for f in filters):
                continue
            orig_glob = str(ddir / "*.parquet")
            live_part = OUT / table / sdir.name / ddir.name
            compacts = list(live_part.glob("compact-*.parquet"))
            if not compacts:
                print(f"{table:6} {sym:3} {date:12} {'':>15} {'MISSING compact-*.parquet':>12}   *** FAIL")
                all_pass = False; n += 1
                continue
            comp_glob = str(live_part / "compact-*.parquet")

            cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{comp_glob}')").fetchall()]
            # Null-safe whole-row key via variadic hash() — lets the completeness
            # check run as a hash anti-join with the small compact side as the
            # build set (the exact IS-NOT-DISTINCT-FROM join defeated the planner
            # and materialized the 2.6B-row side -> OOM). 64-bit collision over
            # ~14M distinct rows is ~1e-12, so lost==0 is a near-certain proof.
            hexpr = "hash(" + ", ".join(f'"{c}"' for c in cols) + ")"

            n_orig = q1(f"SELECT count(*) FROM read_parquet('{orig_glob}')")
            n_comp = q1(f"SELECT count(*) FROM read_parquet('{comp_glob}')")
            n_comp_d = q1(f"SELECT count(*) FROM (SELECT DISTINCT * FROM read_parquet('{comp_glob}'))")
            # completeness: original rows whose row-hash is absent from compact
            lost = q1(
                f"SELECT count(*) FROM read_parquet('{orig_glob}') o "
                f"WHERE {hexpr} NOT IN (SELECT {hexpr} FROM read_parquet('{comp_glob}'))"
            )
            clean = (n_comp == n_comp_d)

            # no-fabrication: full set-equality spot-check on small partitions
            if n_orig <= SPOT_CHECK_MAX_ROWS:
                extra = q1(
                    f"SELECT count(*) FROM (SELECT * FROM read_parquet('{comp_glob}') "
                    f"EXCEPT SELECT * FROM read_parquet('{orig_glob}'))"
                )
                no_fab = "0" if extra == 0 else f"{extra}!"
                fab_ok = (extra == 0)
            else:
                no_fab = "algo"   # precluded by construction; too big to recheck
                fab_ok = True

            ok = (lost == 0) and clean and fab_ok
            all_pass = all_pass and ok
            n += 1
            print(f"{table:6} {sym:3} {date:12} {n_orig:15,d} {n_comp:12,d} {lost:6d} "
                  f"{'yes' if clean else 'NO':>6} {no_fab:>7}  {'PASS' if ok else '*** FAIL'}")

print("-" * len(hdr))
print(f"\n{n} partitions checked — {'ALL PASS ✅  .trash is safe to delete' if all_pass else 'SOME FAILED ❌  do NOT delete .trash'}")
sys.exit(0 if all_pass else 1)
