// zone-pockets.ts — classify the RS bull/bear zones into LP / IP / Sandwich pockets at the
// moment the levels are ingested, so EST/BZ/ZONE engines trigger off precomputed structure
// (instead of re-deriving per tick) AND the cockpit can label them.
//
// Anchors (the tradeable levels): bull zone → BZB = its LOW; bear zone → BrZT = its HIGH.
// Pocket type by arrangement of two ADJACENT zones (ascending):
//   bear below + bull above → LP  (long BrZT→BZB, "waltz" the pocket)
//   bull below + bear above → IP  (long BZB-bounce→BrZT, fast)
// THE 50pt LIMIT IS THE GAP BETWEEN THE ZONE BODIES — upper.low − lower.high — NOT the
// anchor span (Ravi, 2026-06-29). So the qualifier ignores zone thickness; only the empty
// space between adjacent rectangles must be ≤ limit. The TRADE still rides the anchors.
//
// Sandwich = two consecutive pockets that share the middle zone:
//   A) bull·bear·bull (bear in middle) = IP leg + LP leg → one trade BZB→BZB (hold through).
//   B) bear·bull·bear (bull in middle) = LP leg + IP leg → TWO-STEP: BrZT→BZB (exit), await a
//      confirm tap, then BZB→BrZT (the middle BZB is a bounce, not a pass-through).

export type ZoneKind = 'bull' | 'bear';
export interface Zone { kind: ZoneKind; low: number; high: number; }
/** The tradeable anchor: bull → BZB (low), bear → BrZT (high). */
export const anchorOf = (z: Zone): number => (z.kind === 'bull' ? z.low : z.high);

export type PocketKind = 'LP' | 'IP';
export interface Pocket {
  kind: PocketKind;
  lower: Zone; upper: Zone;
  gap: number;        // THE qualifier = inner gap between the bodies: gapHigh − gapLow
  gapLow: number;     // lower zone's TOP  (bottom edge of the empty gap)
  gapHigh: number;    // upper zone's BOTTOM (top edge of the empty gap)
  entry: number;      // TRADE anchor to enter at (LP: BrZT; IP: BZB — or wall facing-edge if clamped)
  target: number;     // TRADE anchor target      (LP: BZB; IP: BrZT — or wall facing-edge if clamped)
  direction: 'long';
  clamped: boolean;   // true if entry/target was pulled to a wall's facing edge (body too thick to traverse)
  note: string;
}

export type SandwichKind = 'Sandwich-A' | 'Sandwich-B';
export interface Sandwich {
  kind: SandwichKind;           // A = bear in middle; B = bull in middle
  middleKind: ZoneKind;
  zones: [Zone, Zone, Zone];
  legs: [Pocket, Pocket];       // lower leg, upper leg
  entry: number;                // overall entry anchor
  finalTarget: number;          // overall target anchor
  twoStep: boolean;             // true for Sandwich-B (middle BZB bounce → exit + confirm tap)
  note: string;
}

export interface PocketResult { pockets: Pocket[]; sandwiches: Sandwich[]; }

// Pocket GAP limit: 50pt NQ (Ravi); ES scaled by the strike ratio (40:10) → 12.5. Override via limitPts.
const DEFAULT_LIMIT: Record<string, number> = { NQ: 50, ES: 12.5 };
// WALL threshold = a zone BODY too thick for a trade to traverse (volatile days reach ~150pt; trim later).
// 150pt NQ (Ravi); ES scaled → 37.5. A wall breaks sandwich chains (no hold-through) and clamps an IP's
// anchor to the wall's facing edge so the trade is the gap-rip, not a body-spanning ride. Override via maxZoneBody.
const DEFAULT_WALL: Record<string, number> = { NQ: 150, ES: 37.5 };

