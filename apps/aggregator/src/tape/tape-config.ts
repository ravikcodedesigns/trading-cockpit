// TAPE detection configuration — the single home for every detector threshold AND every feature
// kill-switch. Moved out of tape-engine.ts (2026-07-15 audit rebuild) so config is reviewable in
// one place and each upgrade can be disabled independently without code changes.
//
// ── FEATURE FLAGS (`TAPE_FEAT`) ────────────────────────────────────────────────
// Every behavior added by the 2026-07-15 detector audit sits behind a flag. Flags default ON
// (the audited behavior is the new standard); set the env var to `0` to fall back to the
// pre-audit behavior for that one feature. Example: `TAPE_FEAT_AGGR_AGG=0` restores the legacy
// per-print block + time-gap sweep chaining.
//
// ── THRESHOLDS (`TAPE_CFG`) ────────────────────────────────────────────────────
// Per-kind floors come from the SHARED `TAPE_FLOORS` (same values the cockpit UI defaults +
// clamps to). Env vars can only be used to raise them for experiments.

import { TAPE_FLOORS } from '@trading/contracts';
import type { Symbol as Sym } from '@trading/contracts';

export const num = (k: string, d: number): number => (process.env[k] != null ? Number(process.env[k]) : d);
const flag = (k: string): boolean => {
  const v = process.env[`TAPE_FEAT_${k}`];
  return v == null ? true : !(v === '0' || v.toLowerCase() === 'false');
};

// One switch per audit upgrade. Names match the audit tranches (HANDOFF §29.8 + industry-gap pass).
export const TAPE_FEAT = {
  aggrAgg:      flag('AGGR_AGG'),       // block/sweep unified on aggressor_order_id (a 100-lot market
                                        //   order prints as several fills; per-print detection undercounts)
  spoofIntent:  flag('SPOOF_INTENT'),   // spoof requires near-touch + opposite-side execution + repetition
                                        //   (the regulatory intent tests) instead of "any big fast pull"
  wallPersist:  flag('WALL_PERSIST'),   // wall must REST ≥ persistMs before it can register (flashed size
                                        //   is flicker — same bug class fixed for icebergs)
  wallRelFloor: flag('WALL_REL_FLOOR'), // wall floor = K × median near-touch level depth per symbol
                                        //   (E0.2: flat 100 ≈ noise on ES, unreachable meaningfully on NQ)
  wallPulled:   flag('WALL_PULLED'),    // depleted-without-consumption walls emit state 'pulled', not 'break'
  absSigGate:   flag('ABS_SIG_GATE'),   // absorption requires λ STATISTICALLY below the collapse line
                                        //   (point estimate + 2·SE), not a noisy point estimate alone
  mlOfi:        flag('ML_OFI'),         // OFI integrated over the top K book levels (Cont–Cucuringu–Zhang)
                                        //   instead of best-quote-only (CKS 2014)
  todBaseline:  flag('TOD_BASELINE'),   // absorption λ baseline per time-of-day bucket (λ is U-shaped
                                        //   intraday; one EWMA mislabels the open)
  absLevelAnchor: flag('ABS_LEVEL_ANCHOR'), // absorption anchors at the defended price extreme, not mid
  midProxy:     flag('MID_PROXY'),      // held/away + trapped/unfinished current-price = mid-quote (doesn't
                                        //   stall on quiet tape); trade-through tests still use last trade
  confFamilies: flag('CONF_FAMILIES'),  // confluence counts FAMILIES once (iceberg+absorption+wall at one
                                        //   level = the same phenomenon, not 3 signals)
  confTiers:    flag('CONF_TIERS'),     // confluence weights scale by calibrated size-percentile tier
  confDecay:    flag('CONF_DECAY'),     // confluence contributions decay with age inside the window
  confStruct:   flag('CONF_STRUCT'),    // confluence annotates structural-level proximity (F5b conditioning)
  confDistThrottle: flag('CONF_DIST_THROTTLE'), // throttle by DISTANCE to last fire (bucket keys have
                                        //   boundary artifacts: 1 tick apart can straddle two buckets)
  brokeFlip:    flag('BROKE_FLIP'),     // a BROKE iceberg feeds the ATTACKER's direction into confluence
                                        //   (a broken bid-iceberg is bearish evidence, not bullish)
  calFloors:    flag('CAL_FLOORS'),     // flow/imb confluence thresholds from calibrated per-symbol
                                        //   distributions when available (80/150 were guesses)
  sweepTimerClose: flag('SWEEP_TIMER_CLOSE'), // close a sweep run on the clock, not only on the next trade
  // ── Confluence V2 (2026-07-15, the decision-grade rebuild — user: the star is an ACTION-AREA
  //    decider, not a reference marker). Layered ON TOP of the family scorer:
  confV2:       flag('CONF_V2'),        // evidence-CLASS gate: ≥1 PASSIVE (resting capital: held
                                        //   iceberg / absorption / wall-hold / book-imb) AND ≥1 ACTIVE
                                        //   (taker initiative) aligned — one aggressor burst can light
                                        //   3 families but never both classes (the 03:14 star); broke/
                                        //   break events vote AGGRESSION (their info = takers won);
                                        //   opposition-ratio abstention in contested zones; F5b gate:
                                        //   at structure PASSIVE must include an aligned level-defense
                                        //   kind or the star abstains
  confConfirm:  flag('CONF_CONFIRM'),   // a qualifying zone is PROVISIONAL for confirmMs and emits
                                        //   only if it still qualifies AND price hasn't left — an
                                        //   action area must survive first contact
  confConflict: flag('CONF_CONFLICT'),  // tag stars that REVERSE a recent opposite star in the
                                        //   zone as `flip` (chart strikes the superseded star;
                                        //   labeler scores flip vs unopposed cohorts separately)
  stopRun:      flag('STOPRUN'),        // stop-run detector: breach of a stop-pool reference + a
                                        //   cascade of DISTINCT aggressor ids (stops are independent
                                        //   market orders; one institutional sweep is one id)
  srHawkes:     flag('SR_HAWKES'),      // Hawkes self-excitation gate on cascade qualification:
                                        //   the aggressor-ARRIVAL burst ratio λ̂fast/λ̂slow must
                                        //   exceed minBurst (a cascade is events causing events —
                                        //   Filimonov–Sornette reflexivity, streaming form). The
                                        //   gate never binds before the baseline matures.
} as const;

