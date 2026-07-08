# EXPL-short design study — 2026-07-08 (the derivation the 1,344-observation harvest was collected for)

## Design (declared before running)
- Universe: every RTH 1m bar close, NQ, 45 days (2026-05-05 → 07-08; 06-29 BMD excluded) = 14,476 candidates.
- Features (the observer's exact set, computed causally at bar close): 10-bar approach {upBars, netPts, rangePts, vol, delta, deltaFrac} + 3-bar compression {range, delta}.
- Causal label: price trades ≥80pt below the candidate bar's high within 35 min BEFORE exceeding that high (tick-resolved when ambiguous). Case rate = 13.3% (train 12.5% / valid 14.8%).
- Chrono 60/40 day split (≤06-12 / after); day-block bootstrap; tradability = short at close, TP80/SL70 first-touch, 30-min refractory.
- Candidate set banked: data/expl_short_candidates.json.

## Results
1. **Drop-probability discrimination: REAL and validated.** All 8 features replicate train→valid with day-block p ≤ 0.03. Strongest: 3-bar compression range (24.3% vs 2.4% case rate across terciles), approach range (23.0% vs 3.6%), volume (23.9% vs 4.8%); delta features weaker (15–22%). Composite (crng HI AND vol HI): 25.2% train / 25.8% valid vs 14.8% base — a 1.74× validated lift.
2. **Trade expectancy at fixed brackets: NO EDGE.** Composite rule vs short-everything baseline: train +3.2 vs −2.7pt (lift +5.9), valid +6.9 vs +7.7pt (lift −0.8) — sign-inconsistent, no validated improvement. The baselines themselves are pure regime drift: train baseline −2.7pt avg during +1,387pt NQ drift; valid baseline +7.7pt during −1,459pt drift.
3. **Reading:** the features detect a VOLATILITY/danger state (violent tape + seller lean), not a tradable direction. The extra drop probability is paid for by an equally elevated stop-out probability. This replicates the program's settled results: range is predictable (IV→range), direction is not (vol→direction settled null; E2/F6 flow nulls).

## Verdict
- EXPL-short as a directional strategy: **stays dead** — no feature rule turns candidates into positive-expectancy fixed-bracket trades beyond drift.
- What survives: the composite (crng+vol) is a validated real-time **danger-state flag** (~26% chance of an 80pt air pocket within 35 min, ~2× base) — candidate uses: risk overlay for the live long book (skip/tighten during flag), tape-state variable for Phase-5 composition. Each use = a NEW hypothesis requiring its own registration; none armed by this study.
- The 1,344-observation harvest is superseded by the banked case-control set (which contains its cases AND the controls it lacked).
