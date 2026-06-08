#!/bin/bash
# Wrapper for the MBO ingest cron job.
#
# Skips if another mbo_ingest run is already in progress (avoids concurrent
# SQLite writes). Logs to ~/Library/Logs/cockpit-mbo-ingest.log.

set -uo pipefail

LOG=~/Library/Logs/cockpit-mbo-ingest.log
mkdir -p "$(dirname "$LOG")"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

echo "" >> "$LOG"
echo "==[ $(ts) ]== mbo-ingest cron fire" >> "$LOG"

if pgrep -f 'tsx.*mbo_ingest' >/dev/null 2>&1; then
  echo "  skipped — previous mbo_ingest still running" >> "$LOG"
  exit 0
fi

# launchd doesn't inherit user shell PATH; resolve pnpm + node explicitly.
export PATH="/Users/ravikumarbasker/.local/share/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HOME=/Users/ravikumarbasker

cd /Users/ravikumarbasker/trading-cockpit || { echo "  ERROR: repo not found" >> "$LOG"; exit 1; }

# Tail the result summary into our log
pnpm --filter @trading/aggregator exec tsx scripts/mbo_ingest.ts 2>&1 \
  | tail -30 >> "$LOG"

echo "==[ $(ts) ]== mbo-ingest done" >> "$LOG"
