#!/bin/bash
# Nightly forward-validation capture of the FILTERED NET-DRIFT SLOPE signal.
# Pulls ABJ-filtered (0DTE/OTM/aggressor) net-drift for SPX+NDX, cumulates the drift
# curve + 10-min rolling slope, persists per-minute rows to data/quantdata.db
# (netdrift_slope). Registered in apps/aggregator/scripts/NETDRIFT_FWD_PREREG.md.
# Runs 17:30 ET (after the 16:00 close + data settle). Captures the last 4 calendar
# days each run (idempotent INSERT OR IGNORE) so missed nights / weekends self-heal;
# weekend/holiday days with no session are skipped gracefully.
set -uo pipefail
LOG=~/Library/Logs/cockpit-netdrift-capture.log
mkdir -p "$(dirname "$LOG")"
export PATH="/Users/ravikumarbasker/.local/share/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd /Users/ravikumarbasker/trading-cockpit/apps/aggregator
{
  echo "──── $(date '+%Y-%m-%d %H:%M:%S %Z') netdrift forward-capture ────"
  for off in 0 1 2 3; do
    D=$(date -v-${off}d +%Y-%m-%d)
    pnpm exec tsx scripts/netdrift_forward_capture.ts "$D"
  done
  echo "──── done $(date '+%H:%M:%S') ────"
} >> "$LOG" 2>&1
