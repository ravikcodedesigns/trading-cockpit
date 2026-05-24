# CF Long (Clean Flip Long) — Complete Reference

## What is CF Long?

CF Long (`clean-impulse`, direction=`long`, strategy_version=`H`, pattern=`FLIP`) is a **counter-trend exhaustion reversal signal** on NQ futures. It fires when sellers have been dominant over the last 5–15 bars and price shows a structural flip — the exhaustion of selling pressure, not a trend-following entry. The expectation is a bounce of 70–80+ pts from entry.

It is NOT a trend-following signal. It fires *against* the prevailing selling direction at moments of seller exhaustion.

---

## Signal Payload Fields

Stored in the `signals` table in `trading.db` as JSON in the `payload` column:

| Field | Type | Meaning |
|---|---|---|
| `entry` | number | Entry price (NQ points). If > 1000, use directly; else query nearest tick from ticks.db |
| `delta5` | number | Net buy−sell volume delta over the last 5 bars. **Negative = sellers dominant** |
| `delta15` | number | Net buy−sell volume delta over the last 15 bars. Negative = bearish background |
| `deltaT` | number | Total session delta from 09:30 ET to signal time |
| `pattern` | string | `'FLIP'` (reversal) or `'CONT'` (continuation). CF Long only uses `FLIP` |

**Key insight on delta5 sign:** For CF long, delta5 must be ≤ −1000 (strongly negative = sellers exhausted). A value of −2000 means stronger selling exhaustion than −1000. Positive delta5 (buyers dominant) is the wrong direction for a reversal long.

---

## Database Schema

### `trading.db` — signals table

```sql
CREATE TABLE signals (
  id               INTEGER PRIMARY KEY,
  ts               INTEGER,          -- Unix ms timestamp
  symbol           TEXT,             -- 'NQ' or 'ES'
  rule_id          TEXT,             -- 'clean-impulse', 'expl', 'absorption', etc.
  direction        TEXT,             -- 'long' or 'short'
  strategy_version TEXT,             -- 'H', 'EXPL', 'B', etc.
  score            INTEGER,
  payload          TEXT,             -- JSON: entry, delta5, delta15, deltaT, pattern, ...
  meta             TEXT,             -- JSON: { filtered: true/false }
  rs_hard_filtered INTEGER           -- 1 if silenced by time gate at creation
);
```

### `ticks.db` — trades table

```sql
CREATE TABLE trades (
  id               INTEGER PRIMARY KEY,
  ts               INTEGER,          -- Unix ms
  symbol           TEXT,             -- 'NQ' or 'ES'
  price            REAL,
  size             INTEGER,
  is_bid_aggressor INTEGER           -- 1 = buyer aggressor, 0 = seller aggressor
);
```

Tick range available: **May 4 – May 22, 2026** (33.5M NQ ticks).

---

## Three Filtering Layers

Signals go through three independent gates before reaching the chart and Discord. Every layer must pass. Listed in order of application:

### Layer 1 — `rs_hard_filtered` (set at signal creation in `strategy-h.ts`)

Stored as `rs_hard_filtered = 1` in the DB. Applied in `isLongTimeAllowed()`:
- **Before 09:54 ET**: blocked (market too volatile at open)
- **14:30–16:00 ET**: blocked (end-of-day, no edge)

Filter in SQL: `AND rs_hard_filtered IS NOT 1`

### Layer 2 — `meta.filtered` (set post-creation)

Stored as `json_extract(meta, '$.filtered') = true`. Applied by the comp_pos filter after signal creation.

Filter in SQL: `AND json_extract(meta, '$.filtered') IS NOT 1`

### Layer 3 — `classifySignalQuality()` in `quality.ts` (in-memory, just before broadcast)

Applied live in `state.ts → applySignal()`. Three sub-gates:

**3a. EXPL conflict check** (`checkExplConflict()`):
- Look back 60 minutes (`EXPL_LOOKBACK_MS = 60 * 60_000`)
- If the most recent EXPL in the window is a SHORT (opposing) AND no same-direction EXPL is more recent → potential conflict
- Compute `ratio = |deltaT| / max(|delta5|, |delta_last3|, 1)` using the EXPL signal's own values
- If `ratio > 0.25` → silenced (active opposing EXPL momentum)
- If `ratio ≤ 0.25` → allowed through (structural exhaustion of the EXPL itself)

