#!/bin/bash
# Weekly registrations probation board — runs registrations_status.ts
# (counts accrued evidence for every OPEN registration in
# docs/cracker-registrations.json), logs the report, and pops a macOS
# notification. If any item prints "DUE", the notification says so —
# that's the signal to run the item's resolver in the next session.
# Recurring (does NOT self-disable, unlike reminder.sh one-shots).
set -uo pipefail
LOG=~/Library/Logs/cockpit-registrations-status.log
mkdir -p "$(dirname "$LOG")"
export PATH="/Users/ravikumarbasker/.local/share/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd /Users/ravikumarbasker/trading-cockpit/apps/aggregator

echo "──── $(date '+%Y-%m-%d %H:%M:%S %Z') weekly registrations status ────" >> "$LOG"
REPORT=$(pnpm exec tsx scripts/registrations_status.ts 2>&1) || true
echo "$REPORT" >> "$LOG"

DUE_COUNT=$(echo "$REPORT" | grep -c 'DUE' || true)
OPEN_COUNT=$(echo "$REPORT" | grep -cE '^\s+\S+\s+\[' || true)
if [[ "$DUE_COUNT" -gt 0 ]]; then
  MSG="$DUE_COUNT item(s) DUE for resolution — run registrations_status.ts for details"
  SOUND='sound name "Glass"'
else
  MSG="$OPEN_COUNT open item(s), none due yet. Evidence accruing."
  SOUND=''
fi
/usr/bin/osascript -e "display notification \"$MSG\" with title \"Cockpit: registrations probation board\" $SOUND" 2>>"$LOG" || true
echo "──── done $(date '+%H:%M:%S') ────" >> "$LOG"
