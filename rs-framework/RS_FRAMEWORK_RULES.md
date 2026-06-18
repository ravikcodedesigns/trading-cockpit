# RS Framework — Operating Manual (synthesized from transcripts + handouts)

Synthesized 2026-06-18 from the 19 video transcripts + ~30 handout diagrams in this folder.
Purpose: a single implementation reference for interpreting price action / levels / platform
data and building the automated RS trading system.

**Reliability note:** the *framework logic* below is consistent across all source material and is
trustworthy. **Specific numeric thresholds** (RI point values, exact win-rate %s) are as stated in
the transcripts and some are approximate / vary by source — treat them as starting values and
verify against live platform data (`ddbands.ri`, `saved-resilience`, backtests) before hard-coding.

---

## 1. Core philosophy ("Blind Monkey" / edge in probabilities)

- **Markets are buoyant** — left alone they drift UP. In a bull greater-market ~70% of days close
  green; in a bear market ~50% (no edge). **Default bias = LONG** unless structure says otherwise.
- **Edge = probabilities, not prediction.** Every level has a stated bounce/break probability; you
  trade the high-probability ones repeatedly and let large numbers play out. You WILL lose ~27% of
  73%-setups — that's expected; manage with stops + sizing, never abandon a +EV setup.
- **Right place vs wrong place:** wrong from the RIGHT place (at a pivot) = small loss; wrong from
  the WRONG place (chasing) = big loss. **Only enter AT a high-volume level. Never chase.**
- **You control the loss, the market controls the gain.** Size/stop are yours; targets are the market's.

---

## 2. Greater Market (directional bias) — the master switch

Per `Greater_Market_Analysis`: **3 positional + 2 volatility** indicators.

Positional: (1) **DD ratio > 0.5**, (2) **SPY > MHP**, (3) **Monthly Map = bullish**.
Volatility: (4) **VX < BBB**, (5) **VVIX < 100**.

**Decision rule (positional): if ANY 1 of the 3 is bullish → BULL; only if ALL 3 bearish → BEAR.**
(Reflects the long-bias: it takes unanimous bearishness to be a bear.)
- BULL → trade longs as primary; shorts only as small fast scalps.
- BEAR → trade both sides.
- Volatility indicators don't set direction; they set *how* you trade (size/entries — §7).

All 5 inputs are now reachable from the platform (DD, SPY-vs-MHP via hpa, monthly map via
LIQUIDITY_MAP; VX/VVIX/BBB you supply) → `greaterMarket` can be auto-computed (backlog 6g).

---

## 3. The levels (what they are, where from, how price behaves)

All RS levels share two empirical traits: **(a) ~100% volume spike on touch** (guaranteed
reaction), and **(b) a same-side-close probability that rises with confluence.**

| Level | What it is | Behavior / notes |
|-------|-----------|------------------|
| **MHP** (Monthly Hedge Pressure) | The dominant monthly options gamma level (max dealer delta-hedging). Structural. | Same-side close ~73% base → ~90% full confluence; break ~27%. Break **>1 strike** = irrational. |
| **HP / WHP** (weekly) | Weekly gamma level (shorter-term). | ~68% base → ~80% confluence. Weaker than MHP. |
| **Bull Zone** (BZB=bottom … top) | Range where dealer **calls > puts** (net-long hedging) = support band. | Long the bottom; zone top = ceiling. Ideal-confluence same-side close ~90%. |
| **Bear Zone** (BrZT=top … bottom) | Dealer **puts > calls** = resistance band. | Short the top (needs full confluence); long the bottom (rebound, low bar). |
| **Liquidity Pocket (LP)** | Mid-range between bear-zone-top and bull-zone-bottom (most liquid). | ~90% bounce; the "favorite" trade. |
| **DD Bands** (upper/lower) | Risk-interval / margin-buffer volatility envelope around prior close. | ~88% of days stay inside; ~4% close above upper, ~8% below lower. Break = irrational. |
| **Dynamic / Overnight HP** | Pre-RTH *estimate* of where MHP/WHP will be at 09:30 (from overnight OI inference). | Acts as a real pivot overnight + into the day; same rules as HP/MHP. |
| **Gamma walls** | Raw call/put OI per strike (the structure HP/MHP are derived from). | Biggest call wall = ceiling/magnet; biggest put wall = floor. HP/MHP ARE the dominant walls; the *full ladder* is the new piece (6d). |
| **Red Line (RL)** | Illiquidity pivot: the un-retraced midpoint of a catalyst spike. Persists until touched. | 100% reaction; ~coin-flip direction → trade *to* it, close fully *at* it. |
| **Yellow Line (YL)** | Illiquidity pivot: ~99%-margin-loss level for a trapped dealer (squeeze ceiling/floor). | Same as RL — target/close-fully, don't hold through. |

