#!/usr/bin/env bash
# Usage:
#   bash scripts/trader-tail.sh                  → last 200 [trader] lines from the most recent log
#   bash scripts/trader-tail.sh "09:59"          → trader lines containing "09:59" (HH:MM filter)
#   bash scripts/trader-tail.sh "09:59" 60       → ±60 lines of context around matches
#   bash scripts/trader-tail.sh -f               → live follow
#
# Requires the dev session to have been started with the tee command:
#   pnpm dev 2>&1 | tee ~/trading-cockpit/logs/dev-$(date +%Y%m%d-%H%M%S).log

set -euo pipefail

LOGDIR="$HOME/trading-cockpit/logs"
PATTERN="${1:-}"
CONTEXT="${2:-0}"

if [ ! -d "$LOGDIR" ] || [ -z "$(ls -A "$LOGDIR" 2>/dev/null)" ]; then
  echo "No log files in $LOGDIR." >&2
  echo "Restart pnpm dev with: pnpm dev 2>&1 | tee $LOGDIR/dev-\$(date +%Y%m%d-%H%M%S).log" >&2
  exit 1
fi

LATEST=$(ls -t "$LOGDIR"/dev-*.log 2>/dev/null | head -1)
if [ -z "$LATEST" ]; then
  echo "No dev-*.log found in $LOGDIR." >&2
  exit 1
fi

echo "# Source: $LATEST"
echo

if [ "$PATTERN" = "-f" ]; then
  # Live follow (filter to trader lines only)
  tail -f "$LATEST" | grep --line-buffered '\[trader\]'
elif [ -z "$PATTERN" ]; then
  # Default: last 200 trader lines
  grep '\[trader\]' "$LATEST" | tail -200
else
  # Search with optional ±N context
  if [ "$CONTEXT" -gt 0 ]; then
    grep -C "$CONTEXT" "$PATTERN" "$LATEST" | grep -E '(\[trader\]|'"$PATTERN"')' | head -500
  else
    grep '\[trader\]' "$LATEST" | grep "$PATTERN"
  fi
fi
