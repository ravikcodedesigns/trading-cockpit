#!/bin/bash
# Install all cockpit launchd plists.
#
# Copies each .plist from this folder to ~/Library/LaunchAgents/ and bootstraps
# it via launchctl. Idempotent — safe to re-run.
#
# To uninstall: see uninstall-all.sh

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR=~/Library/LaunchAgents
UID_GUI="gui/$(id -u)"

mkdir -p "$DEST_DIR"

# Make wrapper scripts executable
chmod +x "$SRC_DIR/mbo-ingest.sh" \
         "$SRC_DIR/structural-levels.sh" \
         "$SRC_DIR/reminder.sh"

for PLIST in "$SRC_DIR"/com.cockpit.*.plist; do
  NAME=$(basename "$PLIST")
  LABEL="${NAME%.plist}"
  DEST="$DEST_DIR/$NAME"

  # Unload any previous version to ensure clean bootstrap
  if /bin/launchctl print "$UID_GUI/$LABEL" >/dev/null 2>&1; then
    /bin/launchctl bootout "$UID_GUI/$LABEL" 2>/dev/null || true
  fi

  cp "$PLIST" "$DEST"
  /bin/launchctl bootstrap "$UID_GUI" "$DEST"
  echo "✓ loaded $LABEL"
done

echo ""
echo "All launchd jobs installed. Verify with:"
echo "  launchctl list | grep cockpit"
echo ""
echo "Logs:"
echo "  ~/Library/Logs/cockpit-mbo-ingest.log"
echo "  ~/Library/Logs/cockpit-structural-levels.log"
echo "  ~/Library/Logs/cockpit-reminders.log"
