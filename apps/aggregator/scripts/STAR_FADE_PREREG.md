# STAR-FADE / STAR-FOLLOW — pre-registered forward study on V2 confluence stars

**Registered:** 2026-07-15 (late RTH) · **Review:** earlier of NQ n≥150 or 10 trading days (~2026-07-29)
**Status:** ACCRUING from 2026-07-16 00:00 ET · **Owner artifacts:** data/tape-events.db (labeled nightly
by com.cockpit.tape-outcomes), this doc = the frozen test.

## Origin (why this exists — and why today's data cannot confirm it)

2026-07-15 (single violent trend-reversal day) the first labeled V2-star sample showed:
- NQ RTH stars: 69% directional hit @30s, ~coin-flip @2m/5m; **high-score (≥6) stars hit 39% @2m
  (mean −29.9t) vs low-score 56% (+32.3t)** — evidence mass inverted at the trading horizon.
- The day's highest-scored NQ star (14:18:27, score 10.5, sell) reversed −166t @5m.
- ES clean (non-struct) stars: 61–63% hit @2m/5m (n=41) — the one positively-reading cohort.
- Mechanism hypothesis: the star accumulates one-sided evidence + 3s confirmation → fires near
  burst ENDS; NQ mean-reverts after thrusts at 2m (move-ignition study, 2:1). Score ∝ how much
  burst already happened → climax marker, not continuation signal.

**All 2026-07-15 stars are GENESIS data (hypothesis-generating) and are EXCLUDED from the
confirmation sample.** One regime day proves nothing (day-type dominates — 06-12 post-mortem).

## Frozen definitions

- **Event:** `tape_events` rows, `kind='confluence'`, `families IS NOT NULL` (V2-era only),
  RTH 09:30–16:00 ET, `t ≥ 2026-07-16 00:00 ET`.
- **Outcomes:** labeled `out_2m` (primary) / `out_5m` (secondary) — signed ticks in the star's
  direction from the nightly labeler. `out_30s` recorded, NOT a test. Fixed horizons only.
- **FADE expectancy** = −1 × signed outcome. **FOLLOW expectancy** = signed outcome.
- **Score tier:** high = `size ≥ 6`, low = `< 6`. **Clean** = `at_struct IS NULL OR at_struct=0`.
- **Template split:** EXH = `families LIKE '%EXHAUSTION%'`; AGGR-led = families contains
  AGGRESSION and/or FLOW and NOT EXHAUSTION.
- **Config freeze:** star-path config as registered (V2 + confirm + flip, calibration file
  updated only by the standing nightly job). Bug fixes that alter scoring semantics void the
  affected cohort and must be logged here with the date.

## Pre-registered test family (BH q=0.10 across these 8, no others)

| # | Cohort | Hypothesis | Horizon |
|---|---|---|---|
| 1 | NQ RTH all | FADE > 0 | 2m |
| 2 | NQ RTH high-score (≥6) | FADE > 0 (predicted strongest) | 2m |
| 3 | NQ RTH high-score | FADE > 0 | 5m |
| 4 | NQ RTH AGGR-led | FADE > 0 | 2m |
| 5 | NQ RTH EXH-containing | FOLLOW > 0 | 2m |
| 6 | ES RTH clean | FOLLOW > 0 | 2m |
| 7 | ES RTH clean | FOLLOW > 0 | 5m |
| 8 | flip=1 stars (both syms) | FOLLOW(flip) > FOLLOW(unopposed) | 2m |

**Tests per cohort:** (a) one-sided binomial vs 50% on sign; (b) Mann-Whitney vs a PLACEBO
distribution = 20 pseudo-events per real star, uniform-random timestamps matched to the star's
symbol + half-hour-of-day across the accrual window, labeled identically, random side. Both must
pass post-BH. Report medians + hit rates, never MFE/MAE.

**Conditioning (recorded, not selected on):** day-type per session (RTH range in ATR terms +
close-location), so a trend-day-only effect is visible at review. No interim peeking for tuning;
the nightly labeler summary is operational monitoring, not evaluation.

**Secondary split (registered 2026-07-15, before accrual start — the residue-as-mechanism
question, aka "WHAT SEPARATES WINNERS FROM LOSERS"):** POST-FAILURE stars (an iceberg/wall/
stoprun episode within the star's zone resolved AGAINST the star's evidence direction —
broke/pulled/reclaimed — inside the 60s window before fire) vs PURE-LIVE stars (every zone
resolution confirmed the star's direction, or none resolved). Computed retroactively from stored
episodes + timestamps; NO scorer change.

Genesis exemplars (2026-07-15, hypothesis-generating only — the matched pair that motivates the
split; near-identical composition/scores, opposite integrity, opposite outcomes):
- **PURE-LIVE winner:** 10:20:11 NQ sell star (score 10.3, stoprun+iceberg+flow+imb) — 2 ask
  icebergs HELD + 2 sell stop runs ACCEPTED in-zone, all resolutions confirming → **+414t @5m**.
- **POST-FAILURE loser:** 14:18:27 NQ sell star (score 10.5, same composition) — the anchor ask
  iceberg BROKE 2s before fire (a bullish resolution); its DEFENSE vote was dead residue →
  **−166t @5m**. (Same anatomy: 16:02:16 star → −40pts.)

Review question frozen for 2026-07-29: does resolution-integrity (pure-live vs post-failure)
separate winners from losers across the full sample, per symbol and horizon? Decision: fade edge
lives in post-failure → residue is MECHANISM (keep; post-failure stars become reversal markers);
follow edge lives in pure-live → build retract-on-resolution and suppress/re-map post-failure
stars. Descriptive split, not in the BH family; it selects between designs, it arms nothing.

## Decision rules (what a confirm/fail DOES)

- **#1–4 confirm →** NQ star re-templates as a CLIMAX marker: display flips to "fade zone"
  annotation (direction shown as reversion side), score presented as climax strength.
  DISPLAY-ONLY — any auto-trade needs its own Gate-2 study (costs, brackets) after.
- **#5 confirms →** EXHAUSTION-led stars keep/regain follow direction as a distinct star type.
- **#6–7 confirm →** ES clean stars earn directional display trust (they stay follow).
- **#8 confirms →** flip badge upgraded to first-class signal tier.
- **Fails →** the failing cohort's star becomes location-only (direction suppressed in display);
  NOT relitigated without a materially new mechanism, per RESEARCH_PROTOCOL.

## Evaluation

Write `star_fade_reader.ts` AT REVIEW (not before) implementing exactly the queries above;
genesis-day rows excluded by the date filter. Absolute review date: **2026-07-29** or when
`SELECT COUNT(*) FROM tape_events WHERE kind='confluence' AND families IS NOT NULL AND at_struct
IS NOT DISTINCT FROM 0 AND symbol='NQ' AND t ≥ 2026-07-16 (RTH)` ≥ 150, whichever first.
