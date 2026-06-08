#!/bin/bash
# Uninstall all cockpit launchd plists.

set -euo pipefail

DEST_DIR=~/Library/LaunchAgents
UID_GUI="gui/$(id -u)"

for PLIST in "$DEST_DIR"/com.cockpit.*.plist; do
  [[ -f "$PLIST" ]] || continue
  NAME=$(basename "$PLIST")
  LABEL="${NAME%.plist}"

  /bin/launchctl bootout "$UID_GUI/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✓ unloaded + removed $LABEL"
done

echo ""
echo "All cockpit launchd jobs removed."
