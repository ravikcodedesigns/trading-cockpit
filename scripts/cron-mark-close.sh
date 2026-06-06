#!/bin/bash
# 4:05 PM ET weekday cron wrapper.
#
# Workflow:
#   1. Compute STRUCTURAL LEVELS for tomorrow's session — uses today's RTH as
#      "prior day", so PDH/PDL/PDC/POC/VAH/VAL are ready. ONH/ONL/ONO will be
#      empty/zero at 16:05 (no overnight yet) — they backfill naturally if the
#      script is re-run in the morning.
#   2. Mark NQ Close / ES Close on TODAY's entry AND tomorrow's entry. After
#      16:00 ET, tradingDayFor() rolls the cockpit to tomorrow's session, so
#      the close marker has to live in both day blocks for continuity.
#
# Output appended to /Users/ravikumarbasker/trading-cockpit/logs/close-level.log

export PATH="/opt/homebrew/bin:/opt/homebrew/opt/node@20/bin:/usr/local/bin:/usr/bin:/bin"
cd /Users/ravikumarbasker/trading-cockpit

# Compute tomorrow's date in ET (skip weekends)
TOMORROW=$(TZ=America/New_York python3 -c "
import datetime
d = datetime.date.today()
while True:
    d = d + datetime.timedelta(days=1)
    if d.weekday() < 5:
        break
print(d.isoformat())
")

echo ''
echo "═══ $(date) ═══"
echo "[cron] computing structural levels for $TOMORROW (tomorrow)"
pnpm --filter @trading/aggregator exec tsx scripts/compute_structural_levels.ts --date $TOMORROW || true

echo "[cron] marking close levels (today + tomorrow)"
pnpm --filter @trading/aggregator exec tsx scripts/mark_close_level.ts || true

echo "[cron] done"