export const TAPE_CFG = {
  block:   { minSize: num('TAPE_BLOCK_MIN', TAPE_FLOORS.block.size) },
  sweep:   {
    minLevels: num('TAPE_SWEEP_LEVELS', TAPE_FLOORS.sweep.levels),
    minSize: num('TAPE_SWEEP_MIN', TAPE_FLOORS.sweep.size),
    gapMs: num('TAPE_SWEEP_GAP_MS', 100),
  },
  spoof:   {
    minSize: num('TAPE_SPOOF_MIN', TAPE_FLOORS.spoof.size),
    maxLifeMs: num('TAPE_SPOOF_LIFE_MS', 4000),
    // intent tests (feat.spoofIntent) — what separates spoofing/layering from MM re-quoting:
    nearTicks: num('TAPE_SPOOF_NEAR', 20),        // must be VISIBLE: within N ticks of its side's touch at post
    minOppExec: num('TAPE_SPOOF_OPP_EXEC', 1),    // ≥ N contracts EXECUTED on the opposite side during its life
                                                  //   (the canonical tell: the fake pressures fills the other way)
    minRepeats: num('TAPE_SPOOF_REPEATS', 2),     // ≥ N qualifying pulls same side/zone inside repeatWinMs
    repeatWinMs: num('TAPE_SPOOF_REPEAT_WIN', 60_000),
    repeatZoneTicks: num('TAPE_SPOOF_REPEAT_ZONE', 8),
  },
  // SYNTHETIC iceberg = a discrete EPISODE of hidden-liquidity defense at one price+side (NOT a
  // rolling metric, NOT session-cumulative). Two independent tests must both pass:
  //   QUALIFY — ≥ minRefills FILL-CONFIRMED machine-latency refills: a fresh order posted at the
  //             level within refillMs of the fill that depleted it, which then TRADED itself.
  //   SIZE    — hidden reserve = traded during the episode − PEAK PERSISTENT displayed.
  // LIFECYCLE — provisional 'active' emits while defended → final 'held' or CONFIRMED 'broke'.
  iceberg: {
    refillMs: num('TAPE_ICE_REFILL_MS', 500),
    minRefills: num('TAPE_ICE_REFILLS', 4),
    // minHidden is PER-SYMBOL — episode hidden sizes scale with book thickness. Calibrated over
    // 19 RTH parquet days (calibrate_tape.ts, episodic): NQ p80=7 p95=20 p99=44 · ES p80=15 p95=54
    // p99=123; hidden p50=0 on BOTH (the hidden test is the real discriminator). Defaults ≈ p90.
    minHidden: {
      NQ: num('TAPE_ICE_HIDDEN_NQ', num('TAPE_ICE_HIDDEN', 12)),
      ES: num('TAPE_ICE_HIDDEN_ES', num('TAPE_ICE_HIDDEN', 30)),
    } as Record<Sym, number>,
    persistMs: num('TAPE_ICE_PERSIST_MS', 400),
    leaveTicks: num('TAPE_ICE_LEAVE_TICKS', 3),
    leaveMs: num('TAPE_ICE_LEAVE_MS', 15_000),
    breakTicks: num('TAPE_ICE_BREAK_TICKS', 3),
    breakMs: num('TAPE_ICE_BREAK_MS', 4_000),
    idleMs: num('TAPE_ICE_IDLE_MS', 120_000),
    emitMs: num('TAPE_ICE_EMIT_MS', 750),   // live-update throttle: exec/queue/hidden changes re-push the marker
  },
  // NATIVE iceberg = a SINGLE order_id whose cumulative fills exceed the largest size it ever displayed.
  icebergNative: { minHidden: num('TAPE_ICE_NAT_HIDDEN', 10), minCum: num('TAPE_ICE_NAT_CUM', TAPE_FLOORS.iceberg.size) },
  // Absorption = significant net order flow (|ΣOFI| ≥ minFlow) whose price impact (Kyle's λ over a
  // rolling best-quote window) is collapsed vs the running baseline — and (feat.absSigGate) collapsed
  // SIGNIFICANTLY: λ + sigK·SE(λ) must clear the line, so a noisy near-zero estimate can't fire.
  absorption: {
    winMs: num('TAPE_ABS_WIN_MS', 4000),
    minQuotes: num('TAPE_ABS_MIN_Q', 15),
    minFlow: num('TAPE_ABS_MIN_FLOW', TAPE_FLOORS.absorption.size),
    collapse: num('TAPE_ABS_COLLAPSE', 0.4),
    sigK: num('TAPE_ABS_SIG_K', 2),          // CI half-width in SEs for the significance gate
    ewma: num('TAPE_ABS_EWMA', 0.03),
    throttleMs: num('TAPE_ABS_THROTTLE', 4000),
    ofiDepth: num('TAPE_ABS_OFI_DEPTH', 5),  // top-K levels per side for multi-level OFI (feat.mlOfi)
  },
  stacked: {
    ratio: num('TAPE_STACK_RATIO', 3.0),
    minLevels: num('TAPE_STACK_LEVELS', TAPE_FLOORS.stacked.levels),
    minVol: num('TAPE_STACK_MINVOL', TAPE_FLOORS.stacked.size),
    winMs: num('TAPE_STACK_WIN_MS', 90_000),
    throttleMs: num('TAPE_STACK_THROTTLE', 5_000),
  },
  wall: {
    minSize: num('TAPE_WALL_MIN', TAPE_FLOORS.wall.size),  // legacy flat floor (feat.wallRelFloor OFF)
    relK: num('TAPE_WALL_K', 6),                 // floor = K × median near-touch level depth (per symbol)
    relFloorMin: num('TAPE_WALL_REL_MIN', TAPE_FLOORS.wall.size),  // rel floor never drops below the UI dial floor
    persistMs: num('TAPE_WALL_PERSIST_MS', 1500),// must REST this long ≥ floor before registering (anti-flash)
    nearTicks: num('TAPE_WALL_NEAR', 40),
    minHitVol: num('TAPE_WALL_HIT', 40),
    breakFrac: num('TAPE_WALL_BREAK_FRAC', 0.2),
    holdFrac: num('TAPE_WALL_HOLD_FRAC', 0.5),
    consumedFrac: num('TAPE_WALL_CONSUMED_FRAC', 0.5),  // 'break' needs hitVol ≥ this × peak, else 'pulled'
    rejectTicks: num('TAPE_WALL_REJECT', 6),
    throttleMs: num('TAPE_WALL_THROTTLE', 8_000),
  },
  unfinished: {
    maxOpp: num('TAPE_UNF_MAX_OPP', 2),
    minVol: num('TAPE_UNF_MINVOL', TAPE_FLOORS.unfinished.size),
    reverseTicks: num('TAPE_UNF_REVERSE', 8),
    winMs: num('TAPE_UNF_WIN_MS', 90_000),
    throttleMs: num('TAPE_UNF_THROTTLE', 10_000),
  },
  trapped: {
    minBurst: num('TAPE_TRAP_BURST', TAPE_FLOORS.trapped.size),
    burstMs: num('TAPE_TRAP_BURST_MS', 3_000),
    trapTicks: num('TAPE_TRAP_TICKS', 12),
    windowMs: num('TAPE_TRAP_WIN_MS', 20_000),
    throttleMs: num('TAPE_TRAP_THROTTLE', 10_000),
    // lifecycle (2026-07-15): the trap resolves — FLUSHED when the cohort's adverse move extends
    // to 2× the trap distance (their stops/pukes fired), RECOVERED when price returns to within
    // recoverTicks of their entry extreme (trap dead, cohort freed). TTL resolves stragglers.
    flushTicks: num('TAPE_TRAP_FLUSH', 24),
    recoverTicks: num('TAPE_TRAP_RECOVER', 4),
    ttlMs: num('TAPE_TRAP_TTL', 300_000),
  },
  // Stop run: a print through a stop-pool REFERENCE (session H/L · rolling swing extreme · daily
  // structural level) followed within cascadeMs by ≥ minDistinct DISTINCT aggressor ids in the
  // breach direction totaling ≥ minVol — triggered stops are many independent market orders; a
  // single institutional sweep is ONE aggressor id (only MBO can tell these apart). Lifecycle:
  // active → RECLAIMED (back inside ref − reclaimTicks = the sweep failed, spring) or ACCEPTED
  // (extends ≥ extendTicks beyond, or still beyond at acceptMs = real breakout).
  stoprun: {
    refWinMs: num('TAPE_SR_REF_WIN', 15 * 60_000),   // rolling swing-extreme memory
    minDistinct: num('TAPE_SR_MIN_IDS', 6),
    cascadeMs: num('TAPE_SR_CASCADE_MS', 2_000),
    minVol: num('TAPE_SR_MINVOL', TAPE_FLOORS.stoprun.size),
    reclaimTicks: num('TAPE_SR_RECLAIM', 2),
    extendTicks: num('TAPE_SR_EXTEND', 12),
    acceptMs: num('TAPE_SR_ACCEPT_MS', 90_000),
    throttleMs: num('TAPE_SR_THROTTLE', 60_000),     // one episode per ref zone per this window
    // Hawkes gate (feat.srHawkes): dual-kernel arrival-intensity estimators over per-side
    // DISTINCT-aggressor arrivals; qualification needs burst ratio λ̂f/λ̂s ≥ minBurst.
    tauFastMs: num('TAPE_SR_TAU_FAST', 800),         // ≈ instantaneous intensity kernel
    tauSlowMs: num('TAPE_SR_TAU_SLOW', 60_000),      // ≈ local exogenous baseline
    minBurst: num('TAPE_SR_MIN_BURST', 4),           // Poisson steady-state ≈ 1; calibrate from stoprun_burst
    minBaseN: num('TAPE_SR_MIN_BASE_N', 30),         // arrivals before the baseline (and gate) is trusted
    // Osler stop clustering: stops pool just beyond ROUND NUMBERS — per-symbol grid in ticks
    // (NQ 50-pt = 200t, ES 25-pt = 100t; 0 disables)
    roundGrid: {
      NQ: num('TAPE_SR_ROUND_NQ', 200),
      ES: num('TAPE_SR_ROUND_ES', 100),
    } as Record<Sym, number>,
  },
  confluence: {
    winMs: num('TAPE_CONF_WIN_MS', 25_000),      // flow-delta window (its calibrated floor is measured on this)
    evWinMs: num('TAPE_CONF_EVWIN_MS', 60_000),  // V2 event-contribution memory — decay does the forgetting
                                                 //   (a 32s-old opposing sweep should fade, not vanish at a cliff)
    zoneTicks: num('TAPE_CONF_ZONE', 8),
    minScore: num('TAPE_CONF_MIN', TAPE_FLOORS.confluence.size),
    minKinds: num('TAPE_CONF_MIN_KINDS', 3),     // legacy scorer: ≥ N distinct KINDS
    minFamilies: num('TAPE_CONF_MIN_FAMILIES', 3), // family scorer: ≥ N distinct FAMILIES on the winning side
    decayTauMs: num('TAPE_CONF_DECAY_TAU', 12_500), // e-folding age for contribution decay (≈ winMs/2)
    // "at structure" = within N ticks of a daily level — PER SYMBOL: 12 ticks is 3 NQ pts (fine)
    // but 3 ES pts covers half the ES level map (2026-07-15: 295 of 336 ES stars tagged @struct,
    // hit rate 42–49% = the gate barely gated). ES band = 5 ticks (1.25 pts).
    structTicks: {
      NQ: num('TAPE_CONF_STRUCT_TICKS_NQ', num('TAPE_CONF_STRUCT_TICKS', 12)),
      ES: num('TAPE_CONF_STRUCT_TICKS_ES', 5),
    } as Record<Sym, number>,
    // a star opposing a star fired in the same zone within this window is a FLIP — it EMITS
    // (newest evidence supersedes; suppressing the newcomer let a wrong 12:24 star outrank the
    // correct 12:25 flip on 2026-07-15) tagged `flip`, and the chart strikes the superseded one
    conflictMs: num('TAPE_CONF_CONFLICT_MS', 120_000),
    flowW: num('TAPE_CONF_FLOW_W', 1.5), flowMin: num('TAPE_CONF_FLOW_MIN', 80),   // flowMin = fallback when
    imbW: num('TAPE_CONF_IMB_W', 1), imbMin: num('TAPE_CONF_IMB_MIN', 150),        //   no calibration (feat.calFloors)
    throttleMs: num('TAPE_CONF_THROTTLE', 20_000),
    // V2 decision gates:
    maxOppRatio: num('TAPE_CONF_MAX_OPP', 0.5),  // losing-side score / winning-side score above this = a
                                                 //   CONTESTED zone → abstain (a decider says "no trade", it
                                                 //   doesn't pick the larger half of a coin flip)
    confirmMs: num('TAPE_CONF_CONFIRM_MS', 3_000),   // provisional star must re-qualify after this long
    driftMaxTicks: num('TAPE_CONF_DRIFT_MAX', 8),    // ...and price must still be within N ticks of the
                                                     //   anchor (an area price already left is not actionable)
  },
  orderTtlMs: 20 * 60_000,   // drop tracked resting orders older than this (memory guard)
};

