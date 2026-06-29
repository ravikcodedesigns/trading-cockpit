# L2 Touch Decider — Implementation Plan

> The level-touch scalping system: at an RS-level first-touch, the **levels engine** gates
> the touch + emits a direction; the **L2 evaluator** confirms/vetoes it from order-flow;
> a trade fires only on confirmation. Target: 20–40pt scalps off RS levels and between zones.
> Companion to `RS_TOUCH_SPEC.md` (touch/TAD/LP-IP/TP-SL definitions). Agreed 2026-06-28.
> Status: PLAN. Nothing wired to the trader. Shadow-only until it beats baseline OOS.

---

## 0. Design principles (non-negotiable — these are what stop OOS death)

1. **Engine decides direction; L2 confirms/vetoes.** At BrZT/LP/IP the framework prior is
   bullish. The L2 evaluator never picks direction cold — it approves the engine's direction
   or vetoes it (and a strong veto may flip short on a confirmed break).
2. **Forward-only / causal.** Every feature uses data up to and including the decision tick.
   No look-ahead, ever. (The +$390→−$147 camp failure was a rule-violation/overfit artifact.)
3. **Relative, not absolute.** Every L2 factor is z-scored or ratio'd against its own rolling
   intraday distribution. NO fixed magnitude thresholds (the repeated OOS-killer).
