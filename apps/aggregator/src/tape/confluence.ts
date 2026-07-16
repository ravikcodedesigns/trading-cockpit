// Confluence scorer — the FLOW+TAPE synthesis star.
//
// V1 (feat.confFamilies, 2026-07-15 am): FAMILY grouping — kinds of the same market phenomenon
// count once (DEFENSE/AGGRESSION/EXHAUSTION/FLOW/BOOK). Fixed the triple-counted-defense star.
//
// V2 (feat.confV2, 2026-07-15 pm — the DECISION-GRADE rebuild): the user's mandate changed from
// "reference marker" to "action-area decider I will take trades from". The 03:14 post-mortem
// showed V1's remaining hole: families dedupe phenomenon TYPE but not information SOURCE — one
// 2-second buy burst lit DEFENSE (broke iceberg, flipped) + AGGRESSION (block) + FLOW (delta) and
// manufactured a 3-family star at a local top. V2 adds, each gate independently reasoned:
//
//   1. EVIDENCE CLASSES — every vote is PASSIVE (resting capital committed: defending iceberg,
//      absorption, wall hold, book imbalance) or ACTIVE (taker initiative: sweep/block/stacked/
//      flow/trapped + broke events). A star requires BOTH classes aligned: someone paying spread
//      AND someone provably resting size in the same direction. A taker burst alone can never
//      manufacture PASSIVE evidence.
//   2. RE-HOMED BROKE EVENTS — broke iceberg / broken wall votes AGGRESSION/ACTIVE (their
//      information is "takers won"; direction already flipped by direction.ts).
//   3. OPPOSITION ABSTENTION — if the losing side scores ≥ maxOppRatio of the winner, the zone is
//      CONTESTED and the decider abstains. It says "no trade", it doesn't pick the larger half.
//   4. F5b STRUCTURE GATE — at a daily structural level, flow-following reverses (the one
//      OOS-confirmed mechanism in this repo). At structure the PASSIVE side must include an
//      aligned LEVEL-DEFENSE kind (iceberg/absorption/wall) or the star abstains; pure
//      flow-following can never print an action area on top of a level.
//   5. CONFIRMATION — a qualifying zone is provisional for confirmMs and emits only if it still
//      qualifies, same direction, with price within driftMaxTicks of the anchor. An action area
//      must survive first contact and still be actionable.
//   6. PASSIVE ANCHOR — the star prints at the strongest aligned defended level (the price you
//      can actually lean against), not at whatever event happened to trigger evaluation.
//
// The star stays FALSIFIABLE: every emit is outcome-labeled nightly (out_30s/2m/5m, split by
// family mix / class mix / at-structure / session). Decision WEIGHTS graduate from these labels —
// the scorer's constants are the prior, the labeler is the judge. Nothing here is "armed": the
// star's job is to say "action area"; sizing/arming still goes through the research protocol.

import type { Symbol as Sym, TapeEvent } from '@trading/contracts';
import {
  TAPE_CFG, TAPE_FEAT, CONF_FAMILY, CONF_FAMILY_W, CONF_MEMBER_W, CONF_W,
  confFamilyClass, CONF_LEVEL_DEFENSE, type ConfFamily,
} from './tape-config.js';
import { tierMult, calFloor } from './calibration.js';
import { nearestStructTicks } from './structural.js';

// Metric key in tape-calibration.json whose distribution tiers each kind's magnitude.
const TIER_METRIC: Record<string, string> = {
  block: 'block_ct', sweep: 'sweep_size', stacked: 'stacked_vol', trapped: 'trapped_ct',
  iceberg: 'iceberg_ct', wall: 'wall_peak',
  stoprun: 'stoprun_ct',
  flow: 'flow_delta', imb: 'imb_abs',
  // absorption deliberately ABSENT → tier ×1: the harness's absorption_ofi is 2s-sampled L1 while
  // the live detector integrates 100ms multi-level OFI — different scales, so tiering live values
  // against the harness distribution would grade everything "huge". Re-add when the harness
  // reaches true sampling parity.
};

export interface ConfContribution {
  ts: number; pi: number; dir: number; kind: string; mult: number;
  fam: ConfFamily | null; cls: 'PASSIVE' | 'ACTIVE' | null; levelDef: boolean;
}
export interface PendingStar { t0: number; pi: number; dir: number; anchorPi: number; }
export interface ConfState {
  win: ConfContribution[];                      // rolling window of recent directional tape signals
  pending: PendingStar[];                       // provisional stars awaiting confirmation (feat.confConfirm)
  lastFireByDir: Map<number, { ts: number; pi: number }>;  // distance throttle
  lastConf: Map<string, number>;                // legacy bucket throttle
}
export function newConfState(): ConfState {
  return { win: [], pending: [], lastFireByDir: new Map(), lastConf: new Map() };
}

