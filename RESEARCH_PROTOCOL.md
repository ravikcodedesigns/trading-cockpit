# Research Protocol — how every study runs here

> Canonical research standards for this project. CLAUDE.md points here. Consolidated 2026-07-06 from BACKLOG.md conventions, `L2_TOUCH_DECIDER_PLAN.md` §0/§4, `RS_ENGINE_SPEC.md` §0, and the verdicts of 10+ completed studies. Change this file only with explicit user sign-off.

## The prior

Most microstructure edges tested in this project **failed out-of-sample**. Pre-entry filters/patterns have now failed to generalize on the ~30-day NQ sample **7–8 independent times** (VWAP-reversal, long-flip gates, regime overlays, alignment filter, DDA, tier-1 fades…). The default expectation for any new pattern is **null**. The job of a study is to beat that prior with evidence — not to find "promising" in-sample numbers.

## Non-negotiables — every study

1. **Outcome labeling follows the TWO-GATE framework** (frozen spec below): Gate 1 discovery is bracket-free (markouts + trend-scanning labels — fixed-horizon signed returns, which are NOT MFE/MAE); Gate 2 tradability uses **fixed pre-registered triple-barrier brackets** (R-grid {1, 1.5, 2, 3}, 1R per the frozen definition below). Metric = expectancy, not win-rate. **Never MFE/MAE.** Register everything before looking at outcomes.
2. **One pre-registered hypothesis at a time.** State the mechanism BEFORE touching the data. If the hypothesis changes after seeing results, that is a new study requiring fresh/held-out data.
3. **Chronological train/test split** (walk-forward for models). In-sample-only results are not findings and must not be reported as findings.
4. **Placebo / null control.** Random-level-touch null, permutation test (p < 0.05), near-spot placebo for any level claim. If the placebo matches the signal, the signal is dead — regardless of its raw PnL.
5. **Beat a baseline, not zero.** Long drift makes all longs "profitable" in an up regime; band mean-reversion runs ~65% on its own. Compare against the dumb version of the idea, and check longs and shorts separately.
6. **Costs in every PnL**: slippage + latency haircut; convert points → dollars (MNQ = $2/pt).
7. **Full-funnel re-derivation** when swapping an input: re-run gating from scratch. Comparing re-gated signals head-to-head produces artifacts (the CVD-migration lesson).
8. **Normalize touches/visits before counting anything.** One interaction per genuine visit (hysteresis + min-away debounce). Beware construction artifacts — the level-memory "94%/7% test-over-test" result was pure artifact (persistence-defined labels + terminal breaks).
9. **Shadow-forward before arming.** Nothing trades live off a backtest alone. Non-backfillable data (RS platform, intraday gamma) = forward validation only.
10. **Verdict discipline.** Report effect size + n + p + a verdict: EDGE / NULL / UNDERPOWERED. "No edge" and "underpowered" are different claims — say which. No hedging, no soft-pedaling, no failure-count storytelling.

## Outcome labeling — the TWO-GATE framework (FROZEN 2026-07-06)

Discovery is decoupled from monetization. A pattern must pass **both gates, in order**. Rationale: brackets conflate "is there signal" with "can you monetize it" — testing them together is why past nulls stayed ambiguous. These definitions are frozen; changing any of them mid-study is a protocol violation (it reopens an overfit channel).

### Gate 1 — DISCOVERY (bracket-free; pure alpha test)

*Question: does this pattern predict price at all, at what horizon, in which regime?*

- **Markout vectors**: signed mid-price forward returns at fixed horizons **{1m, 5m, 15m, 30m}** after the event, cost-adjusted. (Fixed-horizon signed returns — NOT MFE/MAE; compliant with the hard rule.)
- **Trend-scanning labels** (López de Prado): fit linear trends over a span of forward windows, label by the sign of the max-|t| trend. Complements markouts for slow-developing moves.
- **Sample-uniqueness weighting**: overlapping outcome windows are NOT independent — weight each event by average uniqueness (inverse concurrency); tag overlapping-level visits with a `cluster_id`. Raw counts over correlated events are the "247-touches" trap at the statistics layer.
- **Drift adjustment**: the edge must survive per-day de-drifted returns (or a drift-adjusted null). A pattern that merely fires more on trend days is regime exposure, not edge (the DDA long-drift artifact).
- **Pass criterion**: markout alpha significant under block-bootstrap by day, surviving placebo levels AND drift adjustment, at a horizon consistent with the pre-registered mechanism. No pass → the pattern is dead; no bracket test is run (no bracket can rescue a pattern with no markout alpha).

### Gate 2 — TRADABILITY (triple-barrier; monetization test — Gate-1 passers only)

*Question: does the alpha survive stops, path, and realistic fills?*

| Item | Frozen definition |
|---|---|
| **1R (stop)** | `max( structural , vol floor )` — structural = beyond the nearest **LVN behind the level** (far edge of the absorption shelf) + 1 tick; vol floor = `1.0 × σ_ev × √h_ref` |
| **σ_ev** | event-time drift-free returns-RV diffusion estimate (the existing band lineage, commit `977bf87`) |
| **Target grid** | `{1, 1.5, 2, 3}R` — fixed, never tuned |
| **Vertical barrier** | `T = 2 × (1R/σ_1m)²` minutes, capped at session end; unresolved at T → labeled by sign of return at T (kills OPEN-censoring) |
| **Null** | gambler's ruin: `P(win | R:1) = 1/(1+R)` under a driftless walk (2:1 wins 33.3% by chance, 3:1 wins 25%) — computed per-day drift-adjusted; PLUS the placebo-level null |
| **Costs** | **asymmetric**: stop fills modeled with adverse fast-tape slippage estimated from our own book data (the §25.2 slippage-artifact lesson); target fills passive/neutral; MNQ $2/pt |
| **Pass criterion** | expectancy in R > 0 after costs vs the drift-adjusted null, block-bootstrapped by day, on train AND validation, then confirmed once on the lockbox |

Vol-scaling note: this does NOT relitigate the settled "adaptive brackets FAIL" null — that null was about *execution* (scaling live FLIP brackets by prior-day VIX/VXN added no PnL). Here σ scales the outcome *label unit* so events from different vol regimes are comparable rows; the R-grid itself stays fixed. Different layer, different purpose.

Phase-2 (after a pattern passes both gates): **meta-labeling** — the pattern decides direction; a second model decides whether/size. That is where layer-7 management begins; it never enters screening.

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

- New pattern → pre-register (mechanism hypothesis, horizons, sample, nulls) → **Gate 1 discovery on L3 mini NQ** (truth flags; levels/structure supplied by the L2 full-history registry) → validation = chronological OOS → ES-mini replication → **Gate 2 tradability** (triple-barrier, frozen 1R) → **forward-days lockbox** confirmation → shadow-forward → only then discuss arming. (Data policy: CRACKER_PLAN §1.5.)
- Every strategy iteration = a NEW file (never overwrite v1 to make v2).
- Findings go to HANDOFF + memory as **rules with WHY + HOW-TO-APPLY**, not session narratives.
