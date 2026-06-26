#!/bin/bash
# Daily data-integrity verifier — the CHEAP recurring check.
# Runs ~04:00 local (after the 03:10 compaction finishes) over only the last few
# completed ET-days, so it's seconds not hours. Flags compaction backlog, duplicate
# rows, capture gaps, CQG drift, converter crashes. Logs to
# ~/Library/Logs/cockpit-data-integrity.log; non-zero exit + optional Discord on flags.
set -uo pipefail

LOG=~/Library/Logs/cockpit-data-integrity.log
mkdir -p "$(dirname "$LOG")"
export HOME=/Users/ravikumarbasker
REPO=/Users/ravikumarbasker/trading-cockpit
VENV="$REPO/scripts/.venv-mbo"

cd "$REPO" || { echo "$(date '+%F %T')  ERROR: repo not found" >> "$LOG"; exit 1; }
echo "==[ $(date '+%F %T') ]== data-integrity check starting" >> "$LOG"
PYTHONUNBUFFERED=1 "$VENV/bin/python" "$REPO/scripts/data_integrity_check.py" --days 3 >> "$LOG" 2>&1
RC=$?
echo "==[ $(date '+%F %T') ]== data-integrity check done (exit $RC)" >> "$LOG"
exit $RC