/** Record one contributing tape signal (dir must already follow direction.ts conventions).
 *  `size` must be the kind's PRICE-IMPACT magnitude — for a reclaimed stop run that is the
 *  trapped-cohort size (distinct aggressors), not contracts: 190 offside traders are more
 *  reversal fuel than 3 large prints of equal volume. The engine passes the right value. */
export function recordSignal(st: ConfState, sym: Sym, ts: number, pi: number, dir: number, kind: string, size: number, state?: string): void {
  const fc = confFamilyClass(kind, state);
  const metric = kind === 'stoprun' && state === 'reclaimed' ? 'stoprun_ids' : TIER_METRIC[kind] ?? kind;
  const mult = TAPE_FEAT.confTiers ? tierMult(sym, metric, size, ts) : 1;
  st.win.push({
    ts, pi, dir, kind, mult,
    // confFamilyClass is authoritative — a null for a known state (stoprun:active, wall:pulled)
    // means EXCLUDED, and no static-table fallback may resurrect it (defense-in-depth: the
    // engine also skips these before calling, but the scorer must not depend on that)
    fam: fc?.fam ?? null,
    cls: fc?.cls ?? null,
    levelDef: fc?.cls === 'PASSIVE' && CONF_LEVEL_DEFENSE.has(kind),
  });
  const memMs = TAPE_FEAT.confV2 ? TAPE_CFG.confluence.evWinMs : TAPE_CFG.confluence.winMs;
  const cut = ts - memMs;
  let i = 0; while (i < st.win.length && st.win[i]!.ts < cut) i++; if (i) st.win.splice(0, i);
}

export interface FlowEnv {
  flowDelta: number;   // rolling aggressor delta over the confluence window (contracts)
  imbNet: number;      // near-touch resting book imbalance (contracts, >0 = bid-stacked)
  curPi: number;       // current price proxy (mid-quote int) — actionability/drift guard
}

/**
 * Entry point on each contributing signal. V2 + confirmation: a qualifying zone registers a
 * PROVISIONAL star and returns null; resolvePendingStars() emits it after confirmMs if it still
 * qualifies. V2 without confirmation emits immediately. V1/legacy paths preserved verbatim.
 */
export function scoreZone(st: ConfState, sym: Sym, ts: number, pi: number, env: FlowEnv, tick: number): TapeEvent | null {
  if (TAPE_FEAT.confV2) {
    const cand = evaluateV2(st, sym, ts, pi, env, tick);
    if (!cand) return null;
    if (TAPE_FEAT.confConfirm) {
      // dedup: one provisional per direction+zone
      for (const p of st.pending) if (p.dir === cand.dir && Math.abs(p.anchorPi - cand.anchorPi) <= TAPE_CFG.confluence.zoneTicks) return null;
      if (throttled(st, ts, cand.anchorPi, cand.dir, false)) return null;   // already fired here recently
      st.pending.push({ t0: ts, pi, dir: cand.dir, anchorPi: cand.anchorPi });
      return null;
    }
    if (throttled(st, ts, cand.anchorPi, cand.dir, true)) return null;
    if (isFlip(st, ts, cand.anchorPi, cand.dir)) cand.ev.flip = true;
    return cand.ev;
  }
  // ── V1 paths ──
  const C = TAPE_CFG.confluence;
  const decay = (age: number): number => (TAPE_FEAT.confDecay ? Math.exp(-Math.max(0, age) / C.decayTauMs) : 1);
  const flowMin = TAPE_FEAT.calFloors ? calFloor(sym, 'flow_delta', 'p80', C.flowMin, ts) : C.flowMin;
  const imbMin = TAPE_FEAT.calFloors ? calFloor(sym, 'imb_abs', 'p80', C.imbMin, ts) : C.imbMin;
  let ev: TapeEvent | null;
  if (TAPE_FEAT.confFamilies) ev = scoreFamilies(st, sym, ts, pi, env, { flowMin, imbMin }, decay, tick);
  else ev = scoreLegacy(st, ts, pi, env, { flowMin, imbMin }, tick);
  if (!ev) return null;
  if (throttled(st, ts, pi, ev.side === 'buy' ? 1 : -1, true)) return null;
  if (isFlip(st, ts, pi, ev.side === 'buy' ? 1 : -1)) ev.flip = true;
  if (TAPE_FEAT.confStruct) {
    const dTicks = nearestStructTicks(sym, ev.price, tick, ts);
    if (dTicks <= C.structTicks[sym]) ev.atStruct = true;
  }
  return ev;
}

