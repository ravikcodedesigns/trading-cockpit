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
