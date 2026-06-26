#!/bin/bash
# Nightly Parquet maintenance: (1) MBO compaction/dedup + (2) ticks refresh.
#
# (1) MBO compaction:
#   The tail converter writes many small per-batch Parquet files per partition
#   (~2000/day) and is at-least-once, so a hard crash / log re-read can leave
#   overlapping rows. This folds each multi-file partition into a single
#   DISTINCT-deduped file (dedup_parquet_store.py --execute, which only touches
#   partitions with >= 2 files; clean single-file ones are skipped). Safe to run
#   while the converter is live; originals go to data/mbo-parquet/.trash.
#
# (2) ticks-parquet refresh:
#   ticks_to_parquet.py is resumable (skips existing day-partitions), so the
#   historical store stays frozen. --redo-from re-converts the last couple ET
#   days so the just-closed day is finalized and the live current day's snapshot
#   is refreshed from ticks.db. Read-only on ticks.db.
#
# Scheduled ~03:10 local, when the prior ET-day partition no longer receives
# writes. Logs to ~/Library/Logs/cockpit-parquet-compaction.log.

set -uo pipefail

LOG=~/Library/Logs/cockpit-parquet-compaction.log
mkdir -p "$(dirname "$LOG")"

export HOME=/Users/ravikumarbasker
REPO=/Users/ravikumarbasker/trading-cockpit
VENV="$REPO/scripts/.venv-mbo"

if [[ ! -x "$VENV/bin/python" ]]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S')  ERROR: venv not found at $VENV" >> "$LOG"
  exit 1
fi

cd "$REPO" || { echo "$(date '+%Y-%m-%d %H:%M:%S')  ERROR: repo not found" >> "$LOG"; exit 1; }

echo "==[ $(date '+%Y-%m-%d %H:%M:%S') ]== parquet compaction starting" >> "$LOG"
PYTHONUNBUFFERED=1 "$VENV/bin/python" "$REPO/scripts/dedup_parquet_store.py" --execute >> "$LOG" 2>&1
echo "==[ $(date '+%Y-%m-%d %H:%M:%S') ]== parquet compaction done (exit $?)" >> "$LOG"

# Prune .trash to a ~2-day rollback window so it can't silently balloon. Compaction
# moves every pre-compaction original here; un-pruned it hit 81GB by 2026-06-25 (4.7x
# the live data). Trashed files keep their original flush mtime, so -mtime +2 = data
# older than ~2 days; then drop the emptied dirs. The live compact-*.parquet files and
# the .log source both cover these, so pruning loses nothing.
TRASH="$REPO/data/mbo-parquet/.trash"
if [[ -d "$TRASH" ]]; then
  echo "==[ $(date '+%F %T') ]== pruning .trash (>2 days)" >> "$LOG"
  find "$TRASH" -type f -mtime +2 -delete 2>/dev/null
  find "$TRASH" -type d -empty -delete 2>/dev/null
  echo "  .trash now $(du -sh "$TRASH" 2>/dev/null | cut -f1 || echo gone)" >> "$LOG"
fi

# ticks-parquet refresh: re-convert the last 2 ET days (finalize just-closed
# day + refresh the live current-day snapshot). BSD date (macOS) for -2d.
REDO_FROM=$(date -v-2d +%Y-%m-%d)
echo "==[ $(date '+%Y-%m-%d %H:%M:%S') ]== ticks->parquet refresh from $REDO_FROM" >> "$LOG"
PYTHONUNBUFFERED=1 "$VENV/bin/python" "$REPO/scripts/ticks_to_parquet.py" --redo-from "$REDO_FROM" >> "$LOG" 2>&1
echo "==[ $(date '+%Y-%m-%d %H:%M:%S') ]== ticks refresh done (exit $?)" >> "$LOG"
