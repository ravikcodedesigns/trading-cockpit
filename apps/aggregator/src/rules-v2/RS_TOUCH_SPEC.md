# RS Level-Touch Standard — Spec v1

> Canonical definition of how the engines treat RS level touches: what a touch IS,
> approach direction, LP/IP pocket qualification, when engine checks run, how L3 is
> tracked, TP/SL, and the per-minute trade-health report.
> Authority: this doc + `Every_Single_Time_EST.png`. Status: v1 (build exact-cross
> first; expand later). Agreed with Ravi 2026-06-27. To be validated on live RTH.

---

## 0. Scope & instruments

- **RS levels only** (MHP, HP, HG, BZB, BrZT, DD-upper, DD-lower, dyn-HP/MHP, ON-HP/ON-MHP).
  Structural levels (PDH/PDL/POC/VAH/VAL/ON*) are NOT touch-traded here (snapshot-only).
- Per-instrument **point/tick**: NQ/ES tick 0.25. Distances below are in **points**.
- Proximity thresholds: **NQ < 50 pt · ES < 12 pt** (the LP/IP gate, §3).

---

## 1. Touch (the atomic event)

A **touch** = the **first exact cross** of an RS level price within a clock-minute, from
either side.

- **Exact cross** (v1): with `last` = previous observed trade price and `p` = current
  tick price, a cross at level `L` fires when `sign(last − L) ≠ sign(p − L)`, or `p == L`.
  Gaps over the level still register (signs differ). No tolerance band in v1.
- **One per (level, minute):** the first cross of `L` in minute `M` is THE touch. Every
  later re-tap of `L` within `M` is ignored — not logged, not evaluated.
- **Re-arm:** at the top of each new clock-minute, every level is eligible for one fresh
  touch again. (Minute = ET wall-clock minute bucket, `floor(ts/60000)`.)
- A touch is the ONLY thing that triggers engine evaluation (§4) and arms the L3
  tracker (§5).

> **Change vs current `l3-book-worker`:** today a touch fires on entering a ±16-tick band
> and re-arms on leaving a ±24-tick band. v1 replaces that with exact-cross,
> one-per-level-per-minute.

---

## 2. Touch Approach Direction (TAD)

TAD is set by the **open of the 1-minute candle** that contains the first touching tick,
relative to the level:

| candle open vs level | TAD |
|---|---|
| open **>** level | `FROM_UP` (price came from above) |
| open **<** level | `FROM_BELOW` (price came from below) |
| open **==** level | tie-break by the cross direction of the touching tick |

TAD is the candle-open relationship — NOT the direction of the individual crossing tick.

---

## 3. Pocket qualification — LP / IP (per `Every_Single_Time_EST.png`)

A bear-zone + bull-zone pair becomes an EST **pocket** only when the two zones are close
enough. Otherwise they are **two independent zones**, each traded by its own single-level
rule (BZB rule / BrZT rule), and the EST pocket trade does NOT apply.

### 3.1 Liquidity Pocket (LP) — bear zone BELOW, bull zone ABOVE
- **Qualify if** gap `BZB − BrZT` (bull-zone-bottom minus bear-zone-top — the inner facing
  edges) `< THRESH` (NQ 50 / ES 12).
- **EST trade:** LONG **BrZT → BZB** (slow; price "waltzes" up through the pocket).
- Entry pivot = BrZT (from below / hold-through); target = BZB.

