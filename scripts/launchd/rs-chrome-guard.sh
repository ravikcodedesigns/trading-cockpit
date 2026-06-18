#!/bin/bash
# Keeps the debug-port Chrome (9333, Rocket Scooter) up DURING RTH only
# (Mon–Fri 09:30–16:00 ET) for rs-feed's passive reads. Outside RTH it closes
# that Chrome so there's no idle off-hours window. Login persists in the profile,
# so it reopens cleanly each morning. Run under launchd KeepAlive.
PORT=9333
PROFILE="$HOME/.rs-chrome-profile"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# ET weekday + HHMM (base-10 to avoid octal on leading zero)
DOW=$(TZ=America/New_York date +%u)
HM=$((10#$(TZ=America/New_York date +%H%M)))
INRTH=false
if [ "$DOW" -le 5 ] && [ "$HM" -ge 930 ] && [ "$HM" -lt 1600 ]; then INRTH=true; fi

UP=false
curl -s --max-time 3 "http://localhost:$PORT/json/version" >/dev/null 2>&1 && UP=true

if $INRTH; then
  if $UP; then sleep 60; exit 0; fi          # already up — recheck in ~1 min
  exec "$CHROME" --remote-debugging-port=$PORT --user-data-dir="$PROFILE" \
    --no-first-run --no-default-browser-check --restore-last-session
else
  # Outside RTH: don't force Chrome up, and don't kill it (no surprise closes).
  # rs-feed is idle off-hours anyway, so it doesn't need Chrome then. Just idle.
  sleep 300
  exit 0
fi
