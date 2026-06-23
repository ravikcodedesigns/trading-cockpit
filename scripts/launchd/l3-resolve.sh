#!/bin/bash
# Post-close (16:35 ET, Mon-Fri) resolve of the day's L3 decisions to WIN/LOSS/OPEN
# at fixed brackets (NQ 40/40, ES 10/10) for the shadow-week scoring. No orders.
export PATH="/opt/homebrew/bin:$PATH"
cd /Users/ravikumarbasker/trading-cockpit || exit 1
exec pnpm --filter @trading/aggregator exec tsx scripts/l3-decision-resolve.ts