export function classifyPockets(
  bull: Array<{ low: number; high: number }>,
  bear: Array<{ low: number; high: number }>,
  opts: { symbol?: 'NQ' | 'ES'; limitPts?: number; maxZoneBody?: number } = {},
): PocketResult {
  const limit = opts.limitPts ?? DEFAULT_LIMIT[opts.symbol ?? 'NQ'] ?? 50;
  const maxBody = opts.maxZoneBody ?? DEFAULT_WALL[opts.symbol ?? 'NQ'] ?? 150;
  const isWall = (z: Zone) => z.high - z.low > maxBody;
  const zones: Zone[] = [
    ...bull.map(z => ({ kind: 'bull' as const, low: z.low, high: z.high })),
    ...bear.map(z => ({ kind: 'bear' as const, low: z.low, high: z.high })),
  ].sort((a, b) => a.low - b.low);

  const pockets: Pocket[] = [];
  for (let i = 0; i < zones.length - 1; i++) {
    const lower = zones[i]!, upper = zones[i + 1]!;
    if (lower.kind === upper.kind) continue;             // same type → not a pocket
    const gap = +(upper.low - lower.high).toFixed(2);
    if (gap < 0 || gap > limit) continue;               // overlapping, or too far apart
    const gapLow = lower.high, gapHigh = upper.low;      // the empty space between the two bodies
    if (lower.kind === 'bear') {                         // bear below, bull above → LP (rides facing edges; never spans a body)
      pockets.push({ kind: 'LP', lower, upper, gap, gapLow, gapHigh, entry: lower.high, target: upper.low, direction: 'long', clamped: false,
        note: `LP · gap ${gap} [bear-top ${gapLow} → bull-bot ${gapHigh}] · trade BrZT@${lower.high}→BZB@${upper.low}` });
    } else {                                             // bull below, bear above → IP (anchors are FAR edges; clamp to facing edge if a wall)
      const lowWall = isWall(lower), upWall = isWall(upper);
      const entry = lowWall ? lower.high : lower.low;    // wall bull → enter at its top (gap-rip); else BZB bounce
      const target = upWall ? upper.low : upper.high;    // wall bear → target its bottom (start of resistance); else BrZT
      const ed = lowWall ? `top@${entry} (bull ${Math.round(lower.high - lower.low)}pt wall)` : `BZB@${entry} bounce`;
      const td = upWall ? `bear-bot@${target} (bear ${Math.round(upper.high - upper.low)}pt wall)` : `BrZT@${target}`;
      pockets.push({ kind: 'IP', lower, upper, gap, gapLow, gapHigh, entry, target, direction: 'long', clamped: lowWall || upWall,
        note: `IP · gap ${gap} [bull-top ${gapLow} → bear-bot ${gapHigh}] · trade ${ed}→${td}` });
    }
  }

  // Sandwich = two pockets that share the middle zone (same object, since both came from the
  // sorted zone list). A broken chain (a skipped >50 gap) leaves the pockets not sharing a zone.
  const sandwiches: Sandwich[] = [];
  for (let i = 0; i < pockets.length - 1; i++) {
    const a = pockets[i]!, b = pockets[i + 1]!;
    if (a.upper !== b.lower) continue;                   // must share the middle zone
    const mid = a.upper;
    if (isWall(mid)) continue;                           // can't hold through a wall body → no sandwich (the two legs stand alone)
    // entry/finalTarget come from the (already wall-clamped) leg anchors, so a sandwich never spans a wall either.
    if (mid.kind === 'bear') {                           // bull·bear·bull → IP + LP, one trade entry→target
      sandwiches.push({ kind: 'Sandwich-A', middleKind: 'bear', zones: [a.lower, mid, b.upper], legs: [a, b],
        entry: a.entry, finalTarget: b.target, twoStep: false,
        note: `Sandwich-A (bear middle): ${a.entry}→${b.target} hold through BrZT@${mid.high}` });
    } else {                                             // bear·bull·bear → LP + IP, two-step (mid BZB bounce)
      sandwiches.push({ kind: 'Sandwich-B', middleKind: 'bull', zones: [a.lower, mid, b.upper], legs: [a, b],
        entry: a.entry, finalTarget: b.target, twoStep: true,
        note: `Sandwich-B (bull middle): ${a.entry}→BZB@${mid.low} (exit, await confirm)→${b.target}` });
    }
  }

  return { pockets, sandwiches };
}
