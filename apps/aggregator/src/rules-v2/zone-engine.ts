// Zone-combination / "sandwich" engine (Phase 4). From Light_15 + transcript 14.
//
// Two cases, discriminated by what sits in the MIDDLE of the path up:
//   A) BEAR zone in the middle  → HOLD THROUGH: IP leg (bottom-bull→mid-bear) + LP leg
//      (mid-bear→top-bull) combine into one trade BZB→BZB. Take every single time; strongest DD>0.5.
//   B) BULL-zone in the middle → TWO-STEP: leg 1 BrZT→BZB (exit at the middle BZB), then await a
//      confirmation tap before leg 2 BZB→BrZT (leg 2 deferred/stateful).
//
// REWIRED 2026-06-29 to consume the precomputed `ms.pockets.sandwiches` (zone-pockets.ts) instead of
// re-deriving from boundary adjacency. That brings the **50pt inner-gap rule** and **150pt wall
// handling** (no hold-through a wall body; IP anchors clamped to facing edges) — the old version
// fired on any three adjacent boundaries regardless of distance. Pure, gate-aware, family 'ZONE'.
import type { MarketState, Setup, SizeTier } from './engine-types.js';

const Z_STRIKE: Record<'NQ' | 'ES', number> = { NQ: 40, ES: 10 };
const Z_TIERS: SizeTier[] = ['N', 'M', 'S', '0'];
const zDown = (t: SizeTier): SizeTier => (t === 'N' ? 'M' : t === 'M' ? 'S' : t === 'S' ? 'S' : '0');
const zCap = (t: SizeTier, max: SizeTier): SizeTier => (Z_TIERS.indexOf(t) >= Z_TIERS.indexOf(max) ? t : max);

export function evaluateSandwich(ms: MarketState, opts: { proximityPts?: number } = {}): Setup[] {
  const out: Setup[] = [];
  if (ms.price == null || ms.gate.mode === 'sit-out') return out;
  const strike = Z_STRIKE[ms.symbol];
  const prox = opts.proximityPts ?? strike / 5;
  const price = ms.price;
  const dd = ms.confluence.ddRatio;
  const baseTier: SizeTier = dd > 0.5 ? 'N' : 'M';
  const sizeGate = (t: SizeTier): SizeTier => {
    let r = ms.gate.sizeDown ? zDown(t) : t;
    if (ms.gate.mode === 'strong-pivots-small') r = zCap(r, 'S');
    return r;
  };

  for (const sw of ms.pockets?.sandwiches ?? []) {
    if (Math.abs(price - sw.entry) > prox) continue;   // trigger at the (possibly wall-clamped) entry anchor

    if (sw.kind === 'Sandwich-A') {                    // bear in middle → one trade entry→finalTarget, hold through
      out.push({
        family: 'ZONE', pivot: 'Sandwich-A BZB→BZB', level: sw.entry, direction: 'long',
        sizeTier: sizeGate(baseTier), entry: price, stop: +(sw.entry - strike).toFixed(2),
        targets: [sw.finalTarget], bounceVsBreak: 'hold-through', baseProb: 0.90,
        confluenceNote: `${sw.note} · DD ${dd}`,
      });
    } else {                                           // Sandwich-B (bull in middle) → two-step; emit leg 1 only
      const legBZB = sw.legs[0].target;                // LP leg target = the middle bull's BZB (the bounce/exit)
      out.push({
        family: 'ZONE', pivot: 'Sandwich-B leg1', level: sw.entry, direction: 'long',
        sizeTier: sizeGate(baseTier), entry: price, stop: +(sw.entry - strike).toFixed(2),
        targets: [legBZB], bounceVsBreak: 'bounce', baseProb: 0.90,
        confluenceNote: `${sw.note} · leg 1/2 (exit ${legBZB}, await confirm) · DD ${dd}`,
      });
    }
  }

  return out;
}
