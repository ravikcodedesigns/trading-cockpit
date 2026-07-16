#!/bin/bash
# Nightly TAPE outcome labeler — stamps fixed-horizon (+30s/+2m/+5m) signed-tick outcomes on
# every unlabeled row in data/tape-events.db, from the parquet trade tape, signed by each
# event's expected direction (src/tape/direction.ts). The falsifiability layer of the 2026-07-15
# detector audit: every detector accrues P(move | kind/tier/at-structure) instead of priors.
# Runs 22:00 ET, well after the session; days whose parquet hasn't converted defer to next run.
set -uo pipefail
LOG=~/Library/Logs/cockpit-tape-outcomes.log
mkdir -p "$(dirname "$LOG")"
export PATH="/Users/ravikumarbasker/.local/share/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd /Users/ravikumarbasker/trading-cockpit/apps/aggregator
{
  echo "──── $(date '+%Y-%m-%d %H:%M:%S %Z') tape outcome labeling ────"
  pnpm exec tsx scripts/label_tape_outcomes.ts
  echo "──── done $(date '+%H:%M:%S') ────"
} >> "$LOG" 2>&1