**Level priority / tie-break (highest first):** Catalyst active → VX risk-interval break → MHP break
→ DD-band break → Liquidity Map → Hedge Pressure (MHP/WHP/dynamic) → gap fills/half-gap →
Resilience → single pivots. (Top 4 are SIT-OUT triggers, not entries — §7.)

---

## 4. The parameters that decide bounce vs break

**Resilience** (sign + magnitude; 3 flavors: white=redistribution/half-gap, blue=HP, orange=MHP):
- Leading gap-fill signal: compares implied stock gap-fills vs the index → which way the index
  "must" move to catch up. **>0 → upward pressure (favor longs / bounce); <0 → downward.**
- Only valid INSIDE the redistribution (open–close) zone; most sensitive near the middle.
- **On flat days ignore it** unless |value| is large; near 0 it's noise.
- Magnitude = conviction → bigger |resilience| = bigger size.

**DD ratio** (market-cap-weighted % of index stocks in bull vs bear zones):
- **>0.5 = bullish:** long zone bottoms hard; **do NOT short** the bear-zone-top (take the long
  reclaim instead). <0.5 = bearish: shorting becomes valid; longs smaller.

**Confluence stack → win-rate:** base level prob + resilience-aligned + DD-aligned + greater-bull all
compound. Full alignment = the "EST"/A+ tier (~90%); partial = medium; none = small/skip.

**Reclaim rule (critical):** if a level fails (stops you out), do NOT reverse — wait for price to
RETURN to the same level and re-enter the SAME direction. It's a fresh trade at the same odds.
Levels rarely fail >2 reclaims without an irrational structure break.

---

## 5. Setups (entry / stop / target)

- **EST ("Every Single Time"):** the highest-probability level setups (MHP bounce, BZB long,
  BrZT short with confluence, DD-band reclaim, LP bounce). Taken on every occurrence; size by
  confluence. NOT taken when an irrational/sit-out rule is active.
- **Liquidity-Pocket (LP) trade:** price enters the mid-pocket from one side → bounces to the
  opposite wall. Long from bear-zone-top side → target bull-zone-bottom (or vice-versa).
- **Illiquidity-Pocket (IP) trade:** price breaks into a thin zone (around RL/YL) → fast violent
  move → **close fully at the illiquidity pivot** (no runners).
- **Sandwich / zone-combination:** when confluence is strong, **hold through** the middle zone
  (treat the intervening bear-zone-top as "not there") from one bull zone to the next. Otherwise
  treat as two separate trades.
- **Zone-to-zone:** standard target is the next opposing wall.

**Stops = structural, not ATR:** one tick beyond the level that invalidates the thesis (below BZB,
below MHP, above BrZT). Widen proportionally with volatility (VIX/largest-1-min-candle).

---

## 6. Exits

- **Interrupts:** every past/projected high-volume level is an "interrupt" — trim there.
- **Trim rule:** low confluence / resilience-against → trim **>50%** at first interrupt; high
  confluence / resilience-with → trim less, let a runner ride.
- **Longs vs shorts:** market climbs ~3× faster than it falls → **longs = scale out gradually**
  (escalator up); **shorts = close ~80% at first interrupt, 100% at second** (fast/violent).
- **Target hierarchy:** gap fills → opposing zone wall → DD bands → MHP/HP → RL/YL (close fully) →
  liquidity-map arrow tips → VX pivots (rising VX = trim longs).
- **Cost-basis / multiple entries:** add only on retrace to a *better* pivot (a new trade, not
  averaging a loser). Break-even = entry1 + (size1/total)×(entry2−entry1). On a 50% retrace, close
  the larger add (lock ~breakeven), keep the original runner.

---

## 7. Volatility & risk (sit-outs and how to trade)

**Risk Interval (RI):** per-ticker move-size unit from CME SPAN margin (live = `ddbands.ri`, e.g.
NQ≈262). Used for: (a) DD-band width, (b) catalyst/sit-out detection, (c) position sizing.

