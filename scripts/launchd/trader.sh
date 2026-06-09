#!/bin/bash
# Launchd wrapper for the live trader daemon.
#
# Enforces singleton: refuses to start if another trader is already running.
# Logs are captured by launchd via the plist's StandardOutPath/StandardErrorPath
# (~/Library/Logs/cockpit-trader.{stdout,stderr}.log).
#
# Production differences vs. `pnpm dev`:
#   - Uses `pnpm start` (no tsx watch) — no file-change auto-restarts during RTH
#   - Singleton check prevents duplicate Tradovate sessions (the 429 root cause)
#   - `exec` so launchd tracks the trader PID directly, not a wrapper-shell PID

set -uo pipefail

# launchd doesn't inherit shell PATH; resolve pnpm + node explicitly.
export PATH="/Users/ravikumarbasker/.local/share/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HOME=/Users/ravikumarbasker

# Singleton enforcement: bail cleanly if another trader process is already
# running. Matches any node process executing apps/trader/src/index.ts (covers
# both `pnpm dev` and `pnpm start` invocations).
RUNNING=$(pgrep -af 'node.*apps/trader.*src/index' 2>/dev/null \
  | grep -v "$$" || true)
if [ -n "$RUNNING" ]; then
  echo "trader.sh: another trader instance is already running — exiting cleanly:"
  echo "$RUNNING"
  exit 0
fi

cd /Users/ravikumarbasker/trading-cockpit || { echo "ERROR: repo not found"; exit 1; }

# `exec` replaces the shell with pnpm — launchd's KeepAlive + crash detection
# then track the actual trader process, not this wrapper.
exec pnpm --filter @trading/trader start
