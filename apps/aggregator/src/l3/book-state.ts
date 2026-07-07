// book-state.ts — CRACKER Phase 4: the book-state reader.
//
// ── SECOND PRIMITIVE REBUILT UNDER THE 2026-07-07 REBUILD DIRECTIVE ──
// Cracker-owned. Pure functions over ladder snapshots (the OrderBook.ladder()
// output shape) — no OrderBook internals touched, no I/O. Consumed by the trace
// to capture per-visit book-state columns (plan §4.1: resting depth at the
// level, liquidity delta over the approach, void/gap geometry).
//
// MODEL
//   A snapshot is the top-N ladder per side at time t. Three geometry reads:
//   • wallAt(side, level, ±k ticks): resting size in the level's defense zone.
//   • depthBeyond(side, level, dir, w ticks): capacity strictly BEHIND the
//     level on the break side — what a break has to chew through next.
//   • maxGapBeyond: the largest run of consecutive EMPTY ticks in that behind-
//     window — the "trapdoor" (price accelerates through voids).
//   ApproachTracker keeps a 5s-cadence ring of per-price wall sizes + full
//   snapshots, so "the book 60s BEFORE the visit opened" is available at visit
//   close with zero lookahead.
//
// COVERAGE HONESTY (the failure mode that silently poisons book studies):
//   a top-N ladder may not span the requested window. Every beyond-read
//   returns `covered`; the trace stores NULL when the window wasn't fully
//   visible instead of a silently-truncated number. Verified feeds: CQG L2 =
//   ~±50pt banded window (211 px/side probed 2026-07-07), Bookmap L3 = full
//   book — both cover the frozen windows below with margin.
//
// FROZEN PARAMETERS (BS_CFG; ES overrides in the runners' INSTR table):
//   K_WALL 16 ticks NQ (=4pt; ES 4 = 1pt) — matches the LM tape window.
//   W_BEYOND 40 ticks NQ (=10pt; ES 10 = 2.5pt).
//   SNAP_MS 5000 · PRE_MS 60000 · LADDER_N 200 · RING_CAP 40 (~200s history).

export interface LadderLevel { priceInt: number; price: number; size: number; orders: number; }
export interface BookSnap { ts: number; bids: LadderLevel[]; asks: LadderLevel[]; }

export const BS_CFG = {
  K_WALL_TICKS: 16,
  W_BEYOND_TICKS: 40,
  SNAP_MS: 5_000,
  PRE_MS: 60_000,
  LADDER_N: 200,
  RING_CAP: 40,
};
export type BsCfg = typeof BS_CFG;

/** Resting size within ±k ticks of the level on one side. */
export function wallAt(side: LadderLevel[], levelInt: number, kTicks: number): number {
  let s = 0;
  for (const l of side) if (Math.abs(l.priceInt - levelInt) <= kTicks) s += l.size;
  return s;
}

/** True if the side array's captured range spans the window [levelInt, levelInt+dir·w]
 *  (or the book genuinely ends inside it — an untruncated top-N capture). */
function windowCovered(side: LadderLevel[], levelInt: number, dir: 1 | -1, wTicks: number, ladderN: number): boolean {
  if (!side.length) return false;
  if (side.length < ladderN) return true;                    // whole book captured
  let extreme = side[0]!.priceInt;
  for (const l of side) extreme = dir > 0 ? Math.max(extreme, l.priceInt) : Math.min(extreme, l.priceInt);
  return dir > 0 ? extreme >= levelInt + wTicks : extreme <= levelInt - wTicks;
}

/** Resting size strictly beyond the level in direction `dir`, within w ticks.
 *  `covered=false` ⇒ the ladder was truncated inside the window — store NULL. */
export function depthBeyond(side: LadderLevel[], levelInt: number, dir: 1 | -1, wTicks: number, ladderN = BS_CFG.LADDER_N): { size: number; covered: boolean } {
  const covered = windowCovered(side, levelInt, dir, wTicks, ladderN);
  let s = 0;
  for (const l of side) {
    const d = (l.priceInt - levelInt) * dir;
    if (d >= 1 && d <= wTicks) s += l.size;
  }
  return { size: s, covered };
}

