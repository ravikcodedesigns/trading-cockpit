# Trading Cockpit — Handoff Document

> **Author**: Session handoff as of 2026-06-07 (Sunday)
> **Purpose**: Enable a new session to pick up the project without re-discovery
> **Audience**: Engineer or AI assistant continuing the work

---

## 1. Project Overview

**Trading Cockpit** is a real-time signal aggregation + visualization + auto-trading system for NQ/MNQ and ES/MES futures. The user (Ravi) is a retail trader building institutional-grade Pine Script-equivalent strategies in TypeScript, with a long-term goal of fully hands-off automated trading.

**Working directory**: `/Users/ravikumarbasker/trading-cockpit`
**Git remote**: `https://github.com/ravikcodedesigns/trading-cockpit.git` (branch `main`)
**Live cutover target**: Week of 2026-06-09 (V3 shadow → live)
**Live trading account**: Tradovate **1557816** (live mode currently active for FLIPs)

### Tech stack
- **Runtime**: Node.js 20+, TypeScript, pnpm monorepo
- **Backend**: Fastify (aggregator on `:8787`, trader on `:8788`)
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
│   ├── cockpit/           # React dashboard (port 5173)
│   │   └── src/components/
│   │       ├── Chart.tsx           # ⭐ Main chart + signal markers + tools
│   │       ├── SignalFeed.tsx
│   │       ├── RegimePanel.tsx
│   │       ├── OpeningBias.tsx
│   │       ├── KillSwitch.tsx
│   │       ├── TraderStatus.tsx
│   │       └── StatusBar.tsx
│   └── trader/            # Tradovate auto-trader daemon (port 8788)
│       └── src/
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

---

## 3. Data Stores & Schemas

### 3.1 trading.db (1.3 GB)

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

### 3.2 ticks.db (32 GB)

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

### 3.3 mbo.db (76 GB)

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

Currently: **GATE_VERSION = 4**.

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

## 6. V3 Framework

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

## 7. Performance Cohorts (NQ FLIP, inception → 2026-06-05)

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
TRADER_MODE=live                    # placing real orders
TRADER_ENABLED_RULES=clean-impulse  # FLIP only (not WBF, CONT, EXPL)
```

Account: **Tradovate live 1557816**. Listening on port `8788`.

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
  | 'daily_loss_limit'       // -$300 hit
  | 'max_positions'          // already open
  | 'duplicate_signal'       // dedupe
  | 'news_blackout'          // FOMC/CPI/NFP ±15 min
  | 'flip_long_pre_1030'     // FLIP LONG before 10:30 ET
  | 'after_1430_stop'        // any entry after 14:30 ET
  | null;

const FLIP_LONG_START_MIN = 10 * 60 + 30;   // 10:30 ET
const UNIVERSAL_STOP_MIN  = 14 * 60 + 30;   // 14:30 ET
```

**Daily-loss cap**: currently **-$300** (lowered from -$500 on 2026-06-02). When hit, no new entries until next day.

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

## 11. Scripts Directory (apps/aggregator/scripts/)

100+ scripts. The most important ones:

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
- **#18** Draft launchd plist for MBO ingest (24/7 durability)

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
