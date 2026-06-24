#!/bin/bash
# Wrapper for the L3 DECISION worker (apps/aggregator/scripts/l3-decision-worker.ts).
# Consumes touch events from the book builder via the UDS push, runs the framework
# engines + L3 confirmation → data/l3-shadow.db l3_trade_decisions. Restart this freely
# to iterate on engines/confirm — the in-memory book is in the SEPARATE l3-book-worker
# and is never rebuilt. Shadow only — NO orders. Run under launchd KeepAlive.
set -uo pipefail
export PATH="/Users/ravikumarbasker/.local/share/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HOME=/Users/ravikumarbasker
cd /Users/ravikumarbasker/trading-cockpit || exit 1
exec pnpm --filter @trading/aggregator l3:decider
