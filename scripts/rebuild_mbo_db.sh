#!/usr/bin/env bash
#
# rebuild_mbo_db.sh — Recover from the orphan-inode situation.
#
# Background (2026-06-13):
#   The mbo.db visible file was unlinked at ~14:46 ET while two ingest
#   processes still had file descriptors to the original 277 GB inode. The
#   orphan data is unrecoverable through the filesystem. Source MBO log
#   files in ~/cockpit-mbo-capture/ are intact, so we rebuild from those.
#
# Usage:
#   ./scripts/rebuild_mbo_db.sh prep    # stop processes, unload cron, wipe DB
#   ./scripts/rebuild_mbo_db.sh start   # kick off the rebuild in tmux
#   ./scripts/rebuild_mbo_db.sh status  # tail the rebuild progress
#   ./scripts/rebuild_mbo_db.sh finish  # verify + reload cron after done
#
# Run prep first, then start. Walk away. Come back later and run finish.
# Expected total rebuild time: 24–36 hours of CPU.

set -uo pipefail

REPO="/Users/ravikumarbasker/trading-cockpit"
DB_FILE="$REPO/data/mbo.db"
SOURCE_DIR="$HOME/cockpit-mbo-capture"
LOG_FILE="$HOME/Library/Logs/mbo-rebuild-$(date +%Y%m%d-%H%M%S).log"
TMUX_SESSION="mbo-rebuild"
NQ_PLIST="$HOME/Library/LaunchAgents/com.cockpit.mbo-ingest-nq.plist"
ES_PLIST="$HOME/Library/LaunchAgents/com.cockpit.mbo-ingest-es.plist"

cmd="${1:-}"

# ── Helpers (bash-3.2-compatible; macOS default) ────────────────────────────
log()    { printf '\033[1;36m[%s] %s\033[0m\n' "$(date +%H:%M:%S)" "$*"; }
warn()   { printf '\033[1;33m[%s] WARN: %s\033[0m\n' "$(date +%H:%M:%S)" "$*"; }
err()    { printf '\033[1;31m[%s] ERR:  %s\033[0m\n' "$(date +%H:%M:%S)" "$*"; }
prompt() {
  printf '\033[1;35m%s [y/N] \033[0m' "$*"
  read -r ans
  [[ "$ans" =~ ^[Yy]$ ]]
}

show_running_ingests() {
  local pids
  pids=$(pgrep -f 'mbo_ingest.ts.*--symbol' || true)
  if [[ -z "$pids" ]]; then
    log "  no mbo_ingest processes running"
    return 1
  fi
  for pid in $pids; do
    local started cpu cmd
    started=$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//')
    cpu=$(ps -p "$pid" -o time= 2>/dev/null | sed 's/^[[:space:]]*//')
    cmd=$(ps -p "$pid" -o command= 2>/dev/null | head -c 120)
    log "  PID=$pid started=$started cpu=$cpu cmd=${cmd}…"
  done
  return 0
}

# ── PHASE 1: prep — stop runaway processes + wipe DB ────────────────────────
phase_prep() {
  log "=== PHASE 1: prep ==="

  log "Current state:"
  log "  visible mbo.db:    $(ls -lah "$DB_FILE" 2>/dev/null | awk '{print $5,$6,$7,$8}' || echo 'missing')"
  log "  source MBO files:  $(ls "$SOURCE_DIR"/*.log 2>/dev/null | wc -l | tr -d ' ') files"
  log "  running ingests:"
  show_running_ingests || true

  prompt "Proceed to stop ingest processes + unload cron + wipe DB?" || { log "aborted"; exit 0; }

  log "Unloading launchd plists (stops future cron fires)..."
  launchctl unload "$NQ_PLIST" 2>/dev/null || warn "  NQ plist not loaded"
  launchctl unload "$ES_PLIST" 2>/dev/null || warn "  ES plist not loaded"

  log "Sending SIGTERM to running ingest processes..."
  local pids
  pids=$(pgrep -f 'mbo_ingest.ts.*--symbol' || true)
  if [[ -n "$pids" ]]; then
    for pid in $pids; do
      log "  TERM → PID $pid"
      kill -TERM "$pid" 2>/dev/null || warn "    failed to signal $pid"
    done

    log "Waiting up to 60s for clean exit..."
    for i in {1..60}; do
      pids=$(pgrep -f 'mbo_ingest.ts.*--symbol' || true)
      [[ -z "$pids" ]] && break
      sleep 1
    done

    pids=$(pgrep -f 'mbo_ingest.ts.*--symbol' || true)
    if [[ -n "$pids" ]]; then
      warn "Processes still alive after 60s; sending SIGKILL"
      for pid in $pids; do kill -KILL "$pid" 2>/dev/null || true; done
      sleep 2
    fi
  fi

  pids=$(pgrep -f 'mbo_ingest.ts.*--symbol' || true)
  if [[ -n "$pids" ]]; then
    err "Still have ingest processes alive: $pids"
    exit 1
  fi
  log "All ingest processes stopped."

  log "Wiping DB files..."
  rm -f "$DB_FILE" "$DB_FILE-wal" "$DB_FILE-shm"
  log "  done. Visible mbo.db: $(ls -lah "$DB_FILE" 2>/dev/null || echo 'gone (good)')"

  log ""
  log "PREP COMPLETE. Next: ./scripts/rebuild_mbo_db.sh start"
}

