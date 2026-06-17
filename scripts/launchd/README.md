# Cockpit launchd jobs

Persistent macOS schedulers for the recurring + one-shot cron-style jobs we
previously ran via Claude's `[session-only]` crons. Survives Claude session
deaths, terminal closes, and machine restarts.

## What's in here

| Plist | Schedule | What it does |
|---|---|---|
| `com.cockpit.mbo-parquet-converter.plist` | Long-running (tail, KeepAlive) | Follows `~/cockpit-mbo-capture/*.log` and writes the Parquet store (`data/mbo-parquet/`). **Replaced the old SQLite `mbo-ingest` crons (retired 2026-06-16).** |
| `com.cockpit.parquet-compaction.plist` | Daily 03:10 local | Compacts each day's ~2000 tail files into one DISTINCT-deduped file (`dedup_parquet_store.py`). |
| `com.cockpit.structural-levels.plist` | Mon-Fri 9:23 AM local | Pre-RTH compute of PDH/PDL/PDC/ONH/ONL/ONO/POC/VAH/VAL into `daily_levels.json` |
| `com.cockpit.structural-levels-evening.plist` | Mon-Fri 17:55 local | Post-RTH session-derived levels + next-day prefill |
| `com.cockpit.reminder-cvd.plist` | One-shot 2026-06-09 8:43 AM | Reminder: re-evaluate CVD short-gate (`cvdShortFloor=+3000` for wall-broken-fade). Self-disables after firing. |
| `com.cockpit.reminder-flipshorts.plist` | One-shot 2026-07-07 8:53 AM | Reminder: re-evaluate FLIP SHORTS in qualified_signals after 5+ weeks of data. Self-disables after firing. |

The two reminders show a macOS notification (Notification Center) and write to
`~/Library/Logs/cockpit-reminders.log`.

## Install

```bash
bash ~/trading-cockpit/scripts/launchd/install-all.sh
```

What it does:
1. `chmod +x` the wrapper scripts (mbo-parquet-converter.sh, parquet-compaction.sh, structural-levels.sh, reminder.sh)
2. Copies each `com.cockpit.*.plist` to `~/Library/LaunchAgents/`
3. `launchctl bootstrap`s each one under your gui session (`gui/$(id -u)`)

Idempotent — safe to re-run after editing plists or wrapper scripts.

## Verify

```bash
launchctl list | grep cockpit
```

Should show all 4 with PID `-` (not currently running) and exit code `0`
(last run succeeded).

## Logs

| File | Source |
|---|---|
| `~/Library/Logs/cockpit-mbo-parquet.log` | parquet converter (tail) output (flush summaries) |
| `~/Library/Logs/cockpit-parquet-compaction.log` | nightly compaction output |
| `~/Library/Logs/cockpit-structural-levels.log` | structural-levels wrapper output |
| `~/Library/Logs/cockpit-structural-levels.stdout.log` | raw stdout |
| `~/Library/Logs/cockpit-structural-levels.stderr.log` | launchctl errors |
| `~/Library/Logs/cockpit-reminders.log` | reminder firings + self-disable events |

Tail the wrapper logs to verify jobs fire correctly:

```bash
tail -f ~/Library/Logs/cockpit-mbo-parquet.log
tail -f ~/Library/Logs/cockpit-structural-levels.log
tail -f ~/Library/Logs/cockpit-reminders.log
```

## Uninstall

```bash
bash ~/trading-cockpit/scripts/launchd/uninstall-all.sh
```

Removes all `com.cockpit.*.plist` from `~/Library/LaunchAgents/` and unloads
them via `launchctl bootout`.

## Edit / re-install workflow

To change a schedule or wrapper logic:

1. Edit the `.plist` or `.sh` in this folder (repo).
2. Re-run `install-all.sh` — it unloads the existing version before bootstrapping the new one.
3. Verify with `launchctl list | grep cockpit`.

The plist files in `~/Library/LaunchAgents/` are *copies* — the repo source is
the canonical version. Don't edit the live copies directly or you'll lose
changes on next install.

## How the recurring jobs avoid pile-up

- **mbo-parquet-converter.sh** is a single long-running daemon (KeepAlive),
  not a cron — only one instance runs, so no overlap. It checkpoints per log
  file and is at-least-once (flush-then-checkpoint), with the nightly
  compaction deduping any overlap.
- **parquet-compaction.sh** snapshots the file list, writes a verified staging
  file, then swaps it in — safe to run while the converter is live.
- **structural-levels.sh** writes to a JSON file (not SQLite) and runs
  quickly (<10s typical), so overlap is unlikely.

## How the one-shot reminders self-disable

macOS `launchd` doesn't support true "fire-once-and-die" calendars — `StartCalendarInterval`
fires every year on the same date forever. Workaround:

1. The wrapper script (`reminder.sh`) takes a target year as an argument.
2. If `$(date +%Y) != target_year`, exit silently (no notification, no self-removal).
3. If matched, show notification, then `launchctl bootout` + `rm` the plist.

So the reminder fires exactly once at its scheduled date+time, then removes
itself. Subsequent years would have no plist installed = nothing fires.

## Plists vs Claude session crons

| Aspect | Claude session crons | launchd plists |
|---|---|---|
| Survives session death | ✗ | ✓ |
| Survives Mac restart | ✗ | ✓ |
| Visible in cockpit notifications | ✓ (via Claude UI) | ✗ (macOS Notification Center only) |
| Easy to inspect | `CronList` tool | `launchctl list \| grep cockpit` |
| Easy to edit | re-create via `CronCreate` | edit plist + re-install |
| Time to first run | Immediate | After install + next schedule tick |

For operational tasks (MBO ingest, structural levels), launchd is strictly
better. For lightweight reminders, Claude crons are slightly more ergonomic
but vanish on session end.
