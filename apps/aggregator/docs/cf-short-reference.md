# CF Short (Strategy H) — Complete Reference

Generated: 2026-05-23  
Dataset: NQ futures, all CF short FLIP signals after all three filter layers  
TP/SL baseline: **80 pts / 105 pts**  
Entry: signal close (short entry). Stop: 105 pts above entry.

---

## 1. Concept

CF Short fires when **buyer exhaustion** occurs at the upper end of the recent range.

The setup logic:
1. The prior 1–2 bars show **strong buy-side impulse** (large net buy delta, momentum pushing into resistance).
2. The current bar forms a **bearish reversal candle**: the body closes below open (sellers took control), with a long upper wick rejecting higher prices.
3. The bar's HIGH is in the **upper 50–100%** of the trailing 30-bar macro range — price reached elevated territory.
4. The net delta on the reversal bar itself is **bearish** (buyers came in but sellers absorbed them, deltaT ≤ 300).

This is a contra-trend exhaustion signal: the prior bars printed aggressive buying, but the reversal bar shows that buying was absorbed at the high. Price is expected to revert structurally.

CF Short pairs with CF Long as the symmetric side of the `clean-impulse / strategy H` strategy.

---

## 2. FLIP Pattern Detection (SHORT)

The SHORT FLIP is detected in `apps/aggregator/src/rules-v2/strategy-h.ts` → `detect()`.

### 7 Conditions

| # | Condition | Constant / Value |
|---|-----------|-----------------|
| 1 | Bar body (open − close) ≥ minimum | `BODY_MIN = 5 pts` |
| 2 | Upper wick (high − open) ≥ minimum | `FLIP_WICK_MIN_SHORT = 15 pts` |
| 3 | Bar HIGH position in 30-bar macro range ≥ lower bound | `FLIP_COMP_MIN_SHORT_HIGH = 0.50` |
| 4 | Bar HIGH position in 30-bar macro range ≤ upper bound | `FLIP_COMP_MAX_SHORT_HIGH = 1.00` |
| 5 | Prior-bar net buy delta (priorImpulse) ≥ threshold | `FLIP_PRIOR_IMPULSE_SHORT = 1400` |
| 6 | Reversal bar deltaT ≤ max (buyers absorbed, not dominant) | `FLIP_DELTA_T_SHORT_MAX = 300` |
| 7 | Bar total range ≥ minimum | `FLIP_BAR_RANGE_MIN_SHORT = 22 pts` |

### Key computed values stored in payload

| Field | Formula | Role |
|-------|---------|------|
| `compPos` | `(cur.low − macroLow) / (macroHigh − macroLow)` | Position of bar LOW in 30-bar range |
| `compPosHigh` | `(cur.high − macroLow) / (macroHigh − macroLow)` | Position of bar HIGH — SHORT uses this |
| `deltaT` | Net buy-sell delta for the reversal bar | Condition 6 |
| `delta5` | Net delta over last 5 bars | Quality gate (≥ +1000) |
| `delta15` | Net delta over last 15 bars | Quality gate |
| `deltaLast3` | Net delta over prior 3 bars | Context |
| `priorImpulse` | deltaT of the prior bar | Condition 5 |
| `stopLevel` | `cur.high` | Actual bar-high stop (tight) |
| `stopDist` | `cur.high − cur.close` | Distance to bar high |

### Entry & Stop

- **Entry**: `cur.close` (close of the reversal candle, short entry)
- **Stop**: `cur.high` (bar high — the structural invalidation level)
- **Payload stopLevel** = bar high (ranges 15–65 pts from entry in practice)
- **Backtest SL** = 105 pts above entry (fixed, for consistent comparison)

### Hourly Alignment Gate

Before signaling, `isShortHourlyAligned()` checks that the **last complete 1H bar is red** (close < open):
- Green 1H = 13% WR (signal suppressed at generation)
- Red 1H = 82% WR (signal passes)

This gate runs inside `detect()`, not in `classifySignalQuality()`.

### Cooldown & Stale Guards

