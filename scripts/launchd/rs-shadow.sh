#!/bin/bash
# Wrapper for the EST shadow harness (apps/aggregator/scripts/rs-shadow.ts).
# Persistent loop — self-gates to RTH (09:30–16:00 ET); run under launchd KeepAlive.
# INTERVAL comes from the plist EnvironmentVariables. Logs → plist StandardOut/ErrPath.
set -uo pipefail

export PATH="/Users/ravikumarbasker/.local/share/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HOME=/Users/ravikumarbasker

cd /Users/ravikumarbasker/trading-cockpit || exit 1
exec pnpm --filter @trading/aggregator shadow
