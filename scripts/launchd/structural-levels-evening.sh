#!/bin/bash
# Wrapper for the evening structural-levels cron job.
# Runs `pnpm levels:structural:evening` on weekdays at 17:55 ET (after RTH close).
# Writes TODAY's session-derived labels (IBH/IBL/RTHO/VWAP/HVN/LVN/WkH/WkL/nPOC)
# to today's entry. Tomorrow's prior-day-derived labels (PDH/PDL/PDC/POC/VAH/VAL)
# are written by the 16:05 cron-mark-close.sh — kept separate so each cron has
# one clear job and the cockpit's 16:00 trading-day rollover has tomorrow's
# levels ready immediately.
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
