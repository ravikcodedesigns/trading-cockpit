# RS Level Auto-Trader — Engine Spec (Phase 0)

> Build spec for the RS-framework level engine. Source of truth for the framework
> logic is `rs-framework/RS_FRAMEWORK_RULES.md` (+ the concept PNGs). This doc is
> the *implementation* contract: data sources, schemas, rule-tables, phased plan.
> Status: Phase 0 (foundations). All numeric thresholds tagged ⚠️ verify-live.

## 0. Principles (non-negotiable)

- **Shadow-first, forward-validated.** Gamma/resilience/zone data is NOT backfillable,
  so we cannot backtest this. Every rule is shadow-logged and validated forward on real
  sessions before it influences anything. (Same data-wall that killed the bar-feature studies.)
- **Consume the platform passively.** Read only what the RS debug-Chrome has already
  rendered (CDP `Runtime.evaluate` — a local DOM/JS read). NEVER originate API calls,
  replay tokens, or trigger reloads.
- **No live orders without per-order confirmation.** Engine emits *decisions/signals*;
  order placement stays gated (CLAUDE.md hard rule).
- **Confluence, not a kitchen sink.** Edge = level × regime × resilience confluence,
  realized over large N. Size to the odds; never chase; never fade a bull market.

## 1. Architecture — the decision stack

Every evaluation is five ordered layers. Layer 0 overrides everything below it.

| Layer | Question | Inputs |
|---|---|---|
| **0. Global SIT-OUT gate** | Is structure broken? | irrational panel (read) + VX>BBB&VVIX>100 + circuit-breaker proximity; *catalyst & VX-RI parked* |
| **1. WHERE** | Which high-volume pivot is in play? | zones, HP/MHP, DD bands, dynamic HP/MHP, half-gap, ON HP/MHP, RL/YL(later) |
| **2. WHETHER** | Long/short, bounce/break? | GM → resilience(×3) → DD ratio; reclaim-vs-retest |
| **3. HOW MUCH** | Size? | N / M(½) / S(1/10) / **0**; EST never returns 0 |
| **4. EXIT** | Where to trim? | interrupts (every opposing pivot), VX pivoting up |

**Two distinct "don't trade" mechanisms (do not conflate):**
- **Global sit-out** (Layer 0) — market-wide halt; overrides all setups.
- **Leg size `0`** (Layer 3) — a single LM-Summary leg resolves to no-position under its
  conditions; other setups may still fire. EST legs can only be N/M/S.

## 2. Data contract — every input → source

Native scale of the RS analytics is **ETF** (options trade on ETFs/index, not futures).
Futures = `ETF × ratio`; the platform already exposes futures-scale "now" levels too.

| Input | Source (current) | Source (better, Phase 1) | Scale |
|---|---|---|---|
| Live price | `ticks.db` / aggregator feed | `MASTER_TABLE.data.<ETF>.Price` | fut / ETF |
| 9:30 open (black diamond) | `ticks.db` first RTH tick | `…​.LastOpen` | fut / ETF |
| Prev close | `daily_levels` | `…​.PrevDayClose` | fut / ETF |
| Half-gap | `daily_levels` (HG) | `…​.MidGap` | fut / ETF |
| HP / MHP | `daily_levels` + `NQHPNOW`/`SPHPNOW` globals | `…​.man_HP` / `…​.man_MHP` (stamped 09:30 ET, held all day) | fut / ETF |
| Dynamic/overnight HP/MHP | — | `window.DYN_HP.<sym>` `{hp,mhp,close}` | ETF |
| Bull/Bear zones (bands) | `daily_levels` (rs-levels chart shapes) | — (keep) | fut |
| DD bands (upper/lower) | `daily_levels.ddBands` | — (keep) | fut |
| DD ratio | `rs-context.ddRatio` (`sp-DD`) | — | ratio |
| Resilience white/blue/orange | `rs-context.bySymbol.{redist,hp,mhp}` | — | −100..+100 |
| LM code | `rs-context.lmCode` (`.liq-map-image-text`) | `…​.BBrMr`+`LS`+`UD`, `CPbook`/`OPbook` | code |
| Greater Market | `rs-context.greaterMarket` (computed) | — | bull/bear |
| Monthly-Map bias | `rs-context.mmBullish` (1D flip) | `…​.monthly_map` | bull/bear |
| VX / VVIX / BBB | `rs-context.{vx,vvix,bbb}` (vx-poller + manual) | — | level |
| VX gamma HP/MHP | `rs-context.vxGamma{Hp,Mhp}` (`DYN_HP.VX`) | — | UVXY |
| **ON HP/MHP** | **manual — supplied in Discord pre-session** → `daily_levels` additionalLevels | (not auto-read) | fut |
| **Irrational/Unusual states** | **NEW** — `.rules-container .rule-item` | — | state |
| Gamma-wall ladders | — | `…​.man_HP_walls` / `man_MHP_walls` | ETF strikes |
| Catalyst / VX-RI | **parked** (runtime hooks only) | — | — |