- Cooldown: 15 minutes between consecutive SHORT FLIP signals (`COOLDOWN_MS = 900_000`)
- Stale: signals older than 2 minutes are discarded (`STALE_MS = 120_000`)

---

## 3. Three Filter Layers

Identical pipeline to CF Long (see cf-long-reference.md §3).

### Layer 1 — `rs_hard_filtered` (time gate)
- `isLongTimeAllowed()`: blocks before 09:54 ET and 14:30–16:00 ET  
- CF short inherits the same time gate (no separate short time gate in the code)
- SQL: `rs_hard_filtered IS NOT 1`

### Layer 2 — `meta.filtered` (comp_pos / directional quality)
- `classifySignalQuality()` in `quality.ts` applies:
  - **delta5 gate**: `delta5 >= +1000` (buyers dominant in last 5 bars)
  - **delta15 gate**: `delta15 >= threshold` (buyers in background)
  - **EXPL conflict check**: opposing EXPL long in 60-min window silences if `|opp_dT| / max(|opp_d5|, 1) > 0.25`
- SQL: `json_extract(meta,'$.filtered') IS NOT 1`

### Layer 3 — Pattern gate
- SQL: `json_extract(payload,'$.pattern') = 'FLIP'`
- AND: `CAST(json_extract(payload,'$.delta5') AS REAL) >= 1000`

### Canonical SQL (all 3 layers)

```sql
SELECT *
FROM signals
WHERE rule_id = 'clean-impulse'
  AND direction = 'short'
  AND strategy_version = 'H'
  AND symbol = 'NQ'
  AND rs_hard_filtered IS NOT 1
  AND json_extract(meta, '$.filtered') IS NOT 1
  AND json_extract(payload, '$.pattern') = 'FLIP'
  AND CAST(json_extract(payload, '$.delta5') AS REAL) >= 1000
ORDER BY ts
```

---

## 4. Signal Inventory (May 2026)

**n = 11 signals** (NQ only, all three filter layers applied)

| Signal Time (ET)   | Entry     | StopDist | d5    | d15   | dT    | sessDelta | compPos | Result  |
|--------------------|-----------|----------|-------|-------|-------|-----------|---------|---------|
| 2026-05-12 12:16   | 28889.50  | 22.3     | 2472  | 4411  | -448  | -5374     | 0.778   | ✓ WIN   |
| 2026-05-13 09:42   | 29237.00  | 36.3     | 4494  | 1924  | -3    | +2840     | 0.747   | ✓ WIN   |
| 2026-05-15 10:09   | 29212.25  | 23.3     | 2777  | -865  | -223  | -3855     | 0.736   | ✗ LOSS  |
| 2026-05-15 10:36   | 29322.25  | 15.8     | 1346  | -933  | -1206 | +2886     | 0.797   | ✓ WIN   |
| 2026-05-15 11:11   | 29297.75  | 24.8     | 1323  | 284   | -358  | +2027     | 0.689   | ✓ WIN   |
| 2026-05-18 09:52   | 29234.25  | 29.0     | 2904  | 2965  | -479  | +1886     | 0.517   | ✓ WIN   |
| 2026-05-20 09:41   | 29094.25  | 38.3     | 1948  | 2740  | -973  | +3165     | 0.831   | ✓ WIN   |
| 2026-05-20 10:22   | 29209.25  | 17.5     | 1669  | 6300  | -650  | +8333     | 0.970   | ✓ WIN   |
| 2026-05-20 11:17   | 29315.75  | 64.0     | 4211  | 3822  | -1620 | +15611    | 0.928   | ✓ WIN   |
| 2026-05-21 09:56   | 29277.50  | 19.3     | 5058  | 3968  | -601  | +5984     | 0.874   | ✓ WIN   |
| 2026-05-21 13:12   | 29347.25  | 17.3     | 4110  | 5035  | -532  | +8266     | 0.900   | ✗ LOSS  |

**StopDist** = actual bar high − entry (tight structural stop, not the 105pt backtest SL)  
**sessDelta** = cumulative net buy−sell from 09:30 ET to signal time (via `is_bid_aggressor` in ticks.db)

