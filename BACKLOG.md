# Product Backlog

Parked work with enough context to resume cold. Each item: why it exists, what was
already found, exactly what's involved, and the gate that decides done/deploy.

Conventions reminder: WIN/LOSS only (never MFE/MAE); new file per strategy iteration;
no lagging indicators; quantify impact before any live change.

---

## 0. Trap→FLIP veto gate — ✅ IMPLEMENTED LIVE 2026-06-18 (same-dir, longs-only)

**Status:** SHIPPED to live path 2026-06-18. Same-dir veto, FLIP-longs only. Layer =
actionability (signal-pipeline.ts → action `SKIP_TRAP_VETO`). Config flag
`pipeline.flipTrapVeto` (env `FLIP_TRAP_VETO=off` reverts). Reconciled vs backtest (16=16,
0 mismatch). Directional split decided longs-only (shorts: n=2 flagged, not significant,
already 71% WR). Monitor: `SELECT * FROM tradable_signals WHERE action='SKIP_TRAP_VETO'`.
**Open follow-ups:** (a) any-trap variant (stronger stats, looser mechanism) — promote if
forward data backs the opp-dir cohort; (b) CONT-LONG same-dir trap CONFLUENCE
(require a same-dir trap) — cont-long 88% WR with vs 59% without, but n=8, p=0.085 (not
significant); cont SHORT shows no effect (62% vs 71%, p=0.66). Promising + mechanistically
sensible (continuation + confirming thrust), too thin to ship — revisit cont-LONG as the cont
sample grows. (c) consider flip shorts only if a real short-veto sample accumulates.
Original validation details below for reference.

**Status (history):** Validated 2026-06-18. The one OOS-surviving win of the CVD/long research.

**Why it exists:** Trap (J) is dead as a standalone signal (see note at bottom), but it fires at
RS structural levels and turns out to be a strong CONTEXT filter for flips.

**The rule:** Veto a `clean-impulse` (FLIP) signal if a `trap` signal fired **in the same
direction within the prior 30 min** (variant: any-trap, not just same-dir — stronger but drops
more). Mechanism: a reversal firing right after a same-direction fade at the same level is
late/crowded; theory predicted this before the data.

**Evidence (tradable book, 97 NQ OPEN flips, baseline 59% WR / +$3,643):**
- same-dir veto → kept 79, **66% WR, +$4,456** (drops 18 @ 29% WR). June OOS 47%→56%. perm p=0.003.
- any-trap veto → kept 64, **72% WR, +$4,686** (drops 33 @ 34% WR). June OOS 47%→61%. perm p=0.0004.
- Clears all three bars everything else failed: generalizes OOS (improves the weak June regime),
  significant (p=0.0004–0.003), mechanistically coherent. Disproportionately filters weak flip longs.

**What's involved:**
1. Add a trap-recency lookup (last trap ts+direction per symbol, in-memory or a quick
   `signals` query) available at flip evaluation time.
2. Gate in `quality.ts` (silence the flip) or `signal-pipeline.ts` (SKIP_TRAP_VETO action) when a
   trap fired in the window. Follow the `flipLongDelta15Gate` shadow pattern (config flag,
   `shadow` → log marker without skipping, `enabled` → skip).
3. Pick variant: **same-dir** (conservative, keeps more trades, p=0.003) vs **any-trap** (cleaner
   book, drops 1/3 of flips, p=0.0004). Recommend starting same-dir.
4. Shadow ~2–3 weeks live, confirm forward, then enable. Quantify impact before enabling.

**Decision gate to enable:** forward-shadow confirms the vetoed cohort keeps underperforming.
Already passed in-sample + June OOS + permutation, so the bar to start shadowing is met now.

**Reference:** memory `project_trap_signals`. Scripts: `scripts/cvd_migration/trap_confluence.py`,
`trap_veto_validate.py`, `trap_veto_tradable.py`. Also test the CONT confluence (same-dir trap →
75% WR, n=16) as data grows — opposite of flips, mechanistically sensible, too thin yet.

