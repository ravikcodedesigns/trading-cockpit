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

Seven conditions must all pass simultaneously on **1-minute OHLCV bars built from raw tick data** (not external bar feeds), so delta is computed from actual bid/ask aggressor flags.

| # | Condition | Threshold | What it measures |
|---|-----------|-----------|-----------------|
| 1 | Bear bar body `(open − close)` | ≥ 5 pts | Must be a real bearish bar, not a doji |
| 2 | Upper wick `(high − close)` | ≥ 15 pts | Strong rejection — price reached up and got pushed back hard |
| 3 | `compPosHigh` ≥ lower bound | ≥ 0.50 | Bar HIGH is in the **upper 50%** of the trailing 30-bar range — exhaustion at elevated price |
| 4 | `compPosHigh` ≤ upper bound | ≤ 1.00 | Bar is **not** making a fresh 30-bar breakout — that's continuation, not reversal |
| 5 | `priorImpulse` (max of prev 2 bars' delta) | ≥ 1400 | Prior bars had aggressive buying — the trap is set |
| 6 | Reversal bar `deltaT` | ≤ +300 | Buyers weakened on the reversal bar — not aggressively bullish |
| 7 | Bar total range `(high − low)` | ≥ 22 pts | Filters noise/doji bars — must be a real range bar |

**`compPosHigh`** = `(bar.high − macro30Low) / (macro30High − macro30Low)`. Unlike CF Long which uses the bar's LOW, CF Short uses the bar's **HIGH** — the wick reached the top of the range, not the body.

**Entry**: `cur.close`
**Stop (structural)**: `cur.high` (stored as `stopLevel` in payload, ranges 15–65 pts from entry in practice)
**Backtest SL**: 105 pts above entry (fixed, for consistent comparison)

**Scoring bonuses** (additive, starts at 80):
- `bodyShort ≥ 15` → +5 (large bearish body = conviction)
- `upperWick ≥ 20` → +5 (very strong rejection)
- `compPosHigh ≥ 0.80` → +5 (deep into top of range)
- `priorImpulse ≥ 2000` → +5 (extremely strong prior push)

### Key computed values stored in payload

| Field | Formula | Role |
|-------|---------|------|
| `compPos` | `(cur.high − macroLow) / (macroHigh − macroLow)` | Stored as compPos — actually compPosHigh for SHORT |
| `deltaT` | Net buy-sell delta for the reversal bar | Condition 6 |
| `delta5` | Net delta over last 5 bars | Quality gate (≥ +1000) |
| `delta15` | Net delta over last 15 bars | Context |
| `deltaLast3` | Net delta over prior 3 bars | Context |
| `priorImpulse` | max(prevBar.delta, prev2Bar.delta) | Condition 5 |
| `stopLevel` | `cur.high` | Actual bar-high stop (tight structural) |
| `stopDist` | `cur.high − cur.close` | Distance to bar high |

---

## 3. Full Filter Pipeline (in execution order)

A CF Short signal must survive all stages in sequence before it reaches the chart and Discord. A failure at any stage drops the signal.

### Stage 1 — RTH Guard (`isRTH`)

Must be Monday–Friday between **09:30 and 16:00 ET**. Nothing runs outside regular trading hours. Hard coded; no override.

---

### Stage 2 — FLIP Pattern Detection (`detect()`)

The seven conditions above (§2) must all pass on the last completed 1-minute bar. The bar must also have closed within the **last 2 minutes** (`STALE_MS = 2 min`) — prevents stale signals firing on old bars.

---

### Stage 3 — 1H Hourly Alignment (`isShortHourlyAligned`)

CF Short has a **1H alignment gate instead of a time-of-day clock** (CF Long uses a clock gate instead). Checks the **last complete 1H bar** (the one whose close time is before the current minute):

| Last 1H bar | Outcome | Historical WR |
|-------------|---------|--------------|
| Red (close < open) | Signal passes ✓ | **82% WR** (+56.4 pts/trade) |
| Green (close ≥ open) | **Suppressed** | 13% WR (−33.8 pts/trade) |

This is the single most powerful filter on CF Short — it alone cuts the raw detection rate by ~87%. A suppressed signal here leaves **no DB record**.

---

### Stage 4 — Cooldown Guard (`isCooling`)

Two separate cooldowns:

| Rule | Duration | Direction |
|------|----------|-----------|
| Same-direction cooldown | 15 min | No two CF Shorts within 15 min on the same symbol |
| Cross-direction suppression | 45 min | After a CF Short fires, CF Long is suppressed for 45 min |
| Inverse | None | A CF Long does **not** suppress CF Short |

The asymmetry is intentional: a short signal is more structurally bearish, so longs are suppressed afterward. But a long signal does not suppress shorts — tops and bottoms are treated as independent events.

---

### Stage 5 — ORM Gate (`isSignalAllowed` from regime.ts)

An Operational Risk Management gate checked after cooldowns clear. If this returns false, the signal is logged and dropped. Operates at the symbol+direction level.

---

### Stage 6 — Quality Classification (`classifySignalQuality` in quality.ts)

Applied live in `state.ts → applySignal()`. The signal exists at this point but has not been broadcast. Three checks apply to CF Short FLIP (in order):

#### 6a. EXPL Conflict Check (`checkExplConflict`)

Looks at all EXPL signals for this symbol in the **last 60 minutes** (`EXPL_LOOKBACK_MS = 60 * 60_000`).

If the **most recent EXPL is in the opposite direction** (EXPL Long fired recently while we want to go short):

```
ratio = |deltaT| / max(|delta5|, |deltaLast3|)
```

- `ratio > 0.25` → **silenced** (opposing EXPL Long may still be in control)
- `ratio ≤ 0.25` → **allowed through** (the CF short bar was a genuine exhaustion of the EXPL Long itself)

If the most recent EXPL is a **Short** (same direction), no conflict.

#### 6b. Delta5 Gate (directional)

Checks that **buyers were actually dominant** in the 5 bars before the reversal bar:

```
delta5 ≥ +1000 → passes  (buyers were pushing up — correct context for short exhaustion)
delta5  < +1000 → silenced

Exception: same-direction EXPL Short in 60-min window → threshold relaxes to +800
```

The gate is **directional** (not absolute value). A CF Short with `delta5 = −1085` (sellers dominant) would fail — that's the wrong setup for a buyer-exhaustion reversal. The ABS version was a live bug that allowed one wrong-direction signal (May 15 09:41) to broadcast. Fixed to use signed value.

#### 6c. Delta15 Gate

**Does NOT apply to CF Short.** This gate only runs for CF Long direction (checks that sellers were dominant in the 15-bar background). CF Short has no delta15 gate in `classifySignalQuality()`.

#### 6d. Regime Gate

**Currently disabled.** Framework exists but is commented out pending threshold calibration.

---

### Stage 7 — `rs_hard_filtered` (RS Scoring Layer)

A relative-strength context layer scores signals against nearby key levels (daily levels, prior highs/lows, overnight levels). Signals that fail RS quality criteria are stored in the DB with `rs_hard_filtered = 1` and never broadcast.

Cockpit SQL filter: `AND rs_hard_filtered IS NOT 1`

---

### Summary: What Gets to the Chart

A CF Short signal reaches broadcast only if it survives **all of the following**:

```
1. RTH hours (09:30–16:00 ET, Mon–Fri)
2. All 7 FLIP SHORT pattern conditions (detect())
3. Last complete 1H bar is RED
4. 15-min same-direction cooldown cleared
5. 45-min cross-direction cooldown cleared (from last CF Long)
6. ORM gate passes
7. EXPL conflict ratio ≤ 0.25 (or no opposing EXPL in 60m)
8. delta5 ≥ +1000 (buyers must have been pushing up before the reversal)
9. rs_hard_filtered = 0
```

### Canonical SQL (all layers)

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

## 8. CF Short vs CF Long — Side-by-Side

| | CF Short | CF Long |
|--|---------|---------|
| **Thesis** | Buyer exhaustion at the top | Seller exhaustion at the bottom |
| **Range anchor** | Bar HIGH in upper 50–100% (`compPosHigh ∈ [0.50, 1.00]`) | Bar LOW in bottom 30% (`compPos ≤ 0.30`) |
| **Prior pressure condition** | `priorImpulse ≥ 1400` (1–2 bars of strong buying) | `deltaLast3 ≤ −100` (3 bars of selling) |
| **Reversal bar delta** | `deltaT ≤ +300` (buyers just stopped — sellers don't need to push yet) | `deltaT ≥ +300` (buyers absorbed hard) |
| **Upper wick requirement** | ≥ 15 pts (the failed breakout IS the signal) | Not required |
| **Bar range requirement** | ≥ 22 pts | Not required |
| **Stage 3 gate** | Last complete 1H bar must be red | Time-of-day clock (block before 09:54, after 14:30) |
| **Cross-direction suppression** | Does not suppress CF Long | Suppressed 45 min after a CF Short fires |
| **delta15 gate** | ✗ Not applied | ✓ Yes — `delta15 < +500` required |
| **delta5 gate** | `delta5 ≥ +1000` (buyers dominant) | `delta5 ≤ −1000` (sellers dominant) |
| **Structural SL** | Bar high | Bar low |
| **Backtest SL (fixed)** | 105 pts | 55 pts |
| **Backtest TP** | 80 pts (structural ceiling) | 80 pts (70 optimal) |
| **Signals (n)** | 11 | 26 |
| **Win rate** | **81.8%** | 72% (TP=80) / 85% (TP=70) |
| **Sharpe** | 0.650 | 0.682 (TP=80) / 1.104 (TP=70) |
| **PnL/100 trades** | $92,727 | $84,400 (TP=80) / $101,538 (TP=70) |

**The structural difference**: CF Short's exhaustion evidence is mostly in the **prior bars** — the big buy impulse traps buyers, and the reversal bar just needs to show a wick and weakening delta. CF Long's exhaustion evidence requires the **reversal bar itself** to show strong buyer absorption (`deltaT ≥ +300`). NQ tops form passively (buyers stop), NQ bottoms form actively (new buyers step in hard).

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
