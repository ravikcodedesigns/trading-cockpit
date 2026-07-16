#!/bin/bash
# Nightly TAPE recalibration — replays every detector over the full parquet MBO store and
# rewrites data/tape-calibration.json (per-symbol + per-time-of-day percentile tiers, depth
# metrics, calibrated floors). The live engine hot-reloads the file within 5 minutes
# (src/tape/calibration.ts), no restart needed. Needs the 24G heap — 23M-event days OOM the
# 4G default. Runs 22:30 ET, after the outcome labeler, before the 03:10 parquet compaction.
set -uo pipefail
LOG=~/Library/Logs/cockpit-tape-recalibrate.log
mkdir -p "$(dirname "$LOG")"
export PATH="/Users/ravikumarbasker/.local/share/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd /Users/ravikumarbasker/trading-cockpit/apps/aggregator
{
  echo "──── $(date '+%Y-%m-%d %H:%M:%S %Z') tape recalibration ────"
  NODE_OPTIONS=--max-old-space-size=24576 pnpm exec tsx scripts/calibrate_tape.ts
  echo "──── done $(date '+%H:%M:%S') ────"
} >> "$LOG" 2>&1