### 3.2 Illiquid Pocket (IP) — bull zone BELOW, bear zone ABOVE
- **Qualify if** inner gap `BrZ_bottom − BZ_top` (bear-zone-bottom minus bull-zone-top)
  `< THRESH` (NQ 50 / ES 12).
  *(Inner-edge proximity is what's reliably measurable; intended.)*
- **EST trade:** LONG **BZB → BrZT** (fast). Entry pivot = BZB (bounce, outer-lower edge);
  target = BrZT (outer-upper edge). Trade spans the outer edges; qualification uses inner edges.

### 3.3 Independent zones (gap ≥ THRESH)
- BZB → its own EST/zone long-bounce rule.
- BrZT → its own rule (from below = hold-through long; from above = short iff DD<0.5 & GM bear).
- No LP/IP emitted.

> **Change vs current `est-engine.ts`:** IP is currently detected only as "next level up
> is a BrZT" with NO distance gate (line ~87). v1 adds the <50/<12 proximity gate to BOTH
> LP and IP, and the independent-zone fallback.

---

## 4. Engine evaluation — first touch ONLY

At (and only at) a first touch, run the full engine stack for that level/pocket:
DD-ratio, the three resiliences (MHP/HP/redist), gate mode (normal / strong-pivots-small /
sit-out), GM, LM-agreement, base-prob, size tier — exactly the existing engine logic.

- **NOT** re-run on every tick that crosses the level. One evaluation per qualifying touch.
- Output = the engine **thesis**: `{direction, pivot, family (EST/LP/IP/BZB/BrZT/…), entry,
  baseProb, sizeTier, gateMode}` — the candidate the L3 layer then arbitrates (§5).
- If the gate says sit-out (irrational / VX-RI / catalyst / circuit-breaker) → no thesis.

---

## 5. L3 tracking — continuous from touch → exit (NOT a snapshot)

The first touch **arms the decider** for that thesis. From that instant the L3 read runs
**live, tick-by-tick**, until the trade resolves:

1. **Arm** at the touch: open an active-tracking record for `{level, minute, thesis}`.
2. **Stream:** on every subsequent tick, recompute the order-flow read (CVD level+slope,
   native/synthetic icebergs, pull/spoof, sweep, aggressor-cluster, wall, implied-gap)
   at the level.
3. **Decide:** the decider emits a **take** or **skip** verdict for the engine thesis once
   the live flow confirms/vetoes it. (Engines own direction; L3 confirms/sizes/vetoes — it
   never flips direction. Per §23.5.)
4. **Track to exit:** once taken, keep streaming until **TP or SL** (§6) — there is no fixed
   time cap; the window ends at TP/SL.

> **Change vs current worker:** today one snapshot row per touch. v1 = a live evaluation
> window per touch (arm → stream → verdict → track-to-exit).

---

## 6. TP / SL

- **SL = 40 pt, always** (fixed).
- **TP = the nearer of {40 pt, next-closest RS level in the trade direction}.** If a
  qualifying level (HP/MHP/HG/BZB/BrZT/DD…) sits < 40 pt ahead in the trade direction, TP =
  that level; else TP = 40 pt.
- One contract ("one strike") for the standard unit.
- Outcome: **WIN** (TP first), **LOSS** (SL first) — per the no-MFE/MAE rule.

---

## 7. Per-minute trade-health report (touch → TP/SL)

While a taken trade is live, emit a **once-per-minute** status line so the trade can be
watched in real time:

| field | meaning |
|---|---|
| `min` | minutes since entry |
| `price / mae / mfe-as-excursion` | current price vs entry (running, for monitoring only — NOT the outcome metric) |
| `still_valid` | does the engine thesis still hold (level not broken against)? |
| `book_state` | order-flow read now: holding / absorbing / **reversed** / breaking |
| `cvd / cvd_slope` | current CVD level + slope vs entry |
| `dist_to_tp / dist_to_sl` | points to each |
| `verdict_drift` | would the decider still take it now? (confirm / now-veto) |

Purpose: a live "how is it holding, is it still valid, has the book reversed" feed per
open trade — not a backtest metric. (Running excursion is for monitoring; the recorded
*outcome* is still WIN/LOSS at TP/SL only.)

---

## 8. Data model (proposed — to confirm on first run)

One row per **touch** (the atomic event) + the trade lifecycle hung off it:

- `rs_touches`: `id, ts_ms, ts_et, trading_day, minute_bucket, symbol, level_label,
  level_kind, level_price, tad (FROM_UP|FROM_BELOW), pocket (LP|IP|NONE), pocket_gap_pts,
  engine_family, thesis_dir, base_prob, size_tier, gate_mode, dd_ratio, mhp_res, hp_res,
  redist_res, gm, lm_code, is_rational` — the first-touch engine snapshot.
- `rs_touch_decisions`: the L3 verdict (take/skip) + the live read at decision time.
- `rs_touch_minutes`: the §7 per-minute health rows (FK → touch).
- `rs_touch_outcome`: entry, tp, sl, exit_ts, exit_price, exit_reason (TP|SL), pnl_pts.

(Reuse the l3-shadow.db file; new tables, shadow-only — nothing wired to the trader.)

---

## 9. Open items (v1 deliberately defers)

- Tolerance-band touches (v1 = exact cross only).
- Multi-strike sizing / scale-outs (v1 = one strike, single TP/SL).
- Non-RS (structural) level touches.
- LP/IP with >2 zones (multi-zone "sandwich" stacks) — handle the 2-zone case first.
