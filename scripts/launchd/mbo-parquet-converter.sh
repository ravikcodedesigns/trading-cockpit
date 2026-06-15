#!/bin/bash
# MBO → Parquet converter (tail mode).
#
# Long-running daemon: follows ~/cockpit-mbo-capture/*.log and flushes per-batch
# Parquet files into ~/trading-cockpit/data/mbo-parquet/. KeepAlive=true in the
# plist restarts it if it crashes.
#
# Logs to ~/Library/Logs/cockpit-mbo-parquet.log.

set -uo pipefail

LOG=~/Library/Logs/cockpit-mbo-parquet.log
mkdir -p "$(dirname "$LOG")"

export HOME=/Users/ravikumarbasker
REPO=/Users/ravikumarbasker/trading-cockpit
VENV="$REPO/scripts/.venv-mbo"

if [[ ! -x "$VENV/bin/python" ]]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S')  ERROR: venv not found at $VENV — run scripts/.venv-mbo bootstrap first" >> "$LOG"
  exit 1
fi

cd "$REPO" || { echo "$(date '+%Y-%m-%d %H:%M:%S')  ERROR: repo not found" >> "$LOG"; exit 1; }

echo "==[ $(date '+%Y-%m-%d %H:%M:%S') ]== parquet-converter starting tail" >> "$LOG"
exec "$VENV/bin/python" "$REPO/scripts/mbo_parquet_converter.py" tail >> "$LOG" 2>&1
