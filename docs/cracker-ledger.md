# Cracker — Signal & Study Ledger

> Append-only. Every study/factor run gets an entry: what was asked, how, what came back, and the decision. Format per CRACKER_PLAN.md §3.

---

## 2026-07-06 · P0.1 — Spine correctness fixes

- **Question:** is the measurement instrument (level-memory + swings + replay) trustworthy?
- **Method:** four planned fixes (Beta-posterior retirement, confirmTs, idempotency, rehydration) + a 15-check acceptance suite (`cracker_p01_accept.ts`): unit tests + two fresh 5-day replays compared byte-for-byte + same-day re-run.
- **Result:** 15/15 PASS after three additional bugs the suite itself caught: (1) replay nondeterminism from `ORDER BY ts` tie-breaking; (2) the naive canonical re-sort corrupted the book (depth updates are order-dependent within a ms — absolute sizes); (3) re-run days inherited their own levels from 09:30 (pre-confirmation). Fixed via `file_row_number` capture-sequence ordering, own-day level-birth deletes, tail-only guard.
- **Also learned:** cross-session level memory did NOT exist in the original P1 replay (fresh registry every day). It does now. 05-04/05-07 are thin partial-capture days (legitimately 0 obs).
- **Decision:** instrument certified for Phase 0.2+. Suite is a permanent regression gate. Commit `9d9d38e`.

## 2026-07-06 · P0.2 — Clock alignment, CQG(L2) vs Bookmap(L3)

- **Question:** do the two feeds' timestamps agree well enough for cross-feed joins, and by how much do they differ?
- **Method:** `cracker_p02_clock.ts` — same instrument on both sides (CQG "NQ"=MNQ vs Bookmap MNQ; MES as replication). RTH volume per 50ms bin, Pearson cross-correlation at lags ±3s, parabolic sub-bin refinement, AM/PM split for intra-day drift. Sign: positive = Bookmap late vs CQG.
- **Result:** typical offset **−5 to −50ms** (Bookmap stamps earlier), sharp peaks (peakR 0.2–0.5 vs runner-up ~0.06), MES replicates MNQ. Offset is **day-varying, not constant**: two clean days at **+90ms** (06-04, 06-08 — capture restart signature). **Junk cluster 06-24/06-25/06-26**: peakR ≈ 0.03–0.12 on BOTH symbols — feeds don't correlate at any lag; those days cannot be clock-aligned (timing matches the CL/GC wiring window). Drift flags fired almost exclusively on junk-fit days; one real AM anomaly (MES 07-02). Full per-day table: `docs/cracker-clock-offsets.json`.
- **Decision:** (1) use **per-day offsets** (never a global constant); (2) **quality gate** for any cross-feed join/study: peakR ≥ 0.15 AND intra-day drift ≤ 250ms — else the day is ineligible; (3) **06-24/25/26 excluded** from Phase 0.3/0.4 calibration studies (both symbols); (4) at our research horizons (≥1 min) the residual ≤50ms error is negligible; trade-level matching in 0.3 uses the per-day offset ± a 250ms tolerance window. STOP-flag rule per plan was triggered by junk-fit days — remedied by the quality gate rather than abandoning fine joins wholesale.

## 2026-07-06 · P0.3 — Aggressor calibration: inferred vs true