### 2a. Irrational/Unusual panel read (NEW — confirmed via audit)

`document.querySelectorAll('.rules-container .rule-item')` → per row:
- `.rule-name` text → e.g. `/EP DD-Band Break`, `/ENQ DD-Band Break`, `/RTY DD-Band Break`,
  `SPY MHP Break`, `QQQ MHP Break`, `IWM MHP Break`, `UVXY MHP Break`; Unusual:
  `Index Divergence`, `UVXY Bull Zone Bottom`.
- **state** = class: `status-green` (none) / `status-yellow` (caution, returned) / `status-red` (active).
- **direction** = `.direction svg path[d]`: up `"M4 10l3.5-5 3.5 5H4z"` / down `"M4 6l3.5 5L11 6H4z"` / none.
- Priority across indices: **S&P (/EP,SPY) > NASDAQ (/ENQ,QQQ) > Russell (/RTY,IWM)**.

### 2b. The 5 irrational ACTION rules (we encode; states are read)

1. DD-Band break (both bands) → **S, long-only, strong-pivots-only**.
2. MHP break **down** → **S, strong-pivots-only** (incl. MHP itself on the reverse).
3. MHP break **up** (UVXY) → **trade smaller** (vol increasing).
4. Catalyst Active **down** any index → **sit out** (parked detection).
5. VX up 1 RI → **sit out** (parked detection).

Strong-pivot whitelist when irrational = {MHP, BZB, BrZT, DD-band, RL/YL}.

## 3. Schemas

```ts
type SizeTier = 'N' | 'M' | 'S' | '0';            // 0 = no-position leg (not EST)
type Dir = 'long' | 'short';
type GateMode = 'normal' | 'strong-pivots-small' | 'sit-out';

interface MarketState {
  symbol: 'NQ' | 'ES';
  tsET: string;
  price: number; open: number; prevClose: number; halfGap: number;
  levels: {                          // futures scale
    bzb: number[]; brzt: number[];   // bull-zone bottoms / bear-zone tops
    hp: number; mhp: number;
    dynHp: number; dynMhp: number;   // overnight estimate
    onHp?: number; onMhp?: number;   // manual, pre-session
    ddUpper: number; ddLower: number;
  };
  lmCode: string;                    // e.g. BLU / BLD / MR …
  confluence: {
    gm: 'bull' | 'bear';
    ddRatio: number;                 // >0.5 bull
    resWhite: number; resBlue: number; resOrange: number;  // −100..+100, sign=dir
    mmBullish: boolean;
    vx: number; bbb: number; vvix: number;
  };
  gate: { mode: GateMode; reasons: string[];
          irrational: Record<string, {state:'red'|'yellow'|'green'; dir:'up'|'down'|null}>; };
}

interface Decision {
  symbol: 'NQ'|'ES'; tsET: string;
  gate: GateMode;
  setups: Setup[];                   // candidate setups that fired this tick
}
interface Setup {
  family: 'EST'|'LM'|'ZONE'|'DDBAND'|'RDZ';
  pivot: string;                     // 'MHP' | 'BZB' | 'LP' | …
  level: number; direction: Dir;
  sizeTier: SizeTier;
  entry: number; stop: number; targets: number[];
  bounceVsBreak: 'bounce'|'break'|'reclaim'|'hold-through';
  baseProb: number;                  // framework stated, ⚠️ verify-live
  confluenceNote: string;
}
```

## 4. Rule-table — EST core (Phase 2 MVP)

EST = take **every single time** unless the global gate fires; confluence only sizes it
(N/M/S, **never 0**). Stop = 1 strike below last entry (NQ 40 / ES 10), vol-widened to the
largest 1-min candle of the last hour. Targets = next interrupt. ⚠️ size cells verify-live
against `Every_Single_Time_EST.png` + `Light_2`.

