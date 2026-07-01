#!/bin/bash
# MM-only refresh: re-reads the per-symbol Monthly-Map bias (mmBullish) for NQ+ES
# DURING RTH so the auto greater-market tracks price moving into/out of monthly zones.
# LM is NO LONGER read here (rs-feed owns it via MASTER_TABLE.CPbook every 5s). Skips
# the once-daily zones/DD/HP/MHP read (set by com.cockpit.rs-levels at 09:32). Outside
# RTH it no-ops. Run under launchd StartInterval; the RTH gate keeps it quiet overnight.
DOW=$(TZ=America/New_York date +%u)                  # 1=Mon .. 7=Sun
HM=$((10#$(TZ=America/New_York date +%H%M)))          # base-10 to avoid octal on leading 0
# RTH = Mon-Fri 09:30-16:00 ET. Also skip 09:30-09:35 so the chart 1D-flip doesn't collide
# with the 09:32 levels read (com.cockpit.rs-levels reads 1m chart shapes; we flip to 1D).
if [ "$DOW" -gt 5 ] || [ "$HM" -lt 936 ] || [ "$HM" -ge 1600 ]; then exit 0; fi

export PATH="/opt/homebrew/bin:$PATH"
cd /Users/ravikumarbasker/trading-cockpit || exit 1
exec env MM_ONLY=1 CDP_PORT=9333 /opt/homebrew/bin/node scripts/rs-levels.js
