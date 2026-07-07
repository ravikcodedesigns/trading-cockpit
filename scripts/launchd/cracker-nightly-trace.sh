#!/bin/bash
# Nightly Cracker trace fill — appends newly completed days to both trace DBs
# (L3 mini → cracker-trace.db, L2 micro → cracker-trace-l2.db, NQ + ES each).
# TRACE_NEW=1 skips days already present and the current (incomplete) ET day;
# the full day list still provides causal context for placebos/profiles.
# Runs at 04:35 ET, after the 03:10 parquet compaction. Research-only: fills
# the Phase-5 lockbox; the harness refuses to READ days beyond the freeze.
set -uo pipefail
LOG=~/Library/Logs/cockpit-cracker-trace.log
mkdir -p "$(dirname "$LOG")"
export PATH="/Users/ravikumarbasker/.local/share/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd /Users/ravikumarbasker/trading-cockpit/apps/aggregator
{
  echo "──── $(date '+%Y-%m-%d %H:%M:%S %Z') nightly trace fill ────"
  TRACE_NEW=1 TRACE_KEEP=1                 pnpm exec tsx scripts/cracker_p1_trace.ts
  TRACE_NEW=1 TRACE_KEEP=1 TRACE_SYM=ES    pnpm exec tsx scripts/cracker_p1_trace.ts
  TRACE_NEW=1 TRACE_KEEP=1                 pnpm exec tsx scripts/cracker_p1_trace_l2.ts
  TRACE_NEW=1 TRACE_KEEP=1 TRACE_SYM=ES    pnpm exec tsx scripts/cracker_p1_trace_l2.ts
  echo "──── done $(date '+%H:%M:%S') ────"
} >> "$LOG" 2>&1
