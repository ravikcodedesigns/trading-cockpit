# CRACKER — Implementation Plan

> **Cracker** = the deep-orderflow, level-centric trading system for NQ/ES (micros executed).
> The **Spine** (level-memory trace + multi-scale swing detector + footprint engine, committed `4032482`) was step one; this document is the complete build plan from here to a live-armed system.
>
> Governing law: `RESEARCH_PROTOCOL.md` (two-gate outcome framework, frozen 2026-07-06). This plan operationalizes it.
> Written 2026-07-06 after the full design review. Supersedes the step list in HANDOFF §26.8.

---

## 0. The operating principles (why the plan looks like this)

1. **One variable at a time.** Every parameter, feature, and pattern enters the system alone, is tested against the frozen harness, and gets a ledger verdict (EDGE / NULL / UNDERPOWERED) before the next one enters. We always know exactly which component carries weight.
2. **Instrument before measurement, measurement before hypotheses, hypotheses before composition.** Phases 0→2 contain *zero* edge-hunting. You cannot do science with an uncalibrated instrument — most of our historical ambiguity came from testing ideas on measurement layers that had their own artifacts (94/7, slippage artifact, correlated touches).
3. **Everything pre-registered, everything frozen.** A parameter chosen after seeing outcomes is an overfit channel. Frozen values get ONE sensitivity sweep at the very end (Phase 8), never during.
4. **Falsifiable stages.** Every stage ends with an acceptance test and a STOP/GO gate. A stage that can't fail isn't science.

---

## 1. Corrections to the previous plan (what was rudimentary and what replaces it)

| Old (retail/ad-hoc) | Replacement (principled) | Where |
|---|---|---|
| Level `strength` = ±1.0/1.5 ad-hoc score | **Empirical-Bayes hold-rate posterior**: Beta(α₀+holds, β₀+breaks), prior fit to the global hold rate — levels with 2 visits aren't scored like levels with 20 | Phase 0.1 |
| Fixed R-brackets as the only outcome | **Two-gate labeling** (bracket-free markout discovery → triple-barrier tradability) | frozen in RESEARCH_PROTOCOL.md |
| Folk 3:1/4:1 imbalance ratios | Binomial z ≥ 2 (already built) **+ Kish effective-sample-size correction** for blocky trade sizes | Phase 0.5 |
| Visits treated as independent observations | **Sample-uniqueness weights** (inverse concurrency) + cluster_id for overlapping levels | Phase 1.2 |
| Eyeballed HVN/LVN | **Kernel-smoothed volume profile**, HVN/LVN = local extrema of the smoothed density | Phase 1.6 |
| "Stop beyond the level" (vague) | **1R = max(beyond nearest LVN behind the level + 1 tick, 1.0·σ_ev·√h_ref)** — thesis-invalidation point with a noise floor | frozen |
| Win-rate as the metric | Expectancy vs the **gambler's-ruin analytic null** P(win\|R:1) = 1/(1+R), drift-adjusted | frozen |
| Value-area 70% | Kept as *descriptive convention only* — no edge claims attach to it | note |

---

## 2. The phase ladder

### PHASE 0 — Instrument hardening (no research; make the tools trustworthy)

**0.1 Spine correctness fixes** *(code, ~1 session)*
- **Retirement + decay** (currently unimplemented — `retired` is never set true):
  strength is replaced by the Beta posterior; **activity decay** is separate: a level's *relevance* w(t) = 2^(−Δt/H), H = 2 trading sessions since last test. Retire when (posterior mean hold-rate < 0.35 with ≥3 visits — "break accepted") OR (w < 0.05, i.e. ~9 untested sessions). Revive on re-approach (registry already merges across retire).
- **`confirmTs` on every swing** — a swing exists as *knowledge* only after its δ-retrace confirms. All joins and level-births use confirmTs, never extreme-ts (lookahead guard).
- **Replay idempotency** — `run_id` column + delete-day-first semantics; re-running a day can never duplicate rows.
- **Registry rehydration** — constructor loads non-retired levels from the DB (live restarts and incremental day-runs keep the lifecycle memory).
- *Acceptance:* 54-day replay twice → identical row counts; active-level count stays bounded (<~150/symbol); zero levels born before their confirmTs.

