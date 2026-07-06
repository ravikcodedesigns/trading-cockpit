# Trading Cockpit — Handoff Document

> ## ▶ START HERE — new session, read this first
> **Latest state = §26** (2026-07-02: options-landscape VERDICT + the START of the rigorous ORDERFLOW-SYSTEM rebuild — multi-scale swings + footprint engine + spine/level-memory). Orient in this order:
> **1.** §26.1 (read-first — build state, what's built) → **2.** §26.8 (next-steps) + §26.0 (TL;DR) → **3.** `git log --oneline -10`, `git status`, memories `project_orderflow_system` (NEW — read first), `project_quant_data_phase0` (the options arc + verdict), `project_dda_detector`, `project_l2_touch_decider`.
> **The state in one line:** the Quant Data options pivot ran its full course — rigorous testing (multivariate walk-forward + VRP premium backtests) found **NO directional or premium edge** on NQ/ES after honest OOS + costs; the ONE real deliverable is a validated **volatility/range forecaster** (morning-IV → rest-of-day range, Spearman 0.79). We then pivoted to the **8-layer ORDERFLOW rebuild** (§25.3's design, now being BUILT): a persistent lifecycle **level-memory spine** + **multi-scale swing detector** + **footprint engine**, under a strict research protocol (R-multiple/expectancy — NOT win-rate/direction, Shapley attribution, signal ledger).
> **Open threads:** (a) continue the spine build — wire per-visit footprint into level-memory + build the heatmap engine (§26.6/26.8); (b) run the calibration studies (micro-L2 vs mini-L3 footprint agreement + aggressor error) BEFORE pattern screening; (c) EVERYTHING this session is UNCOMMITTED on branch `fix/cockpit-chart-live-tail-poll`.
> §25 = the options pivot + the studies that produced the verdict. §24 = RS-feed pipeline (still current infra). §1–23 earlier layers — the stale-warning below applies to them.

> **Author**: Session handoff originally as of 2026-06-07 (Sunday)
> **Last updated**: 2026-07-06 (Monday) — latest state is **§26** (see START HERE above). **§25** = options pivot + verdict; **§24** = RS-feed pipeline (current infra); **§23** = RS-framework / Lightspeed-L3 pivot; **§22** = 2026-06-08→06-16.
> **Purpose**: Enable a new session to pick up the project without re-discovery
> **Audience**: Engineer or AI assistant continuing the work
>
> ⚠️ **Sections 1–21 are a 2026-06-07/08 snapshot and are now partly stale.** The
> biggest drift: (1) the **V3 framework was fully removed** — §6 is historical,
> read §22.2; (2) **mbo.db (SQLite) was replaced by a Parquet + DuckDB store** —
> §3.3 is historical, read §22.3; (3) the parquet duplicate-row bug flagged here
> earlier was **FIXED 2026-06-16** (§22.9 — store deduped, acceptance passed);
> parquet CVD/volume numbers are trustworthy again. (4) **§5/§8 carry stale LIVE
> CONFIG numbers** — for gate version, enabled rules, and risk caps trust
> `reapply_quality_gates.ts`, `apps/trader/.env`, and `risk-guard.ts` over this doc.

---

## 1. Project Overview

**Trading Cockpit** is a real-time signal aggregation + visualization + auto-trading system for NQ/MNQ and ES/MES futures. The user (Ravi) is a retail trader building institutional-grade Pine Script-equivalent strategies in TypeScript, with a long-term goal of fully hands-off automated trading.

**Working directory**: `/Users/ravikumarbasker/trading-cockpit`
**Git remote**: `https://github.com/ravikcodedesigns/trading-cockpit.git` (branch `main`)
**Live cutover target**: Week of 2026-06-09 (V3 shadow → live)
**Live trading account**: Tradovate **1557816** (live mode currently active for FLIPs)

### Tech stack
- **Runtime**: Node.js 20+, TypeScript, pnpm monorepo
- **Backend**: Fastify (aggregator on `:8787`, tick-store on `:8788`); trader is a daemon with no HTTP server
- **Frontend**: React + Vite + lightweight-charts (cockpit on `:5173`)
- **Storage**: SQLite (3 DBs), JSON files for levels/context
- **Data source**: Bookmap (with custom Java + Python addons for tick + MBO capture)
- **Broker**: Tradovate REST + WebSocket API

---

## 2. Repository Layout

```
trading-cockpit/
├── apps/
│   ├── aggregator/        # Signal detector + Fastify HTTP/WS server (port 8787)
│   │   ├── src/
│   │   │   ├── rules/          # Legacy rules (V1)
│   │   │   ├── rules-v2/       # Current rules (strategy B, H, D, E, CONT, etc.)
│   │   │   │   ├── absorption.ts
│   │   │   │   ├── strategy-cont.ts
│   │   │   │   ├── wall-broken-fade.ts
│   │   │   │   ├── flip-long-pmcore.ts
│   │   │   │   ├── compression-realwall.ts
│   │   │   │   ├── stacked-zone-detector.ts
│   │   │   │   ├── strategy-es-flip.ts
│   │   │   │   └── rs-level-scorer.ts
│   │   │   ├── sources/        # External data fetchers (FlashAlpha, VX, levels)
│   │   │   ├── config.ts       # ⭐ Single source of truth for V3 + per-rule TP/SL
│   │   │   ├── quality.ts      # ⭐ Signal classification (gold | silenced)
│   │   │   ├── state.ts        # ⭐ V3 entry gate logic + trade manager
│   │   │   ├── db.ts           # SQLite layer (trading.db)
│   │   │   ├── server.ts       # HTTP + WS endpoints
│   │   │   ├── trade-manager.ts # V3 open-trade tracking + exit logic
│   │   │   ├── cvd-session.ts  # RTH-anchored CVD per symbol
│   │   │   └── regime-checkpoints.ts # 4× daily regime snapshots
│   │   └── scripts/             # 100+ research/analysis scripts (see §11)
│   ├── cockpit/           # React dashboard (port 5173 — Vite dev, proxies to 8787)
│   │   └── src/components/
│   │       ├── Chart.tsx           # ⭐ Main chart + signal markers + tools
│   │       ├── SignalFeed.tsx
│   │       ├── RegimePanel.tsx
│   │       ├── OpeningBias.tsx
│   │       ├── KillSwitch.tsx
│   │       ├── TraderStatus.tsx
│   │       └── StatusBar.tsx
│   ├── tick-store/        # Fastify HTTP + WS tick ingest (port 8788, writes ticks.db)
│   │   └── src/
│   │       ├── server.ts          # /health /trades /depth + /ws/ticks ingest
│   │       └── db.ts              # better-sqlite3 writer for ticks.db
│   └── trader/            # Tradovate auto-trader daemon (NO HTTP server)
│       └── src/                   # Outbound SSE → 8787, outbound WS → Tradovate
│           ├── index.ts
│           ├── config.ts
│           ├── signal-gate.ts     # ⭐ WS subscriber → trade decisions
│           ├── risk-guard.ts      # Time/news/loss-cap gates
│           ├── order-manager.ts   # Tradovate order placement
│           ├── position-watcher.ts # Orphan-bracket safety net
│           ├── discord.ts
│           ├── db.ts (positions.db)
│           └── broker/tradovate.ts
├── packages/
│   └── contracts/         # Shared TS types (ConfluenceSignal, etc.)
├── addons/
│   ├── bookmap-java/      # Custom Bookmap addon (writes raw MBO to disk)
│   └── bookmap/capture_mbo.py # Python tick relay
├── data/                  # All large DBs (gitignored)
│   ├── trading.db (1.3 GB)
│   ├── ticks.db (32 GB)
│   ├── mbo.db (76 GB)
│   └── positions.db
├── ~/cockpit-mbo-capture/ # Raw MBO .log files (outside repo)
├── daily_levels.json      # NQ structural levels per trading day
├── daily_levels_es.json   # ES structural levels per trading day
└── data/rs-context.json   # Daily RS framework context
```

### 2.5 Service Topology & Ports — **CANONICAL**

These port assignments are fixed. **Do not change them across restarts.** If a port conflict arises, find and kill the squatter — don't reassign.

| Service | Process | Port | Bind | Protocol | Purpose | Health check |
|---|---|---|---|---|---|---|
| **Aggregator** | `apps/aggregator` (Fastify) | **8787** | `127.0.0.1` | HTTP + WS | Signals, levels, history, `/ws/cockpit`, `/ws/sources` ingest | `curl :8787/health` |
| **Tick-store** | `apps/tick-store` (Fastify) | **8788** | `127.0.0.1` | HTTP + WS | Tick/depth writes to `ticks.db`, `/ws/ticks` ingest | `pgrep -f 'tsx.*tick-store'` — **do NOT use `/health`**, it runs `COUNT(*)` on 546M-row depth table (~37s, blocks event loop) |
| **Cockpit** | `apps/cockpit` (Vite dev) | **5173** | `127.0.0.1` | HTTP | React dashboard. Proxies `/ws`, `/context`, `/history`, `/health`, `/levels`, `/calendar`, `/trader`, `/ingest`, `/post-entry`, `/test` → aggregator on 8787 | `curl :5173/` |
| **Trader** | `apps/trader` (daemon) | — | — | **No listener** | Outbound SSE → `127.0.0.1:8787/ws/cockpit`; outbound WS → Tradovate (`md.tradovate.com`). Owns `positions.db`. | `pgrep -f 'tsx.*trader/src/index'` + `lsof -p <pid> -iTCP` should show 1 ESTABLISHED to `:8787` and 1 ESTABLISHED to `34.120.3.201:443` (Tradovate) |
| **Bookmap NQ addon** | `addons/bookmap/cockpit_addon.py` | — | — | WS client | Outbound to `ws://127.0.0.1:8787/ws/sources?source=bookmap` AND `ws://127.0.0.1:8788/ws/ticks` (parallel fan-out) | inside Bookmap process |
| **Bookmap ES addon** | `addons/bookmap/es_cockpit_addon.py` | — | — | WS client | Outbound to `ws://127.0.0.1:8787/ws/sources?source=bookmap-es` AND `ws://127.0.0.1:8788/ws/ticks` | inside Bookmap process |
| **MBO capture (Java)** | `addons/bookmap-java/` | — | — | File writer | Writes `~/cockpit-mbo-capture/*.log`; no network listener. Ingested into `mbo.db` hourly by launchd. | log file growth + `launchctl list \| grep mbo-ingest` |

**Override env vars** (rarely used — only for testing):
- `AGGREGATOR_PORT` (default 8787)
- `TICK_STORE_PORT` / `TICK_STORE_HOST` (defaults 8788 / 127.0.0.1)
- `AGGREGATOR_WS` (trader's override of where to subscribe; default `ws://127.0.0.1:8787/ws/cockpit`)

**Common port-conflict debug**
```bash
# Who owns a port?
lsof -nP -iTCP:8788 -sTCP:LISTEN

# Which app dir is a node PID running from?
lsof -p <pid> | grep cwd

# Identifying confusion: aggregator and tick-store both run as `node ... tsx ... src/index.ts`.
# The only quick disambiguator is the `cwd` (above) or the listening port (8787 vs 8788).
```

**Historical note (2026-06-08):** HANDOFF.md previously listed trader on `:8788`. That was wrong — trader has no HTTP server. Port 8788 has always been tick-store. Section added after this confusion cost a debugging session.

---

## 3. Data Stores & Schemas

### 3.1 trading.db (2.66 GB as of 2026-07-06)

| Table | Purpose | Key columns |
|---|---|---|
| **signals** | Every raw signal emission | id, ts, symbol, rule_id, score, direction, payload (JSON), strategy_version, rule_version, rs_* fields, ctx_* fields, meta |
| **qualified_signals** | Signals that passed quality gate (gold tier) | signal_id (FK), signal_ts, symbol, rule_id, strategy_version, direction, score, session, gate_ver, reason, qualified_at, flip_signal_id |
| **v3_decisions** | V3 framework's decision log | id, ts, symbol, signal_id, rule_id, pattern, direction, qualified, active_mode, action (OPEN/CLOSE/SKIP_*), reason, cvd_session, entry, exit_price, exit_outcome, pnl_pts, open_trade_id |
| **open_trades** | V3's currently-open trades | symbol (PK), signal_id, rule_id, pattern, direction, entry, tp_pts, sl_pts, open_ts |
| **events** | All upstream events (bars, ticks, FlashAlpha, etc.) | id, ts, source, type, symbol, payload (JSON) |
| **daily_regimes** | 4× daily regime checkpoints | id, date, checkpoint (09:31/10:00/12:00/13:30), symbol, label, ts, factors (JSON) |
| **fade_shadow_pnl** | WBF shadow PnL tracking | date-based |
| **fade_blocked_outcomes** | CVD-blocked WBF outcomes (research) | per signal |
| **fade_pnl_variants** | Variant PnL configs |  |
| **signal_outcomes** | Post-hoc outcome tracking |  |
| **expl_short_observations** | EXPL short OOS observations |  |

### 3.2 ticks.db (78.5 GB as of 2026-07-06)

| Table | Purpose | Key columns |
|---|---|---|
| **trades** | Every print | ts, symbol, price, size, is_bid_aggressor |
| **depth** | Snapshot L2 (104M rows — pruning needed) | ts, symbol, side, price, size |

**Critical caveat**: ticks.db `is_bid_aggressor` is **INFERRED by the Bookmap addon** and is **3.5× off from mbo.db ground truth**. RTH session CVD measured today:
- ticks.db: -7,596
- mbo.db (correct): -27,252
- Bookmap display: -28,200

⚠ V3's CVD floor (`cvdLongFloor=-3000`) is calibrated against the **wrong** value (ticks.db). Recalibration is task #20, target 2026-06-09.

**ticks.db NQ symbol is actually MNQ data** — same underlying instrument as `mbo.db symbol='MNQM'`.

### 3.3 mbo.db — **HISTORICAL: this DB no longer exists** (deleted; replaced by `data/mbo-parquet/` + DuckDB, see §22.3)

| Table | Purpose |
|---|---|
| **mbo_events** | Every order event (send/cancel/replace) with order_id |
| **mbo_orders** | Per-order state (status: active/cancelled/filled/partial/orphan) |
| **mbo_trades** | Trades with definitive `aggressor_order_id`, `passive_order_id` |
| **mbo_depth** | Depth snapshots (less common, rolled up from events) |
| **mbo_executions** | Sweep groupings (rebuilt after each ingest) |
| **mbo_capture_files** | Per-file ingest progress (bytes/events) |

MBO data started 2026-06-02. Aggressor flags here are **definitive** (not inferred). Ingest is incremental via `scripts/mbo_ingest.ts`, manually triggered (no launchd plist yet — task #18).

### 3.4 Levels & context

- **daily_levels.json** — NQ structural levels per day (PDH/PDL/POC/VAH/VAL/PDC/NQ Close + ON HP/ON MHP + bullZone/bearZone/ddBands/hedgePressure/mhp)
- **daily_levels_es.json** — Same for ES
- **data/rs-context.json** — Daily RS framework state (greaterMarket, ddRatio, lmCode, mhpResilience, hpResilience, redistResilience, tradingDay)

**Convention** (per memory `feedback_overnight_level_colors`): on TradingView snapshots, **cyan = ON HP, orange = ON MHP** (NOT ONH/ONL).

**Carry-forward** (per memory `feedback_rs_levels_carry_forward`): next-day daily_levels entries carry structural RS fields (bullZone, bearZone, ddBands, hedgePressure, mhp) from prior day; only ON HP/ON MHP refresh nightly.

---

## 4. Signal Strategies (Rules)

### 4.1 Active rules and their conventions

| Rule ID | Strategy version | Pattern field | Description | Detector file |
|---|---|---|---|---|
| **clean-impulse** | H | FLIP | Clean impulse "FLIP" entry — sharp directional bar reversing recent tape | (in state.ts) |
| **absorption** | B | — | Bid/ask absorption (high score = strong abso). Currently retired from UI; backend logs | rules-v2/absorption.ts |
| **tape-speed** | B | — | High tape velocity event (>1000 contracts/2s) | (in rules-v2/) |
| **large-print** | B | — | Single large print (>200 contracts) | (in rules-v2/) |
| **wall-broken-fade** | **WBF** (promoted 2026-06-06) | WBF | Visible bid/ask wall broken → fade entry against the break | rules-v2/wall-broken-fade.ts |
| **expl** | EXPL | — | Explosive move detector (currently SILENCED — both LONG/SHORT losing) | (in rules-v2/) |
| **cont-reentry** | CONT | — | Trend continuation re-entry after a parent FLIP/EXPL/abso/WBF | rules-v2/strategy-cont.ts |
| **es-flip** | ES-FLIP | — | ES-specific FLIP detector (in SHADOW for OOS validation) | rules-v2/strategy-es-flip.ts |
| **compression-realwall** | — | — | Compression + real-bid-wall + capitulation (SHADOW, n=0 so far) | rules-v2/compression-realwall.ts |
| **flip-long-pmcore** | — | — | FLIP-long filtered to 10:30-13:30 ET + deltaLast3≤-300 (SHADOW pending validation) | rules-v2/flip-long-pmcore.ts |

### 4.2 strategy_version values & meaning

- **A** — bar-based legacy (silenced)
- **B** — tick-based (absorption, tape-speed, large-print)
- **H** — clean-impulse (FLIP only)
- **EXPL** — explosive
- **CONT** — continuation re-entry
- **WBF** — wall-broken-fade (promoted 2026-06-06 from 'B')
- **ES-FLIP** — ES variant

(per memory `feedback_naming_convention` for Pine Script context)

### 4.3 Approved parents for cont-reentry

Per `recentGoldTriggerFor` in `apps/aggregator/src/db.ts:412-428`:

```sql
AND (
  (strategy_version = 'H')                              -- clean-impulse FLIP
  OR (strategy_version = 'EXPL' AND direction = 'long') -- EXPL long
  OR (strategy_version = 'B' AND score >= 80)           -- absorption (and accidentally tape-speed/large-print≥80)
  OR (strategy_version = 'WBF')                         -- wall-broken-fade (explicit, added 2026-06-06)
)
```

The `B AND score >= 80` catches tape-speed (n=2433 ≥80) and large-print (n=242 ≥80) but the audit showed neither ever wins the most-recent-parent slot in practice. **WBF dominates the candidate pool** — 157 candidate slots across 29 cont signals = 5.4/cont average.

**SQL picks MOST RECENT parent** (`ORDER BY ts DESC LIMIT 1`). Backlog item to revisit (task #37): consider rule-priority ordering (WBF > FLIP > absorption) instead of recency.

---

## 5. Quality Gate (qualified_signals)

### 5.1 Code path

`apps/aggregator/src/quality.ts` → returns `{ tier: 'gold' | 'silenced', reason: string }` per signal.
Script: `scripts/reapply_quality_gates.ts` re-runs the gate for all historical signals when `GATE_VERSION` is bumped.

Currently: **GATE_VERSION = 5** (verify in `scripts/reapply_quality_gates.ts` — this number drifts; the code is canonical).

### 5.2 Gate cascade (FLIP / clean-impulse)

1. **Pre-gate** (in qualify script, NOT in quality.ts):
   - `rs_hard_filtered = 1` → silenced (this catches `time-gate` LONGs and `DD-band SHORTs`)
   - `meta.filtered = 1` → silenced (ORM/comp_pos filter)
2. **CF Long time gate**: 09:54-14:30 ET only
3. **Strategy H (FLIP)**:
   - LONG: `delta15 >= +500` → silenced (buyers-dominant background; no exhaustion to reverse)
   - Either dir: `|delta5| < 1000` in trade-direction sign → silenced (wrong-direction tape)
4. **Strategy B (absorption)**: SILENCED (retired)
5. **Strategy EXPL**: SILENCED (both LONG 30% WR and SHORT 4% WR losing)
6. **Strategy WBF (wall-broken-fade)**: visual-monitor mode → gold (chart shows but trader doesn't auto-trade)
7. **es-flip**: SHADOW (gold tier so signals log but force-shadow blocks V3 trades)

### 5.3 RS hard filter (rs-level-scorer.ts:430)

```ts
if (levels.ddBands && direction === 'short' && currentPrice < levels.ddBands.lower) {
  return { filtered: true, reason: 'SHORT blocked: price below lower DD Band — irrational territory' };
}
```

**Only one rule**: SHORT below lower DD band → blocked. **This catches today's missed shorts** (06-05 14:57 NQ short was a +$160 winner blocked by this gate).

### 5.4 Time-gate (rs_filter_reason='time-gate')

`scripts/backfill_timegate_h.ts`:
- Suppress strategy H NQ longs before 10:45 ET (calibrated against 30% WR)
- Suppress strategy H NQ longs between 14:00-16:00 ET (65% pass rate, too noisy)
- Sets `rs_hard_filtered=1`, `rs_filter_reason='time-gate'`

This is the **single biggest silencer** of FLIP LONGs — 71 of 89 silenced NQ FLIPs are time-gate blocked.

---

## 6. V3 Framework — **HISTORICAL (framework deleted 2026-06-09; read §22.2. Current term: "tradable signal pipeline")**

### 6.1 Concept

**V3** is a strict entry-gate layer that sits on top of qualified signals. The goal: take only signals with high WR + sufficient runway, decline marginal ones.

**Live config** in `apps/aggregator/.env`:
```
V3_ACTIVE_MODE=shadow         # observe only, log decisions to v3_decisions
```

(Modes: `off` | `shadow` | `live`)

### 6.2 Entry gate cascade (state.ts:383-412)

For every signal V3 evaluates:

1. **SKIP_NOT_V3_RULE** — not in V3-eligible set (only clean-impulse, absorption, wall-broken-fade, expl currently eligible)
2. **SKIP_SILENCED** — quality gate rejected
3. **SKIP_FORCE_SHADOW** — rule is in `forceShadowRules` list
4. **SKIP_FLIP_SHORT** — only if `dropFlipShorts=true` (currently FALSE — shorts allowed)
5. **SKIP_CVD** — LONG and `cvdSession ≤ cvdLongFloor (-3000)`, OR SHORT and `cvdSession ≥ cvdShortFloor (+3000)`
6. **SKIP_COOLDOWN** — symbol already has open V3 trade
7. **OPEN** — passes all gates → V3 opens (in live mode) or logs (in shadow)

### 6.3 Config (apps/aggregator/src/config.ts:60+)

```typescript
v3: {
  activeMode: 'shadow',                   // env-driven
  symbols: ['NQ'],                        // NQ only (ES bypassed)
  rthCloseEt: '15:54:00',                 // 8 min before 16:00 margin close
  cvdLongFloor: -3000,
  cvdShortFloor: 3000,
  dropFlipShorts: false,                  // 2026-06-04 flipped TRUE → FALSE after 78% WR confirmed
  requireQualifiedExitsLongs: true,
  closeShortsOnlyOnFlipLong: true,        // 2026-06-04
  requireQualifiedExitsShorts: false,     // legacy
  forceShadowRules: ['es-flip', 'expl'],  // cont-reentry PROMOTED 2026-06-07
  perRule: {
    'absorption':            { tp: 80, sl: 140 },
    'clean-impulse-FLIP':    { tp: 80, sl: { long: 55, short: 105 } },
    'expl':                  { tp: 80, sl: 70 },
    'wall-broken-fade':      { tp: 20, sl: 10 },
    'compression-realwall':  { tp: 24, sl: 6 },
    'flip-long-pmcore':      { tp: 60, sl: 40 },
    'cont-reentry':          { tp: 80, sl: 70 },
    'es-flip':               { tp: 20, sl: 20 },
  },
}
```

### 6.4 Opposing-signal exit logic (trade-manager.ts:164-188)

`shouldExitOnSignal(symbol, incomingDir, incomingIsQualified, incomingRuleId, incomingPattern)`:

- Same-direction signal → don't exit
- **Open LONG**: incoming opposite (SHORT) must be **qualified** to close (per `requireQualifiedExitsLongs=true`)
- **Open SHORT**: with `closeShortsOnlyOnFlipLong=true`, the closer MUST be a **qualified clean-impulse FLIP-LONG** (prevents weak signals from exiting profitable shorts)

This is **race-condition-safe** by design — only the highest-quality opposing signal can close.

### 6.5 Broadcast behavior by mode

- **`shadow`**: legacy quality gate decides broadcast on `/ws/cockpit`. V3 logs to v3_decisions but doesn't filter.
- **`live`**: only V3-OPEN signals broadcast. Trader sees only what V3 approves.

⚠ **Trader currently sees QUALIFIED signals** because V3 is in shadow. Going live changes the cohort the trader trades.

---

## 7. Performance Cohorts (NQ FLIP, inception → 2026-06-05) — **HISTORICAL (superseded by §22.2 acceptance data + §24.9 replay numbers)**

### 7.1 The three nested cohorts

| Cohort | n | WR | EV/sig | Net $ |
|---|---|---|---|---|
| **Raw FLIP** (all signals) | 178 | 55% | +$26 | +$4,669 |
| **Qualified FLIP** (passed quality gate) | 80 | 58% | +$38 | +$3,022 |
| **V3-OPEN FLIP** (passed all V3 gates) | 40 | **70%** | **+$69** | +$2,754 |

V3 takes 22% of raw signals but captures 59% of raw dollars → **2.7× efficiency per trade**.

### 7.2 By direction (V3-OPEN backtest)

| | n | WR | EV | $ |
|---|---|---|---|---|
| LONG | 30 | 67% | +$63 | +$1,894 |
| SHORT | 10 | **80%** | **+$86** | +$860 |

### 7.3 Cont-reentry (NQ only)

| Cohort | n | WR | EV | $ |
|---|---|---|---|---|
| All raw | 29 | 69% | +$67 | +$1,935 |
| Deduped (5 pair dups removed) | 24 | 71% | +$69 | +$1,651 |
| **Deduped, score ≥ 90** | **12** | **83%** | **+$102** | **+$1,225** |

### 7.4 Combined V3-OPEN (FLIP + CONT @ score≥90)

**66 trades, 70.8% WR, +$4,567 net** over 32 trading days = ~$143/day at 1× MNQ sizing.
For $3,000/day target → **22× MNQ contracts (≈ 2 NQ)**.

### 7.5 PnL computation conventions

- **TP/SL** values are in **points** (NQ: 1 point = $20 E-mini, $2 MNQ)
- All backtest scripts use `PV_NQ = 2` (MNQ pricing)
- All perf reports run with TP=80, SL per perRule config
- **120-minute forward window** in ticks.db to determine outcome
- **Per memory `feedback_no_mfe_mae`**: never report MFE/MAE — only WIN/LOSS/OPEN at fixed TP/SL
- **Per memory `feedback_v3_exit_logic`**: V3 exits on opposing signals too (not just TP/SL) — don't simulate by walking to TP/SL alone for V3 trades

---

## 8. Trader (Tradovate Auto-Trader)

### 8.1 Configuration

**`apps/trader/.env`** (current):
```
TRADER_MODE=live                                 # placing real orders
TRADER_ENABLED_RULES=clean-impulse,cont-reentry  # FLIP + CONT live (CONT enabled ab56d86, §22.6)
```

Account: **Tradovate live 1557816**. The trader has **no HTTP server** — it's a pure daemon: outbound SSE to aggregator (`ws://127.0.0.1:8787/ws/cockpit`) + outbound WS to Tradovate. Health checks happen via `pgrep -f 'tsx.*trader/src/index'` (see §2.5).

### 8.2 Signal flow

1. Aggregator broadcasts on `/ws/cockpit` (qualified signals when V3=shadow, V3-OPEN when V3=live)
2. Trader's `signal-gate.ts:64-94` subscribes:
   - Dedupes by `signal.ts`
   - Filters by `enabledRules` (only `clean-impulse`)
   - Filters out `clean-impulse` non-FLIP patterns (cont-pattern check)
   - 3-min age gate (stale-on-restart guard)
3. If passes → `onSignal(signal)` → `order-manager` places Tradovate bracket order

### 8.3 Risk guards (apps/trader/src/risk-guard.ts)

```typescript
type BlockReason =
  | 'halt_file'              // kill-switch active
  | 'outside_rth'            // not RTH (09:30-16:00 ET)
  | 'daily_loss_limit'       // TRADER_MAX_DAILY_LOSS hit (currently -$1000, raised from -$500 — .env is canonical)
  | 'max_positions'          // already open
  | 'duplicate_signal'       // dedupe
  | 'news_blackout'          // FOMC/CPI/NFP ±15 min
  | 'flip_long_pre_1030'     // FLIP LONG before 10:30 ET
  | 'after_1430_stop'        // any entry after 14:30 ET
  | null;

const FLIP_LONG_START_MIN = 10 * 60 + 30;   // 10:30 ET
const UNIVERSAL_STOP_MIN  = 14 * 60 + 30;   // 14:30 ET
```

**Daily-loss cap**: currently **-$1000** (raised from -$500; `apps/trader/.env` `TRADER_MAX_DAILY_LOSS` is canonical). When hit, no new entries until next day.

### 8.4 Tradovate API quirks (per memory `feedback_tradovate_api_quirks`)

- Contract status is `DefinitionChecked` (NOT `Active`) — broke first demo test
- Stop orders use `orderType: 'Stop'` (NOT `StopMarket`) — also broke first test
- `avgPx` is not in `/order/item` — requires `/fill/deps?masterid=X` lookup
- `apps/trader/src/broker/tradovate.ts:getOrderStatus()` handles both

### 8.5 Position-watcher (position-watcher.ts)

WebSocket listener for Tradovate position updates → detects flat transition → sweeps orphan SL/TP orders → updates positions.db. Critical safety net against orphan-bracket "naked-fill" scenarios.

### 8.6 monitorBracket closure bug (deferred — per memory `feedback_monitor_bracket_closure_bug`)

SL/TP listener captures `orderId` in closure; watchdog-replaced orders aren't tracked → mis-attributed `closed_external` events and zero pnl. Only reachable with unrealistic SL distances; deferred fix.

### 8.7 Discord notifications (discord.ts)

Posts OPEN / CLOSE / REJECT / ORPHAN events with trade context. Configured via `DISCORD_WEBHOOK_URL` env.

### 8.8 News blackout

`scripts/cron-mark-close.sh` (4PM close marker) and economic-calendar fetcher → trader blocks entries ±15 min around FOMC/CPI/NFP events.

### 8.9 Hard rule on broker orders (per memory `feedback_no_orders_without_confirmation`)

- **Trader daemon placing orders autonomously** when picking up real V3 signals during live trading = STANDING CONSENT via TRADER_MODE=live + TRADER_ENABLED_RULES + risk caps. NO per-order confirmation needed.
- **Claude directly placing orders** via curl/Bash/Node scripts that hit the broker API = REQUIRES explicit per-order user confirmation. **HARD RULE**.

---

## 9. Race Conditions & Signal Coordination

### 9.1 Single-position-per-symbol enforcement

- V3's `open_trades` table is keyed by `symbol` (PK) — at most 1 V3 open trade per symbol
- Trader's positions.db is similar
- New signal arriving while a trade is open → routed to `shouldExitOnSignal` (opposing-direction close) or `SKIP_COOLDOWN` (same-direction)

### 9.2 Opposing-signal exit precedence

Per `closeShortsOnlyOnFlipLong=true`:
- Open SHORT closed ONLY by qualified clean-impulse FLIP-LONG
- Open LONG closed by ANY qualified opposing signal

This prevents weak opposers (tape-speed, large-print, low-score absorption) from exiting profitable shorts early.

### 9.3 Duplicate signals

Per memory `feedback_historical_signal_sync` + task #7 (open):
- Historical signals table has known duplicates (clean-impulse paired-dups, 5 pairs on cont-reentry)
- ticks.db audit also needed for duplicate inserts (task #8)
- Trader deduplicates by `signal.ts` in `signal-gate.ts:69`

### 9.4 Live vs backtest discrepancy

V3 live ledger only has 10 OPENs (paired-dup inflation makes it look like 10, actual unique = 7). Backtest gives 40 unique OPENs over the same window. Discrepancies traced to:
- CVD computed differently in live (streaming) vs backtest (retroactive query) — both use ticks.db
- Duplicate signal handling
- Minor timing variance

### 9.5 Race-safety summary

The system is **race-condition-safe** by design through:
1. Symbol-keyed position state
2. Strict opposing-exit rules
3. Cooldown gating
4. SQL UNIQUE constraints (`qualified_signals.signal_id`)
5. Single signal-gate.ts dedup

---

## 10. Cockpit Features

### 10.1 Layout (apps/cockpit/src/App.tsx)

CSS grid: `1fr 14px 360px` (signal panel open) or `1fr 14px` (collapsed). Toggle strip in middle column.

### 10.2 Chart features (apps/cockpit/src/components/Chart.tsx — ~2200 lines)

| Feature | Where | Notes |
|---|---|---|
| **NQ/ES symbol toggle** | StatusBar | switches `selectedSymbol` |
| **1m / 5m / 15m timeframe** | StatusBar | switches `selectedTimeframe` |
| **REGIME button (top-left)** | line 1900 | opens RegimePanel popup |
| **📏 MEASURE tool button** | line 1914 | TradingView-style measure (rectangle + label) |
| **QUALIFIED toggle** | line 1933 | shows/hides qualified-signal markers |
| **V3 toggle** | line 1944 | shows/hides V3-OPEN signal markers |
| **🎯 TRADE RULES box** | top-center | always-on quick reference (FLIP↓/FLIP↑/CONT/STOP) |
| **📅 calendar widget (bottom-left)** | line 2110 | jump to any historical date (back to 2026-04-29) |
| **» scroll-to-latest (bottom-right)** | line 2070 | scrollToRealTime |
| **Signal markers** | line 1300+ | filtered by rule, timeframe, QUALIFIED/V3 toggles |
| **Drawing tools** | line 414+ | line, text, measure |
| **Dynamic bar loading on scroll** | line 549+ | fetches missing windows on demand |
| **VWAP overlay** | line 691 | session-anchored |
| **Level lines (MHP/HP/PDH/PDL/POC/VAH/VAL/ON HP/ON MHP/Bull/Bear/DD)** | line 1140+ | per-day from daily_levels.json |
| **Opening Bias panel** | OpeningBias.tsx | first 15 min direction stats |

### 10.3 Measure tool details

- Click 📏 → click start point on chart → click end point
- Renders rectangle (green if up move, red if down)
- Label shows: `±points · bars · time`
- **X close button** on each box (added 2026-06-07) — `pointer-events: auto` on the X works even when SVG overlay has `pointer-events: none`
- ESC cancels mid-measurement
- Auto-deactivates after second click (one-shot tool)

### 10.4 Calendar widget details

- 📅 button bottom-left → opens date input with OK/Cancel
- On OK: fetches that day's bars via `/history/bars?from=&to=&symbol=&interval=` then scrolls visible range to 09:30 → 16:00 ET
- **Earliest data**: 2026-04-29 (capture start)

### 10.5 Dynamic history loader

`subscribeVisibleTimeRangeChange` → debounced 250ms → fetches uncovered range via `/history/bars`. Tracks loaded ranges per `(symbol, timeframe)` to avoid re-fetching.

### 10.6 RegimePanel (brightened 2026-06-07)

- Time column: `#e0e6f0` (was `#4a5568`)
- Headers: `#b8b8c0`
- Neutral arrows: `#7a7a85` (was `#3a3a45`)
- Body default: `#e8e8ec`

### 10.7 Cockpit kill-switch (KillSwitch.tsx)

Halts trader by writing a halt file → trader's risk-guard sees `halt_file` and blocks all entries.

### 10.8 TraderStatus.tsx

Polls trader's `/trader/state` endpoint → displays IDLE / TRADE-OPEN / disconnected.

### 10.9 ContextStrip + StatusBar

Top bar showing: COCKPIT, NQ, ES, timeframe selector, alert toggle, IDLE/PnL widget, AUTO toggle, BOOKMAP/FLASHALPHA/LEVELS/TRADOVATE connection dots, events count.

---

## 11. Scripts Directory (apps/aggregator/scripts/) — **HISTORICAL SNAPSHOT (now ~285 scripts; the §23–§26 research scripts are absent here)**

100+ scripts as of 2026-06-07. The most important ones then:

### 11.1 Operations
- **mbo_ingest.ts** — incremental MBO log → mbo.db ingest. Resume-from-offset. Manually invoked every ~30 min.
- **reapply_quality_gates.ts** — rebuild qualified_signals from scratch with current quality.ts logic. Run when GATE_VERSION bumps.
- **score_outcomes.ts** — score outcomes for backtest analysis
- **compute_structural_levels.ts** — compute daily structural levels (PDH/PDL/etc.) for next-day file
- **mark_close_level.ts** — 4PM close marker (cron-driven via scripts/cron-mark-close.sh)
- **levels_cli.ts** — CLI tool to add/update daily levels
- **context_set.ts** — update RS context (rs-context.json)

### 11.2 Recent perf scripts (added in this session)
- **flip_perf.ts** — raw FLIP perf (all 178 signals)
- **flip_qualified_perf.ts** — qualified-only FLIP perf
- **v3_flip_backtest.ts** — V3 retroactive backtest on all FLIPs (40 OPENs)
- **v3_flip_filtered_audit.ts** — audit of FLIPs V3 filtered out
- **v3_silenced_flip_breakdown.ts** — silenced bucket gate decomposition
- **silenced_buckets_pnl.ts** — silenced bucket PnL by gate reason
- **v3_flip_plus_cont_combined.ts** — combined V3 FLIP + CONT perf
- **cont_reentry_perf.ts** — cont-reentry all signals
- **cont_reentry_perf_deduped.ts** — deduped + optional `--score N` filter
- **cont_reentry_by_parent.ts** — cont signals broken down by parent rule
- **cont_parent_audit.ts** — audit candidate parents per cont signal

### 11.3 Research scripts
- **cvd-stream.ts** — live MBO CVD streamer (drafted, not deployed)
- **iceberg_native_train_test.ts** — native CME iceberg train/test
- **stacked_zone_validate.ts** — stacked-zone fade validation
- **wall_forensics_phase01.ts** / **phase2.ts** — MBO wall analysis
- **fade_shadow_pnl.ts** / **fade_blocked_pnl.ts** — WBF shadow PnL tracking
- **today_signal_report.ts** — daily signal summary
- **today_fade_analysis.ts** — daily WBF analysis

---

## 12. Important Things Fixed/Changed in This Session

### 12.1 WBF promotion (2026-06-06)
- Was `strategy_version='B'` → conflated with absorption/tape-speed/large-print
- Promoted to dedicated `strategy_version='WBF'`
- Backfilled 11,489 historical rows
- Updated `recentGoldTriggerFor` SQL with explicit WBF clause
- Updated strategy-cont.ts doc comment

### 12.2 Cont-reentry promoted out of force-shadow (2026-06-07)
- Removed from `forceShadowRules` in config.ts
- Now V3 logs real OPEN/SKIP_CVD/SKIP_COOLDOWN for cont-reentry instead of blanket SKIP_FORCE_SHADOW
- Trader still won't trade cont (needs `TRADER_ENABLED_RULES` to add cont-reentry AND `V3_ACTIVE_MODE=live`)

### 12.3 Cockpit improvements (2026-06-06 → 06-07)
- Calendar widget for historical date jump
- Dynamic on-scroll bar fetch
- 📏 measure tool with rectangle + label + X close
- QUALIFIED / V3 marker toggle buttons
- TRADE RULES box centered at top
- TIME AND WR / TRADE buttons removed
- LV3 paneW debug banner removed
- RegimePanel colors brightened

### 12.4 Server endpoint added
- `/signals/marks?symbol=X` returns `{ qualifiedTs, v3OpenTs }` minute-bucketed timestamps for the chart toggles
- `/history/bars` extended with `from` and `to` ms params for date-range queries

### 12.5 Issues identified, fixed, deferred

| Issue | Status |
|---|---|
| **CVD ticks.db vs mbo.db 3.5× discrepancy** | Identified, fix deferred (task #20 — revisit 2026-06-09) |
| **Chart visible range broken with panel open** | Multiple fix attempts, ultimately REVERTED per user request |
| **Today's SHORT winners silenced by DD-band filter** | Identified, fix not shipped (would need DD-band gate review) |
| **TRADE RULES box mis-centered** | Fixed (lifted out of top-left container) |
| **TIME AND WR / TRADE buttons clutter** | Removed |
| **Magenta debug banner** | Removed |
| **Trader process silently dead** | Symptom found earlier; user should restart `pnpm dev` if seen again |

### 12.6 Decisions deferred (backlog)

- **Cont-reentry parent selection** — keep most-recent vs prefer WBF (task #37)
- **Promote absorption to strategy_version='ABS'** — backlog memory (deferred 2026-06-06)
- **CVD floor recalibration against mbo.db** — task #20
- **V3 shadow→live cutover** — task #21 (week of 2026-06-09)
- **MBO ingest launchd plist** — task #18
- **Trader: V3 parity (align SIGNAL_PARAMS with V3 TP/SL)** — task #13
- **Trader: per-rule position sizing** — task #17

---

## 13. Recent User-Asked Analysis (Reference)

### 13.1 V3 vs Qualified vs Raw — which to trade?
- V3-OPEN best edge (70% WR), but only 40 trades over 32 days vs 178 raw
- Trader currently on QUALIFIED FLIP (58% WR) because V3 is in shadow
- Recommended path: validate V3 in shadow → cutover 2026-06-09 → scale position size 1.5-2×

### 13.2 Trade plan for $3,000/day target
- ~22× MNQ contracts (≈ 2 NQ E-mini)
- Daily-loss cap scales to -$5,000
- Account size minimum $50K
- 6-week phased ramp (5 → 10 → 20 MNQ)
- Trade ONLY V3-OPEN signals

### 13.3 Cont-reentry score≥90 perf
- 12 signals, 83% WR, +$1,225
- Last 5 days (06-01 → 06-05): 6 consecutive wins
- LONG dominant (11/12), SHORT n=1

### 13.4 Combined V3 (FLIP + CONT@90)
- 66 trades, 70.8% WR, +$4,567 backtest
- Realistic after slippage: ~$3,800-$4,200

---

## 14. Standing Operational Commands

### 14.1 Run dev environment
```bash
# Aggregator + cockpit + trader concurrently via turbo
cd ~/trading-cockpit && pnpm dev
```

### 14.2 Run MBO ingest (manual, every ~30 min)
```bash
cd ~/trading-cockpit && pnpm --filter @trading/aggregator exec tsx scripts/mbo_ingest.ts
```

### 14.3 Re-qualify all signals
```bash
cd ~/trading-cockpit && pnpm --filter @trading/aggregator qualify
```

### 14.4 Compute structural levels (RTH pre-open)
```bash
cd ~/trading-cockpit && pnpm --filter @trading/aggregator levels:structural
```

### 14.5 Run any perf report
```bash
cd ~/trading-cockpit && pnpm --filter @trading/aggregator exec tsx scripts/<script>.ts
```

### 14.6 Typecheck cockpit / aggregator
```bash
cd ~/trading-cockpit/apps/<app> && pnpm typecheck
```

### 14.7 Add daily ON HP / ON MHP (nightly)
Per memory `feedback_overnight_level_colors`: from the overnight chart snapshot, **cyan = ON HP, orange = ON MHP**. Update `daily_levels.json` and `daily_levels_es.json` for the next trading day's entry. The day's structural fields (PDH/PDL/POC/VAH/VAL/PDC) come from `levels:structural` script; ON HP/ON MHP are manually transcribed from the snapshot.

---

## 15. Conventions & Rules (User Preferences)

### 15.1 Hard rules (from memory)
- **Never place broker orders without confirmation** (Claude-issued; trader-daemon-issued is fine via standing consent)
- **Never use MFE/MAE** — only WIN/LOSS/OPEN at fixed TP/SL
- **No lagging indicators** (EMA/RSI/MACD); use VWAP, CVD, volume profile, liquidity zones
- **Every iteration gets a new file** — never overwrite a strategy version
- **Naming convention**: `SIET-with-RS-v1.x` (Pine Script context)
- **Always read base file before building** — two SIET codebases exist, don't guess
- **Reports extend through "now"** — rescore/refresh upstream tables first
- **Use descriptive task names**, not opaque codes
- **Auto-accept safety prompts** with `dangerouslyDisableSandbox: true` for known-safe Bash commands

### 15.2 Communication preferences
- Terse, direct responses
- Use tables for dense info
- Show file:line references where helpful
- Don't narrate internal deliberation
- Mark recommended options as `(Recommended)`

### 15.3 Memory hints
- ABSO retired from UI 2026-06-02 (backend keeps logging)
- ES FLIPs: explicitly silence (0% WR)
- ticks.db NQ = MNQ data (legacy label)
- Trader's silent-death symptom: check `pgrep -f trader` if signals not firing

---

## 16. Pending Task List (TaskList state as of 2026-06-07)

### High priority
- **#20** CVD short-gate re-evaluation (revisit 2026-06-09)
- **#21** V3 shadow→live cutover (target week of 2026-06-09)
- **#13** Trader: V3 parity — align SIGNAL_PARAMS with V3 TP/SL config
- **#14** Trader: validate end-to-end on demo with one live signal

### Medium
- **#37** Revisit cont-reentry parent selection logic (LATEST vs FIRST vs WBF-priority)
- **#5** MBO iceberg detector — order-ID refresh continuity (in_progress)
- **#6** MBO sweep detector — group trades by aggressor_order_id
- **#11** Stacked-zone validation against V3 opposing-signal exits
- **#15** Trader: wire wall-broken-fade as live signal source
- **#17** Trader: per-rule position sizing
- ~~**#18** Draft launchd plist for MBO ingest (24/7 durability)~~ — **DONE 2026-06-07**, see §21. All 4 jobs (mbo-ingest, structural-levels, reminder-cvd, reminder-flipshorts) running under launchd.

### Low / cleanup
- **#7** Clean up historical signal duplicates in trading.db
- **#8** Audit ticks.db for tick-store duplicate inserts
- **#9** Add startup singleton guard to aggregator

### Backlog (in `project_backlog.md` memory)
- Cont-reentry parent selection revisit
- Promote absorption from `B` to `ABS` (cosmetic taxonomy cleanup)
- MBO ingest launchd plist
- Multi-symbol daily-levels data structure (GC/CL support)
- Strategy J (CVD impulse) — uncaught 40pt+ moves
- ES absorption: explicitly silence
- Display `stopLevel` from absorption payload as chart line
- EXPL SHORT detector (collect ~50 obs ~2026-06-03)
- Regime gate (F3) calibration
- DB depth pruning (104M rows in ticks.db depth)
- Strategy C/D/E viability review

### Calendar reminders
- **2026-07-07**: Re-evaluate FLIP SHORTS by ctx_gm after ~5 weeks of data
- **2026-06-09**: CVD short-gate re-evaluation

---

## 17. Quick-Start for New Session

1. **Read this document** in full once
2. **Check the task list** via TaskList tool — current state may differ
3. **Read MEMORY.md** at `~/.claude/projects/-Users-ravikumarbasker-claude-workspace/memory/MEMORY.md` for additional context
4. **Run MBO ingest** to confirm pipeline health: `pnpm --filter @trading/aggregator exec tsx scripts/mbo_ingest.ts`
5. **Check git status**: `git status` — see what's uncommitted from last session
6. **Verify aggregator + trader running**: `pgrep -f 'tsx.*aggregator|tsx.*trader'`
7. **Check today's V3-OPEN trades**: `sqlite3 data/trading.db "SELECT * FROM v3_decisions WHERE action='OPEN' AND date(ts/1000,'unixepoch','-4 hours')=date('now','-4 hours');"`

### Immediate next-steps the user is likely to ask about
- V3 cutover prep (CVD recalibration + 5-7 day cont-reentry shadow validation)
- Backfill regime-checkpoints table (only 1 day stored — need to recompute historical days)
- Trader ramp plan formalization ($3k/day phased path)
- Open issue: today's SHORT winners getting silenced by DD-band filter (06-05 14:57, etc.)
- Live cutover go/no-go criteria

### Files most likely to be touched
- `apps/aggregator/src/config.ts` — V3 settings, perRule TP/SL
- `apps/aggregator/src/quality.ts` — gate logic
- `apps/aggregator/src/state.ts` — V3 entry pipeline
- `apps/aggregator/src/db.ts` — `recentGoldTriggerFor`, schema
- `apps/cockpit/src/components/Chart.tsx` — UI changes
- `apps/trader/.env` — TRADER_ENABLED_RULES toggle
- `apps/aggregator/.env` — V3_ACTIVE_MODE toggle
- `daily_levels.json` / `daily_levels_es.json` — daily nightly update

---

## 18. Outstanding Open Questions

1. **Should we go V3 live now or wait?** Current shadow is 8 days old, plan was 14. CVD floor calibration is wrong (against ticks.db not mbo.db). Recommended: wait until 06-15+ after CVD fix.
2. **Should DD-band SHORT filter be relaxed?** Today's missed SHORT winners (10:21, 13:05, 14:57 on 06-05) were all blocked by this filter. May be over-conservative on bear days.
3. **Cont-reentry parent priority?** Currently most-recent wins; alternative is rule-priority (WBF > FLIP > absorption). Backlog item.
4. **TRADER_ENABLED_RULES expansion?** Currently just clean-impulse. Adding cont-reentry requires V3 live first.
5. **Position sizing scaling plan?** $3k/day target needs 22× MNQ; ramp from 1× over 6 weeks (5→10→20).
6. **Live CVD streaming source?** cvd-stream.ts drafted but not deployed. Path 1 (tail MBO log) chosen but not shipped.

---

## 19. Reference: Key memory items

Found in `~/.claude/projects/-Users-ravikumarbasker-claude-workspace/memory/`:

- **MEMORY.md** — Master index
- **user_profile.md** — User is retail trader building institutional-grade strategies; dislikes lagging indicators
- **user_automation_goal.md** — Full hands-off FLIP automation; live cutover 2026-06-04
- **project_trading_cockpit.md** — High-level cockpit overview
- **feedback_no_lagging.md** — Never use EMA/RSI/MACD
- **feedback_no_mfe_mae.md** — Only WIN/LOSS/OPEN
- **feedback_versioning_workflow.md** — Every iteration = new file
- **feedback_correct_base_file.md** — Always read base before building
- **feedback_overnight_level_colors.md** — cyan=ON HP, orange=ON MHP
- **feedback_no_orders_without_confirmation.md** — HARD rule on broker orders
- **feedback_tradovate_api_quirks.md** — DefinitionChecked, Stop not StopMarket
- **feedback_aggressor_convention.md** — ticks.db is_bid_aggressor=1 = BUY
- **feedback_ticks_nq_is_mnq.md** — ticks.db symbol='NQ' is actually MNQ data
- **feedback_rs_levels_carry_forward.md** — Structural fields carry forward
- **feedback_v3_exit_logic.md** — V3 exits on opposing signals
- **feedback_reports_through_now.md** — Always extend through request time
- **feedback_trader_naked_fill_safety.md** — Local entryFilled flag in catch
- **feedback_monitor_bracket_closure_bug.md** — Closure orderId issue (deferred)
- **feedback_permission_prompts.md** — Auto-accept safety prompts
- **project_backlog.md** — Master backlog
- **project_db_growth.md** — DB pruning watch
- **project_mbo_research_2026_06_02.md** — MBO research summary
- **project_compression_realwall.md** — compression-realwall rule notes
- **project_flip_long_pmcore.md** — flip-long-pmcore rule notes
- **project_fade_shadow_pnl.md** — WBF shadow PnL tracking
- **project_stacked_zone_fade.md** — Stacked-zone fade research
- **project_mbo_wall.md** — MBO wall forensics
- **project_mbo_iceberg_findings.md** — Iceberg detection
- **project_tsr_research.md** — TSR scalp research
- **project_bsr_short.md** — BSR short scalp
- **project_80pt_detector.md** — 80pt+ move detector
- **project_supertrend.md** — Supertrend reclaim strategy
- **project_siet.md** — SIET v4 strategy

---

**End of handoff.** A new session reading this top-to-bottom should be ~80% caught up. The rest comes from running the tools, reading the code, and asking the user clarifying questions as needed.

---

## 20. Most-Recent-Session Decisions (2026-06-07 evening, post-handoff drafting)

These shipped after the original handoff was drafted earlier in the day. New session: trust these.

### 20.1 LEVEL_STYLES palette standardized
- New `packages/contracts/src/level-styles.ts` is the **single source of truth** for level colors/widths/styles
- Cockpit `Chart.tsx addLevelLine()` consults LEVEL_STYLES first → palette wins over JSON
- `compute_structural_levels.ts` sources its STYLES record from contracts
- `daily_levels.json` + `daily_levels_es.json` for 2026-06-08 re-canonicalized
- Full color spec is in the level-styles.ts header comment + commit `5a9d34c`

### 20.2 CLAUDE.md auto-load
- New `CLAUDE.md` at repo root auto-loads on every Claude Code session
- Points to HANDOFF.md, embeds 6 hard rules, lists common ops
- New sessions should boot with: *"Read CLAUDE.md and HANDOFF.md, then check git status"*

### 20.3 Old project copy deleted
- `/Users/ravikumarbasker/claude-workspace/trading-cockpit` (7 GB, last commit May ~10) was a stale copy from prior workflow
- Verified no daemons/launchd/shell rc referenced it → deleted
- Reclaimed 7 GB. Active project remains at `/Users/ravikumarbasker/trading-cockpit`

### 20.4 Open color questions (Ravi to decide)
The following labels were left at sensible defaults because Ravi didn't include them in his explicit color spec. **A new session should ask before changing**:

- **PDC** (currently `#BBBBBB` grey, solid thin) — should it match PDH/PDL family (bold dashed)?
- **NQ Close / ES Close** (currently `#FFD700` gold, solid 2) — align with `#FFFFFF` like QQQ/SPY/SPX Open/Close?
- **ONO** (currently `#FF9A3C` orange, dotted) — move into ON family (cyan)?
- **Bull Zone / Bear Zone** (currently green/red, solid thin) — custom palette?
- **OHL** in Ravi's original spec was treated as typo for **ONL**. Confirm?

### 20.5 Recent regime backfill question (parked)
Ravi asked: "how many days has the 09:31 regime aligned with the rest of the day?"
- Answer requires backfilling `daily_regimes` table — currently only 1 day (05-26) stored
- Backfill design sketched: export `computeRegime()` from regime-checkpoints.ts → loop historical days → store
- **Not yet shipped.** ~30-45 min of work when prioritized.

### 20.6 Recent perf analysis context
- V3-OPEN FLIP (40 trades): 70% WR, +$2,754
- V3-OPEN SHORT subcohort (n=10): 80% WR, +$860, +$86/trade
- Cont-reentry score≥90 (12 trades, deduped): 83% WR, +$1,225
- Combined V3 (FLIP+CONT@90): 66 trades, 70.8% WR, +$4,567 over 32 days
- **For $3k/day target**: 22× MNQ contracts (≈ 2 NQ E-mini), 6-week phased ramp (5→10→20 MNQ)

### 20.7 Trader current state
- `TRADER_MODE=live` (real orders to Tradovate)
- `TRADER_ENABLED_RULES=clean-impulse` (FLIP only)
- V3 still in shadow (`V3_ACTIVE_MODE=shadow`) → trader sees QUALIFIED FLIPs, not V3-OPEN FLIPs
- To get V3-OPEN cohort live: needs `V3_ACTIVE_MODE=live` AND likely add cont-reentry to TRADER_ENABLED_RULES
- **Target cutover: week of 2026-06-09** (task #21)

### 20.8 Pending issue worth investigating early
Today (06-05) had 3 NQ SHORT FLIP winners (10:21, 13:05, 14:57 at +$80 each) all SILENCED by quality gate — specifically the **DD-band hard filter** (rs-level-scorer.ts:430): SHORT blocked when price < lower DD band. This rule was calibrated for "irrational territory" but is over-blocking on real bear days.

Suggested investigation:
1. Backfill how often DD-band-blocked SHORTs would have won
2. If high WR (>65%), relax to: SHORT blocked only when below DD AND <some volume threshold (avoid panic spikes)

### 20.9 Cockpit features added today (recap)
- Calendar widget (bottom-left) → jump to any historical date back to 2026-04-29
- 📏 Measure tool with X close button (TradingView-style)
- QUALIFIED / V3 marker toggle buttons next to measure tool
- TRADE RULES box centered at top (lifted out of top-left container)
- TIME-AND-WR / TRADE buttons removed
- LV3 paneW debug banner removed
- RegimePanel time column brightened (#e0e6f0)
- Dynamic on-scroll bar fetch with gap tracking
- /signals/marks endpoint serving qualified + V3 timestamps

---

**Truly end of handoff** as of 2026-06-07 21:30 ET (last commit `5a9d34c`).

---

## 21. Persistent Job Scheduler (launchd) — added 2026-06-07 ~midnight

### 21.1 What replaced what

The 4 Claude session-only crons that were dying on every session end have been replaced with **persistent macOS launchd plists**. They now survive:

- ✅ Claude session ending
- ✅ Terminal closing
- ✅ Mac restart
- ✅ Mac sleep/wake (launchd re-evaluates schedules on wake)

This closes task **#18** (Draft launchd plist for MBO ingest — 24/7 durability).

### 21.2 The 5 installed jobs

| Plist | Schedule | What it does | Type |
|---|---|---|---|
| `com.cockpit.mbo-ingest` | Every hour at **:23** | Pulls new bytes from `~/cockpit-mbo-capture/` into `data/mbo.db`. **Skips if another ingest is in flight** (pgrep check). | Recurring |
| `com.cockpit.structural-levels` | **Mon-Fri 9:23 AM local** | Pre-RTH compute of PDH/PDL/PDC/ONH/ONL/ONO/POC/VAH/VAL into `daily_levels.json` | Recurring |
| `com.cockpit.reminder-cvd` | One-shot **2026-06-09 8:43 AM** | macOS notification: re-evaluate `cvdShortFloor=+3000` for wall-broken-fade. Self-disables after firing. | One-shot |
| `com.cockpit.reminder-machine-repair` | One-shot **2026-06-12 (Fri) 4:30 PM** | macOS notification: hand over to weekend repair shop. RTH closed; safe to power down. Self-disables. | One-shot |
| `com.cockpit.reminder-flipshorts` | One-shot **2026-07-07 8:53 AM** | macOS notification: re-evaluate FLIP SHORTS after 5+ weeks of data. Self-disables after firing. | One-shot |

### 21.3 Files (committed at `048d5d3`)

```
scripts/launchd/
├── README.md                              — full ops guide
├── install-all.sh                         — one-shot installer
├── uninstall-all.sh                       — one-shot uninstaller
├── com.cockpit.mbo-ingest.plist           — recurring schedule definition
├── com.cockpit.structural-levels.plist
├── com.cockpit.reminder-cvd.plist
├── com.cockpit.reminder-flipshorts.plist
├── mbo-ingest.sh                          — wrapper (pgrep skip + PATH + log)
├── structural-levels.sh                   — wrapper (PATH + log)
└── reminder.sh                            — generic reminder wrapper (year check + notify + self-disable)
```

### 21.4 How the one-shots "self-disable"

macOS `launchd` doesn't support true fire-once calendars — `StartCalendarInterval` fires every year on the same date forever. The reminder wrapper (`reminder.sh`) handles this by:

1. Takes a target year as argument
2. If `date +%Y != target_year` → exit silently (no notification)
3. If matched → show notification + `launchctl bootout` + `rm` the plist

So the reminder fires exactly once at its scheduled date+time, then permanently removes itself. No annual re-fires.

### 21.5 Standard ops

```bash
# Install (idempotent — safe to re-run after editing plists)
bash ~/trading-cockpit/scripts/launchd/install-all.sh

# Verify all 4 loaded
launchctl list | grep cockpit
# Expected: "-  0  com.cockpit.mbo-ingest" etc. (PID -, exit code 0)

# Tail logs
tail -f ~/Library/Logs/cockpit-mbo-ingest.log
tail -f ~/Library/Logs/cockpit-structural-levels.log
tail -f ~/Library/Logs/cockpit-reminders.log

# Uninstall everything
bash ~/trading-cockpit/scripts/launchd/uninstall-all.sh
```

### 21.6 Edit / re-install workflow

To change a schedule or wrapper logic:

1. Edit the `.plist` or `.sh` in `scripts/launchd/` (repo source = canonical)
2. Re-run `install-all.sh` — it unloads the existing version before bootstrapping the new one
3. Verify with `launchctl list | grep cockpit`

Don't edit the copies in `~/Library/LaunchAgents/` directly — they'll be overwritten on next install.

### 21.7 Why launchd over Claude crons

| Aspect | Claude session crons | launchd plists |
|---|---|---|
| Survives session death | ✗ | ✓ |
| Survives Mac restart | ✗ | ✓ |
| Visible in cockpit notifications | ✓ (via Claude UI) | ✗ (macOS Notification Center only) |
| Easy to inspect | `CronList` tool | `launchctl list \| grep cockpit` |
| Easy to edit | re-create via `CronCreate` | edit plist + re-install |
| Time to first run | Immediate | After install + next schedule tick |

For operational tasks (MBO ingest, structural levels): launchd is strictly better.
For lightweight reminders: Claude crons are slightly more ergonomic but vanish on session end — launchd plists chosen here to survive the upcoming session switch.

### 21.8 First-fire expectations

- **MBO ingest**: next `:23` of any hour (within ~next 60 min from install at 2026-06-08 ~00:55)
- **Structural levels**: next weekday at 9:23 AM local time
- **CVD reminder**: 2026-06-09 8:43 AM (~32 hours from install)
- **Machine-repair reminder**: 2026-06-12 (Fri) 4:30 PM (~4.5 days from install)
- **FLIP SHORTS reminder**: 2026-07-07 8:53 AM (~30 days)

### 21.9 New session: what to know

A new Claude session will not see the Claude `CronList` jobs because those are session-scoped — but **launchd is OS-level** and the jobs are running independently. The new session can:

- Verify they're alive: `launchctl list | grep cockpit`
- Tail logs to confirm recent fires
- Treat them as ambient infrastructure — no re-creation needed

**This means: when starting a new session, you no longer need to manually trigger the hourly MBO ingest. The launchd job handles it.** Old Claude session-only crons that were re-created at every session start are obsolete.

---

**End of section 21.** Project state as of 2026-06-08 ~01:00 ET (last commit `048d5d3`).

---

## 22. Changes since 2026-06-08 (2026-06-08 → 2026-06-16)

> This section supersedes the relevant parts of §1–21. It covers ~40 commits across
> five working days plus one batch of uncommitted cockpit-styling work. Ordered by
> theme, not chronology. Commit hashes cited inline.

### 22.0 TL;DR — what materially changed

| Area | Before (2026-06-07) | Now (2026-06-16) |
|------|---------------------|-------------------|
| Signal engine | V3 cascade in `state.ts:applySignalV3` | **3-stage pipeline** raw → qualified → tradable; V3 fully deleted (§22.2) |
| MBO storage | `mbo.db` SQLite (76 GB, single-writer) | **Parquet + DuckDB**, Hive-partitioned by symbol/date (§22.3) |
| Config namespace | `config.v3.*` | `config.pipeline.*` |
| Audit table | `v3_decisions` | `signal_results` |
| Trader daemon | `pnpm dev` child | **launchd-managed singleton** w/ crash recovery (§22.6) |
| Live rules | clean-impulse (FLIP) only | **clean-impulse + cont-reentry** both live MNQ (§22.6) |
| Alerts | Discord only | **Discord + Pushover** fan-out via `notify.ts` |
| MBO ingest cron | single hourly job | **two parallel jobs** (NQ + ES) at `:23` |
| Levels crons | 1 morning (09:23) | morning (09:23) **+ evening (17:55)** |
| Contract | MNQM6 / MESM6 | rolled to **MNQU6 / MESU6** on 2026-06-14; contract column tags both |
| Research verdict | (open) | pre-entry overlays **don't generalize** at ~25-day sample; edge stays in raw FLIP/CONT @ flat 80/70 (§22.4) |

### 22.1 ⚠️ Open issues / immediate next-steps (read first)

1. **Parquet duplicate-row bug (§22.9)** — ✅ **FIXED 2026-06-16.** Store deduped
   (59 GB → ~8 GB live; 3.9 B+ duplicate rows removed), converter hardened
   (flush-then-checkpoint), nightly compaction job added. Acceptance: NQ 06-16 RTH
   CVD = −18,141, matches Bookmap −18.1k…−19k. Remaining: delete `.trash` (54 GB of
   originals) after you're satisfied the deduped store is correct.
2. **Uncommitted cockpit-styling batch (§22.8)** — Geist fonts, de-blur, bold/size/
   color tweaks, 2026-06-16 levels. All in working tree on branch
   `feat/2026-06-16-regime-research-cockpit-levels`, not yet committed.
3. **Stale "V3 close:" log strings** in the trader (cleanup task #18) — translate
   when reading; rename pending.

### 22.2 Pipeline refactor — V3 fully removed (Phases A–H, 2026-06-09)

The intertwined quality + actionability + side-effects in `state.ts:applySignalV3`
were replaced with a clean **3-stage pipeline: raw signal → qualified → tradable**.
Cutover went live 2026-06-09 16:00 ET (`PIPELINE_ACTIVE_MODE=live`), then the legacy
cascade was deleted phase by phase.

| Commit | Phase | What |
|--------|-------|------|
| `ccf72b9` | PR 1–4 | `signal-pipeline.ts` (`evaluateTechnical` / `evaluateActionability`), `tradable_signals` table, backfill (39k+ rows), diff-vs-V3 acceptance, soft `activeMode` cutover flag |
| `35f6162` | — | qualified-marker reader → live `tradable_signals.qualified=1` |
| `6820762` | B | deleted `applySignalV3` / `isV3EntryRule` / `v3PatternFor` / `logV3Decision` from `state.ts` |
| `e8aa7a9` | C+D | merged `config.v3.*` → `config.pipeline.*`; default mode now `live` |
| `5291058` | E | `v3_decisions` table → `signal_results`; `V3Decision`→`SignalResult`, `V3OpenTrade`→`OpenTradeRow`, `db.v3.*`→`db.openTrades.*`+`db.signalResults.*`; dropped `v3OpenTs`/`v3OpenSignals` from `/signals/marks` |
| `263ba3c` | F+G+H | `git mv` v3-rth-timer.ts→`rth-timer.ts`, v3-tick-router.ts→`tick-router.ts` (+ class/singleton renames); deleted dead `v3_*_smoke` / `diff_pipeline_vs_v3` scripts; dropped `*_pre_refactor` backup tables |
| `a39fedc` | — | close-then-reopen on qualified opposing signal |

**Acceptance data** (retained rules clean-impulse + cont-reentry): pipeline 5W/4L
55.6% +85.5 pts vs V3 baseline 5W/6L 45.5% −38.1 pts (Δ +123.6 pts ≈ +$247 MNQ).
Only 2 "unexpected lost OPENs", both losses — pipeline is marginally more conservative.

**Exit policy** is now Variant A (`trade-manager.ts:shouldExitOnSignal`): single
symmetric rule = opposing-direction + qualified + `rule_id ∈
config.pipeline.tradableExitRules` (`['clean-impulse','cont-reentry']`). Chosen via
`backtest_exit_variants.ts`: 40 trades, 67.5% WR, +1,138.5 pts on FLIP+CONT.

Net: **`grep -rn "v3" src/` is clean** except historical "REMOVED 2026-06-09"
comments. `/pipeline/state` → `{"pipelineMode":"live","symbols":["NQ"]}`. The
trader's `"V3 close:"` log prefix is the only remaining leak (cosmetic).

### 22.3 MBO storage: SQLite → Parquet + DuckDB (`d132861`, `91dada6`)

**Why**: single-writer `mbo.db` couldn't keep up — WAL contention serialized NQ+ES
depth/trade/mbo writes, and on **2026-06-13 an orphan-inode incident wiped 277 GB**
of in-flight data while two ingest procs held fds to a dead inode. Replaced with
columnar Parquet read in place by DuckDB; the JSON-lines `.log` files in
`~/cockpit-mbo-capture/` remain the canonical source of truth + safety net.

- **Converter**: `scripts/mbo_parquet_converter.py` (pyarrow 17.0.0 + duckdb 1.1.3
  pinned in `scripts/.venv-mbo`). Two modes: `backfill` (whole `.log` end-to-end,
  atomic `.tmp`→rename) and `tail` (1s poll, flush per-(table,symbol,date) every 60s
  / 250K rows, byte-offset checkpoints).
- **Schema**: 3 tables `mbo_trades` / `mbo_depth` / `mbo_events`, Hive-partitioned
  `symbol={NQ,ES}/date={YYYY-MM-DD ET}`, ZSTD-3. Adds a **`contract` column**
  (MNQM6/MNQU6/MESM6/MESU6…) so the 2026-06-14 M6→U6 roll keeps contracts separate
  (per the keep-multi-contract memory).
- **Query layer**: `apps/aggregator/src/lib/mbo-reader.ts` (`@duckdb/node-api`)
  exposes views with the legacy SQLite table names → analysis-script migrations are
  mechanical. Empty-typed fallback views for unwritten partitions.
- **Daemon**: `com.cockpit.mbo-parquet-converter.plist` runs `tail` at login,
  KeepAlive, 30s throttle.
- **Compression**: 198 GB raw `.log` → 6.9 GB parquet (**28.7×**); per-day rollup
  1–25 ms cold, 30s trade window 25 ms cold.
- **Gitignored**: `data/mbo-parquet/`, `scripts/.venv-mbo/`, `phase1-*.json`, `*.bak-*`.

**Parallel ingest** (`91dada6`): the single hourly `mbo_ingest` cron was split into
two per-symbol launchd jobs (`com.cockpit.mbo-ingest-{nq,es}`) firing at `:23`,
because sequential processing left ES ~17h behind NQ. Each has a symbol-scoped
`pgrep` guard so ES is no longer blocked by an in-flight NQ run. **Note**: the older
`mbo_ingest.ts` SQLite path predates the parquet converter; the parquet `tail`
daemon is now the live ingest. Confirm which one is authoritative before running a
manual ingest (don't double-write).

To query CVD/volume from parquet (Python): use `scripts/.venv-mbo/bin/python` with
DuckDB over `data/mbo-parquet/`. **`last` is a reserved word in DuckDB — alias around
it.** And see §22.9 — dedup with `DISTINCT` or you'll over-count by ~30%.

### 22.4 Research — Phase 1/2 reversal + regime/vol/VWAP studies (`00c9e3c`, `a83f820`, `e18465a`)

Disciplined train/test studies on the ~25-day NQ tick sample. **Bottom line: no
pre-entry selection overlay generalizes at this sample size; edge stays in raw
FLIP/CONT at flat 80/70 TP/SL.** Parked pending 5-yr MBO data.

- **Phase 1** (`scripts/phase1/`): stratified TRAIN(13)/TEST(12)/HOLDOUT(1) split,
  state-machine touch detector with `IB_LOCK_TIME=10:30 ET` (IBH/IBL leak future
  info pre-10:30), and a **true intratick simulator** that fixed an intra-bar
  look-ahead trap (the bar-walker had inflated fade WR to a fake 90%). Honest
  re-run: fade is **22% train / 31% test — losing net**. Permutation test (50K
  shuffles) + Wilson CI confirm no edge.
- **Phase 2** (`scripts/phase2/`): human-labeled pos/neg setups, two-cohort design
  (cohort_a price-action 25-day; cohort_b deep L2/L3 MBO 9-day BMD subset).
- **`e18465a` findings**:
  - tier-1 reversal: `book_dir` separated in-sample (June L3 AUC 0.73) but failed
    OOS (May L2 AUC 0.60); dropped trades still +EV.
  - regime_gate: variance-ratio/efficiency/autocorr wash out; `AC1≥0 & priorSL==0`
    looked good (82% WR) but fails multiple-testing correction.
  - **vol_regime**: prior-day VXN predicts next-day NQ **RANGE** (rho 0.62, R²0.40,
    1400 days) but NOT trend/chop/direction. VXN-scaled brackets LOSE to flat 80/70.
  - chop_adx_regime: Choppiness+ADX don't separate W/L (AUC ~0.54).
  - vwap_reversal/continuation: both ~break-even; every train pattern collapsed OOS;
    disproves the "flip a low-WR strategy" idea.
  - `regime_shadow` logs live gate decisions for fresh OOS (its `.db` is gitignored).
- **Backtest script batch** (`a83f820`): Variant A family (`backtest_a_detail.ts` is
  the canonical FLIP+CONT replay engine), `backtest_exit_variants.ts` (drove the
  exit-policy decision), `perf_es*.ts`, `persist_simulated_outcomes.ts` (writes
  `sim_pnl_pts`/`sim_exit_reason`/`sim_exit_ts` back into `tradable_signals` with a
  `--write` flag), `pipeline_breakdown.ts`. Research artifacts, not production.

Cross-reference memories: `project_phase2_reversal`, `project_vol_regime`,
`project_vwap_reversal`.

### 22.5 Structural-level + shadow strategy work (`c900d06`, `c4232d1`, `175b66d`)

- **`c900d06`**: 10 new chart labels (IBH/IBL/RTHO/VWAP/HVN/LVN/WkH/WkL/nPOC) added
  to `LEVEL_STYLES`; `compute_structural_levels.ts` gained `--evening` /
  `--prefill-next-day`; **new 17:55 ET evening cron** closes the 17h gap so the
  overnight session has reference levels. (Note: `--prefill-next-day` was later
  dropped — see `6faabc4` — next-day prefill moved to the 16:05 close cron.)
- **`c4232d1`**: shadow-trader infrastructure. `apps/aggregator/src/shadow-trader.ts`
  watches the live tick stream, detects first touches of structural levels, opens a
  **pure-observational** shadow trade (TP=50/SL=20), writes to a new `shadow_trades`
  table. **Fully isolated from live**: own state Map, no SSE/bus broadcast, called
  after `tradeManager.onTick`, wrapped in try/catch in `tick-router.ts`. Backtest
  surfaced WkH/PDH/onVAL as the strongest levels (68% WR top-3 on TEST) but CIs too
  wide to deploy capital — hence shadow-first. Also fixed `computeWeekly` (i=0→i=1)
  so WkH/WkL exclude today.
- **`175b66d`**: cooldown-shadow + corrected structural-TP analyses.
- **Levels behavior**: `8d83a2e` set `HIDE_NON_TIER1_LEVELS=false` so the chart now
  plots all levels again (Bull/Bear zones, DD bands, HP/MHP, ON levels, QQQ/SPY
  Open/Close, etc.). `6774469` had introduced the tier-1-only filter + an **SVG
  marker overlay** (replaces lightweight-charts `setMarkers` — lets us control
  weight/size/color/arrow geometry; visible-range gated).

### 22.6 Trader (Tradovate) — daemon + live cont-reentry + race fixes

| Commit | What |
|--------|------|
| `83fc334` | Trader runs as **launchd singleton** (`com.cockpit.trader`), KeepAlive on crash only, 60s throttle, `pgrep` guard prevents duplicate Tradovate sessions (root cause of a 429 storm). Exponential-backoff WS connect replaces fatal-exit-on-429. `pnpm dev` now tails the launchd log instead of spawning the trader (`pnpm dev:with-trader` for emergencies). |
| `52d2797` | halt-file watcher + composite-key dedup in signal gate |
| `ab56d86` | **cont-reentry enabled for live MNQ** (`TRADER_ENABLED_RULES=clean-impulse,cont-reentry`), TP=80/SL=70 symmetric. 23-day backtest: FLIP+CONT 108 trades 62% WR +$5,014 ($218/day) vs FLIP-only 90 trades 60% +$3,860 ($175/day). CONT lift +$50/day. |
| `b913bae` | **race-safe trade-close**: query each bracket's status BEFORE cancel+flatten; if broker already filled SL/TP, record the fill and SKIP the market order. Fixes an overshoot that opened a −1 opposite position on 2026-06-10 11:13. Also: WS reconnect now calls `ensureAuth()` (token-expiry infinite-loop fix). |
| `fcac3c8` | bound `orderSeen`/`orderSide` on cancel to prevent RangeError in mbo-ingest |
| `6faabc4` | Pushover wiring: `notify.ts` fans alerts to Discord (audit) + Pushover (<1s phone push); `PUSHOVER_USER`/`PUSHOVER_TOKEN` env; `reapply_quality_gates.ts` GATE_VERSION 4→5 |

Tradovate live account **1557816**; daily-loss cap −$1000; qty=1 MNQ (no size-up).

### 22.7 Bookmap capture fix (`86ec5a0`)

`fix(bookmap-java)`: calendar-day file rotation (v1.0 → v1.1) so capture `.log`
files roll at the day boundary instead of growing unbounded.

### 22.8 Cockpit UI — committed + UNCOMMITTED batch

**Committed**:
- `2fafa4d` chart polish — ON shading, sticky labels, badge collision avoidance, bar cache.
- `b2c88d3` TRADABLE + EXPERIMENTAL chart toggles + pipeline-mode badge (replaced the old V3 button).
- `4283ebe` chart-load / "go to latest" button / no-flicker fixes.
- `f7a4d6c` per-symbol resilience override (rs-context) + UI tweaks.
- `8d83a2e` **fire-engine "wail" siren** (3s, sawtooth+detuned square, ~650–1400 Hz sweep; lower band = short) replaces per-rule synth beeps. Fires ONLY on clean-impulse FLIP + cont-reentry OPEN tradables — never shadow/qualified-only.

**UNCOMMITTED** (working tree, this session 2026-06-16) — readability pass driven by Ravi finding text pixelated:
- **Fonts**: IBM Plex → **Geist + Geist Mono** (`index.html` Google Fonts link, `styles.css` `--font-mono`). Real 400/700/800 weights fix the faux-bold/pixelation.
- **Canvas webfont-race fix** (`Chart.tsx` ~L870): lightweight-charts painted axis/labels before Geist Mono downloaded and never redrew. Now force-loads the font then re-applies `layout.fontFamily` on `document.fonts.ready` to repaint.
- **De-blur**: removed `backdropFilter: blur(4px)` from `OpeningBias.tsx` panel and the `App.tsx` top-left levels panel; bumped backgrounds to `rgba(10,10,11,0.96)`. The blur (not the font) was the real "pixelation" cause.
- **OpeningBias**: body `fontWeight:700`, BIAS line 800; font sizes bumped (rows 13, BIAS 14); negative-value red lightened `#d64545`→`#f87171` (Gap/Bar1/CVD/BIAS-SHORT); 09:29/09:31/09:33 timestamps → white.
- **RSContextBar**: label 11→13, value 13→15; PRICE RANGE chip.
- Minor tweaks: `RegimePanel.tsx`, `StatusBar.tsx`, `TradeNoTradePopover.tsx`, `Chart.tsx` TRADE RULES box weight 700→800.
- **Data**: `daily_levels.json` / `daily_levels_es.json` (2026-06-16 RS levels, NQ+ES, ES backfill) + `data/rs-context.json` refresh. (Levels themselves committed at `3e650b7`/`812b5c3`; the working-tree changes are the in-progress 06-16 batch.)

**OpeningBias semantics** (for reference): Gap = today's RTH open − prior trading
day's RTH close (`bar1.open − priorClose`; priorClose = last bar in 15:00–17:00 ET
window before today's open, derived from 1-min bars, not exchange settlement).

### 22.9 Parquet duplicate-row data-integrity bug (discovered + FIXED 2026-06-16)

Cross-checking CVD against Bookmap surfaced a real bug **on our side**:

| Measure | RTH 09:30–16:00 CVD | trades |
|---------|---------------------|--------|
| Parquet **with duplicates** | −27,035 | 4,110,012 |
| Parquet **deduplicated** | **−16,188** | 2,879,919 |
| Bookmap (MNQ, 09:30 anchor) | −18,100 → −19,038 | — |

The converter crash-loop (~96 crashes before the `ff0e465` `ts_ms` guard) re-processed
log segments on each restart, leaving **~1.24M duplicate trade rows (~30%)**. Confirmed
true duplication (identical ts + price + size + order IDs), not OTC/block (zero
`is_otc`). Deduped, we match Bookmap closely (residual ~2–3k = post-16:00 prints +
aggressor edge cases).

**Implications**: the entire June parquet store likely carries ~30% duplicate
trade/depth/mbo rows. **Absolute volume/CVD numbers from parquet are inflated and not
trustworthy**; relative winner/loser comparisons may survive if dupes are ~uniform.
The cockpit's CVD indicator (from `ticks.db`, inferred aggressor) is separately ~3.5×
too small — use parquet (deduped) for definitive CVD, anchored to RTH 09:30 ET.

**Root cause**: each crashed converter life re-read the day's `.log` from offset 0
(`off > size` truncation reset + crash-loop) and re-flushed overlapping whole-day
files. Confirmed via file naming: many `tail-<sameStartTs>-<growingEndTs>-<diffPID>.parquet`.

**Fix applied (2026-06-16)** — three parts:
1. **Deduped the store** — `scripts/dedup_parquet_store.py` (DISTINCT-* per
   partition, originals moved to `data/mbo-parquet/.trash`, verified). Only touched
   partitions with ≥2 files. Huge partitions (mbo ES 06-15 = 2.62 B rows / ~190 GB
   uncompressed) use a **batched-incremental `EXCEPT`** path so they never
   materialize whole (one-shot DISTINCT OOM'd even at 190 GiB temp spill). Result:
   3.9 B+ rows removed; every partition now `total == distinct`; store 59 GB → ~8 GB
   live. **Acceptance**: NQ 06-16 RTH CVD = −18,141 (Bookmap −18.1k…−19k). ✅
2. **Hardened the converter** (`mbo_parquet_converter.py`): **flush-then-checkpoint**
   ordering — the on-disk checkpoint only advances past rows already in parquet, so a
   hard crash re-reads (at-least-once) instead of losing buffered rows; loud `[warn]`
   on the `off > size` truncation/re-read path.
3. **Nightly compaction backstop** — `scripts/launchd/parquet-compaction.sh` +
   `com.cockpit.parquet-compaction.plist` (03:10 daily) folds each day's ~2000 small
   tail files into one DISTINCT-deduped file and cleans any at-least-once overlap.
   Runs the same dedup script (`--execute`, only ≥2-file partitions).

**Still TODO**: delete `data/mbo-parquet/.trash` (54 GB of originals) once the deduped
store is confirmed good. The store dir is gitignored — only the scripts are committed.

### 22.10 `ff0e465` — converter corrupt-`ts_ms` guard

The tail converter crash-looped on malformed `ts_ms` overflowing datetime ("year
58425 out of range"), and moderately-bad timestamps (1970, 2534…) were written to
**70 junk `date=` partitions**. `et_date_str()` now clamps `ts_ms` to a sane window
(≥~2023-11, ≤now+2d) and try/excepts → `None`; both call sites skip None-date rows.
70 junk partitions were removed. Unit-tested. (This stopped the crashes that caused
the §22.9 duplication, but did not retroactively dedup the already-polluted store.)

---

**End of section 22.** Project state as of 2026-06-16 (Tuesday). Last commit
`e18465a`. Branch `feat/2026-06-16-regime-research-cockpit-levels` with the §22.8
cockpit-styling batch uncommitted in the working tree.

---

## 23. Changes since 2026-06-16 (→ 2026-06-24) — the RS-framework / Lightspeed L3 initiative

> This supersedes a lot of §1–22. The project's center of gravity moved from the
> old signal pipeline (FLIP/CONT) to **trading the RS (Rocket Scooter) framework's
> levels with live L3 order-flow confirmation**. Two shadow systems run live; a
> **decision engine fusing them is mid-build** (read §23.5 first — it's where an
> incoming session continues). Branch is still `feat/2026-06-16-regime-research-cockpit-levels`.

### 23.0 TL;DR — the new architecture in one picture

```
price touches an RS level
  → the framework ENGINES (EST/LM/ZONE/DD/RDZ/BZ) decide the trade
      (direction, entry, stop, size, base_prob, bounce-vs-break)   ← rs-engine, §23.2
  → the live L3 BOOK + context CONFIRM or VETO it                  ← l3 worker, §23.4
      (icebergs trading-&-refilling = hold; sitting-&-pulled = spoof)
  → take / skip + size  → shadow-logged, scored nightly            ← decision engine, §23.5
```

The old FLIP/CONT trader (`§8`, `§22.6`) still runs live on MNQ untouched — this is a
*separate, parallel* initiative aimed at replacing it once validated.

### 23.1 ⚠️ Read-first — current build state & live gotchas

1. **Decision engine — engines-decide / L3-confirms architecture is BUILT & shadow-running
   (`cc8e376`, §23.5).** At each RS-level touch the framework engines produce the thesis
   (`engine-thesis.ts:buildThesis`) and the L3 layer confirms/vetoes it (`decision-engine.ts:
   confirm`), logging to `l3_trade_decisions` with a rich diagnostic + "break forming" flag.
   The old naïve v1 scorer (`771ae29`) is **replaced** (its `l3_decisions` table is dead).
   Validated end-to-end; **shadow only, NOT wired to the trader.** The nightly resolver
   (`l3-trade-resolve.ts`, `com.cockpit.l3-resolve` 16:35) scores engine-alone vs engine+L3;
   review **2026-06-30** and tune `decision-engine.ts` weights (the `C` constants) before arming.
2. **`l3-book-worker` reseeds its in-memory book ONLY on process restart** (deploy/crash) —
   not a bug, no self-reseed. After a restart the L3 cross-check climbs back to ~100% over
   30–60 min; L2/CVD/tape are accurate immediately, only the L3 implied-gap is rebuilding.
3. **`daily_levels` single `bullZone`/`bearZone` is often the WRONG zone on gap days** —
   `rs-levels` picks the "primary" as nearest-to-DD-mid, and DD-mid sits ~1000pt from a
   gapped price. The **full zone set lives in `entry.zones.bull/bear`** (8 each); the
   engines use those via `deriveMarketState`, and the l3-worker now watches all of them
   (`545a236`). Don't trust the single primary zone.
4. **RANGE chip / `expectedRangePts` is NQ-only for both symbols** (per-symbol EM-band bug)
   — see BACKLOG. Display-only, harmless.

### 23.2 RS framework ENGINES (`rs-engine`, in `rules-v2/`) — the framework as code

The Rocket Scooter "RS Framework" (manual: `rs-framework/RS_FRAMEWORK_RULES.md`, synthesized
from transcripts) is encoded as six pure engines, each owning level/zone types with
multi-criteria entries, position sizing (S/M/L tiers, strong-pivots-small, lmDown), bounce/
break classification, base probabilities, and LM-agreement:

| Engine | File | Owns |
|--------|------|------|
| EST | `rules-v2/est-engine.ts` | MHP/HP/DD/liquidity-pocket touches (EST-agreement; mostly longs) |
| LM | `rules-v2/lm-engine.ts` | LM-code playbook legs (Light_1), per-code odds |
| ZONE | `rules-v2/zone-engine.ts` | sandwich / zone-combination setups |
| DD | `rules-v2/dd-engine.ts` | DD-band setups (lower-long / upper-short) |
| RDZ | `rules-v2/rdz-engine.ts` | half-gap / redistribution zone (Mode I + II gap-hold/fade) |
| BZ | `rules-v2/bz-engine.ts` | bull/bear-zone × DD-ratio matrix (open-zone × DD) |

- `rules-v2/derive-market-state.ts` builds the `MarketState` (price + full levels + rs-context)
  the engines consume.
- **Shadow harness** `scripts/rs-shadow.ts` runs all six every ~15s during RTH →
  `data/rs-shadow.db` table `shadow_setups` (family, pivot, direction, size_tier, level,
  entry, stop, targets, bounce_vs_break, base_prob, gate_mode, the 3 resiliences, gm, lm,
  lm_agrees, …). `scripts/rs-shadow-resolve.ts` resolves outcomes post-close.
- Per-engine test scripts: `scripts/test_{est,lm,zone,dd,rdz,bz}.ts`.
- launchd: `com.cockpit.rs-shadow`.

### 23.3 RS platform feed (Rocket Scooter, PASSIVE read of debug Chrome :9333)

The platform (rocket.place/pro-plus) is read **passively** via Chrome DevTools Protocol —
NEVER call their API (hard boundary).

- `com.cockpit.rs-chrome` (`scripts/launchd/rs-chrome-guard.sh`) keeps a debug Chrome up on
  **:9333** with a persistent profile (`~/.rs-chrome-profile`), RTH-gated. **To start it
  off-hours: `nohup "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  --remote-debugging-port=9333 --user-data-dir="$HOME/.rs-chrome-profile" … &`.**
- `com.cockpit.rs-feed` (`scripts/rs-feed.js`) — every 5s RTH, CDP reads resiliences + DD +
  ETF/MHP + VX/VVIX → `data/rs-context.json`.
- `com.cockpit.rs-levels` (`scripts/rs-levels.js`) — once at **09:32** + the new MM job:
  scrapes the TV-widget shapes (zones/levels) + LM code (`.liq-map-image-text`) + Monthly-Map
  (1D chart rectangles) → `daily_levels{,_es}.json` + `mmBullish`/`lmCode` into rs-context.
  Hardened this session (`34e9c00`,`65d2156`): **retries until every derived value is non-null**
  (the 09:32 open-time read used to return null and leave the prior day's stale value).
- `com.cockpit.rs-mm` (`scripts/launchd/rs-mm.sh`, `MM_ONLY=1`) — **every 30 min RTH**,
  re-reads only LM+MM so the Monthly-Map tracks price moving into/out of gamma zones intraday
  (`11e1a1f`).
- **Auto Greater-Market**: `gm = bull` if ANY of (DD>0.5, index-ETF>its MHP, MM-bull); only
  all-three-bearish ⇒ bear (the framework's long-bias). Computed in `rs-context.ts:getContext`.
- **KEY data-source finding (memory `project_rs_marketstate_vs_dom`):** the live RS data is in
  **`RS_SOCK.scanner.MASTER_TABLE.data`** (per-ticker; `.QQQ`→NQ, `.SPY`→ES): `CPbook`=LM code,
  `man_MHP`=the GM MHP threshold, `monthly_map`=8 expiry columns of gamma walls. `RS_SOCK.resil.
  marketState` is a **null transient getter — dead end**. Probe scripts: `scripts/rs_probe.js`,
  `scripts/rs_marketstate_compare.js`. Switching LM/MHP/MM reads onto MASTER_TABLE (no DOM/chart-
  flip) is **BACKLOG #8** (parked — works fine via DOM at ~1ms).

### 23.4 L3 live tape + book worker (Lightspeed) — `src/l3/`

- `src/l3/log-tailer.ts` — tails the live Bookmap MBO `.log` (200ms poll, sub-second; not the
  20–60s parquet flush).
- `src/l3/order-book.ts` — per-symbol L2 (depth) + L3 (MBO order-by-order) reconstruction.
  Now also: **per-order iceberg** (`icebergsNear`: cf>displayed or replace-up = native refill)
  and **order-flow primitives** (`pullNear`, `addsNear`, `syntheticRefillsNear`, `sweepNear`,
  `aggressorClusterNear`) — see §23.5. `crossCheck()` = how well L3 matches the L2 ladder.
- `scripts/l3-book-worker.ts` (`com.cockpit.l3-book-worker`) — continuous, KeepAlive. Tails
  **full-size NQU6 + ESU6**, maintains the live book, loads the RS levels, and on each touch
  writes a confluence snapshot → `data/l3-shadow.db` table `l3_level_snapshots`. Now also runs
  the decision engine (§23.5). Strategy: **analyze full-size NQ/ES, execute micros** (memory
  `project_l3_live_tape`). Watches ALL zones now (`545a236`).

### 23.5 ⭐ Decision engine — the live-trading core (MID-BUILD, read this to continue)

**The vision (agreed with Ravi):** the **engines own the trade** (direction/setup/size from the
framework); **L3 + context are a confirm/veto/size layer only — they never pick direction.** At a
touch, the engine for that level produces the thesis, then the live order-flow decides whether to
*take it now* or *skip* (and the orderflow is the powerhouse — it's the final arbiter).

**Scoping:** RS levels ONLY (MHP/HP/BZB/BrZT/DD/zones). Structural levels (onPOC/VAH/VAL/PDH/…)
are snapshot-only. The gate is natural: **the decision fires only where an engine produces a
setup** — structural touches yield no thesis.

**The confirmation principle (the core idea):** what matters is **"is hidden size actually
TRADING-and-replenishing here, or is displayed size being PULLED before it trades?"** — not the
iceberg *type*. Detect **both** native (same-id refill) and synthetic (new-id refill chain)
icebergs; gate reliability by execution + the spoof filter (cancel-on-approach, cancel/trade
ratio). A level absorbing heavy aggression while refilling and holding = real institutional
defense; a wall that sits and gets cancelled = spoof.

**Build sequence — ALL DONE (`cc8e376`, `0a687d2`):**
1. ✅ **Order-flow primitives** (`order-book.ts`): pull/spoof, stacking, synthetic-iceberg refill-
   chain, sweep, aggressor-clustering + native iceberg / implied-gap / CVD-slope / wall / absorption.
2. ✅ **Engines into the worker** — `engine-thesis.ts:buildThesis(ms, level)` runs all six engines at
   a touch, combines the setups AT the level into a thesis (direction/bounce-break/size/base_prob/
   LM-agree + confluence/conflict). Worker builds `MarketState` via the same `rs-context.ts` +
   `readDailyLevels` rs-shadow uses. Fires ONLY when an engine produces a setup (RS-levels gate).
3. ✅ **Confirmation engine** — `decision-engine.ts:confirm(thesis, l3, ctx)` → `{verdict, size,
   confirmationScore, confirms, invalidations, breakForming, diagnostic}`. Respects the framework Gate.
4. ✅ **Rich diagnostics + break-forming** — full narrative per decision; `breakForming` flagged when a
   bounce is killed by a clean opposite break. Log-only (NOT auto-traded).
5. ✅ **Resolver** — `l3-trade-resolve.ts`: engine-alone vs engine+L3 scorecard (skips: losers saved
   vs winners missed).
6. ✅ **Event-driven trigger** (`c752ab2`) — the decision fires on the trade that crosses a level,
   not the 1 Hz loop. **Measured touch→decision 122–312 ms** (was ~1.2 s), compute 1–5 ms.
7. ✅ **TWO-PROCESS SPLIT** (`27b91d7`) — the book and the decision logic are now separate processes
   so restarting the decision logic NEVER rebuilds the book:
   - **`l3-book-worker` (BUILDER, `com.cockpit.l3-book-worker`)** — tails `.log`, maintains the book,
     detects touches, computes the **direction-agnostic** L3 read (both sides + cvd/sweep/cluster) →
     `l3_touch_events`, and PUSHES a nudge over a UDS (`/tmp/cockpit-l3-touch.sock`). **Rarely restart
     — only for new L3 primitives.** No engines/confirm here.
   - **`l3-decision-worker` (DECIDER, `com.cockpit.l3-decision-worker`, `scripts/l3-decision-worker.ts`)**
     — on each nudge drains unprocessed `l3_touch_events` → `deriveMarketState` → `buildThesis` →
     `confirm` → `l3_trade_decisions`. **Restart this freely** to iterate on engines/confirm. Durable
     `processed` flag = a restart resumes + catches up. Push-driven (no poll; 10s tick is a safety net).
   - Why: a builder restart loses the in-memory book → ~30–60 min for the L3 cross-check to reconverge,
     during which **icebergs + implied-gap** are degraded (CVD-slope/sweep/pull/wall recover in ~1 min).
     The split removes that pain from daily decision-logic iteration. `l3_trade_decisions` gained `touch_ms`.

**NEXT: shadow the week → 2026-06-30 review → tune the `C` weights (decision-engine.ts) → arm.**

**Current shadow plumbing (running now):**
- `data/l3-shadow.db` table **`l3_decisions`** — one decision per touch episode (action/setup/size/
  score + the L3 read incl. `icebergs` + full rs-context + `reasons`/`vetoes` JSON + outcome cols).
  Fired by the worker's touch-episode tracker (one per visit, re-arm on leave; 90s CVD-slope ring).
- `scripts/l3-decision-resolve.ts` + `com.cockpit.l3-resolve` (16:35 ET Mon–Fri) — walks each
  long/short decision forward to a fixed bracket (NQ 40/40, ES 10/10) → WIN/LOSS/OPEN, `pnl_pts`.
- Reminder `com.cockpit.reminder-l3-scorecard` fires **2026-06-30 16:45 ET** to review the week's
  scorecard and tune weights before wiring to the trader. **Nothing is wired to the trader.**
- Experiment scripts (touch-by-touch L3 replays, no-lookahead walk-forward): `scripts/
  exp_l3_touches_0618.py`, `exp_l3_rs_touches.py`, `exp_l3_0623_touches.py`, `exp_l2_bmd_vs_cqg.py`.

**Validated findings from the week's replays (06-18, 06-23):** the *static* L3 wall/iceberg snapshot
did NOT separate winners from losers; **CVD context (level + slope) did**, and big static walls
*trapped* (06-23 ES DD-lower: 650-lot wall → lost). So the confirmation must weight CVD-context +
absorption-that-trades, and treat big sitting walls with suspicion.

### 23.6 Cockpit + levels

- Regime header: `RSContextBar.tsx` (GM/LM/VX/BBB/VVIX/DD/ETF chips + the RANGE/EM chip),
  `DayRegime.tsx` (the **DAY badge** next to the kill-switch: `BULLISH/BEARISH·CALM/STRESSED`,
  polls `/context/rs` every 30s). RS zone bands shaded; EM ±1σ/2σ lines.
- Levels: RS levels decoupled from the structural cron; **ON HP/ON MHP transcribed manually**
  (cyan=ON HP, orange=ON MHP, from `LEVEL_STYLES`); EM bands via `scripts/compute_expected_move.js`.
  Both files carry a single `bullZone`/`bearZone` (often the wrong primary — §23.1) AND the full
  `zones.bull/bear` arrays.

### 23.7 Pipeline / trader (the OLD live system — still running, MNQ)

- `39fc52a` trap→flip-long veto (skip flip-longs after a same-dir trap; `FLIP_TRAP_VETO=off` reverts).
- `800db58` cvdLongFloor tightened −3000 → **−1000**.
- `53119fa` roll-aware front-month resolver. Contract rolled M6→U6 (and a Sep roll reminder exists).
- Trader unchanged: live MNQ, clean-impulse + cont-reentry, −$1000 cap. See §8 / §22.6.

### 23.8 Data / infra

- **MBO + ticks → Parquet/DuckDB**: SQLite mbo-ingest retired (`934961a`); ticks→parquet nightly
  (`0c933d3`); store deduped + converter hardened (`27b40dc`, `0c5005e` — see §22.9).
- **Two data providers** (memory worth knowing): **BMD** (BookmapData) streams full-size NQ/ES +
  micros → the `.log` capture (L2+L3, all four). **CQG** streams the micros' L2 → `ticks.db` via
  `cockpit_addon.py` (provider-stripped, MNQ→`NQ`/MES→`ES`). ticks.db = CQG micro L2; `.log`/parquet
  = BMD. BMD vs CQG L2 agree within 1 tick ~81–97% (`exp_l2_bmd_vs_cqg.py`).
- **Aggregator wedge incident (06-23):** the aggregator event-loop deadlocked at the open (all HTTP
  hung, port still listening). Recovery: hot-reload via `touch apps/aggregator/src/index.ts` (it runs
  under `tsx watch`). Root cause unknown — output isn't logged (runs under interactive `pnpm dev`);
  adding a file log would make it diagnosable.

### 23.9 Immediate next-steps for an incoming session

1. **Continue the decision-engine build at §23.5 step 2** — wire the six engines into the worker, then
   the confirmation layer, then rich diagnostics. This is the active task.
2. **2026-06-30:** review the `l3_decisions` scorecard (`SELECT action,outcome,COUNT(*),SUM(pnl_pts)
   FROM l3_decisions GROUP BY action,outcome`) and tune the engine confirmation weights.
3. Verify the live infra each session: `launchctl list | grep cockpit`; rs-context fresh
   (`data/rs-context.json` mtime <10s during RTH); Rocket Scooter open in Chrome :9333; trader
   Tradovate WS connected.
4. **Don't** trust the v1 decision-engine calls or the single `bullZone`/`bearZone` (§23.1).

### 23.10 New launchd jobs / DBs / memories since §22

- **launchd (new):** `rs-shadow`, `rs-feed`, `rs-chrome`, `rs-levels`, `rs-mm`, `l3-book-worker`,
  `l3-resolve`, `parquet-compaction`, `structural-levels-evening`, `reminder-l3-scorecard`,
  `reminder-contract-roll`. (Full list: `launchctl list | grep cockpit`.)
- **DBs (new):** `data/rs-shadow.db` (`shadow_setups`), `data/l3-shadow.db` (`l3_level_snapshots`,
  `l3_decisions`), `data/regime_shadow.db` (regime gate research). `shadow_trades` table added to
  `trading.db` (structural-level shadow-trader, §22.5).
- **Key new memories:** `project_rs_framework_manual`, `project_rs_platform_feed`,
  `project_rs_gm_lm_method`, `project_level_autotrader`, `project_l3_live_tape`,
  `project_rs_marketstate_vs_dom`, `project_trap_signals`, `project_vol_regime`, `project_vwap_reversal`.

### 23.11 Reference — current CODE state (verified against the tree, not just commits)

**Specs / manuals (read these to understand the framework + engines):**
- `rs-framework/RS_FRAMEWORK_RULES.md` — the RS framework operating manual (GM, levels,
  resilience, EST/LP/IP/sandwich, sit-outs, exits, risk interval).
- `apps/aggregator/src/rules-v2/RS_ENGINE_SPEC.md` — the engine spec (§1 stack, §3 schemas).

**Engine API (what the worker will call in §23.5 step 2):** all take a `MarketState`, return `Setup[]`.
- `evaluateEst(ms)` · `evaluateLmSetups(ms)` + `annotateWithLm(ms,setups)` + `lmRead(ms)` ·
  `evaluateSandwich(ms)` · `evaluateDdBands(ms)` · `evaluateRdz(ms)` · `evaluateBullBearZone(ms)`.
- `deriveMarketState({symbol, rs, levels, price, open})` builds the `MarketState`.

**`MarketState`** (`rules-v2/engine-types.ts`): `{symbol, tsET, price, open, prevClose, halfGap,
levels:{bzb[], brzt[], hp, mhp, dynHp, dynMhp, onHp, onMhp, ddUpper, ddLower}, lmCode,
confluence:{gm, ddRatio, resWhite(=redist/half-gap), resBlue(=weekly-HP), resOrange(=MHP),
mmBullish, vx, bbb, vvix, vxAboveBBB, vvixElevated, isRational}, gate}`.
- `Gate`: `{mode:'normal'|'strong-pivots-small'|'sit-out', longOnly, sizeDown, ddBandBreak,
  mhpBreak, unusual}` — the Layer-0 sit-out/size-down gate derived from the irrational panel + vol.
- `Setup`: `{family:'EST'|'LM'|'ZONE'|'DDBAND'|'RDZ'|'BZ', pivot, level, direction, sizeTier:
  'N'|'M'|'S'|'0', entry, stop, targets[], bounceVsBreak:'bounce'|'break'|'reclaim'|'hold-through',
  baseProb (⚠ framework-stated, verify-live), confluenceNote}`.

**`rs-context.json` / `RSContext`** (`rs-context.ts`): `greaterMarket, ddRatio, lmCode,
mhpResilience/hpResilience/redistResilience/resilience, bySymbol{NQ,ES}, irrational[], spy/qqq/
spyMhp/qqqMhp/spyPrev/qqqPrev/qqqSpyRs, uvxy/vxGammaHp/vxGammaMhp/vxVolState, vx/bbb/vvix,
vxAboveBBB/vvixElevated/vvixGolden/isRational, vxn/expectedRangePts/em{Mid,1Low,1High,2Low,2High},
setAt, tradingDay`. `getContext(symbol)` overlays `bySymbol[symbol]` (resiliences, gm, lmCode,
mmBullish, dynHpEtf/dynMhpEtf/dynCloseEtf) on the flat defaults.

**`daily_levels{,_es}.json`** per-symbol entry keys: `symbol, mhp, hedgePressure, ddBands{upper,
lower}, bullZone{low,high}, bearZone{high,low}` (single PRIMARY — often wrong, §23.1), `zones{bull[],
bear[]}` (the FULL 8-zone arrays — use these), `additionalLevels[{label,price,color,style,width}]`
(structural + ON HP/MHP + EM bands + QQQ/SPY Open/Close, colors from `@trading/contracts` LEVEL_STYLES).

**DB schemas:**
- `rs-shadow.db.shadow_setups`: `id, trading_day, ts_ms, ts_et, symbol, family, pivot, direction,
  size_tier, level, entry, stop, targets, bounce_vs_break, base_prob, gate_mode, gate_reasons,
  lm_code, dd_ratio, res_white, res_blue, res_orange, gm, vx, bbb, vvix, price, state_json,
  outcome, exit_price, exit_ts_ms, pnl_pts, resolved_at, lm_bias, lm_prob, lm_agrees`.
- `l3-shadow.db.l3_level_snapshots`: `ts_ms, ts_et, trading_day, symbol, level_label, level_kind,
  level_price, price, dist_ticks, defend_side, l2_size, l2_orders, l3_size, implied_gap, best_bid,
  best_ask, spread, cvd, aggr_buy, aggr_sell, tape_prints`.
- `l3-shadow.db.l3_decisions`: `…, approach, defend_side, action, setup, size, score, wall, l3_size,
  implied_gap, icebergs, cvd, cvd60, aggr_buy, aggr_sell, gm, mm, mhp_res, hp_res, redist_res,
  dd_ratio, lm_code, is_rational, vx, vvix, vx_vol_state, reasons, vetoes, outcome, exit_price,
  exit_ts_ms, pnl_pts, resolved_at`.

**Aggregator endpoints (RS/shadow-relevant):** `GET /context/rs?symbol=` · `POST /context/vx` ·
`GET /pipeline/state` · `GET /signals/marks` · `POST /test/signal` · `GET /history/post-entry-markers`.

**OrderBook accessors (`src/l3/order-book.ts`):** `bestBid/bestAsk`, `ladder(n)`, `depthNear`,
`l3Near`, `icebergsNear` (native), `syntheticRefillsNear`, `pullNear`, `addsNear`, `sweepNear`,
`aggressorClusterNear`, `tapeNear`, `crossCheck`. (The §23.5 confirmation layer reads these.)

---

**End of section 23.** Project state as of 2026-06-24 (Wednesday), last commit `0a687d2` (HANDOFF
update itself follows). The active task is the decision-engine rebuild (§23.5) — engines decide,
L3 confirms. Nothing in this initiative is wired to the live trader yet.

---

## 24. Changes since 2026-06-24 (→ 2026-07-01) — RS-feed pipeline redesign + feed-health safety

### 24.0 TL;DR — what materially changed
- **The RS-platform feed was rewritten into a disjoint-file pipeline** — each writer owns one file, the aggregator is the sole merger. This kills the write races that existed when rs-feed/rs-mm/rs-levels all wrote `rs-context.json`. Committed as **`f31b6e2`**.
- **A full feed-health / staleness safety stack** was built. The pipeline now self-heals, and dead/stale regime data can no longer silently reach live orders — this closes the **06-29 failure class** (the platform showed DD + resiliences = 0 all morning and the engine traded on it). It also **auto-restarts the trader** if the Tradovate WS drops (closes the 06-23 zombie-WS gap).
- **BZB DD-gate + L2 touch-decider guards** (Images 8/9/10) were added — **IN-PROGRESS, UNCOMMITTED** (a separate thread from the feed-health work).
- **06-29 BMD data was excluded** (~37 GB, delayed feed); **context gaps** are documented (06-25 feed-late, 06-29 dead-zero).
- **Perf pull (07-01):** FLIP shorts 64.4% WR / +$1,575; CONT L/S 65% WR / +$3,058 (fixed TP/SL, MNQ $2/pt).

### 24.1 ⚠️ Read-first — build state & live gotchas
- **Committed:** `f31b6e2` (feed-health pipeline, 13 files) on branch `feat/2026-06-16-regime-research-cockpit-levels`.
- **UNCOMMITTED (the BZB/L2 thread — commit separately):** `est-engine.ts`, `engine-types.ts`, `derive-market-state.ts`, `zone-engine.ts`, `server.ts`, `l2/cqg-l2-book.ts`, `scripts/l2_touch_capture.ts`, `scripts/test_zone.ts`, `L2_TOUCH_DECIDER_PLAN.md`, + untracked `zone-pockets.ts`, `l2-decider.ts`, `RS_TOUCH_SPEC.md`, `scripts/dump_swings.ts`, `scripts/flip_short_perf.ts`.
- **LIVE now** (all restarted/reloaded, every process is launchd-persistent + RTH-gated): rs-feed, aggregator (auto-reloads on save via `tsx watch`), trader, rs-mm (60s), feed-health monitor.
- **Verify at the 07-01 open** (could not test after-hours — no live MM/feed data): `readMm` → `rs-context-mm.json` → merge; LM (CPbook) values; keep-alive holds the page; feed-health monitor + WS auto-restart behave; vx 1m/429; run `python3 scripts/verify_rawjson.py` for the live raw_json pass.

### 24.2 RS-feed pipeline — the disjoint-file model
Each writer owns ONE file; the aggregator merges. No cross-writer race. (Memory: `project_rs_feed_pipeline`.)

| writer | file | owns | cadence | reload | atomic |
|---|---|---|---|---|---|
| **rs-feed** (`scripts/rs-feed.js`, daemon) | `data/rs-context.json` | DD · 3 resiliences · **LM** · DYN_HP · irrational panel · GM-legs (spyMhp/qqqMhp) · VX-γ | 5s (RTH) | **yes — owns it** (24.3) | yes |
| **rs-mm** (`rs-levels.js MM_ONLY`) | `data/rs-context-mm.json` | mmBullish (NQ+ES) | 60s (RTH, skips 09:30–35) | no | yes |
| **rs-levels** (`scripts/rs-levels.js`) | `daily_levels{,_es,_cl,_gc}.json` | zones · DD-bands · HP · MHP | once 09:32 | last-resort | yes |
| **vx-poller** (`sources/vx-poller.ts`, in aggregator) | `rs-context.json` via saveContext | vx/vvix/spy/qqq/uvxy | 1m (+429 backoff) | no | yes |
| **aggregator** (`rs-context.ts`) | merged in-mem `_context` | merges rs-context.json ⊕ rs-context-mm.json | 2s poll + fs.watch both | — | — |

- `loadContext()` = `compute(mergeMm(rs-context.json))` — overlays `mmBullish` from `rs-context-mm.json`. `readJsonSafe` returns null on a torn/missing file → caller keeps last-good. `watchContext` watches both files + polls every **2s** (the poll is the real safety net; fs.watch is an instant-trigger layer). `saveContext` is atomic (temp + rename).
- **MM cannot be a pure read** — there's no `monthly_map` in `MASTER_TABLE` (that row has CPbook, man_HP/MHP_walls=gamma walls, OPbook, BBrMr). `RSZones`={call,put} gamma walls; `LIQUIDITY_MAP`=a string. So rs-mm keeps the 1D chart-flip; its 09:36 start avoids colliding with the 09:32 levels read.

### 24.3 rs-feed internals — LM, reload state machine, keep-alive, feedSetAt
- **LM = pure JS read** of `RS_SOCK.scanner.MASTER_TABLE.data[QQQ|SPY].CPbook` (QQQ→NQ, SPY→ES; e.g. "BLU"), NOT the `.liq-map-image-text` overlay (single/active-chart, needs a click). Moved LM off rs-levels/rs-mm → rs-feed (5s).
- **Reload state machine (the 06-29 fix):** bad tick = null scrape OR **dead-zero** (`DD==0 && nq.redist==0 && nq.mhp==0 && nq.hp==0`). 3 bad ticks → `Page.reload` (CDP) → 90s settle (no scrape/record) → capped backoff 90/180/300s → **ALARM after 4** (stop, log). A bad tick is **never recorded** — the file keeps last-good and `setAt`/`feedSetAt` freeze (= the staleness signal downstream).
- **Keep-alive:** synthetic mousemove (`Input.dispatchMouseEvent`) every 2 min — defeats the platform's **inactivity-suspend** (the page goes unresponsive after idle → all CDP evals time out; recovers on interaction). rs-feed's reload also wakes a suspended page.
- **feedSetAt** = rs-feed's OWN write time (separate from `setAt`, which vx-poller/extension also bump). All staleness gates use `feedSetAt ?? setAt`, so a vx write can't mask a dead rs-feed.

### 24.4 Feed-health / staleness safety stack
Three independent gates between a stale feed and a live order, plus rs-feed self-heals at the source, plus alerting.

| layer | what | threshold / action |
|---|---|---|
| `getContext()` (`rs-context.ts`) | stamps `contextAgeSec` / `contextStale` (from feedSetAt) every read | 30s |
| `rs-level-scorer.ts` | hard-filters (no signal, `filterReason='context-stale'`) when `contextStale` | — |
| `feed_health_monitor.js` + `com.cockpit.feed-health` (20s cron, RTH-gated) | **FEED** stale (feedSetAt >30s OR dead-zero) → writes `/tmp/trader.context-stale` (trader halts) + macOS/Discord alert; **MM** (>150s) & **LEVELS** (today's NQ set missing after 09:40) → alert-only markers | self-clears + "recovered"; one alert per episode |
| trader `risk-guard.ts` | `checkCanTrade` → `'context_stale'` (blocks order) when `/tmp/trader.context-stale` exists (separate from the manual `/tmp/trader.halt`) | per-signal |

- Alerts: macOS `osascript` always; Discord if `DISCORD_WEBHOOK` set (currently **empty** in the plist). Marker files: `/tmp/trader.context-stale`, `/tmp/trader.tradovate-ws`, `/tmp/feed-health.{mm,levels,ws}-stale`.

### 24.5 Tradovate WS health + auto-restart
- `broker/tradovate.ts` touches `/tmp/trader.tradovate-ws` on every received WS frame (Tradovate heartbeats ~2.5s), throttled ~5s.
- The monitor: WS silent **>30s in RTH → AUTO-RESTARTS the trader** (`launchctl kickstart -k gui/$UID/com.cockpit.trader`), **rate-limited** (90s cooldown between attempts), **gives up after 3** (`WS_MAX_KICKS`) → escalates to a manual-check alert. Marker `/tmp/feed-health.ws-stale` holds JSON `{count,lastKickMs}`. Test bypasses: `FEED_HEALTH_FORCE=1`, `FEED_HEALTH_NO_KICK=1`. Closes the 06-23 zombie-WS gap (WS looked alive but sat dead 11.5h; memory `feedback_trader_ws_check`).

### 24.6 History recorder raw_json completeness + verify
- `rs-context-history.ts snapshot()` now writes `raw_json = {...globalFields, ...perSymbolOverlay}` so EVERY context field lands in a column OR raw_json. Previously 8 globals were missed: `irrational`, `spyMhp`, `qqqMhp`, `spyPrev`, `qqqPrev`, `uvxy`, `vxGammaHp`, `vxGammaMhp`.
- It reads the MERGED in-mem context (`getContext`), so `mmBullish` etc. from the split files are captured (dedups on `setAt`, so a fresh mm lands on the next rs-feed tick, ≤5s). **Forward-only** — pre-fix rows keep the old raw_json. Verify: `scripts/verify_rawjson.py` (one-command pass/fail; confirmed all 8 present on a post-fix row 06-30).

### 24.7 Data integrity
- **06-29 BMD excluded** (~37 GB): NQ/ES/MNQ/MES delayed/mismatched vs CQG. CQG `ticks.db` 06-29 is intact and is the reference. `data/mbo-parquet/EXCLUDED_DAYS.md`. (Memory `data_bmd_0629_excluded`.)
- **Context gaps** (`data/CONTEXT_GAPS.md`): **06-25** feed-late (rs-context started 11:28 ET; usable 11:28+); **06-29** partial dead-zero (DD + resiliences = 0 from 09:30 until **12:21:39** — the platform didn't reload to populate the scanner fields; usable 12:21+). Same root cause (platform reload); fixed by the reload+repull cron + rs-feed's reload SM.
- **Contract identities:** CQG = `F.US.MNQU26` (Micro), stored as symbol `NQ` in `ticks.db`; BMD = `NQU26` (full). Same index — verified in-sync 06-30 (ts within 29 ms, price to 1 tick).

### 24.8 BZB DD-gate + L2 touch-decider (IN-PROGRESS, UNCOMMITTED)
(Memories `project_l2_touch_decider`, `project_rs_zone_pockets`.)
- **Settled direction rules:** BZB (bull-zone bottom) = FROM_UP support bounce; BrZT (bear-zone top) = FROM_BELOW; floors FROM_UP, ceiling FROM_BELOW.
- **BZB DD-gate (Image 10):** BZB long fires **N if DD>0.5**; on DD<0.5 only **M and only if the LM opened bullish** (`lmOpenZone==='B'`), else **skip**. `lmOpenZone` threaded engine-types → derive-market-state → est-engine → l2_touch_capture (LM code near 09:30, decoded B/MR/Br).
- **Bracket:** nearest-engine-target exits TESTED + DROPPED (worse: −541 vs −295) → reverted to **fixed 40/40** (pocket-top for LP).
- **l2_touch_capture guards:** missing-open guard (`lmOpenZone` undefined unless a real ctx row within ±30 min of 09:30) + skip touches before the first VALID context (dead-zero detector) — handles the 06-25/06-29 contamination.
- **Clean L2 validation set = 06-26 (only fully clean) + 06-25 (post-11:28)**; 06-29 DROPPED. Result: **engine-only −10 / decider CONFIRM +207** over ~2 days = **NOT validated, DO NOT ARM**. BZB gate is UNVALIDATED — needs a clean MR/Br-open + DD<0.5 day to prove it bites.

### 24.9 Signal performance (07-01) — fixed TP/SL replay, MNQ $2/pt, WIN/LOSS/OPEN only (never MFE/MAE)
| signal | bracket | n | W | L | WR | net pts | $ |
|---|---|---|---|---|---|---|---|
| **FLIP shorts** (clean-impulse short) | TP80 / SL105 * | 59 | 38 | 21 | 64.4% | +788 | +$1,575 |
| **CONT long** (cont-reentry, deduped) | TP80 / SL70 | 36 | 24 | 12 | 66.7% | +1,015 | +$2,029 |
| **CONT short** | TP80 / SL70 | 24 | 15 | 9 | 62.5% | +514 | +$1,029 |
| **CONT both** | | 60 | 39 | 21 | 65.0% | +1,529 | +$3,058 |

- The **score gate carries both** — 90+ is where the edge lives (FLIP-short 90+ = 70% WR/+$1,865, 80-89 flat; CONT 90+ = 71% WR). Scripts: `cont_reentry_perf_deduped.ts`, `flip_short_perf.ts` (new, takes `--tp/--sl/--score`).
- *FLIP-short SL=105 is the assumed live "CF↓" stop (memory `trading_params`) — CONFIRM it; the WR/PnL shift with the stop.

### 24.10 Deployment state + automatic recovery
- All processes are **launchd-persistent** (rs-feed/trader daemons; rs-levels/rs-mm/feed-health crons) or always-up (aggregator via `pnpm dev` / `tsx watch`); each **self-gates on RTH** — nothing "starts" with data.
- **Recovery is automatic:** data returns → rs-feed writes fresh (≤5s) → `getContext.contextStale` flips false (instant → scorer un-filters) → feed-health monitor clears the stale-halt (≤20s) + "recovered" → trader resumes. Total **≤20–30s**. Conservative-by-default: at the open the trader stays blocked until the feed is *confirmed* fresh.
- **Only manual case:** platform logout / Chrome death (rs-feed reloads exhausted → ALARM; WS auto-restarts exhausted → manual alert) — re-login/restart Chrome, then it auto-resumes. You are alerted (macOS/Discord).

### 24.11 Immediate next-steps for an incoming session
1. At the 07-01 open, run the verify checklist (24.1) + `python3 scripts/verify_rawjson.py` live-data pass.
2. **Commit the BZB/L2 thread separately** (24.1 file list); then forward-accumulate clean L2 days to validate the decider + BZB gate.
3. **Confirm the flip-short live stop** (assumed SL=105); optionally add flip longs + commit `flip_short_perf.ts`.
4. Optional: set `DISCORD_WEBHOOK` in `com.cockpit.feed-health.plist` for off-Mac alerts.

### 24.12 New launchd jobs / files / memories since §23
- **launchd:** `com.cockpit.feed-health` (new, 20s); `com.cockpit.rs-mm` bumped `1800`→`60`. Repo copies synced in `scripts/launchd/`.
- **New files:** `scripts/feed_health_monitor.js`, `scripts/verify_rawjson.py`, `apps/aggregator/scripts/flip_short_perf.ts`, `data/CONTEXT_GAPS.md`, `data/mbo-parquet/EXCLUDED_DAYS.md`, `data/rs-context-mm.json` (rs-mm output).
- **Memories:** `project_rs_feed_pipeline`, `data_bmd_0629_excluded`, `feedback_conversational_tone` (new); `project_l2_touch_decider` (updated).

### 24.13 Reference — current CODE state (verified this session, file:line where cited)
- `scripts/rs-feed.js` — reload SM + atomic + keep-alive + LM(CPbook) + feedSetAt (deadZero detector ~line 160; state machine in the run loop).
- `scripts/rs-levels.js` — `readMm` (MM-only, NQ+ES, no LM/click); `writeRsContext` → `rs-context-mm.json`; retry/reload demoted + FATAL alarm.
- `scripts/feed_health_monitor.js` — the 4 checks (feed/MM/levels/WS) + auto-restart.
- `apps/aggregator/src/rs-context.ts` — `MM_PATH`, `readJsonSafe`, `mergeMm`, `loadContext`, `watchContext` (2s poll), atomic `saveContext`, `getContext` (contextStale/feedSetAt).
- `apps/aggregator/src/rs-context-history.ts` — `snapshot()` raw_json globals fold-in.
- `apps/aggregator/src/sources/vx-poller.ts` — 1m + 429 backoff loop.
- `apps/aggregator/src/rules-v2/rs-level-scorer.ts` — contextStale hard-filter.
- `apps/trader/src/risk-guard.ts` — `STALE_FILE` + `context_stale` block.
- `apps/trader/src/broker/tradovate.ts` — `WS_BEAT_FILE` heartbeat tap in `ws.on('message')`.
- `apps/aggregator/scripts/l2_touch_capture.ts` — lmOpenZone, BZB gate wiring, fixed bracket, first-valid-context skip.

---

## 25. 2026-07-01 — L2 slippage-artifact finding + STRATEGIC PIVOT to a Quant Data options-regime spine

### 25.0 TL;DR — what materially changed
- **The L2 touch-decider "edge" was a slippage artifact.** The old bracket entered at `level±5` (slip) but anchored TP/SL to the LEVEL (±40), so the 5pt slip was charged on BOTH outcomes → every win was +35 and every loss −45 (a 35/45 bracket from the fill, not 40/40). Fixed to a true 40/40-from-entry bracket; on the honest bracket the pooled result goes **from +25.5pt to −211pt engine-alone**, and the decider CONFIRM set from +206.5pt to **−153.5pt**. **There is no L2 edge at n≈96/2days.** (Ravi caught the slip double-count.)
- **Stage-2 confirmed no separation:** `l2_score` AUC 0.52, every feature ≈0.5; the only "consistent" one (λ) is backwards-signed. Underpowered-null, not a validated signal.
- **STRATEGIC PIVOT (the big one):** stop trying to squeeze edge out of the ~2-week non-backfillable L2 tape. Onboard **Quant Data** (quantdata.us) — options/GEX/DEX/vanna/charm + dark pool + options flow, **1-minute intraday history back to Jan-1-2025** (order flow to Aug-2020), **backfillable** — as the new **backtestable spine**. This breaks the forward-only "regime not backfillable → n=2-days → nothing validates" wall that killed L2/DDA/CVD/VWAP.
- **Locked approach:** goal = **profitable trader, data-source-agnostic** (RS+quant, or quant alone; orderflow optional-later). **RS levels = the scaffold** (touch generator); **options data = the source-of-truth** we grade each level with; run a **head-to-head** (RS levels vs our-own-options-derived levels) and let data decide which governs.
- **Cockpit chart self-heal** shipped (`645341d`+`d3f6a9d`) — chart froze after a mid-session feed reconnect; now a 20s live-tail poll + a range-tracker guard recover it without a manual refresh. Covers NQ **and** ES (same `Chart.tsx`, symbol-switched).
- **Setup done:** Quant Data API key in `apps/aggregator/.env` (gitignored), MCP server added + `✔ Connected` (tools surface after a session reload), TradingView MCP connected (visual verification, bound to tab 2). **Security flag: root `.env` is committed — fix pending.**

### 25.1 ⚠️ Read-first — build state, branch, the pivot
- **Branch:** `fix/cockpit-chart-live-tail-poll` (off `feat/2026-06-16-regime-research-cockpit-levels`). Commits this session:
  - `2a3d8b3` feat(rs-engine): pockets layer (LP/IP/sandwich) + FROM_UP/BZB DD gates + L2 relative decider — **the BZB/L2 thread from §24.8, now committed**.
  - `3049c86` chore(gitignore): new research DB blobs + stray root trading.db.
  - `645341d` fix(cockpit): self-healing live-tail poll.
  - `d3f6a9d` fix(cockpit): don't mark the live edge as "loaded" (range-poisoning guard).
- **UNCOMMITTED (commit next):** `apps/aggregator/scripts/l2_touch_capture.ts` — the **slippage fix** (bracket now anchored to entry, §25.2). Untracked: `apps/aggregator/.env.example` (Quant Data env template). Plus the pre-existing exploratory scratch scripts + churning `data/rs-context.json` (leave).
- **The pivot governs everything now.** Do NOT keep iterating the L2 decider — it's dead at this sample (§25.2). The work is the Quant Data spine (§25.4). RS levels are the scaffold, not the goal.
- **Nothing is armed / no live trading changes.** Trader untouched; flip-short/CONT live perf from §24.9 still stands (CONT short confirmed live-managed well 07-01 — see §25.7).

### 25.2 L2 touch-decider — the slippage artifact + honest verdict (DEAD at this n)
- **Sweep 06-25→06-30 re-ran** with the current committed engine (FROM_UP/BZB-DD gates). Context-gap guards worked: **06-29 = 0 usable touches** (dead-zero until 12:21 then price gapped into a no-touch zone), **06-30 = 2 touches** (verified REAL — one-way trend-up day, price crossed only BZB@30164 + DDup@30258 once each in the post-09:40 valid window; DDup correctly GATED on DD 0.84 bull "never fade an upper-band break"). Clean set stayed effectively 06-26 + 06-25(post-11:28).
- **The bug (Ravi's catch):** `entry = level ± SLIP(5)` but `tp = level ± 40`, `sl = level ∓ 40` → realized **win +35 / loss −45** for every fixed-bracket trade (confirmed in DB: 35 wins @+35, 26 losses @−45). Slip was effectively charged on both sides. Fix in `l2_touch_capture.ts`: **TP/SL now anchored to `entry`** (`tp = entry ± TP_CAP`, `sl = entry ∓ SL_PTS`; pocket-top TP unchanged for LP) → true 40/40, slip has no point cost (Ravi's chosen convention).
- **Re-run on the honest 40/40 bracket (pooled 25-30):** engine-alone **48W/52L, 48.0% WR, −211pt**; decider CONFIRM **29W/32L, 47.5%, −153.5pt**; VETO 19W/20L. The old +25.5 / +206.5 numbers were the 35/45 geometry (closer target + wider stop inflates WR). **At a fair bracket there is no edge**, and the decider adds nothing (CONFIRM≈VETO WR).
- **Stage-2 (`l2_touch_analyze.ts`) on the pooled set:** nothing separates. `l2_score` AUC 0.52 (p=.73), `aggr_ratio` 0.54, `cvd_norm60` 0.53; only λ flags "consistent" but with the counter-intuitive sign → distrust. Most signal is level-identity/regime (BZB1 80% vs BZB0 0% at n≤6 — overfit). **NOT validated; do not arm.**
- **DD-tightening tested + failed:** BZB+BrZT with DD>0.6 = 38.5% / −127pt (worse); the DD≤0.6 set is where the (weak) money was (+107pt). DD>0.75 = 3 trades total (noise). WIN/LOSS `dd_avg` identical → DD carries no separation. "Cream" filters (AM-only, skip VX pinned, baseprob≥0.90) lift the numbers but collapse onto 06-26 = overfit, not validated. §24.8's "engine −10 / decider +207" is superseded — those were the buggy bracket.
- **Takeaway that drove the pivot:** every strategy dies the same way (underpowered null on a non-backfillable 2-week sample). The fix isn't a better feature — it's **backfillable data** (→ Quant Data, §25.4).

### 25.3 Orderflow methodology reframe + the 8-layer system design (design only, not built)
Long working session on *why* orderflow strategies keep failing and how to do it right (memory-worthy; not yet coded):
- **Root causes:** we sampled orderflow at a single instant (snapshot, not the movie); a fixed 40/40 bracket defines away the management where the edge lives; we ran underpowered significance tests and reported the nulls as "no edge" (method failure, not data failure); we tested marginals when the signal is in interactions; we never isolated the RS/options levels; "absorption" was a bid-only scalar caricature.
- **8-layer target architecture:** (0) correct primitives, (1) **level-memory/the running trace** (every level's interaction history + hold/break record + strength/freshness), (2) multi-source level unification (RS + swings + HVN + liquidity clusters + session refs), (3) liquidity/heatmap-as-data (defended vs spoof, voids, icebergs), (4) interaction semantics over a window (absorption/exhaustion/initiative/CVD-divergence/trapped-traders, relative-normalized), (5) **regime conditioning — GEX sign is THE mode-switch** (positive gamma → levels hold/fade; negative → levels break/go-with), (6) synthesis/explainable thesis, (7) trade lifecycle with **entry separated from management** (structural stops, liquidity targets — not fixed brackets), (8) descriptive-first evaluation + forward accumulation. Bulletproofing: causal/no-lookahead state machine, one engine live+replay, relative features, persistent inspectable trace.
- **From 3 orderflow-trader (Carmine) video transcripts** → seed playbook vocabulary to encode later: **delta-outlier level birth + cross-session recurrence**, **failed-break→reclaim (stop-run) reversal**, **test-over-test CVD-divergence discriminator**, **confirmation-as-a-sequence** (attack→absorb→opposite-aggression), **structural stop + next-liquidity target R:R**, **balance "don't trade the middle" / fade the false break**, **playbooks are regime-conditional**. His whole method ≈ our 8-layer spine, discretionary — validates the shape. He uses NO options data → our GEX layer is a genuine upgrade on his read.

### 25.4 Quant Data integration — decision, confirmed facts, schemas, the game plan
**Memory: `project_quant_data` (read first). Vendor: quantdata.us, $150/mo API tier (no free API trial). Ravi is subscribing / has the key.**
- **Confirmed by support (Jacob) + docs:** 1-minute **intraday historical back to Jan-1-2025** (Consolidated Order Flow back to Aug-2020); **all endpoints** provide real-time + history (Exposure-By-Strike, Interval Map, Dark Pool, Net Flow — none live-only); **6,000 tickers incl. SPX + NDX indexes** (no futures options → use SPX→ES, NDX→NQ); exposure is **dealer/MM-signed via their trade classification** (not OI-heuristic; algo is proprietary/black-box → validate against RS + price); real-time cadence **<1s**; **no quota beyond 240 req/min**; **official hosted MCP** (`https://api.quantdata.us/mcp`).
- **API shape:** base `https://api.quantdata.us/v1`, every endpoint is **`POST` + `Authorization: Bearer qd_…`** + JSON body.
  - **Exposure-By-Strike** (`/options/tool/exposure-by-strike`): body `{sessionDate | snapshotTime, greekMode: GAMMA|DELTA|VANNA|CHARM, representationMode: PER_ONE_DOLLAR_MOVE|PER_ONE_PERCENT_MOVE|RAW, filter:{ticker, ...}}` → `data[ticker].exposureMap[expiry][strike].{callExposure,putExposure}` + `stockPrice`.
  - **Interval Map** (`/options/tool/interval-map`) = **THE BACKFILL WORKHORSE**: body `{greekMode, sessionDate | timeRange:{startTime,endTime}, aggregationPeriod (MUST set to 1-min token — default is coarse; verify exact token, likely "1m"), filter:{ticker, minStrikePrice, maxStrikePrice}}` → `data[epochMs][expiry][strike].{CALL,PUT}` — **a full day of per-minute per-strike exposure in ONE request**. Gamma spine backfill ≈ 375 days × 2 indices ≈ **~750 requests** (~minutes at 240/min).
- **Storage decision:** persist **DERIVED features durable** (net GEX, gamma-flip level, call/put walls, distance-to-flip, regime labels, joined study rows), treat **raw pulls as an ephemeral cache**. Clean re: any retain-on-lapse ToS clause; the derived store is our own work. Ask support to confirm internal-storage is permitted (they said "fine to extract"; didn't explicitly bless persistence — our design makes us indifferent).
- **THE LOCKED APPROACH (Ravi):** RS levels are the **base/scaffold**, not gospel (they are themselves GEX-derived, so anchoring purely on them is partly circular). **Grade each RS-level touch with the raw options context** (nearest wall, which side of the gamma-flip, distance-to-flip, net GEX, flow) and test against the ACTUAL price outcome (hold/break) — the outcome label breaks the circularity. **From day one compute our OWN options levels (walls/flip) alongside and run a head-to-head**: if our raw-options levels beat RS's curated set, options-data becomes the literal base and RS graduates out.
- **The game plan (phases, each gates the next):**
  - **Phase 0 (NEXT — lock before any code):** define the exact **regime-signal / grading vector**. Proposed: per-minute per index (SPX→ES, NDX→NQ) = {net GEX, gamma-flip level, call wall, put wall, distance price→flip}. Decide instruments (SPX+NDX indexes; SPY/QQQ as optional cross-check?), and the first-study question.
  - **Phase 1 — validation spike (HARD GATE):** thin REST client + pull ONE clean past day (e.g. 06-26) via Interval Map for SPX+NDX gamma → compute our regime vector → diff vs the RS levels we logged that day AND vs actual price behavior. Confirm 1-min density, history depth, RS agreement. Pass→go, fail→stop.
  - **Phase 2 — backfill** Jan-2025→now of the regime vector into the derived-features store (~15 min pull).
  - **Phase 3 — first study (the payoff):** does the gamma regime (flip side, wall proximity, distance-to-flip) predict RS-level **hold vs break** + long/short, and trend-vs-chop days? Proper train/test on the now-backfillable sample. Reuse the existing L2 touch dataset (bolt options grading onto it).
  - **Phase 4 — compose** flow (leading confirm) → dark pool (new level source) → vanna/charm, one at a time, each validated.
  - **Phase 5 — live** (only after edge shown): real-time poller → disjoint file → aggregator merge (mirror the RS-feed pattern); regime = a conditioning gate; shadow then arm.
- **Competitive scan (for the record):** direct API alternatives — **FlashAlpha** (API-first GEX/DEX/VEX/CHEX, claims history to 2018 + free tier; **we already have a disconnected `flashalpha` source stub** in the aggregator — worth a head-to-head), SpotGamma (best rep, **no public API**), Unusual Whales (flow-first, GEX secondary, best dark-pool presence), Gexbot/MenthorQ (cheap, narrower; MenthorQ is futures-aware). Raw-data route: Databento/Polygon/ORATS (compute our own). Quant Data won on backfillable 1-min GEX+vanna+charm+darkpool+flow via one API + MCP.

### 25.5 Setup state — env, MCP, TradingView
- **Quant Data key:** in `apps/aggregator/.env` as `QUANTDATA_API_KEY=qd_…` (**gitignored ✅**; verified present, qd_ prefix). Template committed at `apps/aggregator/.env.example` (documents `QUANTDATA_API_KEY` + `QUANTDATA_BASE_URL`). Aggregator loads it via `import 'dotenv/config'` (cwd = apps/aggregator when scripts run via `pnpm --filter`). The REST-client path works NOW without any reload.
- **Quant Data MCP:** added `claude mcp add --transport http -s user quantdata https://api.quantdata.us/mcp --header "Authorization: Bearer …"` → `✔ Connected`. **Tools only surface after a session reload** — a fresh session gets the `quantdata` MCP tools automatically; this session's build path uses the REST client instead.
- **TradingView MCP:** connected via `tv_launch` (CDP :9222). Bound to **tab 2** (index 1) for agent work; tab 1 is Ravi's. Both tabs share `chart_id pKqn1XlO` (drawings/symbol changes MAY sync — offered a fresh isolated tab; Ravi OK with tab 2). Use for **visual verification** at validation (draw our levels/walls/flip, screenshot, eyeball hold/break) — NOT a data source (ticks.db/Quant Data are truth). Skip the lagging studies on the chart (Choppiness/ADX) per Ravi's rule.

### 25.6 ⚠️ Security — root `.env` is committed (FIX PENDING)
- `git ls-files` shows **root `.env` is tracked** (committed before the `.gitignore` `.env` rule; gitignore doesn't untrack existing files). Whatever real secrets it holds (root `.env.example` has slots for `TRADOVATE_PASSWORD`, `DISCORD_WEBHOOK`, …) may be in git history. **Not read** (avoid printing secrets). The Quant Data key was deliberately placed in `apps/aggregator/.env` (ignored), NOT root.
- **Fix (not yet done, needs sign-off):** `git rm --cached .env` (untracks, keeps local file) + commit; then **rotate** any real creds that were committed (they persist in history). Ravi to decide on rotation.

### 25.7 Health / data-integrity confirmations (07-01)
- **§24 feed pipeline VERIFIED LIVE + healthy** (the pending RTH verification): NQ+ES rs-context **0 dead-zero, no gaps** 09:30→13:19; `readMm`→`rs-context-mm.json` fresh (60s), aggregator merging per-symbol `mmBullish`; today's levels landed (09:38); vx-poller + irrational panel (10 rules — the #14 gap is now populated) live. One rs-feed reload episode **12:15:03→recovered 12:16:37 (~94s, 2 reloads, never recorded garbage)** = the reload SM working exactly as designed. Aggregator up 15.7h, `eventsLogged` climbing, in-mem merge current. (`rs-levels` exited status 2 but levels landed + `levels-stale` clear — benign.)
- **BMD 06-30 = COMPLETE, no data loss** (checked after a scare): max inter-trade gap ≤8s across the full RTH for all CME index symbols; the apparent "13:00 hole" was a **duckdb timezone-coercion bug in the query**, not the data. Use `scripts/.venv-mbo/bin/python` (has duckdb) + **epoch-integer filters** (not `to_timestamp ± INTERVAL` vs string timestamps) when querying the parquet store.
- **Live tape read (worked example):** Ravi's CONT-short from 30177.75 — read the tape (sell delta exhausting at 30109 double-tested low, delta flipped +, countertrend vs DD-0.81 bull regime) → advised protect/close over holding for TP; **closed ~+$100**. Good example of exit-on-thesis-invalidation (the management edge our fixed brackets can't capture).

### 25.8 New files / cockpit fix reference (verified this session)
- `apps/cockpit/src/components/Chart.tsx` — **self-healing chart** (`645341d`+`d3f6a9d`): live bars arrive via WS `recentEvents`→`series.update`; the init effect did a one-shot gap-backfill only, and the range tracker (`loadedRangesRef`) got poisoned across an outage → froze until refresh. Fix: (1) a 20s **live-tail poll** re-fetching `[lastBar→now]` from `/history/bars` independent of WS + `loadedRangesRef` (self-heals in one interval); (2) `recordLoadedRange()` clamps recorded ranges to `now−2min` so the live edge is never falsely "loaded". Covers NQ+ES (same component, symbol-switched). Bars come from `events` table `type='bar'` (bookmap), NOT ticks.db.
- `apps/aggregator/scripts/l2_touch_capture.ts` — bracket anchored to entry (slippage fix, §25.2). **UNCOMMITTED.**
- `apps/aggregator/.env.example` — Quant Data env template. **UNTRACKED.**
- Memory `project_quant_data` (new); `project_l2_touch_decider` context carries forward (its +207 number is now known-artifact).

### 25.9 Immediate next-steps for an incoming session
1. **Lock Phase 0** with Ravi (§25.4): the exact grading vector (net GEX / gamma-flip / call+put walls / distance-to-flip per SPX+NDX), instruments, and the first-study question. **Do not write code before this is agreed** (Ravi: "plan first, don't sprawl").
2. **Build the thin Quant Data REST client** (`apps/aggregator/src/sources/quantdata.ts` or a script): base `api.quantdata.us/v1`, `POST`+Bearer from `process.env.QUANTDATA_API_KEY`, rate-limit-aware. Verify the **Interval Map 1-minute `aggregationPeriod` token** against the live API first.
3. **Phase 1 validation spike:** pull 06-26 via Interval Map (SPX+NDX gamma) → compute net GEX/flip/walls → diff vs the RS levels logged 06-26 + actual price behavior. Optionally draw on TradingView tab 2 + screenshot for the visual check.
4. **Commit the L2 slippage fix** (`l2_touch_capture.ts`) on its own; note in the message it supersedes §24.8's numbers.
5. **Fix root `.env`** (`git rm --cached .env` + rotate) once Ravi signs off (§25.6).
6. Optional: **FlashAlpha head-to-head** (we have a disconnected stub) before over-committing to one vendor (§25.4).
7. For MCP-based interactive Quant Data queries, **restart the session** so the `quantdata` tools load (REST client doesn't need this).

## 26. 2026-07-02 — Options-landscape VERDICT + the ORDERFLOW-SYSTEM rebuild (spine: multi-scale swings + footprint)

### 26.0 TL;DR — what materially changed
- **The Quant Data options pivot ran its full course and reached an honest VERDICT: no directional or premium edge on NQ/ES after rigorous OOS testing + realistic costs.** Direction (multivariate walk-forward, 12 features, all 6 endpoint families) → AUC 0.49 (below chance, below shuffled-null, below always-long). ATM 0DTE premium selling → efficiently priced (credit≈realized move, QQQ 374d naked −$4337). OTM defined-risk credit spreads (put/call/iron-condor) → all negative after honest costs. **The ONE real, validated deliverable: a volatility/range FORECASTER** (morning IV → rest-of-day range, Spearman 0.79, +0.62 marginal over the free price-only baseline). Options predict MAGNITUDE, not DIRECTION.
- **We then PIVOTED to building the 8-layer ORDERFLOW system** (§25.3's design). This is now the active work. Built so far: the **persistent lifecycle level-memory spine** (visit-normalized), the **multi-scale swing detector** (fixes the vol-scaling granularity drift + a trend-day δ-cap), and the **footprint engine** (book-relative aggressor, significance-based imbalances). Under a strict research protocol: **R-multiple/expectancy as the metric (NOT win-rate/direction)**, one pre-registered hypothesis at a time, univariate-IC → conditional-on-context → **Shapley attribution**, a written signal ledger.
- **A persistent Quant Data store** was built (`data/quantdata.db`) — universal gzipped raw cache + materialized tables + `qdCached` read-through; a **concurrency-safe throttle fix** (Ravi caught 429 rate-limiting corrupting a sample). Reusable regardless of the options verdict.
- **Nothing is armed / no live-trading changes.** All work is UNCOMMITTED on `fix/cockpit-chart-live-tail-poll`.

### 26.1 ⚠️ Read-first — build state (everything UNCOMMITTED)
- **Branch:** `fix/cockpit-chart-live-tail-poll`. Nothing from §26 is committed. Memories are the durable record: **`project_orderflow_system` (read FIRST)**, `project_quant_data_phase0` (the full options arc + verdict + the store).
- **New source modules (aggregator):** `src/sources/quantdata.ts` (REST client + throttle), `src/sources/quantdata-store.ts` (the persistent store), `src/l3/swing-levels-ms.ts` (multi-scale swing detector — the new level source), `src/l3/footprint.ts` (the footprint engine). Plus the earlier `src/l3/level-memory.ts` (the spine, visit-normalized).
- **Data assets:** `data/quantdata.db` (options store, gzipped), `data/level-memory.db` (the spine trace), `data/quantdata_features.csv` (the multivariate-model matrix). Many scratch scripts in `apps/aggregator/scripts/` (dump_swings_*, fp_smoke, build_level_memory, *_backtest, *_check).
- **The orderflow rebuild governs now.** The options thread is CLOSED (verdict reached); its store + vol-forecaster remain reusable assets. Do NOT re-mine options for a directional/premium edge — 7 checks + a proper multivariate model + premium backtests all say it isn't there.

### 26.2 The options arc → the honest verdict (why we stopped)
Ran the full Phase-0→Phase-3 program with placebo/null discipline. Every DIRECTIONAL/LEVEL test came back null; the MAGNITUDE test passed. Chronology:
- **Phase 0 locked** the grading vector; **Phase 1 gate PASSED** (QuantData serves 1-min history to Jan-2025, walls agree with RS hedge-pressure AND actual 06-26 price turns; basis NQ−NDX ~+167 small). Store + client built.
- **RS-level hold/break study** (2688 touches, 28 days, structural label, graded via `snapshotTime`): net-GEX sign flat, wall-side flat, wall-proximity died on normalization, family×regime sign-inconsistent = **NULL**. Refinement (fixed flip + local-GEX): direction-correct but **concentrated in ~2 weeks / driven by 06-26** → not a stable edge.
- **Day-regime** (does flip-side split trend vs range days, 36d): **dead** (fracEff ~0.07 EVERY day).
- **Flow-leads-price** (net-drift, 18d): LEAD corr 0.039 (coherent lead>lag>null but untradeable linearly).
- **Vol-drift / VRP:** IV−realized gap corr with day RANGE% = **0.857** (but with efficiency only 0.138 → range predictable, direction NOT). **Causal gate:** morning IV → rest-of-day range **Spearman 0.79**, marginal 0.62 over free baseline = the one real edge.
- **Multivariate walk-forward model** (`walk_forward_model.py`, HistGradientBoosting, TimeSeriesSplit, 12 features, 373d): **OOS AUC 0.490** — below chance, below shuffled-null (0.533), below always-long (0.564). Definitive: the full smart-money combination does NOT predict NQ/ES intraday direction.
- **Premium backtests:** vol-scaled 0DTE ATM straddle (mean-rev) FAILS OOS (QQQ test 41.8% WR, losing). Naked 0DTE ATM straddle = efficiently priced (credit≈move). OTM defined-risk spreads (put/call/iron-condor, 372d, real wing cost): all negative; iron condor (direction-neutral) train −$1265/test −$2367; put spread loses even in a bull market; 74% WR still negative (pennies-vs-steamroller; 4-leg cost eats 30% of credit).
- **VERDICT:** options data on NQ/ES = a validated volatility/range forecaster (analytical/risk-sizing tool), NOT a turnkey directional or premium strategy. Ravi trades MNQ/MES.

### 26.3 The Quant Data persistent store + client (reusable regardless)
- `data/quantdata.db`: **`api_responses`** (universal gzipped raw cache, keyed by endpoint + canonical-body-sha256, ~5× compression) + materialized **`chain_snapshots`** (per-strike/expiry grids, opaque `cells_json`) + **`price_bars`** + **`coverage`** + **`regime_vector`**. `qdCached(endpoint, body)` = read-through: pulls once, owns forever, works offline/past-rate-limit.
- **All 23 options endpoints probed** → mapped to 6 shape-families (chain-grid / time-series / bars / trade-tape / oi-change / ticker-scalar). Confirmed REST paths: exposure `/options/tool/exposure-by-strike` (body `filter:{ticker}`+greekMode+representationMode+sessionDate|snapshotTime); price `/equities/tool/stock-price-over-time` (`filter:{ticker}`); option OHLC `/options/tool/option-price-over-time` (`filter:{ticker,expirationDate,strikePrice,contractType}`); also net-drift, vol-drift, vol-skew, oi-change, dark-flow paths (see memory). History to Jan-2025 (order flow to Aug-2020).
- **⚠️ Throttle bug FIXED (Ravi caught 429s on the dashboard):** the client throttle used a shared `lastCallMs` that isn't concurrency-safe → `Promise.all` multi-leg fetches bursted past 240/min → 429s were caught as SKIPS, biasing samples (OTM backtest 304-skip vs proper 20). NO data was corrupted (429s throw before caching; cache verified clean). FIX: serialized promise-chain throttle (MIN_SPACING 300ms) + 429/503 retry-with-backoff in `qdPost`. Re-ran OTM clean (372d).

### 26.4 The ORDERFLOW-SYSTEM rebuild — design LOCKED (the active work)
The rigorous rebuild of §25.3's 8-layer design. **Locked decisions (Ravi, PhD-quant framing):**
- **8 layers:** (0) primitives [`l3/order-book`, `l2/cqg-l2-book`, `divergence` OFI/Kyle-λ/MK] · (1) **level-memory/running trace** [`l3/level-memory` — the spine] · (2) multi-source level unification [`l3/swing-levels-ms` + footprint HVN/POC + RS + walls + session refs] · (3) liquidity/heatmap-as-data [TODO] · (4) interaction semantics [footprint + divergence] · (5) **regime conditioning — use VOL/expected-range (validated 0.79), NOT GEX** (this session found GEX doesn't predict level hold/break) · (6) synthesis/thesis [`engine-thesis`] · (7) lifecycle: entry SEPARATED from management, structural stops + next-liquidity targets · (8) descriptive-first eval + forward accumulation. Carmine Rosato's discretionary method maps onto this (validates the shape).
- **Research protocol:** metric = **R-multiple / expectancy distribution, NOT win-rate/direction** (a 48%-win 2.5:1 setup beats a 60%-win 1:1). Outcome = WIN/LOSS/OPEN at a FIXED pre-registered R-bracket grid {1,1.5,2,3}R, 1R = structural stop beyond the zone (NO MFE/MAE per the hard rule; fixed brackets = anti-overfit guard, walk-forward OOS). One pre-registered hypothesis at a time → univariate IC → conditional-on-context → **Shapley attribution** (which pattern is the differentiator when several fire) → a written **signal ledger**. This is the cure for "kitchen-sink → no edge, no clue what to adjust."
- **Level zones are DATA-DEFINED, not a fixed band:** swings = *candidates*; the footprint/heatmap at formation defines the zone WIDTH + significance (orderblock/sweep/HVN/absorption), and filters out thin/random swings.
- **MASTER DATAPOINT CATALOG** written (the trace-schema blueprint) — categories: level-identity / significance-zone / visit-geometry / footprint / orderbook-heatmap / flow / L3-institutional (iceberg/meta-order/VPIN) / outcome / test-over-test-deltas / context / cross-instrument — each tagged core-vs-phase2 + L2/L3. (Full catalog in the 2026-07-02 conversation; reproduce into a `docs/` file when convenient.)

### 26.5 Data provenance + the L2/L3 usage framework
- **CQG L2 (`ticks.db` / `ticks-parquet`, labeled NQ/ES) = actually MICRO (MNQ/MES)** — the mislabel is known but not renamed (scripts depend on it). NQ 2026-05-04→07-02 (54d), ES 05-12→07-02 (46d). ~1-lot avg trade size (retail/micro), consistent throughout (no micro→mini switch). **Ravi trades MNQ/MES.** Live data lands in `ticks.db`; the parquet converter LAGS (today often only partially converted → read `ticks.db` for the current day).
- **L3 MBO capture (`~/cockpit-mbo-capture`, Bookmap) = has BOTH mini and micro:** mini NQU6/ESU6 + micro MNQU6/MESU6, **2026-06-19 → 07-02** (~12 clean days; 06-29 index contracts missing = the BMD-delayed day; CL/GC from 06-24). This is the full-size institutional-flow **playground**. No separate mini-L2 exists — mini only lives in L3.
- **Usage framework — route each pattern by OBSERVABILITY:** *institutional-only* patterns (iceberg / meta-order / passive-accumulation, need order-lifecycle) → **L3 mini only** (low-N, use mini-ES as the replication). *Cross-observable* patterns (footprint delta/imbalance, sweep, structure) → **L2 micro (54d) for statistical-power screening**, **L3 mini for mechanism confirmation**, and on the ~12 OVERLAP days **race the L2-version vs L3-version against the same shared outcome** (outcomes = price = arbitrage-shared) to decide which read wins per pattern. Micro-is-retail hazard guarded by L3 confirmation; micro may also be usable as a retail-contrarian gauge. **Run the two CALIBRATION studies first** (micro-L2 vs mini-L3 footprint agreement; inferred-vs-true aggressor error).
- **Price identity vs flow:** MNQ/NQ prices are arbitrage-pinned (price discovered in the mini, micro inherits) → micro is perfect for LEVEL detection; but ORDER FLOW differs (different crowds) → footprint delta can diverge from institutional truth. **Q/S value = `qqqSpyRs` (rs-context.ts:154) = (QQQ%chg − SPY%chg)×100 pct-pts; >0 = NQ/tech leading.** Cross-instrument confluence (common-factor vs spread decomposition: both-move-together = macro, trust the break; NQ-alone = rotation, fade) is DESIGNED, deferred to a later phase (build ES spine now, analysis later).

### 26.6 The SPINE build state (what's built + verified)
- **Level-memory spine — `l3/level-memory.ts` (BUILT, visit-normalized):** persistent lifecycle level registry (dedup-by-price, merges across retire — fixes the duplicate-level bug) + a **VISIT model with hysteresis** that fixed the over-count (naive band-exit = interaction over-counted chop: 56% of interactions <5s apart, 13 "touches"/minute; visit model collapsed 94106→4751 interactions, 30202-level 296→9 visits). **KEY FINDING:** once counted as real visits, the apparent "level memory" signal VANISHED — P(hold|prior held)=64.5% vs P(hold|prior broke)=64.6% (identical) — the 94/7 was a construction artifact. Naive hold/break has no edge; richer features (P2) are the open question. Writes `data/level-memory.db` (`levels` + `interactions`).
- **Multi-scale swing detector — `l3/swing-levels-ms.ts` (BUILT + tuned):** replaces the v1 2-min-reactive vol (which caused granularity drift). Design: **session-anchored stable base vol (floor 2 / cap 40) + MULTI-SCALE zigzags (scales 1.5×/3×/6× base) + leg-relative threshold** `δ=min(DELTA_CAP[s], max(scale×base, 0.5×leg))`. **δ-cap `[40,90,180]pt` was added after today's (07-02) −1050pt trend-down day exposed the leg-relative term growing UNBOUNDED in a trend** (965pt selloff demanded a ~480pt bounce → zero swings). Tuned + verified on trend(06-05)/chop(05-29)/normal(06-02): generalizes; nested scales capture Ravi's visual swings ACROSS scales; scale+legSize = built-in significance. Insight: WHICH scale is useful depends on day character (coarse=trends, medium=chop/normal). Runs via `dump_swings_parq.ts` (parquet, fast trades-only) / `dump_swings_ticksdb.ts` (live day). Marked on TradingView tab-2 as zigzags (via `ui_evaluate` + `removeEntity`/`createMultipointShape` — the MCP `draw_remove_one`/`draw_clear`/`scroll` tools are BROKEN this session with `getChartApi is not defined`; drive the chart's real shape API via `ui_evaluate` instead).
- **Footprint engine — `l3/footprint.ts` (BUILT + validated):** incremental per-price BUY(ask-aggressor)/SELL(bid-aggressor) tallies; **book-relative aggressor** (trade≥ask=buy, ≤bid=sell — NOT the ~3.5×-off CQG flag); per-instrument binning (`FP_CFG`: NQ 4-tick, ES 1-tick); **significance-based diagonal imbalances** (signed binomial z=(a−b)/√(a+b), minZ=2 — replaces folk 3:1/4:1, makes each cell meaningful regardless of bin size); features: POC, delta, aggressorRatio, value-area(70%), imbalances, STACKED imbalances(≥3). **Reusable at TWO scopes: session-wide (always-on, cheap O(1)/trade — a LEVEL SOURCE via POC/HVN/LVN + birth-context) AND per-visit (spun up only at tracked levels, the auction read for decisions).** Validated on 06-05 down day: session delta −57927 (NEGATIVE = classification correct); notable — delta only −1.6% on a −1016pt move = the delta-vs-price DECOUPLING (passive absorption drove the move) that footprint exists to reveal. Verify via `fp_smoke.ts`.

### 26.7 The footprint's role in the system (the two-tier answer)
- **Tier 1 — session-wide footprint (always-on):** builds the full volume profile → POC/HVN/LVN/value-area are LEVEL SOURCES (not swings — must be discovered) + every swing's birth context (was it born on an HVN / absorption → zone width + significance). Cheap; must be always-on (live can't reconstruct the past profile).
- **Tier 2 — per-visit footprint (level-local):** a fresh footprint per level-test, fed only that visit's zone trades → the fine auction read (delta/imbalances/absorption/who-wins) → snapshotted into the trace + compared to the prior visit (test-over-test). Only at tracked levels (a decision only happens at a level).
- So footprint is BOTH a level **source** (Tier 1 volume levels) and a level **grader** (Tier 2 auction). NOT confined to swing zones — it *creates* some zones and grades all of them (swing-based + volume-based).

### 26.8 Immediate next-steps for the incoming session (resume here tomorrow)
1. **Wire the per-visit footprint into `level-memory.ts`** — spin up a Tier-2 `Footprint` per open visit, snapshot its features (delta/POC/imbalances/absorption) into the `interactions` trace, add test-over-test deltas. (This is Stage-2 completion.)
2. **Add Tier-1 volume levels** (POC/HVN/LVN) as a level source into the registry (Layer-2 unification), alongside the multi-scale swings.
3. **Build the heatmap engine (Stage 3)** — resting liquidity from the depth stream: walls (defended vs pulled/spoof), voids, book-flip. Snapshot at levels.
4. **Run the two CALIBRATION studies** on the 06-19→07-02 overlap BEFORE pattern screening: (a) micro-L2 vs mini-L3 footprint agreement (sets trust in the 54-day dataset + routes each pattern to L2/L3), (b) inferred-vs-true aggressor error (confidence bounds on delta).
5. **Then P2/P3 pattern screening** under the research protocol (R-multiple/expectancy, pre-registered hypotheses, univariate→conditional→Shapley, signal ledger). First pattern candidates: absorption-on-retest, sweep/stop-run-reversal, stacked-imbalance→absorption→delta-flip sequence, book-flip.
6. **Deferred:** cross-instrument NQ↔ES confluence (common-factor/spread) — build the ES spine now, analysis later. Options vol-forecaster available as a sizing/regime input.
7. **Housekeeping (not urgent):** everything is uncommitted; the committed root `.env` security issue (§25.6) still pending; reproduce the master datapoint catalog into a `docs/` file.