/**
 * Resolve provisional stars due for confirmation — call on a periodic tick with a FRESH env.
 * Emits only zones that STILL qualify, same direction, with price within driftMaxTicks of the
 * anchor. Returns the confirmed events to sink.
 */
export function resolvePendingStars(st: ConfState, sym: Sym, now: number, env: FlowEnv, tick: number): TapeEvent[] {
  if (!st.pending.length) return [];
  const C = TAPE_CFG.confluence;
  const out: TapeEvent[] = [];
  const keep: PendingStar[] = [];
  for (const p of st.pending) {
    if (now - p.t0 < C.confirmMs) { keep.push(p); continue; }
    const cand = evaluateV2(st, sym, now, p.pi, env, tick);
    if (cand && cand.dir === p.dir
      && (!env.curPi || Math.abs(env.curPi - cand.anchorPi) <= C.driftMaxTicks)
      && !throttled(st, now, cand.anchorPi, cand.dir, true)) {
      cand.ev.durMs = now - p.t0;   // how long the area survived before confirming
      if (isFlip(st, now, cand.anchorPi, cand.dir)) cand.ev.flip = true;
      out.push(cand.ev);
    }
  }
  st.pending = keep;
  return out;
}

// A recent OPPOSITE star in this zone? The new star is a FLIP — newest evidence supersedes, it
// is NEVER suppressed (first design suppressed the newcomer; 2026-07-15 measured that killing
// the correct 12:25 flip while the wrong 12:24 star stood — stale info must not outrank fresh).
function isFlip(st: ConfState, ts: number, pi: number, dir: number): boolean {
  if (!TAPE_FEAT.confConflict) return false;
  const C = TAPE_CFG.confluence;
  const opp = st.lastFireByDir.get(-dir);
  return !!opp && ts - opp.ts < C.conflictMs && Math.abs(pi - opp.pi) <= C.zoneTicks;
}

// Distance-based throttle (feat.confDistThrottle) with the legacy bucket fallback. `commit`
// stamps the fire; commit=false only checks.
function throttled(st: ConfState, ts: number, pi: number, dir: number, commit: boolean): boolean {
  const C = TAPE_CFG.confluence;
  if (TAPE_FEAT.confDistThrottle) {
    const last = st.lastFireByDir.get(dir);
    if (last && ts - last.ts < C.throttleMs && Math.abs(pi - last.pi) <= C.zoneTicks) return true;
    if (commit) st.lastFireByDir.set(dir, { ts, pi });
    return false;
  }
  const key = dir + ':' + Math.floor(pi / C.zoneTicks);
  if (ts - (st.lastConf.get(key) ?? -Infinity) < C.throttleMs) return true;
  if (commit) st.lastConf.set(key, ts);
  return false;
}

// ── V2 evaluation (pure: no throttle, no pending side-effects) ────────────────
interface V2Candidate { ev: TapeEvent; dir: number; anchorPi: number; }