**0.2 Clock alignment (L2 ↔ L3)** *(study, small)*
- Concept: we will join CQG-L2 and Bookmap-L3 events; if feed clocks skew, joins smear.
- Math: offset δ̂ = argmax over δ of the cross-correlation between 100ms-binned trade-count series of the two feeds; estimate per day, check stability.
- *Acceptance:* |δ̂| and day-to-day σ(δ̂) published; correction applied to all cross-feed joins. STOP if unstable (>250ms drift within a day) → joins restricted to coarse horizons.

**0.3 Aggressor calibration (inferred vs true)** *(study)*
- Concept: L2 footprint uses book-relative inference; L3 MBO knows the truth. This bounds the error on every delta we will ever compute on the 54-day L2 set.
- Math: trade-level agreement rate; per-minute signed-delta Pearson r; error distribution by trade size and by volatility state.
- *Acceptance (pre-registered):* agreement ≥ 90% AND per-minute delta r ≥ 0.95 → L2 deltas usable with error bars. Below → flow features route to L3-only (observability framework).

**0.4 Micro-vs-mini footprint agreement** *(study)*
- Concept: we screen on micro (power) and confirm on mini (institutional truth); this measures how far apart the two crowds' footprints actually are.
- Math: per-bin delta correlation; POC-distance distribution; imbalance-flag agreement via **Cohen's κ** (chance-corrected — raw % agreement flatters).
- *Acceptance:* routing table per feature family (micro-OK / mini-only / both-with-correction). ~9 clean overlap days (06-29 excluded) — this is *estimation*, not hypothesis testing; report CIs, no verdicts.

**0.5 Estimator freezes** *(code + doc)*
- **σ_ev** (event-time diffusion): EWMA realized volatility on 1-min log-returns, half-life 30 min, session-anchored (reset at 18:00 ET), drift-stripped (demeaned). Jump-robust option recorded (bipower variation BV = (π/2)·Σ|rᵢ||rᵢ₋₁|) but the simple estimator is the frozen default. *(EWMA here is a statistical estimator of variance, not a price indicator — the lagging-indicator ban is about signals.)*
- **Kish correction** for imbalance z: n_eff = (Σs)²/(Σs²) over the cell's trade sizes; z is computed on n_eff, not raw volume — a single 200-lot no longer counts as 200 independent trials.
- *Acceptance:* both formulas in code with unit tests; σ_ev plotted across the 3 reference days (trend 06-05 / chop 05-29 / normal 06-02) and sane.

**GATE 0→1: instrument validated.**

---

### PHASE 1 — The trace, completed (measurement layer; still zero hypotheses)

