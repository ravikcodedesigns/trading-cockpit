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
