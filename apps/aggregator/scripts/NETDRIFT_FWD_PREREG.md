# Filtered Net-Drift Slope — Forward-Validation Pre-Registration

> Registered **2026-07-09** BEFORE any forward outcome exists. Source of the signal:
> Quant Data "How to use Net Drift to See Live Call & Put Options Activity" tutorial
> (recorded videos/quantdata-netdrift.mov, presenter "ABJ"). This freezes the signal,
> the filter, the placebo, and the decision rule so the result cannot be back-fit.
>
> **Review / decision date: 2026-07-23** (≈2 weeks; re-check weekly thereafter until
> powered). Do NOT arm, do NOT tune against interim numbers, do NOT read the sample
> before the review date except to confirm the capture is accruing.

## Why this is registered and not simply relitigated
Options flow → NQ/ES **direction** is a SETTLED NULL (memory `project_quant_data_phase0`:
multivariate walk-forward OOS acc 0.503). This study does NOT reopen that. It tests a
**narrower, specific** variant the settled work did not isolate:

- The settled null and `scripts/flow_lead_check.ts` used **unfiltered** net-drift and the
  **raw per-bucket tilt**. 18-day pooled result (NDX, 5-min): `corr(tilt, ret[t→t+1]) =
  0.039` LEAD vs 0.022 LAG vs −0.014 null → **no lead at power.** That is the prior.
- This study changes exactly two things: (a) ABJ's **0DTE + OTM + aggressor** filter
  (drop complex/tied/floor/cancelled), and (b) the **10-min cumulative-drift slope**
  instead of raw tilt. On a single live day (2026-07-09) that variant showed a weak hint
  the crude version lacked: drift-slope predicted forward 5–10 min return at r≈0.13–0.18,
  **above** a price-momentum placebo (0.03–0.11). n=1, both trend-up days — could be noise.

The forward test's entire job: decide whether (a)+(b) survives at power, or dies like the
crude version. Default prior = **NULL** (pre-entry/flow filters have failed OOS 8+× here).

## Mechanism hypothesis (one, pre-stated)
Aggressive 0DTE OTM call/put premium forces dealer gamma hedging, which pushes the index
intraday. The *smoothed 10-min slope* of the filtered net-call-minus-put drift therefore
carries directional information about the **next 5–10 minutes** of the mapped future
(NDX→NQ, SPX→ES) **beyond** what current price momentum already tells you.

Directional claim: sign of the 10-min drift slope predicts the sign of forward index
return, and does so with information **incremental to** price momentum.

## Computable signal (frozen)
- **Data**: `getNetDrift(index, day, 'ONE_MINUTE', abjNetDriftFilter(day))` for `index ∈
  {SPX, NDX}` (quantdata-store.ts). Filter = MONEY_TYPE=OTM ∧ IS_COMPLEX=false ∧
  IS_TIED=false ∧ IS_FLOOR=false ∧ IS_CANCELLED=false ∧ EXPIRATION_DATE=session (0DTE).
  Verified to reproduce the Quant Data MCP output byte-for-byte (netdrift_filter_probe.ts).
- **Curve**: cumulative `net_cum[t] = Σ (netCall − netPut)` over the session.
- **Signal** = `slope10[t]` = least-squares slope (per minute) of `net_cum` over the
  trailing **10 one-minute buckets**. First 9 buckets of a session = null (no window).
- **Placebo yardstick** = `price_slope10[t]` = same 10-min LSQ slope of the underlying spot.
- Persisted per minute to `data/quantdata.db(netdrift_slope)` by
  `scripts/netdrift_forward_capture.ts` (nightly launchd job com.cockpit.netdrift-capture).
- `filter_tag = 'ABJ_0DTE_OTM_AGGR'` frozen; a different filter = a new tag, never a rewrite.

## Outcome & the join (frozen)
Setup events are the ones already captured live 24/7 in `data/tape-events.db(tape_events)`
(`t` = epoch seconds; kinds sweep/block/iceberg/absorption/…). At the review date:
1. Join each qualifying tape_event to the nearest `netdrift_slope` row within ±60 s on
   `(futures, t_sec)` (NDX→NQ, SPX→ES).
2. Outcome = signed forward return at **fixed brackets** on the future (per protocol; TP/SL
   from memory `trading_params`, and markout at {1,5,10,15} min). Report WIN/LOSS/OPEN only
   (never MFE/MAE). "Agreement" = sign(slope10) == setup direction.
3. **The one test that matters**: does *slope-agreement* beat *price-momentum agreement*
   (sign(price_slope10)) at the same brackets? If drift adds nothing over price momentum,
   it is redundant (the two are ~0.69 correlated same-minute) → NULL.

## Nulls & baselines (beat a baseline, not zero)
1. **price-momentum placebo** (primary): replace slope10 with price_slope10. Drift must beat it.
2. **shuffled-slope null**: slope10 values permuted across events → should be ~0.
3. **crude prior**: the 18-day unfiltered `flow_lead_check.ts` result (0.039) — the filtered
   slope must clear it materially to justify the filter+smoothing.

## Statistics (frozen)
- Chronological accumulation from **2026-07-09** forward. No day is read before the review.
- Powered decision only when n(events) resolves an effect of size ≥ price-momentum baseline
  (compute MDE at review; if under-powered, keep accruing — do not force a verdict).
- Day-block bootstrap for CIs (mirror the AMN/cracker harness).
- **Verdict rule**: EDGE only if drift-slope beats the price-momentum placebo with a CI clear
  of 0, same sign across a chronological train/test split. Else NULL if powered, else KEEP
  ACCRUING.

## Status
- **2026-07-09**: registered; capture built + seeded (SPX 1015 min, NDX 405 min — day 1).
  NOT armed. Shadow data only. Nothing gates any live trade.