**Trap STANDALONE = dead** (don't re-litigate): native tight stop loses (−$562 NQ); wide-stop
"profit" (+$2,553) decomposed to a regime/short artifact (all profit shorts in the June selloff,
direction-shuffle permutation p≈0.2). Keep silenced as a standalone trade.

---

## 1. True-CVD migration — SHELVED (revisit only with a live true-aggressor feed)

**Status:** Shelved 2026-06-18. Do not resume without the precondition below.

**Why it existed:** The live `cvdSession` is built from the tick feed's *inferred*
aggressor (`is_bid_aggressor`), which is ~3.5× off vs Bookmap/true. Goal was to migrate
flips/conts to a "true" CVD computed from the exchange aggressor (MBO tape).

**What was found (the reason it's shelved):**
- The quote rule (Lee-Ready on L2) reconstructs true aggressor well on **MBO depth**
  (85–95% per-trade agreement) but **fails on tick-grade depth** (wrong-signed CVD on
  06-12) — so the live tick feed cannot produce true CVD, and May (ticks-only) can't either.
- Head-to-head true-vs-inferred CVD looked great for longs (AUC 0.749 vs 0.654) — but that
  was a **re-gating artifact** (re-scored a fixed ticks-detected signal set).
- The honest **full-funnel re-derivation** (re-detect AND re-gate on the MBO tape, identical
  engine both arms) showed true CVD is **NOT better**: inferred 45 tradable / 56% WR / +562pt
  vs true 25 tradable / 56% WR / +285pt — same WR, fewer trades, less PnL. It drops as many
  winners as losers (12W/12L) and the new signals it surfaces are net losers (2W/4L).

**Precondition to ever resume:** a real-time **true-aggressor feed** (Databento live MBO or
CME MBO; Tradovate aggressor field if it exists). Without it the migration is unreachable live
*and* unproven valuable — both must change.

**What's involved if resumed:**
- Ingest the live MBO feed into a real-time true-`cvdSession`.
- Re-derive ALL aggressor-dependent thresholds on the true scale (not just cvd floors:
  deltaT/deltaLast3/priorImpulse/delta5/delta15 in detection; delta15<500 & |delta5|≥1000 in
  quality). Inventory of these gates is in the session notes / `quality.ts` + `strategy-h.ts`
  + `strategy-cont.ts` + `config.ts`.
- Validate OOS (forward-accumulated MBO or a purchased history), not in-sample.

**Decision gate:** only deploy if true CVD beats inferred on a full-funnel, OUT-OF-SAMPLE test
(WR and net PnL), with the live feed in place. Current evidence says it won't — set a high bar.

**Do NOT** spend ~$5k on 5-yr MBO history *for this purpose* — the edge didn't survive honest
testing. (A purchase may still be justified for *other* research; not this.)

**Reference scripts (kept):** `scripts/cvd_migration/{quote_rule,cross_validate_ticks,
cvd_headtohead,harden_truecvd,compare_arms}.py`, `apps/aggregator/scripts/cvd_scan_funnel.ts`.
Sandbox MBO-true ticks DB builder logic also there (regenerates `data/sandbox-cvd/ticks_true.db`
from mbo-parquet). Memory: `project_cvd_migration`.

---

## 2. Long-flip deltaT-cap re-test (best long-side candidate; re-test as data grows)

**Status:** Parked 2026-06-18. Promising direction, not yet deployable.

**Why it exists:** Long FLIPs underperform shorts and degraded badly through June (the
"flip longs keep failing" complaint). We looked for a detection-side fix.

**What was found:**
- Mirror features Ravi proposed do NOT work: `priorImpulseDown` gate is *backwards* (winning
  longs followed WEAKER prior selling), `lowerWick` doesn't separate W/L at all.
- The one real signal: **`deltaT` is inversely related to long success** — winners have LOWER
  reversal-bar buy-aggression (median 701 vs losers 898). High-`deltaT` longs (>900) are
  coin flips: 41% WR, EV +0.2 pt/trade. The current detector REQUIRES `deltaT≥300` and
  REWARDS high deltaT in scoring — i.e. tuned toward the cohort that underperforms.
- **Capping deltaT** (e.g. `300 ≤ deltaT ≤ 900`): in-sample WR 52→59%, EV +14.3→+24.5,
  preserves PnL. **But it fails the bar:** permutation p=**0.061** (misses 0.05) and it does
  not generalize OOS — May→June: baseline 59→44%, cap≤900 69→47% (+3, noise), cap≤700 72→43%
  (worse). 8th in-sample mirage on this ~30-day sample.

**What's involved to re-test (do this when ≥~60 more tradable longs have accumulated):**
1. Re-run `apps/aggregator/scripts/long_flip_features.ts` (reads ticks.db, writes
   `long_flip_features.json`) over the expanded date range.
2. Re-run `scripts/cvd_migration/test_deltat_cap.py`: cap sweep + AUC permutation + a
   genuine train/test split using the NEW data as OOS (not May/June which is now in-sample).
3. If it holds, the live change is small: add an upper bound to `FLIP_DELTA_T_LONG` logic in
   `strategy-h.ts` (long branch ~line 262) and/or drop the high-deltaT scoring bonus
   (~line 269). Mirror in `backfill_clean.ts`. Quantify impact first.

**Decision gate to deploy:** OOS WR lift that holds on data the cap never saw, AND permutation
p<0.05 on the larger sample. Until both, leave the detector unchanged.

**Caveat:** June long weakness is largely **regime**, not a criterion gap — a cap may not be the
right tool. Consider the regime-conditioning item below as the alternative framing.

**Reference:** memory `project_longflip_findings`. Scripts kept under
`apps/aggregator/scripts/long_flip_features.ts` + `scripts/cvd_migration/`.

---

## 3. MBO-parquet hygiene (prerequisite for ANY future MBO/true-CVD analysis)

**Status:** Open 2026-06-18. Cheap, do before relying on mbo-parquet again or deleting mbo.db.

**Why it exists:** Surfaced while building the CVD sandbox. The offline mbo-parquet store has
corruption that would silently poison any future analysis sourced from it.

**What was found:**
- `date=2026-06-17` partition is **corrupt**: 58.9M trades (~15× a normal day; normal ~3–4M).
  Likely a mid-capture / dedup miss. (Also it was *today* when captured — possibly incomplete.)
- **Junk contract labels** in some rows: `MNQM26` (06-01, should be MNQM6), `MNQU6QU6` (1 row,
  06-17). Real label corruption, not a query artifact.
- `date=2026-06-01` is a partial first-capture day (212K trades, mislabeled) — verify/quarantine.

**What's involved:**
1. Inspect + reconcile the 06-17 partition against the raw capture; rebuild or quarantine it.
2. Normalize/repair contract labels (map junk → canonical front month, or drop bad rows).
3. Add a validation step to the nightly compaction: flag partitions whose row count is a gross
   outlier vs the trailing median, and flag non-canonical contract strings.

**Decision gate:** mbo-parquet passes a per-day sanity check (row counts in normal band, only
canonical contract labels) before it's used as the kept source — especially before the planned
mbo.db (~300GB) deletion, after which parquet is the only true-aggressor copy.

**Note:** This does NOT affect live trading (live reads ticks.db, not mbo-parquet).

---

## 4. Long-side regime conditioning (research framing, lower priority)

**Status:** Idea 2026-06-18. The deeper "why" behind items 1–2.

**Why it exists:** Every pre-entry feature tried (CVD, mirror structure, deltaT cap) failed to
fix long performance because the May→June long degradation is **regime-driven** (baseline long
WR 59%→44% across the split), not a per-signal criterion gap.

**What's involved:** Instead of more per-signal filters, condition long eligibility on a
day/session **regime** classifier (trend-up / range / trend-down), using the structural inputs
already favored (VWAP, volume profile, structural levels — NOT lagging indicators). Tie into
existing regime work ([[project_vol_regime]] found RANGE predictable via cross-asset vol;
direction/trend not). Test whether long FLIPs only pay in specific regimes.

**Decision gate:** a regime split that holds OOS and materially lifts long WR/PnL vs taking all
longs. Larger research effort — scope before starting.
