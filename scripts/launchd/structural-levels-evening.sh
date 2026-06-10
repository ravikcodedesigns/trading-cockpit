#!/bin/bash
# Wrapper for the evening structural-levels cron job.
# Runs `pnpm levels:structural:evening` on weekdays at 17:55 ET (after RTH close).
# Writes TODAY's session-derived labels (IBH/IBL/RTHO/VWAP/HVN/LVN/WkH/WkL/nPOC)
# to today's entry, AND pre-fills tomorrow's PDH/PDL/PDC/POC/VAH/VAL using today's RTH.
# Logs to ~/Library/Logs/cockpit-structural-levels-evening.log.

set -uo pipefail

LOG=~/Library/Logs/cockpit-structural-levels-evening.log
mkdir -p "$(dirname "$LOG")"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

echo "" >> "$LOG"
echo "==[ $(ts) ]== structural-levels-evening cron fire" >> "$LOG"

export PATH="/Users/ravikumarbasker/.local/share/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HOME=/Users/ravikumarbasker

cd /Users/ravikumarbasker/trading-cockpit || { echo "  ERROR: repo not found" >> "$LOG"; exit 1; }

pnpm --filter @trading/aggregator levels:structural:evening 2>&1 | tail -50 >> "$LOG"

echo "==[ $(ts) ]== structural-levels-evening done" >> "$LOG"
