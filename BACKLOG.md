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
forward data backs the opp-dir cohort; (b) CONT × trap confluence as a
SIZING lever — promoted to its own entry, **item #5** below. (c) flip shorts only if a real
short-veto sample accumulates.

**Trap as a SCALP = DEAD (don't re-litigate):** the trapped-flush is real but the trap signal
fires 16–39s after the spike, so it's unfillable. Real-tick entry at signal time loses both
directions (EV −3.3 to −4.5pt); placebo trap-entry EV −3.27 vs random +0.04, p=0.976 (worse than
random). To trade the flush you'd need sub-second failed-break detection, not this signal.
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

---

## 5. CONT × trap CONFLUENCE — sizing lever (parked: promising, not yet significant)

**Status:** Parked 2026-06-18. Mirror of the flip veto (item #0) — opposite direction: for
continuation trades a same-direction trap CONFIRMS the trend resuming, so it's a **confluence**,
not a veto. Intended as a **SIZING** lever, NOT a skip rule (conts WITHOUT a trap still win).

**Why it exists:** A trap is a failed counter-move rejected at a level. Before a CONT that's in
the trend's favor → confirmation the trend is resuming. Mechanistically the clean inverse of the
flip case (where a same-dir trap means a reversal is late/crowded).

**Evidence (tradable OPEN cont book, NQ, May–Jun 2026):**
- baseline conts already strong: long 75% / short 75% WR.
- WITH same-dir trap: 83% WR (+$1,320) vs WITHOUT 69% (+$918).
- WITH any trap: 86% WR (+$1,640) vs WITHOUT 64% (+$598).
- Shows on BOTH cont directions on the tradable book (raw signal set earlier showed long-only —
  cohort-unstable, a small-sample warning).

**Why it's parked, not shipped:** NOT significant — best permutation p=0.090 (cont-short,
any-trap); the rest 0.11–0.30. Cells are n=6–14. And without-trap conts are already 64–70% WR, so
the confluence adds a modest, unproven bump on a sliver of trades.

**The feature (when it earns it):** at signal time, if a same-direction trap fired in the prior
30 min, **size the cont up** (e.g. 2× base) rather than skipping anything. Reuse the same
`db.lastSignalTsBefore('trap', sym, dir, ts)` lookup the flip veto already added; apply in the
sizing path, not the OPEN/SKIP gate. Keep base size for conts without a trap.

**Decision gate:** permutation p<0.05 on an accumulated (≥~40 with-trap conts) sample, holding
OOS. Until then, trade conts at base size regardless of trap. Revisit as the cont sample grows.

**Reference:** scripts/cvd_migration/{trap_cont_confluence.py, trap_cont_by_dir.py}; memory
`project_trap_signals`.

---

## 6. Rocket Scooter platform integration (PASSIVE read of debug Chrome)

**Hard rule:** PASSIVE ONLY — read what the platform already rendered/loaded into the local
debug Chrome (CDP DOM read + buffered responses). NEVER originate API calls / replay the token /
reload. See memory `project_rs_platform_feed` for access method + full data inventory.

**6a. rs-feed v1 — ✅ DONE/LIVE (2026-06-18).** scripts/rs-feed.js + launchd com.cockpit.rs-feed
(+ com.cockpit.rs-chrome guard). DD + 3 resiliences (NQ/SP) → data/rs-context.json every 5s,
preserving manual fields. Resilience mapping: redist=NQValues-w, mhp=NQMHP-w, hp=NQHP-w.

**6b. Auto-levels → daily_levels{,_es}.json — ✅ DONE/LIVE 2026-06-18.** scripts/rs-levels.js +
launchd `com.cockpit.rs-levels` (once/day, weekdays 09:37 ET, one-shot — levels static intraday).
Reads NQ (MNQ) + ES (MES) chart shapes via CDP TV-widget API: rectangles = full zone bands
(Bull label at bottom, Bear label at top), trend_lines+text = point levels. Writes bullZone/bearZone
(nearest primary, scorer back-compat) + NEW `zones:{bull:[{low,high}],bear:[{high,low}]}` (ALL bands,
top+bottom → enables liquidity-pocket/sandwich) + ddBands/HP/MHP + RS additionalLevels (HG, QQQ/SPY
Open/Close); PRESERVES price-derived levels (PDH/POC/VWAP from structural-levels cron 09:23, runs
before). Validated vs chart (NQ bull 30299.8–30304). NOTE: tab-selector must exclude /settings (2
pro-plus tabs exist) — fixed in rs-levels + rs-feed. Cockpit still needs UI to render the full `zones`
bands (band fills) — currently only primary bullZone/bearZone render.

**6c. Risk interval — sit-out filter (DEPRIORITIZED → do LAST).** Clarified 2026-06-18: the RI
sit-out is a LINE anchored at an **event-trigger point** (the moment the market suddenly moved on a
catalyst — news/tweet/announcement), measured in risk-intervals from there; "1 Risk Interval VX up
→ sit out." The `ddbands.ri` value is only the interval SIZE (NQ≈262, per-ticker incl VX) — easy.
**The blocker is auto-identifying the exact catalyst/event point** (a sudden, fast, large move
attributable to news vs normal vol) = real event/catalyst detection, which is hard and unreliable
without a news feed. Because of that, parked as the LAST 6-series item. (ri also gives DD-band
widths; ties to project_rsscore_rewrite irrational penalty.)

**6d. Gamma-wall-derived levels (NEW potential — validate first).** From `hpa.man_MHP_walls`
(call/put OI by strike, for the tracking ETF — QQQ for NQ, SPY for ES), construct levels of interest
(largest call wall=ceiling, put wall=floor, gamma flip). **Nuance:** HP/MHP we ALREADY use ARE the
dominant gamma walls — so the new piece is the **full strike-by-strike ladder** (secondary walls +
call/put distribution), not the primary wall. **Test: do the secondary walls match our BZB/BrZT/etc,
or are there strong walls we don't plot?** If new → real potential.

  **PREP (do at RTH):**
  1. On the platform, **enable the WALLS indicator** (currently OFF per `tview/indicators` WALLS:false)
     → populates `window.WALLS_HP` / `WALLS_MHP` (currently empty) + draws wall lines on the chart.
  2. Passively capture the full ladder from the **`hpa` response** (`man_MHP_walls` = {strike,call,put})
     for QQQ (NQ) and SPY (ES) — it's loaded by the page; read via CDP getResponseBody (no origination).
  3. Note: `DYN_HP` global already gives per-future HP/MHP via ETF (NQ→QQQ 725/722.5, ES→SPY 742.5/741),
     ETF-price → convert to futures via the ratio (NQ≈QQQ×~41.3).
  4. Convert ETF strikes → futures price, overlay vs our existing levels, quantify overlap.

  **Decision gate:** backtest whether wall-confluence (flip-short at a call wall / flip-long at a put
  wall) or wall-targets improve flip/cont WR/PnL — same discipline as the trap veto. Feeds 6f.

**6e. Top-10 Nasdaq constituent behavior at MHP/HP/HG → bias/entry (NEW potential).** `eventsLog`
gives real-time constituent level-crosses; `db/nq` gives mcap weights. Study how the top-10 NQ
names behave at their HP/MHP/HG and whether aggregate breadth ("X% of top-10 crossed up MHP")
predicts NQ direction → use as bias/entry confluence for flips/conts. Currently these are just
decorative on the chart — put to real use. Validate like the trap veto (train/test + permutation).

**6f. Gamma-wall entry/exit dimensionality (NEW).** Build entries/exits around the gamma walls as
foundational options-based S/R (targets at walls, stops beyond walls, fade at wall rejections).
Depends on 6d proving the walls are useful.

**6g. Greater-market auto-computation.** Per Greater_Market_Analysis: BULL if ANY 1 of 3 positional
bullish (DD>0.5 [have], SPY>MHP [hpa Price vs man_MHP], Monthly Map=bullish [liq-map/monthly, Ravi
to show at RTH]); BEAR if all 3 bearish. + volatility VX<BBB & VVIX<100 (Ravi supplies VVIX/BBB).
Auto-derive `greaterMarket` instead of manual context:set.

**6h. Historical OHLCV datafeed (situational).** datafeed history for vol tickers we lack
(UVXY/VX/VVIX) — cross-asset vol research ([[project_vol_regime]]). Only what the page loads.

## 7. Regime-aware gating + daily gate save/cost tracker

**Status:** Finding 2026-06-18. First live look at whether the CVD-long-floor + trap-veto gates
help or hurt.

**Finding (2026-06-18, one strong bull-TREND day):** the gates were **0-for-5** — they skipped 5
FLIP/CONT signals that *all* won at the fixed bracket → **cost ~400 pt / −$800 MNQ, saved 0.**
Breakdown: 09:59 longFLIP (CVD), 10:31 longFLIP (trap-veto), 10:50 shortFLIP (CVD), 11:39 longFLIP
(CVD), 11:43 longCONT (CVD) — each +80 TP. Method: no-lookahead walk-forward in ticks.db, entry =
signal-bar close (walk from signal_ts+60s — an earlier lookahead bug falsely showed the 09:59 long
as a −55 SL; its true post-entry low was only −18.5). Brackets: FLIP tp80/sl55L/sl105S, CONT
tp80/sl70 (config.ts ruleBrackets).

**Read:** classic CVD-gate failure mode on a *trend* day — the divergence filter (built for fragile
chop/reversal entries) blocked trend-following winners. ONE adverse day; the gates' edge is
statistical over many days (trap-veto 66/72% WR p=0.0004 [[project_trap_signals]]; CVD floor
[[project_longflip_findings]]). DON'T over-update — but clean evidence the gates cost on trend days,
and today's DAY badge was BULLISH.

**Design rule for the level auto-trader ([[project_level_autotrader]]):** gate by **regime, not
blanket** — relax/disable the CVD-long-floor + trap-veto when GM is bullish + trend confirmed.

**Relative CVD (Ravi's preference — absolute floor is volume-fragile):** replace the hardcoded
cvdSession floor (−1000 long / +3000 short) with a **volume-scaled imbalance ratio = cvdSession ÷
cumulative session volume** (net order-flow imbalance, −1…+1) — same raw CVD means very different
things on a 500k vs 2M day; the ratio self-scales. CVD is **inferred** (is_bid_aggressor tape,
cvd-session.ts; true MBO shelved [[project_cvd_migration]]), and ticks.db has both size + aggressor,
so the ratio is computable from the same tape and **backtestable**. Alternatives to A/B: windowed
CVD (last 15–30m), CVD position within day's CVD hi/lo, VXN/expected-range-scaled floor.

**TODO:**
1. Build a **daily gate save/cost tracker**: walk each SKIP_CVD/SKIP_TRAP_VETO signal forward to its
   bracket (WIN/LOSS, no MFE/MAE), accumulate saved-vs-cost **by DAY regime** (trend/chop, bull/bear).
   For each skip, **compute BOTH** the absolute-floor decision AND the imbalance-ratio (cvd ÷ cum
   volume) so we can see which generalizes. `sim_*` cols in `tradable_signals` only populate for
   OPENED rows (stale to 06-09) — skips must be walked forward. Run nightly after close, append to a table.
2. After ~3–4 weeks of sample, test **regime-conditioned gating** (gate active only on chop/reversal/
   bear-GM days). Quantify before changing anything live; keep shadow.

**OUTCOME (2026-06-18) — backtested, nothing beat the floor; LEAVING −1000/+3000 UNCHANGED.**

---

## 8. RS feed: source LM / MHP (and MM) from MASTER_TABLE, not the DOM/chart (enhancement)

**Status:** PARKED 2026-06-23 — low value right now; do when adding enhancements.

**Why:** rs-feed/rs-levels read the LM code from the DOM (`.liq-map-image-text`) and the
Monthly-Map by flipping the 1D chart and scraping rendered rectangles — both fragile (the
09:32 open-time chart read returns null; patched with retries + a 30-min MM job). The same
data sits in a stable in-page JS object.

**Found (2026-06-23, live, passive CDP :9333):** `RS_SOCK.scanner.MASTER_TABLE.data` —
per-ticker, retained; `.QQQ` → NQ, `.SPY` → ES. Holds it directly: `CPbook` = LM code
(matches rs-context `lmCode`), `man_MHP` = the GM MHP threshold (= `qqqMhp`/`spyMhp`),
`monthly_map` = 8 expiry columns of raw gamma walls. `RS_SOCK.resil.marketState` is a null
transient getter — dead end. See [[project_rs_marketstate_vs_dom]].

**What's involved:** (a) read LM from `CPbook` and MHP from `man_MHP` — drops the DOM scrape
AND the 1D chart flip for LM (eliminates the flaky open-time failure). Mechanical: both
already match live. (b) MM: derive from `monthly_map` (candidate rule: price below the
call-wall floor = bearish; fits 06-23) — but VALIDATE against computeMM's rendered-rectangle
read over several sessions incl. a bullish day before switching MM off the chart.

**Gate:** LM/MHP — confirm `CPbook`/`man_MHP` track live for a few days, then swap. MM —
`monthly_map` formula must match computeMM ≥ N sessions. No speed urgency (DOM read ≈ 1 ms).
First-pass on 171 resolved NQ FLIP/CONT signals (cvd backfilled from tape; scripts:
`cvd_ratio_backtest.cjs`, `cvd_ratio_traintest.cjs`, `feature_scan.cjs`, `alignment_validate.cjs`):
- **Relative CVD ratio** — clean *in-sample* monotonic (long WR 39→75% by quintile) but **failed
  chronological OOS** (train kept 72%/skip 38% → test kept 48%/skip 44%; skipped still +EV).
- **Directional alignment** (prior-30m momentum agrees) — looked good on a *random* split (65/53,
  leakage) but **failed chrono** (test 52% vs 51%) and **permutation p=0.14** (not significant).
- **Distance-to-level** and **trend-efficiency** — sign-flipped train↔test (noise).
**Conclusion: no bar-level pre-entry filter generalizes on this ~170-signal / 30-day sample**
(7th confirmation of the overfit wall). Decision: keep the live −1000/+3000 floor as-is; do NOT
ship a relative/alignment gate on this sample. Revisit only with a much larger FORWARD sample and
regime-conditioning. The level auto-trader should rely on **level + regime structure**, not bar
features, and be validated forward — not backfit. See [[project_level_autotrader]].

---

## 9. Cockpit: Opening Bias as a collapsible button before REGIME (UI — needs proper fix)

**Want:** a clickable **OPEN BIAS** button in the chart control bar, placed **before the REGIME
button**, that expands a small table (09:29 Gap · 09:31 Bar1 % · 09:33 CVD3 · BIAS) and collapses
on a second click. No extra label on top, each row on a single line.

**Status 2026-06-24:** ATTEMPTED, REVERTED. The cockpit is back to the original **always-on**
`<OpeningBias>` overlay (`Chart.tsx`, rendered right after the control-button IIFE, inside the
top-left column overlay at `~3001`). The `whiteSpace:'nowrap'` fix on the OpeningBias panel root
was kept (harmless). REGIME's toggle pattern is the model to mirror (`activePanel` state at
`Chart.tsx:544`; button + dropdown at the `// ── REGIME ──` block; `ctrlBtn(color, active)` style
helper defined in the IIFE).

**What went wrong (the actual bug to fix):** moving `<OpeningBias>` into a button-toggled dropdown
broke it. When mounted *fresh on click* (`{activePanel==='bias' && <OpeningBias/>}`) it rendered
`null` — i.e. `computeBias` returned `gapPts===null && bar1Pos===null` in the browser, even though
the CLI proves the data is there (`/history/bars?symbol=NQ&minutes=600&interval=1` → 600 bars,
todayBars=3, bar1Pos=0.57). Switching to **always-mounted + `display` toggle** made it render
intermittently, but the user still saw "not working" / blank on repeated tries. So the root cause
is NOT the data — it's `OpeningBias`'s mount/timing behavior in the dropdown context
(barHistoryRef population? the `[symbol, barsVersion]` effect not firing/ resolving on a fresh mount
in a `display:none` parent? an HMR-stale render?). **Diagnose live in the browser** (console + React
devtools): when mounted in the dropdown, log `dbg = bars/today/histSize` and `result` to see which
is null and why, vs the always-on instance which computes fine.

**Cleanest likely fix:** keep `<OpeningBias>` exactly where it works (always-mounted, computes on
load) and only **toggle its visibility** via `activePanel` — but verify in-browser that the toggled
instance is the *same* mounted instance, not a remount. The button lives in the control bar; the
panel can render in place (top-left column) gated by `display`. Avoid conditional `&&` mount.

**Gate:** clicking OPEN BIAS reliably shows/hides the identical table the always-on overlay shows,
no label, one line per row — verified across a hard refresh and symbol switches (NQ/ES).

## 10. DDA detector — P1 band-sensitivity + shadow wiring (after P0, 2026-06-24)

**STATUS 2026-06-24: SCREEN FAILED — NO EDGE on NQ (committed a3ae93b).** Reactive swing-zone
source built (fixed the sparse-levels problem). Backtest on NQ ticks-parquet (32 days, no-lookahead,
train/test, 5pt slip, TP/SL sweep): absorption-on-retest reversal = random-walk baseline at every
bracket, confirmation AND early entry; only positive PnL is a long-drift artifact (longs +6540 /
shorts -3360 → shorts fail = not a reversal signal). Does NOT advance to forward shadow. Math/infra
(divergence/episode-tracker/swing-levels/harness, 60+ tests) retained. Items below were the pre-screen
plan — moot unless a materially different sample/regime or a different USE of the signal is pursued.
P1 band fix (item 1) already landed (977bf87). See [[project_dda_detector]] memory.

P0 done+committed (0a45294/d5d0a7a/84fdcf3): `divergence.ts` (Kyle λ/OFI/MK/CUSUM, 21 unit
tests) + `episode-tracker.ts` (8 integration tests) + 06-24 offline replay proof. See
`~/.claude/plans/cheerful-watching-muffin.md` and the `project_dda_detector` memory.

06-24 replay: **DISTRIBUTION-short PROVEN** (29800 @11:44 + 29775 @12:00 ET, conf 1.0, caught
the top ~1h before the 400pt slide).

Since-P0 (committed): **reclaim/rejection gate** (71257b6) — accum/dist now keyed on retest EXIT
direction not extreme trend, so SPRINGS (lower-low reclaim) + UPTHRUSTS (higher-high reject) are
caught (the 06-24/MHP shape was a spring the old gate couldn't see); symmetric, synthetic-tested.
**Diffusion band** (977bf87) — see item 1.

P1 tasks (NONE wired to the trader; FORWARD shadow is the gate — in-sample guilty until proven):
1. **Band estimator — FORM FIXED (977bf87), forward-validation remains.** Old `0.33×halfRange`
   conflated trend with vol → engulfed retest zones in moves. Now `band = BAND_K·σ·√τ`, σ =
   diffusionScale (robust MAD realized-vol on RETURNS, drift-free; sparse 1s sampling for micro-
   structure noise). τ = touch timescale (s), one knob; band auto-scales per-instrument/regime.
   Sweep harness `scripts/sweep_band_tau.ts`: stable plateau τ≈30-90s (band ~6-10pt NQ), default
   τ=45s on structural stability. REMAINING (sequenced):
   (a) **NQ FIRST** — backtest/screen the detector across NQ L3 history (full-size 06-16→24 +
       micros 06-02→24): measure DIST/ACC setup edge (fixed-bracket WIN/LOSS vs a random-level-
       touch NULL, stratified by day/regime) AND confirm τ=45 holds for NQ on the sweep.
   (b) **THEN extend to ES / GC / CL** — re-run the τ sweep per instrument (σ differs: ES tighter,
       CL/GC different scale/tick) and confirm τ / band behavior before enabling each.
   Forward shadow stays the gate; the backtest is a SCREEN (short history), not validation.
2. **Baseline λ measured AWAY from levels.** Current rolling baseline is contaminated by at-level
   absorption quotes (06-24 note showed "λ 332% of baseline" while clearly absorbing — the MK
   z-trend path saved it). Compute the prevailing λ from quotes outside any level band.
3. **Wire as a shadow emitter** into `l3-book-worker.ts` (source='episode', off the hot path) +
   `l3-decision-worker.ts` (new branch, returns early; confirm/veto at RS, primary at structural,
   NO override) → `l3_episode_*` tables + walk-forward (reuse the FLIP/CONT shadow shape). Regression
   check: RS touches still log to l3_trade_decisions, FLIP/CONT to l3_signal_validations, unchanged.
4. **Complementary single-event path** for sharp V-reversals / no-retest run-away breakouts (the
   episode machinery is multi-retest by design and does NOT cover these — often the biggest moves).

P2: decisiveness-gated override at non-sacred levels, ONLY after the distribution precision is
forward-proven. DD-lower never inverts (sacred — veto only).

## 11. Revamp confirm() microstructure detection — principled math (de-hardcode)

The L3 confirmation decider `apps/aggregator/src/l3/decision-engine.ts` (`confirm()`) is built on
exactly what the DDA work replaced: hardcoded weights (`C = {cvdWith:2, cvdAgainst:-3, refill:3,
sweepAgainst:-4, takeScore:4 ...}`), a magic CVD threshold (`cvdThresh:150`), and CVD-**slope**
heuristics. It also empirically over-rejects — on 2026-06-24 it called nearly every FLIP/CONT and
the live longs invalid (score 0 / skip).

Revamp with the same rigor as the DDA layer (`divergence.ts`):
- Replace CVD-slope thresholds with a principled flow measure (OFI / Kyle-λ absorption, like the DDA)
  + robust/non-parametric significance (no fixed magnitude cutoffs).
- Re-derive absorption (refill/iceberg vs pull/spoof) mechanically — measure realized price-impact,
  not displayed-size heuristics (displayed size is spoofable; realized λ is not).
- Change-point (CUSUM) for the "break forming" timing instead of the fixed cvdThresh trip.
- Re-fit / drop the magic weights; validate the verdict against outcomes (it's currently unproven).
Until then: do NOT bolt confirm() onto the DDA (would re-import the un-principled thresholds). The
DDA runs standalone on its own principled absorption signal.