/** Largest run of consecutive EMPTY ticks strictly beyond the level (window w). */
export function maxGapBeyond(side: LadderLevel[], levelInt: number, dir: 1 | -1, wTicks: number, ladderN = BS_CFG.LADDER_N): { gapTicks: number; covered: boolean } {
  const covered = windowCovered(side, levelInt, dir, wTicks, ladderN);
  const occ = new Set<number>();
  for (const l of side) {
    const d = (l.priceInt - levelInt) * dir;
    if (d >= 1 && d <= wTicks && l.size > 0) occ.add(d);
  }
  let gap = 0, run = 0;
  for (let d = 1; d <= wTicks; d++) {
    if (occ.has(d)) run = 0;
    else { run++; if (run > gap) gap = run; }
  }
  return { gapTicks: gap, covered };
}

export interface WallSample { ts: number; bid: number; ask: number; }

/** 5s-cadence ring of per-price wall sizes + full snapshots. Keys are the
 *  level's priceInt (a wall is a property of the PRICE — sources sharing a
 *  price share the ring). Zero lookahead: reads return the newest sample at or
 *  before the requested time. */
export class ApproachTracker {
  private rings = new Map<number, WallSample[]>();
  private snaps: BookSnap[] = [];
  private lastTs = 0;
  constructor(private cfg: BsCfg = BS_CFG) {}

  /** True when the next SNAP_MS-cadence sample is due (lets callers skip the
   *  ladder-sort cost between samples). */
  due(ts: number): boolean { return ts - this.lastTs >= this.cfg.SNAP_MS; }

  /** Call on the throttle loop; self-limits to SNAP_MS cadence. */
  maybeSample(ts: number, snap: BookSnap, levelInts: Iterable<number>): boolean {
    if (ts - this.lastTs < this.cfg.SNAP_MS) return false;
    this.lastTs = ts;
    this.snaps.push(snap);
    if (this.snaps.length > this.cfg.RING_CAP) this.snaps.shift();
    const seen = new Set<number>();
    for (const pi of levelInts) {
      if (seen.has(pi)) continue;
      seen.add(pi);
      let ring = this.rings.get(pi);
      if (!ring) { ring = []; this.rings.set(pi, ring); }
      ring.push({ ts, bid: wallAt(snap.bids, pi, this.cfg.K_WALL_TICKS), ask: wallAt(snap.asks, pi, this.cfg.K_WALL_TICKS) });
      if (ring.length > this.cfg.RING_CAP) ring.shift();
    }
    // GC rings for prices no longer tracked (bounded memory across a session)
    if (this.rings.size > 4 * seen.size + 64) {
      for (const k of this.rings.keys()) if (!seen.has(k)) this.rings.delete(k);
    }
    return true;
  }

  /** Newest wall sample at or before `ts` (within 3×SNAP_MS staleness). */
  wallsAt(priceInt: number, ts: number): WallSample | null {
    const ring = this.rings.get(priceInt);
    if (!ring) return null;
    for (let i = ring.length - 1; i >= 0; i--) {
      const s = ring[i]!;
      if (s.ts <= ts) return ts - s.ts <= 3 * this.cfg.SNAP_MS ? s : null;
    }
    return null;
  }

  /** Newest wall sample at or before ts − PRE_MS (the "before the approach" read). */
  wallsPre(priceInt: number, ts: number): WallSample | null {
    return this.wallsAt(priceInt, ts - this.cfg.PRE_MS);
  }

  /** Newest full snapshot at or before `ts` (within 3×SNAP_MS). */
  snapAt(ts: number): BookSnap | null {
    for (let i = this.snaps.length - 1; i >= 0; i--) {
      const s = this.snaps[i]!;
      if (s.ts <= ts) return ts - s.ts <= 3 * this.cfg.SNAP_MS ? s : null;
    }
    return null;
  }
}
