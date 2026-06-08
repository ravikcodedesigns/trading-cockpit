#!/bin/bash
# Wrapper for the daily structural-levels cron job.
# Runs `pnpm levels:structural` on weekdays at 9:23 AM ET (pre-RTH).
# Logs to ~/Library/Logs/cockpit-structural-levels.log.

set -uo pipefail

LOG=~/Library/Logs/cockpit-structural-levels.log
mkdir -p "$(dirname "$LOG")"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

echo "" >> "$LOG"
echo "==[ $(ts) ]== structural-levels cron fire" >> "$LOG"

export PATH="/Users/ravikumarbasker/.local/share/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HOME=/Users/ravikumarbasker

cd /Users/ravikumarbasker/trading-cockpit || { echo "  ERROR: repo not found" >> "$LOG"; exit 1; }

pnpm --filter @trading/aggregator levels:structural 2>&1 | tail -30 >> "$LOG"

echo "==[ $(ts) ]== structural-levels done" >> "$LOG"
