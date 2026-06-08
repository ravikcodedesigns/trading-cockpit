#!/bin/bash
# Generic reminder wrapper for one-shot launchd plists.
#
# Usage:
#   reminder.sh <plist-label> <target-year> "<title>" "<message>"
#
# Behavior:
#   1. If today's year != target-year → exit silently (plist re-fires annually
#      until manually unloaded; we self-unload after the target year fires).
#   2. Show macOS notification + log + (optional) Discord ping.
#   3. Unload + delete the plist so it doesn't fire next year.
#
# Plist label must match the filename: e.g. com.cockpit.reminder-cvd
# (plist file: ~/Library/LaunchAgents/<label>.plist)

set -uo pipefail

LABEL="${1:?missing plist label}"
TARGET_YEAR="${2:?missing target year}"
TITLE="${3:?missing title}"
MESSAGE="${4:?missing message}"

LOG=~/Library/Logs/cockpit-reminders.log
mkdir -p "$(dirname "$LOG")"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
CURRENT_YEAR=$(date +%Y)

if [[ "$CURRENT_YEAR" != "$TARGET_YEAR" ]]; then
  # Year doesn't match — silently skip. Plist auto-disables after target year.
  exit 0
fi

echo "" >> "$LOG"
echo "==[ $(ts) ]== reminder fired: $LABEL" >> "$LOG"
echo "  $TITLE — $MESSAGE" >> "$LOG"

# macOS notification (visible in Notification Center)
/usr/bin/osascript -e "display notification \"$MESSAGE\" with title \"$TITLE\" sound name \"Glass\"" 2>>"$LOG" || true

# Self-disable: unload + delete the plist so it never fires again.
PLIST=~/Library/LaunchAgents/${LABEL}.plist
if [[ -f "$PLIST" ]]; then
  /bin/launchctl bootout "gui/$(id -u)" "$PLIST" 2>>"$LOG" || true
  /bin/rm -f "$PLIST"
  echo "  self-disabled: removed $PLIST" >> "$LOG"
fi

echo "==[ $(ts) ]== reminder done" >> "$LOG"
