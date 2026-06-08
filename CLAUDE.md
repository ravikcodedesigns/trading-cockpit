# Trading Cockpit — Claude Code Project Instructions

> Auto-loaded by Claude Code at session start. Keep this file short — it's part of every prompt.

## Read this first

Before answering any non-trivial question or making any code change, **read `./HANDOFF.md`** (838 lines, sectioned). It contains:

- Repo layout, schemas, signal strategies, V3 framework
- WR/PnL data per cohort
- Trader integration, race conditions, race-safety design
- Cockpit features, conventions, pending tasks
- Open questions and immediate next-steps

Skim the table of contents (section headings) and read the relevant sections in detail. The HANDOFF is the single source of truth for project state as of 2026-06-07.

After reading the HANDOFF, also check:
- `git log --oneline -10` to see what's changed since the doc was written
- `git status` to see uncommitted work
- TaskList (via the TaskList tool) for current task state

## Hard rules — non-negotiable

These apply to **every** interaction:

1. **NEVER place broker orders directly via curl/Bash/scripts without explicit per-order user confirmation.**
   The trader daemon placing orders autonomously when picking up real V3 signals = standing consent.
   You issuing a broker API call = requires confirmation for that specific order.

2. **NEVER report MFE/MAE.** Only WIN/LOSS/OPEN at fixed TP/SL. Per the user's stated rule for backtests.

3. **NEVER use lagging indicators** (EMA, RSI, MACD) in any analysis or recommendation. The user explicitly rejects them. Use VWAP, CVD, volume profile, liquidity zones, structural levels instead.

4. **Versioning workflow**: every meaningful iteration of a strategy gets a NEW file. Don't overwrite v1 to make v2 — create v2 alongside.

5. **Levels JSON color palette**: when generating or updating `daily_levels.json` / `daily_levels_es.json`, import the standardized palette from `@trading/contracts` (`LEVEL_STYLES`). Don't hardcode colors.

6. **Never skip git hooks** (`--no-verify`) or bypass signing unless the user explicitly asks.

## Working directory & key paths

- **Repo root**: `/Users/ravikumarbasker/trading-cockpit`
- **Aggregator**: `apps/aggregator/` (port 8787, fastify + sqlite)
- **Cockpit**: `apps/cockpit/` (port 5173, vite + react + lightweight-charts)
- **Trader**: `apps/trader/` (port 8788, fastify + tradovate)
- **Contracts**: `packages/contracts/` (shared TS types + LEVEL_STYLES palette)
- **MBO capture**: `~/cockpit-mbo-capture/` (outside repo)
- **Data**: `data/` (3 SQLite DBs, gitignored)

## Common ops

```bash
# Dev environment
cd ~/trading-cockpit && pnpm dev

# Incremental MBO ingest (manually triggered)
cd ~/trading-cockpit && pnpm --filter @trading/aggregator exec tsx scripts/mbo_ingest.ts

# Re-qualify all signals (bump GATE_VERSION in reapply_quality_gates.ts first)
cd ~/trading-cockpit && pnpm --filter @trading/aggregator qualify

# Compute structural levels (pre-RTH)
cd ~/trading-cockpit && pnpm --filter @trading/aggregator levels:structural

# Run any backtest
cd ~/trading-cockpit && pnpm --filter @trading/aggregator exec tsx scripts/<name>.ts

# Typecheck before commits
cd ~/trading-cockpit/apps/<app> && pnpm typecheck
```

## Communication style

The user (Ravi) prefers:
- **Terse, direct responses** — no preamble, no excessive caveats
- **Tables for dense info** — easier to scan than prose
- **File:line citations** when referencing code
- **Honest assessments** — don't soft-pedal trade-offs
- **Markdown formatting** — but no emojis unless he uses them first

When proposing changes that affect live trading (V3 config, trader rules, position sizing): **always quantify the impact** before shipping. Use the perf scripts in `apps/aggregator/scripts/`.

## When the user asks for an MBO ingest

It happens every ~30 minutes during active sessions. Always:
1. Check `pgrep -f mbo_ingest` first to avoid concurrent SQLite writes
2. If clean, run the ingest
3. Report a 1-line summary: which files had new bytes, MB ingested, parse errors

Never report MFE/MAE for trades. Repeat for emphasis.

## When in doubt

- **Verify against current code, not just docs/memories**. HANDOFF.md is a point-in-time snapshot.
- Ask the user for clarification on ambiguous requests rather than guessing.
- For backtest math, use existing scripts in `apps/aggregator/scripts/` as templates — don't reinvent the conventions.
