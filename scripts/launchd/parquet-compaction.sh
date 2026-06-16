#!/bin/bash
# Nightly MBO Parquet compaction + dedup.
#
# The tail converter writes many small per-batch Parquet files per partition
# (~2000/day) and is at-least-once, so a hard crash / log re-read can leave
# overlapping rows. This job folds each multi-file partition into a single
# DISTINCT-deduped file (dedup_parquet_store.py --execute, which only touches
# partitions with >= 2 files; clean single-file partitions are skipped).
#
# Safe to run while the converter is live: dedup snapshots the file list, writes
# a verified staging file, then swaps it in; any file the converter writes
# mid-run is simply left for the next night. Originals go to data/mbo-parquet/
# .trash (not hard-deleted).
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
