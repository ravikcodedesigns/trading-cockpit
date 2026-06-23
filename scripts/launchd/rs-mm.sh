#!/bin/bash
# MM-only refresh: re-reads the per-symbol Monthly-Map bias (mmBullish) + LM code
# every ~30 min DURING RTH so the auto greater-market tracks price moving into/out
# of zones intraday. Skips the once-daily zones/DD/HP/MHP read (those are set by
# com.cockpit.rs-levels at 09:32). Outside RTH it no-ops — the debug Chrome (:9333)
# is RTH-gated too, so a read off-hours would just fail. Run under launchd
# StartInterval (1800s); the RTH gate keeps it quiet overnight/weekends.
DOW=$(TZ=America/New_York date +%u)                  # 1=Mon .. 7=Sun
HM=$((10#$(TZ=America/New_York date +%H%M)))          # base-10 to avoid octal on leading 0
# RTH = Mon-Fri 09:30-16:00 ET
if [ "$DOW" -gt 5 ] || [ "$HM" -lt 930 ] || [ "$HM" -ge 1600 ]; then exit 0; fi

export PATH="/opt/homebrew/bin:$PATH"
cd /Users/ravikumarbasker/trading-cockpit || exit 1
exec env MM_ONLY=1 CDP_PORT=9333 /opt/homebrew/bin/node scripts/rs-levels.js
