// Zone-combination / "sandwich" engine (Phase 4). From Light_15 + transcript 14.
//
// Two cases, discriminated by what sits in the MIDDLE of the path up:
//   A) BEAR zone in the middle  → HOLD THROUGH: at a BZB with [BrZT, BZB] above,
//      combine the IP leg (BZB→BrZT, fast) + LP leg (BrZT→BZB, slow) into one trade
//      BZB→BZB. Take every single time; strongest when DD>0.5.
//   B) BULL-zone-bottom in the middle → TWO-STEP: at a BrZT (from below) with
//      [BZB, BrZT] above, BZB is a BOUNCE not a pass-through → leg 1 BrZT→BZB (exit at
//      BZB), then await a confirmation tap before leg 2 BZB→BrZT (leg 2 is deferred).
// Pure, gate-aware, emits candidate Setups (family 'ZONE') for the shadow harness.
import type { MarketState, Setup, SizeTier } from './engine-types.js';

const Z_STRIKE: Record<'NQ' | 'ES', number> = { NQ: 40, ES: 10 };
const Z_TIERS: SizeTier[] = ['N', 'M', 'S', '0'];
const zDown = (t: SizeTier): SizeTier => (t === 'N' ? 'M' : t === 'M' ? 'S' : t === 'S' ? 'S' : '0');
const zCap = (t: SizeTier, max: SizeTier): SizeTier => (Z_TIERS.indexOf(t) >= Z_TIERS.indexOf(max) ? t : max);

interface Boundary { p: number; t: 'BZB' | 'BrZT'; }

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

  // Ordered, de-duplicated zone boundaries.
  const bs: Boundary[] = [
    ...ms.levels.bzb.map(p => ({ p, t: 'BZB' as const })),
    ...ms.levels.brzt.map(p => ({ p, t: 'BrZT' as const })),
  ].filter(b => Number.isFinite(b.p)).sort((a, b) => a.p - b.p);
  if (bs.length < 3) return out;

  // The boundary price is at (within proximity).
  const atIdx = bs.findIndex(b => Math.abs(price - b.p) <= prox);
  if (atIdx < 0) return out;
  const at = bs[atIdx]!;
  const up = bs.slice(atIdx + 1).filter(b => b.p > at.p + 1);
  if (up.length < 2) return out;

  // Case A — sandwich hold-through: at a BZB, [BrZT, BZB] above → BZB→BZB, hold through.
  if (at.t === 'BZB' && up[0]!.t === 'BrZT' && up[1]!.t === 'BZB') {
    out.push({
      family: 'ZONE', pivot: 'Sandwich BZB→BZB', level: at.p, direction: 'long',
      sizeTier: sizeGate(baseTier), entry: price, stop: +(at.p - strike).toFixed(2),
      targets: [up[1]!.p], bounceVsBreak: 'hold-through', baseProb: 0.90,
      confluenceNote: `sandwich (bear zone in middle): hold through BrZT@${up[0]!.p} to BZB@${up[1]!.p} · DD ${dd}`,
    });
  }

  // Case B — BZB-bounce two-step (leg 1): at a BrZT from below, [BZB, BrZT] above →
  // BrZT→BZB, exit at BZB, await confirm tap for BZB→BrZT (leg 2 deferred, stateful).
  if (at.t === 'BrZT' && price <= at.p + prox && up[0]!.t === 'BZB' && up[1]!.t === 'BrZT') {
    out.push({
      family: 'ZONE', pivot: 'BZB-bounce leg1', level: at.p, direction: 'long',
      sizeTier: sizeGate(baseTier), entry: price, stop: +(at.p - strike).toFixed(2),
      targets: [up[0]!.p], bounceVsBreak: 'bounce', baseProb: 0.90,
      confluenceNote: `two-step (BZB bounce): BrZT→BZB leg 1/2 — exit at BZB@${up[0]!.p}, await confirm for BZB→BrZT@${up[1]!.p} · DD ${dd}`,
    });
  }

  return out;
}