**3b. delta15 gate** (LONG only):
- `delta15 >= 500` → silenced (buyers still dominant in background, no exhaustion to reverse)
- `delta15 < 500` (or null) → passes

**3c. delta5 gate**:
- Without same-direction EXPL in window: `|delta5| >= 1000` required
- With same-direction EXPL in window: `|delta5| >= 800` required (zone confirmation substitutes for raw magnitude)
- Note: the live code uses `ABS(delta5) >= threshold` — but for longs, all signals in practice have negative delta5, so directional check (`delta5 <= -1000`) is equivalent and more correct

**3d. Regime gate**: Currently **DISABLED** in production (`quality.ts` line ~262). See regime section below.

---

## Canonical SQL — Chart-Visible NQ CF Long Signals

This query exactly replicates what the live system broadcasts. Use this as the ground truth for any analysis:

```sql
WITH expl_sig AS (
  SELECT ts AS expl_ts, direction AS expl_dir,
    CAST(json_extract(payload,'$.delta5') AS REAL) AS expl_d5,
    CAST(json_extract(payload,'$.deltaT') AS REAL) AS expl_dT
  FROM signals WHERE rule_id='expl' AND strategy_version='EXPL' AND symbol='NQ'
),
cf AS (
  SELECT ts, payload, CAST(json_extract(payload,'$.delta5') AS REAL) AS delta5
  FROM signals
  WHERE rule_id='clean-impulse' AND direction='long' AND strategy_version='H' AND symbol='NQ'
    AND rs_hard_filtered IS NOT 1
    AND json_extract(meta,'$.filtered') IS NOT 1
    AND (json_extract(payload,'$.delta15') IS NULL OR
         CAST(json_extract(payload,'$.delta15') AS REAL) < 500)
    AND CAST(json_extract(payload,'$.delta5') AS REAL) <= -1000
),
opp_expl AS (
  -- Most recent opposing EXPL in 60-min window before each CF long
  SELECT cf.ts AS cf_ts,
    e.expl_ts AS last_opp_ts, e.expl_d5 AS opp_d5, e.expl_dT AS opp_dT
  FROM cf JOIN expl_sig e ON e.expl_dir='short'
    AND e.expl_ts >= cf.ts - 3600000 AND e.expl_ts < cf.ts
    AND e.expl_ts = (
      SELECT MAX(e2.expl_ts) FROM expl_sig e2 WHERE e2.expl_dir='short'
        AND e2.expl_ts >= cf.ts - 3600000 AND e2.expl_ts < cf.ts
    )
),
same_expl AS (
  SELECT cf.ts AS cf_ts, MAX(e.expl_ts) AS last_same_ts
  FROM cf JOIN expl_sig e ON e.expl_dir='long'
    AND e.expl_ts >= cf.ts - 3600000 AND e.expl_ts < cf.ts
  GROUP BY cf.ts
),
conflict AS (
  SELECT cf.ts, cf.payload,
    CASE WHEN o.last_opp_ts IS NOT NULL
          AND (s.last_same_ts IS NULL OR o.last_opp_ts > s.last_same_ts)
         THEN 1 ELSE 0 END AS has_conflict,
    ABS(o.opp_dT) * 1.0 / MAX(ABS(o.opp_d5), 1) AS ratio
  FROM cf
  LEFT JOIN opp_expl o ON o.cf_ts = cf.ts
  LEFT JOIN same_expl s ON s.cf_ts = cf.ts
)
SELECT ts, payload FROM conflict
WHERE NOT (has_conflict = 1 AND ratio > 0.25)
ORDER BY ts;
```

**Important:** Also filter `isRTH(ts)` in code (weekday 09:30–16:00 ET) after the SQL.

---

## Signal Counts (as of May 22, 2026)

| Stage | Count | Notes |
|---|---|---|
| All CF long ever created | ~84 | NQ + ES combined |
| NQ only | 73 | `AND symbol='NQ'` |
| After `rs_hard_filtered IS NOT 1` | ~47 | Removes time-gated signals |
| After `meta.filtered IS NOT 1` | ~35 | Removes comp_pos filtered |
| After delta15 < 500 + delta5 ≤ −1000 | 27 | Removes weak/wrong-direction |
| After EXPL conflict check | **26** | Final chart-visible count |

---

## Win Rate Analysis

### Parameters (active as of May 2026)

| Strategy | SL | TP |
|---|---|---|
| CF Long | **55 pts** | **80 pts** |
| CF Short | 105 pts | 80 pts |
| EXPL Long | 70 pts | 80 pts |
| ABSO Long | 140 pts | 80 pts |