**VIX complex:**
- **BBB** = midpoint between prior-month VX close and current-month VX open (set on VIX-OPEX,
  3rd Wed). **VIX < BBB = calm/liquid** (trade full size, tight); **VIX > BBB = illiquid** (expect
  2–3× overshoot → **split entries**: portions below/at/above the pivot).
- **VVIX** (vol-of-vol): **<90 golden, <100 ok, ≥100 elevated (size down / avoid news), ≥110 danger.**
- **Golden/elite condition: greater-market bull + VIX<BBB + VVIX<100** → blind monkey works, long
  everything at full size.

**Irrational / SIT-OUT rules (from `Irrational_Rules`):** when triggered, strong pivots that
normally work ~90% drop to ~60%.
1. **Catalyst active** = price moved **≥1 RI from the event anchor** (news/tweet) without retracing
   >50% → **absolute sit-out** until it reverts past ~50%. (Anchor detection is the hard part — 6c.)
2. **VX up ≥1 risk-interval** → absolute sit-out.
3. **MHP break (down, >1 strike)** → small only, strong pivots only.
4. **DD-band break (both bands)** → long-only, small, strong pivots only.
5. **No structure** (pivots/reclaims failing in sequence, volume dries up) → sit out.

**Position sizing:** Normal/Medium/Small/Zero by confluence × resilience magnitude; **reduce a tier
per loss** during the day; vol-adjust (wider stop in high VIX → smaller size to hold risk constant).
RI also bounds account risk (size so ~20 consecutive RI losses still leaves ~50% of account).

---

## 8. Other regime signals

- **COT (Commitment of Traders):** weekly CFTC. Dealer (red) >0 = won't crash / near a bottom;
  <0 = free to sell. Asset-mgr (green) up + leveraged (blue) down = strong rally. Dealer flipping
  neg→pos has historically marked cycle bottoms (load calls). **Monthly Maps = a daily proxy for COT.**
- **Monthly Maps:** project zones forward weeks. Bull zone sloping **down** = accumulation (stronger
  support); sloping **up** = distribution (weakening). Bear→bull crossover = rare high-conviction reversal.
- **Catalyst types:** index-level vs single-name; "event" (may retrace, watch) vs "catalyst active"
  (moved ≥1 RI, sit out) vs "non-event" (retraced to anchor, news priced in, safe to scalp).

---

## 9. Mapping the framework → our platform data (what's automatable now)

| Framework input | Our source | Status |
|-----------------|-----------|--------|
| Resilience (3) | rs-feed (`NQValues-w`/`NQMHP-w`/`NQHP-w`) | ✅ live |
| DD ratio | rs-feed (`sp-DD`) | ✅ live |
| HP/MHP, Bull/Bear zones (full), DD bands, HG, ON, QQQ | rs-levels (chart shapes) → daily_levels{,_es}.json | 🔜 RTH |
| Gamma wall ladder | `hpa.man_MHP_walls` (passive) | 🔬 6d |
| COT proxy / breadth | `eventsLog` constituent crosses + `db/nq` mcaps | 🔬 6e |
| Risk interval | `ddbands.ri` | 🔬 6c (size easy; catalyst-anchor hard) |
| Greater market | DD + SPY>MHP(hpa) + monthly map(LIQUIDITY_MAP) + VX<BBB + VVIX<100 | 🔜 6g |
| VVIX / BBB | Ravi supplies | manual |

**Reconciliation with our existing system:** the RS scorer (`rs-level-scorer.ts`) already encodes
level-proximity + DD/LM/resilience context + first-test confirmation — this manual is the spec to
align it to (and the rs-score rewrite, [[project_rsscore_rewrite]], should follow the §2–4 rules:
DD-gate the top levels, sign-based resilience, irrational ×penalty). The flip/cont detectors are
order-flow reversals/continuations; the RS levels are *where* (Carmine-style levels of interest),
and confluence (§4) is *whether*.

## 10. Caveats before hard-coding
- Verify all numeric thresholds (RI values, win-rates) against live data / backtest — transcripts vary.
- Probabilities are statistical; size + stop discipline is what makes them tradable.
- Catalyst-anchor detection (6c) and gamma-wall edge (6d/6f) and breadth (6e) are **unvalidated for
  our markets** — backtest with trap-veto discipline (train/test + permutation) before live.

Full per-theme extraction (with source citations) was done by 4 reader agents on 2026-06-18; this is
the deduped synthesis. Source files: rs-framework/transcripts/*.txt + rs-concepts-handouts/*.png.