function evaluateV2(st: ConfState, sym: Sym, ts: number, pi: number, env: FlowEnv, tick: number): V2Candidate | null {
  const C = TAPE_CFG.confluence;
  const decay = (age: number): number => (TAPE_FEAT.confDecay ? Math.exp(-Math.max(0, age) / C.decayTauMs) : 1);
  const flowMin = TAPE_FEAT.calFloors ? calFloor(sym, 'flow_delta', 'p80', C.flowMin, ts) : C.flowMin;
  const imbMin = TAPE_FEAT.calFloors ? calFloor(sym, 'imb_abs', 'p80', C.imbMin, ts) : C.imbMin;

  // strongest member per (family, dir) + class/level-defense bookkeeping per dir
  const best = new Map<string, { score: number; kind: string }>();
  const cls = { 1: { passive: false, active: false }, [-1]: { passive: false, active: false } } as Record<number, { passive: boolean; active: boolean }>;
  const levelDef = new Map<number, { score: number; pi: number; kind: string }>();  // dir → strongest aligned defended level
  const consider = (fam: ConfFamily, dir: number, kind: string, raw: number, c: 'PASSIVE' | 'ACTIVE' | null, ldPi?: number): void => {
    const key = `${fam}:${dir}`;
    const cur = best.get(key);
    if (!cur || raw > cur.score) best.set(key, { score: raw, kind });
    if (c === 'PASSIVE') cls[dir]!.passive = true;
    if (c === 'ACTIVE') cls[dir]!.active = true;
    if (ldPi != null) {
      const curLd = levelDef.get(dir);
      if (!curLd || raw > curLd.score) levelDef.set(dir, { score: raw, pi: ldPi, kind });
    }
  };
  for (const c of st.win) {
    if (Math.abs(c.pi - pi) > C.zoneTicks || !c.fam) continue;
    const raw = (CONF_MEMBER_W[c.kind] ?? 1) * c.mult * decay(ts - c.ts);
    consider(c.fam, c.dir, c.kind, raw, c.cls, c.levelDef ? c.pi : undefined);
  }
  if (Math.abs(env.flowDelta) >= flowMin) {
    const mult = TAPE_FEAT.confTiers ? tierMult(sym, 'flow_delta', Math.abs(env.flowDelta), ts) : 1;
    consider('FLOW', env.flowDelta > 0 ? 1 : -1, 'flow', (CONF_MEMBER_W.flow ?? 1) * mult, 'ACTIVE');
  }
  if (Math.abs(env.imbNet) >= imbMin) {
    const mult = TAPE_FEAT.confTiers ? tierMult(sym, 'imb_abs', Math.abs(env.imbNet), ts) : 1;
    consider('BOOK', env.imbNet > 0 ? 1 : -1, 'imb', (CONF_MEMBER_W.imb ?? 1) * mult, 'PASSIVE');
  }

  // family votes (each family once, its stronger direction)
  const famVote = new Map<ConfFamily, { dir: number; score: number; kind: string }>();
  for (const [key, m] of best) {
    const [fam, dirS] = key.split(':') as [ConfFamily, string];
    const dir = Number(dirS);
    const scored = CONF_FAMILY_W[fam] * m.score;
    const cur = famVote.get(fam);
    if (!cur || scored > cur.score) famVote.set(fam, { dir, score: scored, kind: m.kind });
  }
  let bull = 0, bear = 0, bullN = 0, bearN = 0;
  const sigs: Array<{ dir: number; kind: string; fam: ConfFamily }> = [];
  for (const [fam, v] of famVote) {
    if (v.dir > 0) { bull += v.score; bullN++; } else { bear += v.score; bearN++; }
    sigs.push({ dir: v.dir, kind: v.kind, fam });
  }
  if (bull === bear) return null;
  const dir = bull > bear ? 1 : -1;
  const win = Math.max(bull, bear), lose = Math.min(bull, bear);
  const nFam = dir > 0 ? bullN : bearN;

  // ── the decision gates ──
  if (win - lose < C.minScore || nFam < C.minFamilies) return null;
  if (!cls[dir]!.passive || !cls[dir]!.active) return null;          // both evidence classes
  if (lose / win > C.maxOppRatio) return null;                       // contested zone → abstain
  const ld = levelDef.get(dir) ?? null;
  const anchorPi = ld ? ld.pi : pi;
  const atStruct = nearestStructTicks(sym, anchorPi * tick, tick, ts) <= C.structTicks[sym];
  if (TAPE_FEAT.confStruct && atStruct && !ld) return null;          // F5b: at a level, flow alone never prints

  const aligned = sigs.filter((s) => s.dir === dir);
  const ev: TapeEvent = {
    t: ts / 1000, kind: 'confluence', price: anchorPi * tick, side: dir > 0 ? 'buy' : 'sell',
    size: +(win - lose).toFixed(1), levels: nFam,
    signals: aligned.map((s) => s.kind), families: aligned.map((s) => s.fam),
  };
  if (atStruct) ev.atStruct = true;
  return { ev, dir, anchorPi };
}