# ── PHASE 2: start — kick off rebuild in tmux ───────────────────────────────
phase_start() {
  log "=== PHASE 2: start rebuild ==="

  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    err "tmux session '$TMUX_SESSION' already exists. Attach with: tmux attach -t $TMUX_SESSION"
    exit 1
  fi

  if [[ -s "$DB_FILE" ]]; then
    err "$DB_FILE exists and is non-empty (size=$(stat -f %z "$DB_FILE")). Run 'prep' first."
    exit 1
  fi

  if ! command -v tmux >/dev/null; then
    err "tmux not installed. Install: brew install tmux"
    exit 1
  fi

  local n_files
  n_files=$(ls "$SOURCE_DIR"/*.log 2>/dev/null | wc -l | tr -d ' ')
  log "Source files to ingest: $n_files"
  log "Log file:               $LOG_FILE"
  log "tmux session:           $TMUX_SESSION"
  log ""
  log "Starting rebuild in detached tmux session..."

  # The rebuild — uses default mbo_ingest behavior with --rebuild flag to
  # wipe-and-recreate. Output goes to log file AND tmux scrollback.
  tmux new-session -d -s "$TMUX_SESSION" \
    "cd $REPO && \
     pnpm --filter @trading/aggregator exec tsx scripts/mbo_ingest.ts --rebuild 2>&1 | tee '$LOG_FILE'; \
     echo '======================================'; \
     echo 'REBUILD FINISHED at $(date)'; \
     echo 'Run: ./scripts/rebuild_mbo_db.sh finish'; \
     echo '======================================'; \
     read -p 'Press any key to close tmux pane...'"

  log "Rebuild running. Useful commands:"
  log "  tail progress:   tail -F '$LOG_FILE'"
  log "  attach tmux:     tmux attach -t $TMUX_SESSION"
  log "  detach:          Ctrl-b then d"
  log "  status check:    ./scripts/rebuild_mbo_db.sh status"
  log ""
  log "Walk away. Expected duration: 24–36 hours."
}

# ── PHASE 3: status — quick progress check ──────────────────────────────────
phase_status() {
  log "=== Rebuild status ==="
  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    log "  tmux session ACTIVE: $TMUX_SESSION"
  else
    log "  tmux session NOT running"
  fi
  log "  visible mbo.db:    $(ls -lah "$DB_FILE" 2>/dev/null | awk '{print $5,$6,$7,$8}' || echo 'missing')"
  log "  most recent log:   $(ls -t "$HOME/Library/Logs/mbo-rebuild-"*.log 2>/dev/null | head -1)"
  log ""
  log "Last 15 lines of most recent log:"
  ls -t "$HOME/Library/Logs/mbo-rebuild-"*.log 2>/dev/null | head -1 | xargs tail -15 2>/dev/null || true
}

# ── PHASE 3: finish — verify + reload cron ──────────────────────────────────
phase_finish() {
  log "=== PHASE 3: finish ==="

  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    warn "tmux session '$TMUX_SESSION' still active — rebuild may not be done"
    prompt "Continue anyway? (will kill the tmux session)" || { log "aborted"; exit 0; }
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  fi

  if [[ ! -s "$DB_FILE" ]]; then
    err "$DB_FILE is missing or empty — rebuild failed?"
    exit 1
  fi

  log "DB size: $(ls -lah "$DB_FILE" | awk '{print $5}')"
  log ""
  log "Per-symbol latest timestamps:"
  sqlite3 "$DB_FILE" "SELECT symbol, datetime(MAX(ts)/1000,'unixepoch','-4 hours') AS latest_et, COUNT(*) AS n_rows FROM trades GROUP BY symbol;" 2>&1

  log ""
  prompt "Reload the per-symbol launchd plists (re-enable cron)?" || { log "skipping reload"; exit 0; }
  launchctl load "$NQ_PLIST" 2>&1
  launchctl load "$ES_PLIST" 2>&1
  log "Plists reloaded. Verify with: launchctl list | grep mbo-ingest"

  log ""
  log "REBUILD COMPLETE."
}

# ── Dispatch ────────────────────────────────────────────────────────────────
case "$cmd" in
  prep)   phase_prep ;;
  start)  phase_start ;;
  status) phase_status ;;
  finish) phase_finish ;;
  *)
    cat <<EOF
Usage: $0 {prep|start|status|finish}

  prep    — stop running ingests, unload cron plists, wipe DB files
  start   — kick off the full rebuild in a detached tmux session
  status  — check rebuild progress (DB size, tmux session, log tail)
  finish  — verify rebuild + reload cron plists

Run in order: prep → start → (walk away) → status (occasionally) → finish

Log:   $LOG_FILE
Source files: $SOURCE_DIR
DB file:      $DB_FILE
EOF
    exit 1
    ;;
esac