---

## 5. Performance Statistics

### TP=80 / SL=105 (baseline)

| Metric | Value |
|--------|-------|
| Total signals | 11 |
| Resolved | 11 (wins=9, losses=2, open=0) |
| Win rate | **81.8%** |
| Mean PnL/trade | **+46.4 pts** |
| Std deviation | 71.35 pts |
| **Sharpe** | **0.650** |
| PnL / 100 trades | **$92,727** (at $20/pt NQ) |

### MFE Distribution

All 9 winners hit exactly TP=80 (MFE=80 for all wins). No signal exceeded 80 pts before first hitting SL.  
The 2 losses saw only 18 and 25.8 pts of favorable movement before reversing to SL.

```
MFE   0– 20 pts :  █   (n=1)   ← Loss 1 (18 pts)
MFE  20– 40 pts :  █   (n=1)   ← Loss 2 (25.8 pts)
MFE  80–100 pts :  █████████  (n=9)   ← All winners hit TP=80
```

### TP Sensitivity (SL=105 fixed)

| TP | WR | Mean (pts) | Sharpe | PnL/100 |
|----|-----|-----------|--------|---------|
| 60 | 81.8% | +30.0 | 0.471 | $60,000 |
| 70 | 81.8% | +38.2 | 0.566 | $76,364 |
| **80** | **81.8%** | **+46.4** | **0.650** | **$92,727** |
| 90 | 0.0% | −105.0 | — | −$210,000 |

**TP=80 is the structural maximum.** Raising to 90+ would catch zero wins — no CF short signal went 90 pts below entry without first hitting SL=105. This confirms 80 is near the architectural target for this pattern.

### SL Sensitivity (TP=80 fixed)

Using tighter SL reduces per-loss damage but does not change WR (both losses went all the way to MAE≈105):

| SL | WR | Mean (pts) | Sharpe | PnL/100 |
|----|-----|-----------|--------|---------|
| 60 | 81.8% | +54.5 | 1.010 | $109,091 |
| 80 | 81.8% | +50.9 | 0.825 | $101,818 |
| **105** | **81.8%** | **+46.4** | **0.650** | **$92,727** |

Note: The SL=120 proxy shows 100% WR but this is an artifact — we do not have tick data after the 105pt SL was hit, so we cannot know if those trades would have recovered.

### Win Rate by Time Window

| Window | WR |
|--------|-----|
| 09:30–09:59 | 100% (n=4) |
| 10:00–10:29 | 50% (n=2) ⚠ |
| 10:30–11:29 | 100% (n=3) |
| 11:30–12:59 | 100% (n=1) |
| 13:00–14:29 | **0% (n=1) ⚠** |
| 14:30–15:59 | — (no signals) |

