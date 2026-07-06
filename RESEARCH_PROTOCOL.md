# Research Protocol — how every study runs here

> Canonical research standards for this project. CLAUDE.md points here. Consolidated 2026-07-06 from BACKLOG.md conventions, `L2_TOUCH_DECIDER_PLAN.md` §0/§4, `RS_ENGINE_SPEC.md` §0, and the verdicts of 10+ completed studies. Change this file only with explicit user sign-off.

## The prior

Most microstructure edges tested in this project **failed out-of-sample**. Pre-entry filters/patterns have now failed to generalize on the ~30-day NQ sample **7–8 independent times** (VWAP-reversal, long-flip gates, regime overlays, alignment filter, DDA, tier-1 fades…). The default expectation for any new pattern is **null**. The job of a study is to beat that prior with evidence — not to find "promising" in-sample numbers.

## Non-negotiables — every study

1. **Metric = expectancy (R-multiple), not win-rate.** Outcomes are WIN/LOSS/OPEN at **fixed pre-registered brackets** (the strategy's pt brackets, or an R-grid {1, 1.5, 2, 3}, 1R = structural stop). **Never MFE/MAE.** Register the bracket before looking at outcomes.
2. **One pre-registered hypothesis at a time.** State the mechanism BEFORE touching the data. If the hypothesis changes after seeing results, that is a new study requiring fresh/held-out data.
3. **Chronological train/test split** (walk-forward for models). In-sample-only results are not findings and must not be reported as findings.
4. **Placebo / null control.** Random-level-touch null, permutation test (p < 0.05), near-spot placebo for any level claim. If the placebo matches the signal, the signal is dead — regardless of its raw PnL.
5. **Beat a baseline, not zero.** Long drift makes all longs "profitable" in an up regime; band mean-reversion runs ~65% on its own. Compare against the dumb version of the idea, and check longs and shorts separately.
6. **Costs in every PnL**: slippage + latency haircut; convert points → dollars (MNQ = $2/pt).
7. **Full-funnel re-derivation** when swapping an input: re-run gating from scratch. Comparing re-gated signals head-to-head produces artifacts (the CVD-migration lesson).
8. **Normalize touches/visits before counting anything.** One interaction per genuine visit (hysteresis + min-away debounce). Beware construction artifacts — the level-memory "94%/7% test-over-test" result was pure artifact (persistence-defined labels + terminal breaks).
9. **Shadow-forward before arming.** Nothing trades live off a backtest alone. Non-backfillable data (RS platform, intraday gamma) = forward validation only.
10. **Verdict discipline.** Report effect size + n + p + a verdict: EDGE / NULL / UNDERPOWERED. "No edge" and "underpowered" are different claims — say which. No hedging, no soft-pedaling, no failure-count storytelling.

## Regime hygiene

- **Day-regime dominates weak per-touch features.** Any per-event edge must survive regime conditioning or be reported as regime-conditional.
- Sample across regimes (trend / chop / normal days) or state the limitation explicitly.
- Watch for drift artifacts: a "signal" that only wins on one side in a directional month is regime, not edge.

## Settled nulls — do NOT relitigate without materially new data

| Verdict | Evidence | Grade |
|---|---|---|
| Vol/VIX → next-day **direction** or trend-vs-chop: NOT predictable (range IS — VXN rho ~0.6) | n=1403 days, no-lookahead | VERY HIGH |
| Adaptive vol-scaled brackets: FAIL; flat 80/70 near-optimal | n=1403 basis | HIGH |
| Options data → NQ/ES **direction**: dead (multivariate walk-forward OOS acc 0.503) | 373 days, 12-feat model | HIGH |
| Gamma walls/flip as tradeable S/R: FALSIFIED (walls 40–57% vs 65% near-spot placebo) | 28 days + placebo | HIGH |
| Net-GEX sign as day-regime switch: no hold/break or trend/range split | 2688 touches, train/test | HIGH |
| 0DTE premium selling (ATM straddles, OTM spreads, condors): negative after honest costs | 372–374 days, train/test | HIGH |
| True (MBO) CVD vs inferred: NOT better; don't buy $5k data | 11 days, full-funnel | MED-HIGH |
| DDA absorption-on-retest reversal (NQ): NO EDGE at every bracket; and no info as FLIP veto (p=0.48–0.97) | 32 days train/test; 77 flips | HIGH |
| Trap standalone: DEAD 3 ways (tight-stop, wide-stop regime artifact, latency scalp — placebo p=0.976) | May–Jun NQ+ES | HIGH |
| VWAP reversal AND continuation: no edge; all train patterns died OOS | 490 events, 60/40 split | HIGH |
| Long-flip gates (priorImpulseDown, lowerWick, deltaT-cap): fail OOS (p=0.061) | ~124 longs walk-forward | MED-HIGH |
| Tier-1 FADE reversals: no edge (24–32% train WR) | 25 days L2 | MED-HIGH |
| Regime/book_dir/directional-alignment overlays on FLIP/CONT: none beat fixed brackets OOS (alignment filter REJECTED — discards 45 winners) | ~130 signals | MED |
| Level-memory raw test-over-test 94/7: construction artifact | 54 days, 94k interactions | HIGH (as caution) |

**Meta-null:** pre-entry filters do not generalize on ~30-day samples here. Bring a bigger sample, a different instrument, or a mechanism-level claim — or don't bring it.

## What actually survived (build on these)

- Raw FLIP/CONT tradables: ~62–65% WR at flat 80/70 brackets
- **Trap-veto on flips**: 59%→66/72% WR, OOS confirmed, p=0.0004–0.003
- **VXN → next-day range** (rho ~0.6, n=1403): use for sizing/brackets, never direction
- Tier-1 breakout-continuation 60/20: OOS-positive (medium confidence)
- `priorSL==0` circuit-breaker: 78/62% vs 72/57% (medium confidence, needs forward)
- IV → realized range (Spearman 0.79, causal): volatility forecasting only

## Session workflow

- New pattern → pre-register (hypothesis, bracket, sample, null) → screen on L2 micro (statistical power) → confirm mechanism on L3 mini → shadow-forward → only then discuss arming.
- Every strategy iteration = a NEW file (never overwrite v1 to make v2).
- Findings go to HANDOFF + memory as **rules with WHY + HOW-TO-APPLY**, not session narratives.