**1.1 Outcome columns (the two-gate data)** — per visit, deferred-resolution pass in replay:
- Markout vector m(h) = sign-adjusted mid return at h ∈ {1, 5, 15, 30} min after visit close, raw AND drift-adjusted (m̃(h) = m(h) − day-drift·h).
- Gate-2 barrier outcomes at each R ∈ {1, 1.5, 2, 3}: WIN/LOSS/TIME, with the 1R used, σ_ev, and vertical-barrier T = 2·(1R/σ_1m)² min recorded.
- **Drift-adjusted null** stored alongside: with θ = 2μ_day/σ², P(hit target R·s before stop s) = (1 − e^{−θs}) / (1 − e^{−θ(R+1)s}) — reduces to 1/(1+R) as μ→0.
**1.2 Uniqueness weights + clusters:** concurrency c(t) = # open outcome windows at t; uniqueness uᵢ = mean over window i of 1/c(t). Overlapping active levels (within merge distance across sources) share a `cluster_id`.
**1.3 Placebo sources in the registry:** `placebo-random` (uniform in day range, same count as swings), `placebo-shifted` (yesterday's swings replayed today), `round` (00/50 handles — the honest null: they carry real flow).
**1.4 Context columns:** time-of-day phase (open-drive 09:30–10:30 / mid / close 14:30–16:00), realized day dir-ratio, expected range (VXN/IV forecaster — validated, sizing/conditioning only), **minimal NQ–ES common-factor state**: rolling 5-min return sign-agreement + relative strength (computed from our own two feeds; full common/spread decomposition stays deferred).
**1.5 Per-visit footprint (Tier-2) with the approach ring-buffer:** 60s pre-band trade buffer so the *attack* phase is captured. Per-visit features, each phase-split (approach / contact / resolution): delta, imbalance count, **absorption ratio** = absorbed_vol / max(penetration, 1 tick) (volume digested per point of give — high = passive defense), test-over-test deltas vs prior visit.
**1.6 Tier-1 volume levels + confluence:** kernel-smoothed session profile (Gaussian in price, bandwidth ≈ 2 bins); POC/HVN = local maxima, LVN = local minima → level sources. **Confluence score** = # distinct sources in a cluster. **Polarity history** kept (a support becoming resistance is data, not an overwrite).
**1.7 ES spine switched on** (same code, ES config) — accumulates from day one; analysis deferred.

*Acceptance:* full 54-day rebuild; QA notebook — row counts, null rates, feature distributions, placebo rows present, uniqueness weights ∈ (0,1]. **No significance tests run.** GATE 1→2: trace certified.

---

### PHASE 2 — Nulls and power (know what "nothing" looks like before hunting)

**2.1 Pipeline self-test on placebos:** at placebo levels, barrier outcomes must reproduce the drift-adjusted analytic null (within bootstrap CI). *This validates the measurement code itself* — if placebo ≠ theory, the pipeline is broken, not the market.
**2.2 Baseline curves:** mean-reversion-at-band hold rate (the ~65%) with CIs; markout distribution at random times.
**2.3 Power table (kills "underpowered-reported-as-null" forever):** block-bootstrap (by day) SE of mean markout per subsample size → **minimum detectable effect** MDE ≈ (z_{α/2} + z_β)·SE = 2.8·SE for 80% power at α = 0.05. Published per horizon. Any factor whose plausible effect < MDE at available n is *pre-declared untestable on this sample* — it goes to the forward-accumulation queue instead of being burned.

**GATE 2→3: nulls reproduce theory; power table published.**

---

### PHASE 3 — The single-factor ladder (Gate-1 discovery; ONE factor at a time)

The heart of Cracker. A fixed harness; factors queue through it one at a time; each gets a ledger entry; nothing else changes between runs.

**The frozen harness (identical for every factor):**
1. Factor value computed per visit (pre-registered definition, no peeking).
2. **Univariate IC** = Spearman rank-correlation of factor vs drift-adjusted markout m̃(h) at each horizon, uniqueness-weighted, block-bootstrapped by day → CI.
3. Binary split (top vs bottom tercile) conditional markout curves.
4. Same computation on **placebo levels** — factor must beat its own placebo twin.
5. Verdict: EDGE (CI excludes 0, beats placebo, mechanism-consistent horizon) / NULL / UNDERPOWERED (per the Phase-2 power table). Ledger entry with all numbers.
6. Train (~30d) + validation (~12d). **Lockbox (final 12d) untouched until Phase 5.**

**The queue (ordered by mechanism prior; each is a separate session-sized experiment):**
| # | Factor | The question |
|---|---|---|
| F1 | Level-source identity (swing vs placebo, by scale) | do our levels matter *at all*? coarse > fine? |
| F2 | Confluence count | do multi-source clusters out-predict single-source? |
| F3 | Visit-index / test-over-test hold posterior | the corrected 94/7 question, survivorship-stratified |
| F4 | Absorption ratio at contact | is passive defense measurable and predictive? |
| F5 | Contact delta sign & magnitude (Tier-2) | does aggressor flow at the level predict resolution? |
| F6 | Approach imbalance (attack phase, from the ring-buffer) | does *how price arrives* matter? |
| F7 | Sweep geometry (penetration depth × reversal speed) | stop-run reversal, quantified |
| F8 | Prior-visit delta divergence (test-over-test CVD) | Carmine's discriminator, formalized |

STOP/GO is per-factor, not per-phase: NULL factors are recorded and **dropped** — they never reappear inside compositions.

---

### PHASE 4 — Heatmap engine (minimal scope, then its factors join the ladder)

**4.1 Minimal heatmap (L2):** resting depth at level ± k ticks per side; **liquidity delta over the approach** ΔL = (L_contact − L_approach)/L_approach (pulled vs added vs defended); void detection (book gaps). Explicitly *deferred*: spoof/iceberg classification (an L3-only research program — Phase 4b on mini data, low-N, mechanism-grade only).
**4.2 New factors → the Phase-3 harness, one at a time:** F9 wall-behavior on approach (pulled/added/defended), F10 void-ahead distance, F11 (4b, L3) iceberg/replenishment at level.

---

### PHASE 5 — Composition & tradability (only survivors may combine)

**5.1 Pairwise interactions of EDGE-verdict factors only** (bounded combinatorics — the anti-kitchen-sink rule): conditional markouts on factor pairs; then a small walk-forward model (logistic or shallow GBM) on survivors; **Shapley = attribution narrative only, never the decision rule** (unstable under correlated features).
**5.2 Sequence patterns from validated primitives:** attack→absorb→delta-flip composed from F6+F4+F5 *only if all three individually survived*; failed-break→reclaim from F7.
**5.3 Gate-2 tradability** on composed candidates: triple-barrier with the frozen 1R, drift-adjusted gambler's-ruin null, **asymmetric slippage** (stop fills = adverse fast-tape fills estimated from our own book data — the §25.2 lesson; targets passive/neutral).
**5.4 Lockbox opened ONCE.** Whatever survives train+validation gets a single confirmatory shot on the final 12 days. Pass → Phase 6. Fail → back to the ladder; the lockbox is spent and the next lockbox must accumulate from forward data.

---

### PHASE 6 — Regime conditioning (layer 5)

Survivors conditioned on: expected-range regime (VXN/IV), realized day-type, common-factor state, time-of-day phase. Output: the **playbook table** — {pattern × regime → trade/no-trade} — with per-cell CIs. A pattern that only works in one regime is *regime-conditional edge*, tradable with the regime gate on; a pattern whose sign flips across regimes without a mechanism is discarded (that's noise wearing a costume).

---

### PHASE 7 — Lifecycle & shadow (layer 7; management separated from entry)

**7.1 Meta-labeling:** the pattern fixes direction; a secondary model (features: regime, confluence, visit posterior) decides take/size. Trained walk-forward; sized by fractional Kelly (¼-Kelly cap — full Kelly is variance-suicide at our n).
**7.2 Management research (only now):** structural-stop + next-liquidity-target management vs the fixed Gate-2 brackets, as a *comparison study* on proven-edge signals — management can add to a real edge; it can no longer create a fake one.
**7.3 Shadow-forward:** Cracker runs live, logging signals, placing nothing, ≥ 20 sessions. Distribution drift test: backtest vs shadow signal/outcome distributions via KS test + PSI; expectancy CI over shadow signals.

---

### PHASE 8 — Arming (pre-registered criteria, decided before shadow starts)

GO requires ALL: shadow expectancy CI excludes 0 after asymmetric costs (n ≥ 100 signals or 20 sessions, whichever later) · no KS/PSI drift flag · data-integrity clean · **parameter-stability sweep passed** (the one and only sensitivity pass: every frozen parameter wiggled ±20%; edge that vanishes under wiggle is curve-fit, not edge). Then micro-size (1 MNQ), per-order human confirmation until a further explicit decision — the hard rule stands.

---

## 3. Cross-cutting rules

- **The signal ledger** (`docs/cracker-ledger.md`): every factor/pattern run — date, definition hash, n, IC, CI, verdict, decision. Append-only.
- **Versioning:** every engine iteration = new file (hard rule). The ladder harness itself is version-locked per phase.
- **Data hygiene:** 06-29 BMD excluded; Mondays source prior-Friday reference levels; contract-roll data tagged per contract.
- **What Cracker does NOT do:** no lagging indicators; no MFE/MAE anywhere; no GEX in level logic (falsified) — options data enters only as the expected-range regime input (validated); no RS-platform API calls (passive CDP reads only).

## 4. Where we are + immediate next step

- ✅ Spine built + committed (`4032482`); protocol + two-gate labeling frozen (`9f19847`).
- ▶ **Next: Phase 0.1** (retirement/decay via Beta posterior, confirmTs, idempotency, rehydration) — then 0.2→0.5 calibrations.
