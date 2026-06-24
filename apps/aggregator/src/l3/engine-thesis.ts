// engine-thesis — at a level touch, run all six RS framework engines against the
// live MarketState and combine the setups that fire AT that level into one THESIS:
// the framework's trade (direction / bounce-vs-break / size / base_prob / LM-agreement)
// + confluence (how many engines agree, and which disagree). This is the decision —
// the L3 layer (decision-engine.confirm) only validates or vetoes it.
import { evaluateEst } from '../rules-v2/est-engine.js';
import { annotateWithLm, lmRead, evaluateLmSetups } from '../rules-v2/lm-engine.js';
import { evaluateSandwich } from '../rules-v2/zone-engine.js';
import { evaluateDdBands } from '../rules-v2/dd-engine.js';
import { evaluateRdz } from '../rules-v2/rdz-engine.js';
import { evaluateBullBearZone } from '../rules-v2/bz-engine.js';
import type { MarketState, Setup, SizeTier, Dir, BounceVsBreak } from '../rules-v2/engine-types.js';

export interface Thesis {
  level: number;
  direction: Dir;
  bounceVsBreak: BounceVsBreak;
  engines: string[];        // families agreeing on the chosen direction at this level
  confluence: number;       // = engines.length (stacked-engine agreement)
  conflict: string[];       // families firing the OPPOSITE direction here (caution)
  sizeBase: SizeTier;       // biggest framework size tier among the agreeing setups
  baseProb: number;         // best framework base_prob (⚠ framework-stated, verify-live)
  lmAgrees: boolean | null;
  entry: number; stop: number; targets: number[];
  notes: string[];          // each engine's confluenceNote
}

const TIER_RANK: Record<SizeTier, number> = { '0': 0, S: 1, M: 2, N: 3 };

type AnnSetup = Setup & { lmAgrees?: boolean | null };

/** Run all six engines; combine the setups within ±tolPts of levelPrice into a thesis. */
export function buildThesis(ms: MarketState, levelPrice: number, tolPts = 2): Thesis | null {
  const all: AnnSetup[] = [];
  lmRead(ms); // primes the LM read used by annotateWithLm
  for (const s of annotateWithLm(ms, evaluateEst(ms))) all.push(s);
  for (const s of evaluateLmSetups(ms)) all.push({ ...s });            // LM legs are the LM itself
  for (const s of annotateWithLm(ms, evaluateSandwich(ms))) all.push(s);
  for (const s of annotateWithLm(ms, evaluateDdBands(ms))) all.push(s);
  for (const s of annotateWithLm(ms, evaluateRdz(ms))) all.push(s);
  for (const s of annotateWithLm(ms, evaluateBullBearZone(ms))) all.push(s);

  const at = all.filter(s => Math.abs(s.level - levelPrice) <= tolPts);
  if (!at.length) return null;

  const longs = at.filter(s => s.direction === 'long');
  const shorts = at.filter(s => s.direction === 'short');
  // dominant direction = more engines; tie → long (framework long-bias)
  const pick = longs.length >= shorts.length ? longs : shorts;
  const other = pick === longs ? shorts : longs;
  const direction: Dir = pick === longs ? 'long' : 'short';

  const rep = pick.reduce((a, b) => (b.baseProb > a.baseProb ? b : a));
  const sizeBase = pick.reduce<SizeTier>((a, b) => (TIER_RANK[b.sizeTier] > TIER_RANK[a] ? b.sizeTier : a), '0');
  const lmAgrees = rep.family === 'LM' ? true : (rep.lmAgrees ?? null);

  return {
    level: levelPrice,
    direction,
    bounceVsBreak: rep.bounceVsBreak,
    engines: [...new Set(pick.map(s => s.family))],
    confluence: new Set(pick.map(s => s.family)).size,
    conflict: [...new Set(other.map(s => s.family))],
    sizeBase,
    baseProb: rep.baseProb,
    lmAgrees,
    entry: rep.entry, stop: rep.stop, targets: rep.targets,
    notes: pick.map(s => `${s.family}:${s.confluenceNote}`),
  };
}