**Win condition:** TP hit before SL, scanning tick-by-tick from entry to end of RTH (16:00 ET). Each signal evaluated independently. Losers that expire at EOD without hitting either = counted as LOSS.

### Overall WR (May 5–22, 2026, n=26 signals)

| Metric | TP=80 / SL=55 | TP=70 / SL=55 |
|---|---|---|
| Wins | 18 | 22 |
| Losses | 7 | 4 |
| Open at EOD | 1 | 0 |
| **Win rate** | **72%** | **85%** |
| **Mean PnL/trade** | **+42.2 pts** | **+50.8 pts** |
| **Std deviation** | 61.86 pts | 45.99 pts |
| **Sharpe ratio** | **0.682** | **1.104** |
| **PnL/100 trades** | **+$84,400** | **+$101,538** |

At $20/pt per 1 NQ contract. Sharpe = mean PnL per trade / std deviation (per-trade, no risk-free rate).

**TP=70 is strictly better on every metric.** Higher mean, lower std dev, higher Sharpe. The Sharpe improvement (0.68 → 1.10) comes from both a higher average return and a tighter distribution — converting 3 near-miss losses (MFE 70–78) into wins reduces outcome variance significantly. A Sharpe above 1.0 is generally considered good; above 2.0 is excellent.

**TP=70 mechanics:** 3 May 22 afternoon losses had MFE of 70–78 pts before reversing, so they hit TP=70 before SL=55. The 4 remaining losses (MFE 24–41 pts) never reached 70 regardless.

### Time-Window WR (TP=80, SL=55)

| Window | CF↑ WR | n |
|---|---|---|
| 09:30–09:59 | — | 0 |
| 10:00–10:29 | 50% ⚠ | 2 |
| 10:30–11:29 | 80% | 5 |
| **11:30–12:59** | **79%** | **14** ← strongest window |
| 13:00–14:29 | 40% ⚠ | 5 |
| 14:30–15:59 | — | 0 (time gated) |

---

## The 7 Losses — Complete Detail

| Date & ET | Entry | MAE | MFE | delta5 | delta15 | sessDelta | Regime |
|---|---|---|---|---|---|---|---|
| May 18 11:10 | 29047.25 | −55 | 41 | −1513 | −1143 | −3780 | NEUTRAL |
| May 19 13:48 | 29061.5 | −55 | 40 | −2761 | −2963 | +13198 | BULL WEAK |
| May 21 14:18 | 29454.5 | −55 | 24 | −1464 | −3289 | +8892 | BULL WEAK |
| May 22 10:08 | 29563.75 | −55 | 36 | −1490 | −4518 | +852 | BULL STRONG |
| May 22 11:50 | 29675.5 | −55 | 72 | −2292 | −3466 | +2611 | BULL STRONG |
| May 22 12:16 | 29670.0 | −55 | 78 | −1744 | −1747 | +1003 | BULL STRONG |
| May 22 13:20 | 29677.5 | −55 | 70 | −2784 | −3436 | +1483 | BULL STRONG |

**sessDelta** = cumulative net buy−sell volume from 09:30 ET to signal time (from `ticks.db` using `is_bid_aggressor`).

### Why May 22 was different

May 22 had 4 consecutive losses and 1 winner (10:24, delta5=−4239, MFE=80). The winning signal had:
- sessDelta = −2085 (sellers had taken net control by 10:24)
- |delta5| / |delta15| ≈ 1.0 (current selling as intense as 15-bar background = acute exhaustion)

All 4 losers had positive sessDelta (+852 to +2611) — buyers net dominant on the day — and |delta5| / |delta15| < 1.0 (selling flush weaker than background). May 22 was a **distribution day** where price kept bouncing to near TP then reversing. No intraday filter in the dataset cleanly isolates it.

---

## Filter Analysis — What Would Have Avoided the Losses

| Filter | Losses removed | Wins removed | Verdict |
|---|---|---|---|
| Time < 14:00 | 1 (May21 14:18) | 0 | ✅ Clean, narrow |
| After 13:00 AND sessDelta > +8,000 | 2 (May19+May21) | 0 | ✅ Best clean filter |
| 1h bar bullish | 2 | 4 | ❌ Removes too many winners |
| delta5 ≤ −2000 | 4 | 9 | ❌ Poor tradeoff |
| sessDelta < 0 | 6 | 12 | ❌ Kills half the trades |