- **Question:** can L2 flow features (delta/imbalance/absorption) be trusted — i.e., how good is our aggressor classification vs Bookmap L3 ground truth (`is_bid_aggressor` on 5.1M trades/day)?
- **Method:** `cracker_p03_aggressor.ts`, two parts. Part 1 (method error, no cross-feed matching): replay the L3 book on 5 evenly-spaced usable days, classify each trade book-relatively, compare to the true flag; convention pinned empirically. Part 2 (end-to-end): per-minute signed delta from the actual L2 pipeline vs true L3 delta on all 17 usable days (per-day clock offsets applied); CQG's native flag graded alongside.
- **Result:**
  - Convention pinned: `is_bid_aggressor = true ⇔ aggressive BUY` (95.2% day-1 book agreement; matches the empirical note already in `cvd-session.ts:7`).
  - **Book-relative inference: FAILS the frozen bar.** Trade-level agreement 94.5% (✓ ≥90%) BUT degrades hard with size — 1-lot 94.9%, 5–9 73.5%, **10+ 64.1%** (sweeps execute through multiple prices) — and 28.8% of trades print inside the spread (unclassifiable → |vol| ratio ~0.85). Per-minute delta r = **0.910** mean, min 0.670 (worst on trend days) < 0.95 bar.
  - **CQG's NATIVE flag: r = −0.994 vs truth on every one of 17 days** (−0.990..−0.997) — i.e. |r| ≈ 0.994 with the true⇔BUY convention. The **"~3.5×-off CQG flag" folklore is FALSIFIED** — the flag is near-perfect; the folklore almost certainly came from reading it with the inverted sign. (Ironic: footprint.ts was built book-relative specifically to avoid this flag.)
  - **Live-code audit:** cvd-session / order-book / backtest-expl already use true⇔BUY correctly. **`morning-brief.ts:85` had it inverted** (buy/sell vols swapped in the brief) — fixed this commit.
  - Data flag: 3 of 5 Part-1 days (06-15, 06-19, 07-03) could not sustain a valid L3 book (depth present, book never two-sided) — does not affect this verdict; logged as an open item for Phase 4b (L3 institutional work).
- **Decision:** **L2 flow features CERTIFIED for the full 54-day set — via the NATIVE flag (true⇔BUY), not book-relative inference.** Footprint/Tier-2 wiring (Phase 1.5) switches its aggressor source to the flag; book-relative stays as a fallback only. Error bars: per-minute delta |r| ≈ 0.994. Book-relative method verdict stands as FAIL — do not use it where the flag exists.

## 2026-07-06 · P0.4 — Micro-vs-mini footprint agreement (the routing study)

- **Question:** we screen on micro (54-day power) and confirm on mini (institutional truth) — do the two crowds' footprints agree well enough for that to work, per feature family?
- **Method:** `cracker_p04_micromini.ts` — mini vs micro compared WITHIN the same Bookmap capture (same clock; isolates crowd difference from feed artifacts), native flag both sides, 13 clean days each pair. Metrics: per-minute delta r, per-bin profile correlation + POC distance + 70% value-area Jaccard, per-bin imbalance-category Cohen's κ. Estimation study — distributions, no pass/fail.
- **Result (NQ/MNQ · ES/MES):**
  - **Profile family: near-identical.** vol-r 0.966 · 0.956; VA-Jaccard 0.88 both; median |POC dist| 4.0pt · 0.3pt. Caveat: NQ shows **twin-peak instability** — ~5/13 days have POC distance 50–120pt (two competing HVNs; the crowds pick different peaks) while value areas still overlap ≥0.69 → use **HVN sets, not single POC**, as level sources.
  - **Delta family: correlated but attenuated.** r1m 0.799 ± 0.029 (NQ — remarkably stable) · 0.645 ± 0.115 (ES). The crowds genuinely differ minute-to-minute.
  - **Imbalance family: does NOT transfer.** κ 0.162 · 0.267 — bin-level imbalance flags are crowd-specific.
- **Decision (routing table):**
  | family | route |
  |---|---|
  | volume structure (POC/HVN/LVN/VA/zones) | **micro-OK** — screen on the full 54-day L2 set (HVN-set caveat) |
  | delta/flow | **BOTH-with-correction** — screen on micro, expect ~0.8 (NQ) / ~0.65 (ES) attenuation vs institutional truth; mini confirmation mandatory; **Phase 2.3 power table must incorporate the attenuation** (a true mini effect appears shrunk on micro) |
  | bin-level imbalances (incl. stacked) | **mini-ONLY** (L3, ~13–17 days, mechanism-grade); revisit coarser-granularity definitions if imbalance factors matter later |
