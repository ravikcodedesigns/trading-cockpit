# Trading Cockpit — Claude Code Project Instructions

> Auto-loaded every prompt. RULES only — project state lives in `HANDOFF.md`, durable lessons in memory, research standards in `RESEARCH_PROTOCOL.md`.

## Session boot — before any non-trivial work

1. Read `./HANDOFF.md` — the **START HERE block at the top** routes to the current sections (~1,900 lines, sectioned; §1–§21 are historical). For live config, **trust code over docs**: `apps/trader/.env` (rules, risk caps), `apps/aggregator/src/config.ts`, `apps/aggregator/scripts/reapply_quality_gates.ts` (gate version).
2. `git log --oneline -10` + `git status` — docs lag the tree.
3. For anything touching live trading: verify the trader's Tradovate WS is actually alive (recent "tradovate WS opened" + fresh log mtime). Process running ≠ connected.

## Hard rules — non-negotiable

These apply to **every** interaction:

1. **NEVER place broker orders directly via curl/Bash/scripts without explicit per-order user confirmation.**
   The trader daemon placing orders autonomously when picking up real tradable signals = standing consent.
   You issuing a broker API call = requires confirmation for that specific order.

2. **NEVER report MFE/MAE.** Only WIN/LOSS/OPEN at fixed TP/SL. Per the user's stated rule for backtests.

3. **NEVER use lagging indicators** (EMA, RSI, MACD) in any analysis or recommendation. The user explicitly rejects them. Use VWAP, CVD, volume profile, liquidity zones, structural levels instead.

4. **Versioning workflow**: every meaningful iteration of a strategy gets a NEW file. Don't overwrite v1 to make v2 — create v2 alongside.

5. **Levels JSON color palette**: when generating or updating `daily_levels.json` / `daily_levels_es.json`, import the standardized palette from `@trading/contracts` (`LEVEL_STYLES`). Don't hardcode colors.

6. **Never skip git hooks** (`--no-verify`) or bypass signing unless the user explicitly asks.

7. **RS platform boundary**: passive CDP reads of the debug Chrome only. NEVER call the RS platform's API or drive its UI.

## Research standards

Read `./RESEARCH_PROTOCOL.md` before running or judging any backtest/study. Non-negotiables: expectancy at fixed pre-registered brackets; chronological train/test + placebo null; beat a baseline, not zero; check its **settled-nulls list** before proposing a study — most past "edges" died OOS and must not be relitigated without materially new data.

## Working directory & key paths

- **Repo root**: `/Users/ravikumarbasker/trading-cockpit`
- **Aggregator**: `apps/aggregator/` — Fastify HTTP + WS, **port 8787**
- **Tick-store**: `apps/tick-store/` — HTTP + WS ingest, **port 8788**
- **Cockpit**: `apps/cockpit/` — Vite dev server, **port 5173** (proxies to 8787)
- **Trader**: `apps/trader/` — **no HTTP server**; outbound SSE → 8787, outbound WS → Tradovate
- **Contracts**: `packages/contracts/` (shared types + LEVEL_STYLES)
- **Data**: `data/` — multiple SQLite DBs (trading, ticks, positions, level-memory, quantdata, rs-*…) + parquet stores (`ticks-parquet/`, `mbo-parquet/`), all gitignored
- **MBO capture**: `~/cockpit-mbo-capture/` (outside repo; launchd converter → parquet, no manual ingest)

**Port assignments are fixed — do not change.** Full topology: HANDOFF §2.5.

## Common ops

```bash
cd ~/trading-cockpit && pnpm dev                                   # dev environment
pnpm --filter @trading/aggregator qualify                          # re-qualify signals (bump GATE_VERSION first)
pnpm --filter @trading/aggregator levels:structural                # structural levels (pre-RTH)
pnpm --filter @trading/aggregator exec tsx scripts/<name>.ts       # any backtest/research script
cd apps/<app> && pnpm typecheck                                    # before commits
```

For backtest math, use existing scripts in `apps/aggregator/scripts/` as templates — don't reinvent conventions.

## Communication style

The user (Ravi) prefers:
- **Terse, direct responses** — no preamble, no excessive caveats
- **Tables for dense info**; plain conversational language for narrative answers
- **File:line citations** when referencing code
- **Honest assessments** — verdicts, not hedging
- No emojis unless he uses them first
- All timestamps in **ET**

When proposing changes that affect live trading: **always quantify the impact first** using the perf scripts.

## When in doubt

- **Verify against current code, not docs/memories** — every doc is a point-in-time snapshot.
- Ask for clarification on ambiguous requests rather than guessing.
- Destructive ops: show exact rows/files to be removed and pause for sign-off — "go ahead" is not blanket consent.