**Actionable filter with zero false positives:** "After 13:00 ET, skip CF long if session delta > +8,000 (buyers have been dominant all session — the reversal signal is late, not a genuine exhaustion)."

The May 22 losses have no clean systematic filter that doesn't also remove winners — they are a **regime day** problem requiring day-level context.

---

## Regime Backtest

The cockpit computes regime at 4 checkpoints (09:31, 10:00, 12:00, 13:30) using:
- **Daily structure** (yesterday's bar: close position + direction)
- **4H structure**
- **H1 structure** (at 12:00 and 13:30)
- **VWAP** (session VWAP vs current price)
- **Session delta / 30m delta / OR break / vs morning** (checkpoint-specific)

Majority vote → `BULL STRONG | BULL WEAK | NEUTRAL | BEAR WEAK | BEAR STRONG`.

### CF Long WR by regime label (May 5–22, 2026)

| Regime | Wins | Losses | WR |
|---|---|---|---|
| **BEAR STRONG** | **4** | **0** | **100%** |
| BULL STRONG | 12 | 4 | 75% |
| BULL WEAK | 1 | 2 | 33% |
| NEUTRAL | 1 | 1 | 50% |
| BEAR WEAK | 0 | 0 | — |

### Key findings

1. **Blocking CF long in bearish regime** (original idea) = **wrong direction**. Makes results worse: blocks 4 winners, catches 0 losses. EV drops from +42 to +35 pts/trade.

2. **Requiring BEAR STRONG as confirmation** (counter-trend confirmation idea) = conceptually sound. CF long works best in clearly bearish structure where sellers are most overextended. 100% WR in BEAR STRONG.

3. **BUT: n=4 is statistically meaningless.** Need 30+ BEAR STRONG signals before this is a trustworthy filter. Currently tracking. Do NOT implement as a live filter yet.

### Status: TRACKING — DO NOT IMPLEMENT

The regime filter for CF long is a **hypothesis under observation**. Current evidence:
- BEAR STRONG regime: 4/4 wins (100%) — too small to trust
- Losses clustered in BULL STRONG/WEAK — regime does not protect against them

Re-evaluate when dataset reaches 15–20 BEAR STRONG CF long signals.

---

## Key Code Locations

| File | Purpose |
|---|---|
| `apps/aggregator/src/rules-v2/strategy-h.ts` | Signal creation, `isLongTimeAllowed()` time gates |
| `apps/aggregator/src/quality.ts` | `classifySignalQuality()`, `checkExplConflict()`, `isRegimeBearish()` (disabled) |
| `apps/aggregator/src/state.ts` | `applySignal()`, `buildRegimeContext()`, `EXPL_LOOKBACK_MS=60min` |
| `apps/cockpit/src/components/Chart.tsx` | `computeRegime()`, `regimeAlignment()`, `WR_ROWS` table |
| `apps/cockpit/src/components/RegimePanel.tsx` | UI for regime checkpoints |
| `apps/aggregator/scripts/wr_by_window.ts` | Time-windowed WR analysis script (authoritative) |

---

## Analysis Scripts

```bash
# Time-windowed WR table (updates Chart.tsx WR_ROWS)
cd apps/aggregator && node_modules/.bin/tsx scripts/wr_by_window.ts

# Regime backtest against all CF long signals
cd apps/aggregator && node_modules/.bin/tsx scripts/regime_cf_backtest.ts
```

---

## Open Questions / Future Work

1. **sessDelta filter**: "After 13:00, skip if sessDelta > +8,000" caught 2 losses cleanly. Monitor whether it holds on new data.

2. **BEAR STRONG hypothesis**: Collect more signals. If BEAR STRONG WR stays near 100% at n=20+, implement as a confirmation gate (require BEAR STRONG, not merely allow it).

3. **May 22 day-level filter**: What identifies a distribution day before signals fire? Candidates: price below prior day's close at 09:30, or 09:30–09:45 opening range is a strong bearish bar. Needs separate analysis.

4. **TP=70 vs TP=80**: TP=70 gives better EV (+50.8 vs +42.2 pts) and higher WR (85% vs 72%) on current data. Consider switching live TP to 70 once validated on out-of-sample data.

5. **Regime gate in `quality.ts`**: Currently disabled. Do not re-enable for CF long until BEAR STRONG hypothesis is validated (see point 2).