- Composition with P0.3: L2-micro ≈ L3-micro at 0.994 (feed error is negligible); L3-micro ≈ L3-mini at ~0.8 (crowd gap is the dominant term). The pipeline's total distortion budget is now measured end-to-end.
- **Post-study simplification (user decision):** the routing-with-correction model is replaced by the two-line DATA POLICY (CRACKER_PLAN §1.5): L2 full history = levels & structure ONLY; L3 mini NQ = flow discovery; ES mini = replication; lockbox = next 10 forward days. No renaming of the L2 "NQ"/"ES" labels (they mean MNQ/MES — documented, not refactored).

## 2026-07-06 · P0.5 — Estimator freezes (σ_ev + size-aware imbalance z)

- **Question:** freeze the two statistical rulers before any research uses them.
- **σ_ev** (`src/l3/sigma-ev.ts`, frozen): EWMA variance of drift-stripped 1-min log returns, half-life 30 min, session-anchored (18:00 ET reset, warmup carries prior session's value), floor 0.5pt / cap 60pt, output in points per √min + σ√h horizon scaling. Units: floors the Gate-2 stop, sizes the vertical barrier, feeds the swing detector.
- **Size-aware imbalance z** (`footprint.ts`, frozen): null model = each TRADE (not contract) is a fair coin → Var(buyVol−sellVol) = Σsize², z = (a−b)/√(Σs²). Reduces exactly to the old binomial with 1-lots; a lone 36-lot block at z_naive≈5.06 now reads z≈0.89 → no fake significance from single blocks.
- **Acceptance (8/8):** synthetic-vol recovery within 2% (est 20.6 vs true 21.0pt); drift-stripping verified (10bp/min trend + 2bp noise reads 5.5pt ≈ noise, not 27pt drift); session-reset carry; floor; binomial-reduction; block-rejection; reference days sane (trend 06-05 σ 16.4pt > chop 05-29 10.7pt > normal 06-02 7.1pt).
- **Decision:** both estimators FROZEN. **PHASE 0 COMPLETE** — instrument hardened (0.1), clocks measured (0.2), aggressor certified via native flag (0.3), crowd-agreement routed → simplified to the data policy (0.4), rulers frozen (0.5). Next: Phase 1 (the trace).

## 2026-07-06 · P1 build → DATA-INTEGRITY FINDING: mbo-parquet capture order destroyed from ~06-19

- **What happened:** the full trace build produced visits only on 06-16→06-18; every later day = 0 observations (book permanently crossed, e.g. 66,377 crossed checks on 06-23 with both sides populated).
- **Diagnosis chain:** sides correct → deletions present → sanity filters remove only ~180/25M rows → **monotonicity check is the smoking gun**: on working days ts_ms is perfectly monotonic in file order (0 backward steps); on failing days **94–99% of rows sit >5s behind the running max, worst offset exactly 24h** — i.e. `file_row_number` no longer reflects capture order AT ALL. The files were rewritten/shuffled after conversion (prime suspect: the nightly parquet-compaction job; converter multi-pass writes possible too). Same-ms absolute-size depth updates replayed out of order → permanently poisoned book (the exact mechanism P0.1 identified on L2, here at full scale). Garbage contract labels (NQU6BMD, NQU6NQU6NQU6…, ~5–10 rows/day) additionally indicate converter line-tearing.
- **This retroactively explains:** P0.3 Part-1 zero days (06-15/06-19/07-03 — open item CLOSED), and plausibly the P0.2 junk cluster 06-24/25/26 (if ts VALUES are also wrong on some rows, cross-feed volume bins smear; re-run P0.2 after repair).
- **Not affected:** trades-table GROUP-BY aggregations (order-independent) — P0.3 Part-2 (per-minute deltas) and P0.4 conclusions stand. The trace ENGINE is proven working (439 visits on 06-17/18, placebos live, outcomes resolved).
- **Recovery:** raw BMD logs are INTACT for all affected days (06-19→07-06, mini + micro). Remediation plan (pending user go): (1) inspect converter + compaction for the reorder; (2) add an explicit `seq` column (log line number) so capture order survives any rewrite; (3) re-convert affected days for NQ/MNQ/ES/MES; (4) acceptance = monotonicity check + trace rebuild + P0.2 re-run on the junk cluster.

## 2026-07-06 · Capture-order repair — EXECUTED & VERIFIED (minis)

- **Root cause pinned:** `dedup_parquet_store.py` (one script, ALL symbols/tables) rewrote partitions via `SELECT DISTINCT` with a deliberate no-ORDER-BY (perf comment in code). Fixes shipped: `seq` INT64 = source-log byte offset on all three schemas (deterministic across re-reads → at-least-once dups still collapse); dedup rewrites now `ORDER BY (ts_ms, seq)` and REFUSE legacy no-seq partitions; nightly compaction DISARMED pre-03:10; live tail restarted 22:04 ET with seq (all future capture order-proof).
- **Re-conversion (minis):** NQU6+ESU6 logs 06-19→07-05 (~107 GB) → staging → **verification 78/78 partitions PASS** (zero displaced rows per source file; the initial 07-02 "failure" was a verifier artifact — midnight-boundary spillover puts two logs in one date partition and their byte-offset seqs collide; replays sort (ts_ms, seq) and are immune; verifier now partitions by filename). Swapped into the live store; originals quarantined (`.corrupt-order-quarantine`, 4.3 GB).
- **BONUS FINDING — the old dedup also ATE real trades:** staging carries **+1–5% more trades** than the original store (NQ ~+1.2%, ES ~+3–5%): full-row DISTINCT merged legitimate identical trades (two 1-lot fills, same ms/price/flags). The code's "verified safe for trades" claim was false. All trades-based historical numbers were slightly undercounted; seq makes rows unique and recovers them.
- **Trace rebuild = repair PROVEN:** 439 visits/2 days → **4,312 visits/12 clean days** (06-19 97, 06-22 368, 06-23 262, 06-24 349, 06-25 628, 06-26 383, 06-30 335, 07-01 535, 07-02 826, 07-03 90). Remaining zeros = Sundays + thin 06-16 + live 07-06 (re-converts after 07-07 close).
- **Baseline at scale (the wall P3 must beat):** hold rates — swing 0.665, placebo-random 0.654, placebo-shifted 0.661, round 0.669. **Raw hold-rate carries ZERO level-identity information.**
- Pending: micro re-conversion (in flight) → swap → P0.2 clock-study re-run on 06-24/25/26 → prove order-safe dedup on one day → re-enable compaction. CL/GC = BACKLOG item 16.

## 2026-07-07 · Repair completed: micros swapped, dedup proven order-safe, compaction re-enabled — and one hypothesis FALSIFIED

- **Micros re-converted & swapped:** MNQU6+MESU6 (~220 GB) → all partitions PASS (zero displaced per source file; trades +1.7–2.6% recovered) → 80 partitions swapped; quarantine now 12 GB total (160 partitions preserved).
- **HYPOTHESIS FALSIFIED — the P0.2 junk cluster was NOT the shuffle.** Re-run on repaired data: 06-24/25/26 remain uncorrelatable (peakR 0.03–0.10). Correct in hindsight — P0.2 used order-independent GROUP-BY binning, so row order never touched it. Those days have a genuine timestamp-VALUE problem on the Bookmap side (window coincides with the addon exchange-time migration, BACKLOG #13). Their exclusion from fine cross-feed joins stands, now with the right cause attached. All other days: offsets stable (MES σ 24ms).
- **Order-safe dedup PROVEN on live data:** ran on all 18 of 07-07's partitions — compacted outputs ts-monotone in file order (12/12 checked PASS); the 3.1% removed = true at-least-once duplicates from the 22:04 converter restart (same line ⇒ same seq ⇒ collapsed), while legitimate identical trades survive (different seq). Both dedup behaviors correct simultaneously.
- **Nightly compaction RE-ENABLED** (order-safe; refuses legacy no-seq partitions). Remaining tail: re-convert 07-06 after today's close (its partition is mixed pre/post-fix); CL/GC = BACKLOG 16.
- **Net state:** the L3 store is order-proof end-to-end — capture (raw logs) → conversion (seq) → compaction (ORDER BY + seq-gate) → verification tooling in repo. Discovery dataset: 12 clean days + every day forward.

## 2026-07-07 · P1.6 — Kernel volume profile: HVN/LVN sources, confluence, structural 1R (first primitive rebuilt under the rebuild directive)

- **Question:** complete Phase 1.6 — Tier-1 volume levels (kernel-smoothed profile → POC/HVN/LVN as level sources), confluence score, and the FINAL frozen 1R stop (LVN-structural term replacing the interim σ-only rule).
- **Method:** new Cracker-owned module `src/l3/volume-profile.ts` (built from first principles, not a copy-edit of legacy code):
  - Weighted Gaussian KDE of volume-at-price on the exact tick histogram. Bandwidth = **Improved Sheather-Jones** (Botev–Grotowski–Kroese 2010, DCT fixed-point) with **Kish n_eff** = (Σs)²/Σs² as the sample size (blocky prints widen h — same principle as the frozen P0.5 imbalance z); weighted-Silverman fallback, method always reported.
  - **Structural bandwidth floor 2.0pt (NQ)**: probed 3 reference days — raw ISJ (h≈0.6pt, MISE-optimal at n_eff~2·10⁵) fragments single shelves into 13–16 "HVNs" (six inside one 60pt shelf); the plan-frozen ≈2pt scale yields 7–12 cleanly separated shelves; 4pt merges real ones. h = max(ISJ, 2pt) — selector still adapts UPWARD on thin sessions. Floor is per-instrument (ES value set at Phase 1.7).
  - HVN/LVN = topographic-**prominence**-qualified extrema (≥10% of peak density; edge-artifact zone excluded); HVN SET kept per the P0.4 twin-peak caveat, POC = global max, first of the set. Value area 70% computed as descriptive convention only.
  - Trace wiring: prior-VALID-session profile (walk-back ≥50k contracts RTH — Monday reads Friday, thin 06-19-style holidays skipped) → `hvn`/`lvn` level sources, causal by construction. `confluence_n` = distinct structural sources among OTHER active levels within ±5pt at visit OPEN (self excluded → placebos measured with the same yardstick; placebos never contribute, `round` does). **1R finalized per direction**: max(1 tick beyond nearest prior-session LVN behind the level within 5×σfloor, σ_ev·√15); vertical barrier T = 2·(1R/σ_1m)² min capped 60 (floor-1R reproduces the interim 30min exactly); `stop_src_l/s` records which term bound. Polarity history = derivable from the interactions `side` sequence (no schema change). Trace schema v3 (regenerable; full rebuild).
- **Acceptance:** `cracker_p16_accept.ts` **24/24 PASS** — synthetic ground-truth recovery (bimodal/trimodal modes tick-exact, valley LVNs, no spurious extrema), determinism, ISJ<Silverman on multimodal, Kish monotonicity on thin samples (h 4.18→8.77pt as n_eff 745→62), clamp/degenerate guards, structural-stop geometry (5 cases), 3 real-day structure sanity. **P0.1 regression gate re-run after the src/l3 edits: 15/15 PASS**, twin 5-day replays byte-identical.
- **Result (full rebuild, 12 clean days):** 5,200 visits (was 4,312; +888 = the new hvn/lvn levels). Hold rates: swing 0.665 (baseline REPRODUCED exactly), placebo-random 0.654, placebo-shifted 0.661, round 0.669, **hvn 0.668, lvn 0.679** — raw hold rate at volume levels sits in the placebo band too, extending the P1 conclusion: NO level source carries identity in raw hold rate; discrimination must come from Phase-2 features. Structural stop engaged on 17% of visits (avg 1R 105pt vs 74.8pt floor). Confluence distribution 0:2101 · 1:2140 · 2:782 · 3:157 · 4:20. Days 07-05/06/07 = 0 obs (Sunday + pending re-conversion + live day), expected.
- **Decision:** Phase 1.6 COMPLETE; volume-profile module certified as Cracker instrument code. Outcome columns now carry the FINAL 1R definition — Phase-2 factor tests consume these, never the interim ones. Remaining Phase 1: 1.4 context columns, 1.7 ES trace. Deferred, pre-registered as ideas only: shifted-HVN placebo if volume-level factors reach Phase 3; developing (intraday) profile as an alternative LVN basis.

## 2026-07-07 · P1.4 — Context columns (tod phase · NQ–ES common factor · morning IV)

- **Question:** complete Phase 1.4 — the stratification columns the plan pre-registered: time-of-day phase, minimal NQ–ES common-factor state, expected-range conditioning (the validated IV→range forecaster input). Day dir-ratio already existed in `day_context`.
- **Method:** pure functions in `trace.ts` (`todPhase`, `commonFactor`) + idempotent `resolveContext` pass → new `visit_context` table + `morning_iv` on `day_context`. NO book replay needed — the pass joins existing visit rows against 1-min closes of OUR two feeds, so it ran as a backfill (`cracker_p14_context.ts`) over the standing 12-day trace; the runner also executes it for every future day. Frozen definitions:
  - `tod_phase`: open [09:30,10:30) · close ≥14:30 · mid between (ET).
  - `es_agree`: fraction of the 6 non-overlapping trailing 5-min log returns where sign(NQ)=sign(ES), pairs with a zero return excluded, null if <4 valid pairs.
  - `rs_30m_bp`: 30-min log-return differential (NQ−ES)×10⁴.
  - `morning_iv`: mean NDX ATM-IV 09:30–10:00 ET from the quantdata store (cache-first, fetch-and-persist on miss). Stored RAW — conditioning is rank-based; fitting an IV→points calibration would add an estimated parameter for nothing.
  - **Knowledge times documented per column** (close-ts / close-ts / 10:00 ET / 16:00 for dir_ratio): these are STRATIFICATION columns, not entry features; Phase-2+ tests must respect the stamps.
- **Acceptance:** 12/12 PASS — units (phase boundaries; agreement 1/0 on co-/anti-moving synthetic tapes; rs exact to 1e-9; <4-pairs→null; **causality: appending future bars leaves the window unchanged**; zero-return exclusion) + integration (one context row per visit 5,200/5,200; idempotent re-run; es_agree avg 0.877 null 0%; rs avg −8.8bp null 0%; phases open 1,543 / mid 2,778 / close 879; morning_iv 11/13 days, IV 29.9–54.1%).
- **Two nulls chased to ground, not waved off:** 06-19 = Juneteenth (options closed — correct null); 07-03 = vendor 422 "data unavailable" for the half-session (verified live). 07-06 was initially missed because the backfill looped visit_features days only — a 0-visit day still owns a day_context row; fixed (union with day_context) and its IV fetched (405 buckets).
- **Decision:** Phase 1.4 COMPLETE. Remaining Phase 1: 1.7 ES trace. es_agree averaging 0.877 confirms the two feeds are measuring the same market (a sanity mirror of P0.4's delta-family r); rs_30m and phase splits now available to every Phase-2 factor test.