// ── Confluence weighting ──────────────────────────────────────────────────────
// FAMILY grouping (feat.confFamilies): kinds that are the same market phenomenon share one family
// and count ONCE — iceberg + absorption + wall at one level is one defense, not three signals.
// V2 adds the EVIDENCE-CLASS axis on top: PASSIVE = resting capital committed (a defender you can
// lean a stop against), ACTIVE = taker initiative (paying spread). Families dedupe phenomenon
// TYPE; classes dedupe information SOURCE — one buy burst can light three families (broke-iceberg
// + block + flow, the 03:14 star) but it can never manufacture PASSIVE evidence.
export type ConfFamily = 'DEFENSE' | 'AGGRESSION' | 'EXHAUSTION' | 'FLOW' | 'BOOK';
export type ConfClass = 'PASSIVE' | 'ACTIVE';
export const CONF_FAMILY: Record<string, ConfFamily> = {
  iceberg: 'DEFENSE', absorption: 'DEFENSE', wall: 'DEFENSE',
  sweep: 'AGGRESSION', block: 'AGGRESSION', stacked: 'AGGRESSION',
  trapped: 'EXHAUSTION', stoprun: 'EXHAUSTION',
  flow: 'FLOW',
  imb: 'BOOK',
};
// V2 family+class resolution BY STATE: a broke iceberg / broken wall carries "takers won"
// information — it votes AGGRESSION/ACTIVE, not DEFENSE (its direction is already flipped by
// direction.ts). Level-defense kinds in their defending states are the PASSIVE core.
export function confFamilyClass(kind: string, state?: string): { fam: ConfFamily; cls: ConfClass } | null {
  switch (kind) {
    case 'iceberg':
      return state === 'broke' ? { fam: 'AGGRESSION', cls: 'ACTIVE' } : { fam: 'DEFENSE', cls: 'PASSIVE' };
    case 'wall':
      return state === 'hold' ? { fam: 'DEFENSE', cls: 'PASSIVE' }
        : state === 'break' ? { fam: 'AGGRESSION', cls: 'ACTIVE' }
        : null;   // 'pulled' never scores
    case 'absorption': return { fam: 'DEFENSE', cls: 'PASSIVE' };
    case 'sweep': case 'block': case 'stacked': return { fam: 'AGGRESSION', cls: 'ACTIVE' };
    case 'trapped':
      // the trap DETECTION scores (unlike wall/stoprun 'active', a trap already contains its
      // confirming reversal by definition — and this is the validated FLIP-veto conditioner;
      // changing its scoring would also violate the STAR_FADE config freeze). The lifecycle
      // RESOLUTIONS are display/labeler-only until the 2026-07-29 review.
      return state === 'flushed' || state === 'recovered' ? null : { fam: 'EXHAUSTION', cls: 'ACTIVE' };
    case 'stoprun':
      // reclaimed = the trapped-breakout cohort about to unwind (dir already flipped by
      // direction.ts) → EXHAUSTION; accepted = takers won a level → AGGRESSION; unresolved
      // 'active' runs never score (emit() skips them — a decider doesn't lean on an open coin)
      return state === 'reclaimed' ? { fam: 'EXHAUSTION', cls: 'ACTIVE' }
        : state === 'accepted' ? { fam: 'AGGRESSION', cls: 'ACTIVE' }
        : null;
    case 'flow': return { fam: 'FLOW', cls: 'ACTIVE' };
    case 'imb': return { fam: 'BOOK', cls: 'PASSIVE' };
    default: return null;
  }
}
// PASSIVE kinds that count as LEVEL DEFENSE for the F5b structure gate (book imb alone is not a
// defended level — someone must be provably absorbing there).
export const CONF_LEVEL_DEFENSE = new Set(['iceberg', 'absorption', 'wall']);
export const CONF_FAMILY_W: Record<ConfFamily, number> = {
  DEFENSE: num('TAPE_CONF_W_DEFENSE', 2),
  AGGRESSION: num('TAPE_CONF_W_AGGRESSION', 1.5),
  EXHAUSTION: num('TAPE_CONF_W_EXHAUSTION', 1.5),
  FLOW: num('TAPE_CONF_W_FLOW', 1.5),
  BOOK: num('TAPE_CONF_W_BOOK', 1),
};
// Within-family member quality (research-informed): stacked is a POWERED NULL standalone
// (E0.2, 44,966 events) → heavy downweight; trapped is a validated FLIP-veto conditioner → full.
export const CONF_MEMBER_W: Record<string, number> = {
  iceberg: 1, absorption: 0.9, wall: 0.9,
  sweep: 1, block: 0.8, stacked: 0.5,
  trapped: 1, stoprun: 1, flow: 1, imb: 1,
};
// Legacy flat per-kind weights (feat.confFamilies OFF). spoof/unfinished stay excluded everywhere:
// spoof = deception noise, unfinished = settled null (visual-only).
export const CONF_W: Record<string, number> = { iceberg: 2, absorption: 2, wall: 2, stacked: 1.5, sweep: 1.5, trapped: 1.5, block: 1 };
