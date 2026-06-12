#!/bin/bash
# MBO ingest wrapper — ES symbol only.
#
# Runs in parallel with mbo-ingest-nq.sh (independent files, no shared
# order IDs). 5-second sleep at start staggers the initial SQLite writes
# so both processes don't hit the WAL with their first transaction at
# the same instant. The pgrep guard is scoped to ES runs only.
#
# Logs to ~/Library/Logs/cockpit-mbo-ingest-es.log.

set -uo pipefail

LOG=~/Library/Logs/cockpit-mbo-ingest-es.log
mkdir -p "$(dirname "$LOG")"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

echo "" >> "$LOG"
echo "==[ $(ts) ]== mbo-ingest-es cron fire" >> "$LOG"

# Stagger 5s after NQ to avoid first-write SQLite contention. Cheap insurance —
# WAL handles concurrent writers correctly, but reducing simultaneity helps
# latency for both processes.
sleep 5

# Symbol-scoped pgrep — only skip if a prior ES ingest is still running.
if pgrep -f 'tsx.*mbo_ingest.*--symbol ES' >/dev/null 2>&1; then
  echo "  skipped — previous ES ingest still running" >> "$LOG"
  exit 0
fi

export PATH="/Users/ravikumarbasker/.local/share/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HOME=/Users/ravikumarbasker

cd /Users/ravikumarbasker/trading-cockpit || { echo "  ERROR: repo not found" >> "$LOG"; exit 1; }

pnpm --filter @trading/aggregator exec tsx scripts/mbo_ingest.ts --symbol ES 2>&1 \
  | tail -40 >> "$LOG"

echo "==[ $(ts) ]== mbo-ingest-es done" >> "$LOG"
