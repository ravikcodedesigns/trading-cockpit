#!/bin/bash
# MBO ingest wrapper — NQ symbol only.
#
# Runs in parallel with mbo-ingest-es.sh (independent files, no shared
# order IDs). The pgrep guard is scoped to NQ runs only so the ES
# wrapper is not blocked.
#
# Logs to ~/Library/Logs/cockpit-mbo-ingest-nq.log.

set -uo pipefail

LOG=~/Library/Logs/cockpit-mbo-ingest-nq.log
mkdir -p "$(dirname "$LOG")"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

echo "" >> "$LOG"
echo "==[ $(ts) ]== mbo-ingest-nq cron fire" >> "$LOG"

# Symbol-scoped pgrep — only skip if a prior NQ ingest is still running.
# An ES ingest in flight does NOT block this NQ run.
if pgrep -f 'tsx.*mbo_ingest.*--symbol NQ' >/dev/null 2>&1; then
  echo "  skipped — previous NQ ingest still running" >> "$LOG"
  exit 0
fi

# launchd doesn't inherit user shell PATH; resolve pnpm + node explicitly.
export PATH="/Users/ravikumarbasker/.local/share/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HOME=/Users/ravikumarbasker

cd /Users/ravikumarbasker/trading-cockpit || { echo "  ERROR: repo not found" >> "$LOG"; exit 1; }

# Tail the result summary into our log
pnpm --filter @trading/aggregator exec tsx scripts/mbo_ingest.ts --symbol NQ 2>&1 \
  | tail -40 >> "$LOG"

echo "==[ $(ts) ]== mbo-ingest-nq done" >> "$LOG"