// ── V1 family scorer (feat.confV2 OFF) ────────────────────────────────────────
function scoreFamilies(
  st: ConfState, sym: Sym, ts: number, pi: number, env: FlowEnv,
  floors: { flowMin: number; imbMin: number }, decay: (age: number) => number, tick: number,
): TapeEvent | null {
  const C = TAPE_CFG.confluence;
  const best = new Map<string, { score: number; kind: string }>();
  const consider = (family: ConfFamily, dir: number, kind: string, raw: number): void => {
    const key = `${family}:${dir}`;
    const cur = best.get(key);
    if (!cur || raw > cur.score) best.set(key, { score: raw, kind });
  };
  for (const c of st.win) {
    if (Math.abs(c.pi - pi) > C.zoneTicks || !c.fam) continue;
    consider(c.fam, c.dir, c.kind, (CONF_MEMBER_W[c.kind] ?? 1) * c.mult * decay(ts - c.ts));
  }
  if (Math.abs(env.flowDelta) >= floors.flowMin) {
    const mult = TAPE_FEAT.confTiers ? tierMult(sym, 'flow_delta', Math.abs(env.flowDelta), ts) : 1;
    consider('FLOW', env.flowDelta > 0 ? 1 : -1, 'flow', (CONF_MEMBER_W.flow ?? 1) * mult);
  }
  if (Math.abs(env.imbNet) >= floors.imbMin) {
    const mult = TAPE_FEAT.confTiers ? tierMult(sym, 'imb_abs', Math.abs(env.imbNet), ts) : 1;
    consider('BOOK', env.imbNet > 0 ? 1 : -1, 'imb', (CONF_MEMBER_W.imb ?? 1) * mult);
  }
  let bull = 0, bear = 0, bullN = 0, bearN = 0;
  const famVote = new Map<ConfFamily, { dir: number; score: number; kind: string }>();
  for (const [key, m] of best) {
    const [fam, dirS] = key.split(':') as [ConfFamily, string];
    const dir = Number(dirS);
    const scored = CONF_FAMILY_W[fam] * m.score;
    const cur = famVote.get(fam);
    if (!cur || scored > cur.score) famVote.set(fam, { dir, score: scored, kind: m.kind });
  }
  const sigs: Array<{ dir: number; kind: string; fam: ConfFamily }> = [];
  for (const [fam, v] of famVote) {
    if (v.dir > 0) { bull += v.score; bullN++; } else { bear += v.score; bearN++; }
    sigs.push({ dir: v.dir, kind: v.kind, fam });
  }
  const net = bull - bear;
  if (net === 0) return null;
  const dir = net > 0 ? 1 : -1;
  const score = Math.abs(net);
  const nFam = dir > 0 ? bullN : bearN;
  if (score < C.minScore || nFam < C.minFamilies) return null;
  const aligned = sigs.filter((s) => s.dir === dir);
  return {
    t: ts / 1000, kind: 'confluence', price: pi * tick, side: dir > 0 ? 'buy' : 'sell',
    size: +score.toFixed(1), levels: nFam,
    signals: aligned.map((s) => s.kind), families: aligned.map((s) => s.fam),
  };
}

// ── Legacy scorer (feat.confFamilies OFF) — pre-audit behavior, verbatim ─────
function scoreLegacy(
  st: ConfState, ts: number, pi: number, env: FlowEnv,
  floors: { flowMin: number; imbMin: number }, tick: number,
): TapeEvent | null {
  const C = TAPE_CFG.confluence;
  const kd = new Map<string, number>();
  for (const c of st.win) if (Math.abs(c.pi - pi) <= C.zoneTicks) kd.set(c.kind, c.dir);
  let bull = 0, bear = 0, bullN = 0, bearN = 0; const sigs: string[] = [];
  for (const [k, d] of kd) { const w = CONF_W[k] ?? 0; if (d > 0) { bull += w; bullN++; } else { bear += w; bearN++; } sigs.push((d > 0 ? '+' : '-') + k); }
  if (Math.abs(env.flowDelta) >= floors.flowMin) { if (env.flowDelta > 0) { bull += C.flowW; bullN++; } else { bear += C.flowW; bearN++; } sigs.push((env.flowDelta > 0 ? '+' : '-') + 'flow'); }
  if (Math.abs(env.imbNet) >= floors.imbMin) { if (env.imbNet > 0) { bull += C.imbW; bullN++; } else { bear += C.imbW; bearN++; } sigs.push((env.imbNet > 0 ? '+' : '-') + 'imb'); }
  const net = bull - bear, dir = net > 0 ? 1 : -1, score = Math.abs(net);
  const nKinds = dir > 0 ? bullN : bearN;
  if (score < C.minScore || nKinds < C.minKinds) return null;
  const aligned = sigs.filter((s) => (s[0] === '+') === (dir > 0));
  return {
    t: ts / 1000, kind: 'confluence', price: pi * tick, side: dir > 0 ? 'buy' : 'sell',
    size: +score.toFixed(1), levels: nKinds, signals: aligned.map((s) => s.slice(1)),
  };
}