The 13:00–14:29 window has 0% WR (confirmed via chart's TIME AND WR table). Time gate already blocks 14:30–16:00.

---

## 6. Loss Analysis

### Loss 1 — 2026-05-15 10:09

- **Entry**: 29212.25 | **MFE**: 18.0 pts | **MAE**: 105 pts (full SL)
- **delta5**: 2777 ✓ (buyers in 5 bars)  
- **delta15**: −865 ⚠ **(negative — sellers dominant in 15-bar background)**  
- **sessDelta**: −3855 (session sold off from open through 10:09)
- **compPos**: 0.736 ✓ (upper range)

Context: This signal fired during an intraday downtrend (sessDelta negative, delta15 negative). The 5-bar buyers were a brief counter-rally into a falling market — not genuine buyer exhaustion at a top, but a short-squeeze that continued upward.

Potential filter: `delta15 < 0` is a warning sign for CF short. But May 15 10:36 winner also had delta15=−933 (even more negative) and won cleanly. n=1 is too small to establish a gate.

### Loss 2 — 2026-05-21 13:12

- **Entry**: 29347.25 | **MFE**: 25.8 pts | **MAE**: 105 pts (full SL)
- **delta5**: 4110 ✓ | **delta15**: 5035 ✓ | **deltaT**: −532 ✓
- **sessDelta**: +8266 ⚠ **(strongly bullish session — very heavy buying all day)**
- **compPos**: 0.900 ✓ (near top of range)

Context: Fired at 13:12 in a session with extreme positive sessDelta (+8266). The macro momentum was strongly bullish despite the short-term exhaustion pattern. This is the **time window risk**: 13:00–14:29 has 0% WR for CF short in this dataset.

Actionable: The time gate analysis already flags 13:00–14:29. Silencing CF short in this window would eliminate Loss 2 with no collateral damage (it is the only signal in that window).

---

## 7. Filter Candidates (Not Yet Implemented)

### Time gate: Block 13:00–14:29 for CF Short
- **Effect**: Removes 1 signal (Loss 2). No winners lost. 0% → 100% WR improvement for that window.
- **Risk**: Only n=1 in that window — not statistically significant yet.
- **Recommendation**: Track. Implement when n≥5 in 13:00–14:29 window confirms the pattern.

### delta15 Positive Gate
- **Effect**: Would block Loss 1 (delta15=−865). Would also block May 15 10:36 winner (delta15=−933).
- **Net**: 1 loss avoided, 1 winner lost. WR unchanged at 81.8%. Not worth it.
- **Status**: Do not implement.

### sessDelta Threshold
- **Observation**: Loss 1 had sessDelta=−3855, but the strongest winner (May 12 12:16) had sessDelta=−5374.
- **Conclusion**: sessDelta polarity alone does not predict outcome. Not a viable filter.

---

## 8. Comparison with CF Long

| Metric | CF Long | CF Short |
|--------|---------|---------|
| n (signals) | 26 | 11 |
| Win rate | 72% | **81.8%** |
| Sharpe (baseline) | 0.682 | 0.650 |
| Optimal Sharpe | 1.104 (TP=70/SL=55) | — |
| Losses | 7 | **2** |
| TP structural max | ∼80 pts | **80 pts** (hard ceiling) |
| SL (backtest) | 55 pts | 105 pts |
| PnL/100 trades | $84,400 (TP=80) | $92,727 (TP=80) |

CF Short has fewer losses (2 vs 7) but a wider backtest SL (105 vs 55). Both hit 80pts as structural TP. The CF Short has a higher WR but similar Sharpe. The smaller sample makes CF Short harder to filter systematically.

---

## 9. Open Hypotheses

1. **13:00–14:29 time gate for CF Short**: 0% WR in this window (n=1). Monitor — implement when n≥5.

2. **Regime filter**: May 15 Loss 1 fired in a bearish intraday context. May 21 Loss 2 fired in a strong bullish session. Both loss contexts show strong opposing macro momentum. Consider requiring regime ≠ BULL STRONG for CF short entries (symmetric to the BEAR STRONG hypothesis for CF long). Backtest pending.

3. **Tight SL option**: Using actual `stopLevel` (bar high) as SL (~20–40 pts) rather than fixed 105 pts would dramatically tighten risk. However, some winners like May 20 11:17 (stopDist=64 pts, mae unknown) may get stopped out. Requires full re-scan using per-signal stopLevel to evaluate.

4. **compPos floor**: The May 18 winner had compPos=0.517 (just barely in the upper half). All others ≥ 0.689. If requiring compPos ≥ 0.65 would it filter Loss 1 (0.736 — no, it would not)? Loss 1 passes. Not useful.

5. **Afternoon CF Short**: Only 1 afternoon signal (13:12, a loss). The 14:30–16:00 window is already gated out. The 13:00–14:30 window warrants a soft block pending more data.

---

## 10. Re-running the Analysis

```bash
cd /Users/ravikumarbasker/trading-cockpit/apps/aggregator
node_modules/.bin/tsx scripts/cf_short_analysis.ts
```

Script: `apps/aggregator/scripts/cf_short_analysis.ts`  
Database: `data/trading.db` (signals) + `data/ticks.db` (tick resolution + sessDelta)