4. **L2 only (for now).** L3 reads (icebergs, synthetic-refill, implied-gap, true aggressor-
   cluster) are commented out until BMD addon v1.2 exchange-time is validated (#13). Then flip on.
5. **Time-accurate sources only.** CQG/ticks.db for price+L2 (BMD parquet timing is broken
   until v1.2). rs-context-history for the header/regime.
6. **Beat a baseline.** The bar is not "positive PnL" — it's "adds over taking every engine-
   approved touch in its prior direction," out-of-sample, with slippage.
7. **WIN/LOSS only** at a fixed bracket. Never MFE/MAE.

---

## 1. The pipeline (one touch's life)

```
price first-crosses an RS level (≥09:32, first per level per minute)        ← RS_TOUCH_SPEC §1
  → LEVELS ENGINE gates the touch: DD/mRes/HP-res/LM/GM/gate-mode → {take?, direction, family}
       (EST/RDZ/DD/LM/ZONE/BZ; BrZT/LP/IP = bullish prior)                  ← rules-v2 engines
  → if engine says no-thesis → log, no trade.
  → else ARM the L2 evaluator at the touch tick:
       • snapshot the causal L2 + regime state                              ← Stage 1
       • track a REACTION WINDOW tick-by-tick (seconds)                     ← arm-and-track, not 1 snapshot
       • at the CONFIRMING tick: L2 confirms engine direction → ENTER
         (or vetoes → skip; or confirmed opposite break → optional flip)
  → manage to TP/SL bracket (RS_TOUCH_SPEC §6, pocket-scaled for LP/IP)
  → label outcome WIN/LOSS (forward walk, slippage), shadow-log
```

Two clocks: **minutes** for regime bias (delta5/15, header), **seconds** for the touch trigger
(approach-anchored + reaction-window flow). delta5/15 are 5/15-MINUTE bar deltas → regime only,
NOT the trigger.

---

## 2. The L2-only feature set

Three anchors per touch (all relative/normalized):

**A. Regime (minutes — from rs-context-history, join by ts):**
gm, dd_ratio, mhp_res, hp_res, redist_res, vx/bbb (vxAboveBBB), vvix(+elevated/golden),
qqq_spy_rs, is_rational, vx_vol_state. (+ expectedRangePts/EM once #14 lands.)
Plus a **causal regime classifier**: camping / trending / flushing (from price oscillation +
CVD persistence over the prior N min). Gates whether/how to act — the camp lesson.

**B. Approach (the leg INTO the level — seconds):**
- CVD-since-approach, OFI-since-approach (conviction driving in).
- approach velocity (pts/sec of the leg).
- "approach" anchor = when price entered the approach band (e.g. ~1 zone-width from the level
  on this leg). Distinguishes a violent sell-leg (break-prone) from a drift (hold-prone).

**C. At-touch + reaction window (seconds AFTER the touch — the core):**
- **Kyle's λ at the level** (realized price-impact, reuse `divergence.ts` OFI/λ — it's L2):
  low/collapsing λ = flow absorbed = defended; high λ = thin = breaks. **The principal signal.**
- **Δresting-size vs trade-volume reconciliation** at the level: size hit-and-refills =
  absorption; size drops without trades = pull/spoof; size returns = refill. (L2 proxy for the
  L3 iceberg/pull reads — net-per-level, not order-by-order, but enough for go/no-go.)
- CVD-since-touch (does flow flip in the engine's direction?).
- **sweep (relative-derived):** abnormally fast, multi-level, one-sided aggression vs the last
  N-min distribution (re-derive — the logged `cockpit_addon` sweep uses fixed 3/50/500 thresholds
  + inferred CQG aggressor; concept good, thresholds must become relative).
- large-print concentration (L2 proxy for aggressor-clustering; true clustering is L3, deferred).

L3 (deferred until v1.2 validated): native icebergs, synthetic-refill chains, implied-gap,
true aggressor-clustering, true CVD.

---

## 3. Build stages

### Stage 0 — Data foundation
- **Source decision:** CQG/ticks.db micro L2 now (time-accurate, thin); flip to BMD full-size
  after v1.2 exchange-time is validated (#13). Build the reader symbol-agnostic so the swap is config.
- Causal L2 book reconstruction from CQG depth(L2 snapshots, side 0=bid/1=ask)+trades. (Have the
  pattern from `l2_causal_walk.py`.)
- Lift OFI/Kyle-λ from `src/l3/divergence.ts` as reusable L2 primitives (pure functions already).

### Stage 1 — RTH L2 trace + per-touch capture (LOG ONLY, label outcomes)
- **1s RTH trace, CONTINUOUS FROM RTH OPEN (09:30)** of the L2 factors → time-series table. Two
  jobs: (a) the rolling intraday **baseline/distribution** every relative feature normalizes against
  (z-scores need history before a touch); (b) the **approach record** — so when a touch fires we
  already have the full pre-touch leg (e.g. the ~40s sell-leg into BrZT @09:32:56) to compute
  CVD/OFI/velocity-since-approach. The before-touch data is a first-class PREDICTIVE input (conviction
  driving into the level), not just context.
- **Per-touch:** detect first-touch (RS_TOUCH_SPEC §1), join engine thesis + regime, capture the
  A/B/C feature vector, ARM the reaction window, record the confirming tick (if any).
- **Outcome labeling:** forward-walk CQG trades to the bracket → WIN/LOSS, pnl_pts, with a slippage
  assumption (≥5pt entry, measured). No MFE/MAE.
- **Persist** → new shadow tables in `l3-shadow.db` (or a new `l2-touch.db`):
  `l2_touch_trace` (1s), `l2_touches` (touch + features + engine thesis + regime),
  `l2_touch_outcome` (bracket result).
- Nothing trades. This is the dataset.

### Stage 2 — Empirical analysis (does ANY feature separate W/L?)
- Across many touch days: which relative features separate winners from losers at touches?
- **Train/test split or walk-forward** (never one window). Permutation test for significance.
- **Baseline to beat:** take every engine-approved touch in its prior direction. The L2 layer
  must ADD over that, OOS. Honest possible outcome: nothing separates → stop (valid result).

### Stage 3 — Encode the decider (confirm/veto), shadow forward
- Only features that survived Stage 2. `decision-engine.ts` L2-only fork: comment out L3, drive
  confirm/veto from the surviving L2 features (relative).
- Run forward shadow → `l2_touch_outcome`. Resolver scores engine-alone vs engine+L2 (like the
  existing l3 resolver pattern).

### Stage 4 — Arm (only after forward shadow beats baseline)
- Wire to the trader behind a flag, micro size, with the risk guards. Review gate first.

---

## 4. Validation gates (the make-or-break)
- Causal/forward-only (audited).
- OOS / walk-forward across many days — not one window.
- Beats the engine-prior baseline, OOS.
- Permutation p significant; small-n humility.
- Slippage + entry latency (~5pt) in every PnL.
- Shadow-forward confirms before any arm (true live book not backfillable).

> Project prior: most microstructure edges here (DDA, true-CVD, VWAP, stacked-zones) FAILED OOS.
> Expect to disprove this one; only ship if it clears every gate.

---

## 5. New artifacts
- `scripts/l2_touch_capture.{ts|py}` — Stage 1 trace + per-touch capture + labeling.
- `scripts/l2_touch_analyze.py` — Stage 2 train/test feature separation.
- L2-only fork of `decision-engine.ts` (confirm/veto) — Stage 3.
- Tables: `l2_touch_trace`, `l2_touches`, `l2_touch_outcome`.
- Reuse: `divergence.ts` (OFI/λ), `RS_TOUCH_SPEC.md` (touch/TAD/LP-IP/bracket), rs-shadow engines,
  rs-context-history (regime), `l2_causal_walk.py` (book reconstruction pattern).

## 6. Open decisions to settle before Stage 1
1. Bracket for scalps: fixed 40/40, pocket-scaled (LP/IP), or vol-scaled (EM/RANGE)? (RS_TOUCH_SPEC §6.)
2. Reaction-window length + the "confirming tick" definition (relative).
3. CQG-micro now vs wait for v1.2 BMD full-size.
4. Which levels in scope first (BrZT/LP/IP only, or all RS levels).
5. Regime-classifier definition (camp/trend/flush thresholds — relative).
6. **Approach anchor**: when does the "leg into the level" start — price within N pts of the level,
   or the start of the directional move toward it? (defines CVD/OFI/velocity-since-approach.)
7. **Rolling-baseline window** for the relative z-scores (e.g. last 10/20 min vs session-so-far).

### Settled (2026-06-28)
- Data source: **CQG micro now**, re-run on BMD full-size after v1.2 validated.
- Level scope: **BrZT / LP / IP only** first.
- Bracket: **pocket-scaled** (TP = opposite edge, SL ≈ 0.3·H).
- Touch evaluation: **arm at touch + track to the flow-flip confirming tick** (contested if price
  leaves the band first).