| Pivot | Dir | Entry | Size matrix | Base prob | Notes |
|---|---|---|---|---|---|
| **MHP bounce** | long | at MHP | N if resOrange>0 · S/M if resOrange<0 | 73% (90% full) | reclaim = chase at level, no retest |
| **Lower DD band** | long | at band (reclaim) | N if DD>0.5 · M if DD<0.5 | 92% close-above | full exit at band, no runner; never short below |
| **BZB** (bull-zone bottom) | long | at BZB | N if DD>0.5 · M if DD<0.5 | ~90% | bounce, not pass-through |
| **BrZT** (bear-zone top) | long(hold)/short | from below → **hold-through** · from above short only if DD<0.5 | N(hold) · short N if DD<0.5 / 0 if DD>0.5 | ~90% | often waltzes through |
| **LP** (liquidity pocket) | long | at BrZT side → BZB | N if DD>0.5 · S if DD<0.5 | ~90% | slow; bread-and-butter |
| **IP** (illiquidity pocket) | long | at BZB → BrZT | N if DD>0.5 · M if DD<0.5 | ~90% | fast; the runner |

**Reclaim engine:** on stop-out at an EST level, re-arm the same-level entry on price
return (same stop); chase at level (no retest); track consecutive-fail count (kill ≈ 2, up to 4 rare).
**Break vs reclaim:** *reclaim* = opened above level, returned → chase. *break-into-new-territory*
= opened below / breaking out → wait retest + small.

## 5. Rule-tables — later families (outlines)

- **LM Summary (Phase 3)** — `Light_1`: keyed by LM code (zone B/Br + HP side L/S + HP-vs-MHP U/D)
  → legs (1a/1b, V-reversals, shorts) → per-leg {conditions, arrow=entry/exit, size incl `0`}.
  EST = the high-confidence subset that must agree. SPY empirical odds (verify): BrSD→80% BrZT,
  BLD→72.4% BZB, MR open<WHP→70% BZB / open>WHP→50/50.
- **Zones full (Phase 4)** — `Light_15`: sandwich hold-through (BZB→BZB through a middle bear zone),
  BZB-is-a-bounce (exit+confirm), reclaim-vs-retest.
- **DD Bands full (Phase 5)** — `Light_4`: 88% inside / 4% above / 8% below; repulsive magnet;
  float off the opposite band to DD bias; upper band = longs-only/S/strong-pivots, no shorting;
  break = irrational; full-exit target.
- **RDZ (Phase 6)** — `Light_10/11`: open/half-gap/close pivots, white-resilience tiebreak
  (valid only when rational, ignore on flat days <1 strike unless |res|>50), gap-fill targeting.
  Doubles as the primary EXIT-target engine.

## 6. Sizing / stops / exits

- **Asymmetry:** long steps N→M→S as confluence drops (never skip); short needs unanimous
  confluence or sit out ("no maybe short").
- **Stops:** 1 strike below last entry (NQ 40 / ES 10). VX>BBB → split entries around the
  pivot down to the vol-overshoot (largest 1-min candle/hr); VX<BBB → single tight entry.
- **Exits = interrupts:** trim ≥half by default; longs stage out, shorts dump 80%@1st/100%@2nd;
  VX pivoting up → trim longs; UVXY tagging its bull-zone-bottom = lit fuse.
- **Multi-entry/cost-basis:** add bigger at the better pivot, close adds on return to BE,
  keep original as runner; sequence planned up front (not revenge).

## 7. Phased plan

| Phase | What | Status |
|---|---|---|
| **0 — Foundations** | data audit (✅), this spec + rule-tables + schemas, `RS_FRAMEWORK_RULES` v2 | in progress |
| **1 — State deriver** | `deriveMarketState()` (LM code, levels, confluence, gate). **+ validate `MASTER_TABLE` vs current reads live during RTH, then migrate the backbone onto it** (keep proven readers for any field that disagrees) | next |
| **2 — EST core (MVP)** | encode §4 table; shadow-log decisions | |
| **3 — LM Summary** | §5 LM table on the code | |
| **4 — Zones + sandwich + bounce/break** | §5 zones | |
| **5 — DD Bands (full)** | §5 DD bands | |
| **6 — RDZ / half-gap / gap-fill** | §5 RDZ (+ exit engine) | |
| **7 — Shadow harness** (cross-cutting from P2) | decision log → DB, WR by setup/tier vs framework stats, cockpit panel | |
| **8 — Paper → live (gated)** | only after shadow stats hold; per-order confirmation | |

## 8. Open verifications (before hard-coding)

- ⚠️ EST size-matrix cells vs `Every_Single_Time_EST.png` (live re-read).
- ⚠️ `MASTER_TABLE` fields == current reads (Phase 1, live RTH): `man_HP`=chart HP,
  `BBrMr`+`LS`+`UD`/`CPbook`=our `lmCode`, `MidGap`=HG, `LastOpen`=open.
- ⚠️ RI is dynamic per contract → use live `ddbands.ri`; bind resilience by semantics
  (white=RDZ / blue=weekly-HP / orange=MHP), not color.
- Catalyst-anchor + VX-RI detection: parked (runtime gate hooks only).
