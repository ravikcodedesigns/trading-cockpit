#!/bin/bash
# Wrapper for the Lightspeed L3 book worker (apps/aggregator/scripts/l3-book-worker.ts).
# Continuous — tails the live full-size NQ+ES Bookmap .log, maintains the L3 book,
# and logs per-RS-level L3 confluence snapshots to data/l3-shadow.db. Shadow only —
# NO orders. Run under launchd KeepAlive so it seeds the book across the session and
# follows the per-ET-day log rollover. Logs → plist StandardOut/ErrPath.
set -uo pipefail

export PATH="/Users/ravikumarbasker/.local/share/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HOME=/Users/ravikumarbasker

cd /Users/ravikumarbasker/trading-cockpit || exit 1
exec pnpm --filter @trading/aggregator l3:worker
