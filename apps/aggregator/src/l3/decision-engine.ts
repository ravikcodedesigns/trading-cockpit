// decision-engine — the L3 CONFIRMATION layer. The framework engines already chose
// the trade (engine-thesis.ts); this only asks: does the live order-flow back it?
// It never picks direction — it confirms, vetoes, or trims, and writes a detailed
// diagnostic. Core principle: what matters is whether hidden size is actually
// TRADING-and-replenishing here vs SITTING-and-being-pulled (spoof).
import type { Thesis } from './engine-thesis.js';
import type { SizeTier } from '../rules-v2/engine-types.js';

export interface L3Read {
  defendSide: 'bid' | 'ask';     // the side the thesis is betting holds (bid=support, ask=resistance)
  wall: number; l3Size: number; impliedGap: number;
  nativeIce: number;             // same-id refilling icebergs at the level
  synthRefills: number;          // new-id refill-chain links (synthetic iceberg)
  executedNear: number;          // volume actually TRADED at the level in the window
  cvd: number; cvd60: number;    // session CVD + 60s slope
  aggrBuy: number; aggrSell: number;
  pull: number;                  // displayed size cancelled on the defend side (spoof tell)
  adds: number;                  // displayed size added on the defend side (stacking)
  sweepWith: boolean;            // a single aggressor swept ≥3 levels WITH the thesis
  sweepAgainst: boolean;         // …AGAINST the thesis (clearing the defended side)
  clusterDominance: number;      // top aggressor's share of volume (0–1)
}

export interface CtxRead {
  isRational: boolean;
  vxVolState: 'pinned' | 'above-hp' | 'above-mhp' | null;
  gateMode: 'normal' | 'strong-pivots-small' | 'sit-out';
  gateLongOnly: boolean;
  gateSizeDown: boolean;
  price: number;
  ddUpper?: number | null;
  ddLower?: number | null;
}

export interface ConfirmResult {
  verdict: 'take' | 'skip';
  size: SizeTier | null;
  confirmationScore: number;
  confirms: string[];
  invalidations: string[];
  breakForming: { dir: 'long' | 'short'; trigger: number; note: string } | null;
  diagnostic: string;            // the rich narrative
}

const C = {
  cvdWith: 2, cvdAgainst: -3, cvdThresh: 150,
  refill: 3, absorb: 2,          // real, executing, replenishing defense
  pullSpoof: -3,                 // wall yanked, didn't trade
  sweepAgainst: -4, sweepWith: 2,
  stacking: 1, cluster: 1, confluence: 1, lm: 1,
  takeScore: 4,
};

export function confirm(t: Thesis, l3: L3Read, ctx: CtxRead): ConfirmResult {
  const confirms: string[] = [];
  const invalidations: string[] = [];
  let score = 0;
  const isBounce = t.bounceVsBreak === 'bounce' || t.bounceVsBreak === 'hold-through';
  const dirSign = t.direction === 'long' ? 1 : -1;

  // ── hard gates (the framework's own sit-out + vol + irrational territory) ──
  if (ctx.gateMode === 'sit-out') invalidations.push('GATE sit-out (irrational + VVIX/VX)');
  if (ctx.vxVolState === 'above-mhp') invalidations.push('VX above gamma-MHP — vol inflection, sit out');
  if (ctx.gateLongOnly && t.direction === 'short') invalidations.push('GATE long-only (irrational DD-break) — short blocked');
  if (t.direction === 'short' && ctx.ddLower != null && ctx.price < ctx.ddLower) invalidations.push('price < DD-lower — no shorts (irrational)');
  if (t.direction === 'long' && ctx.ddUpper != null && ctx.price > ctx.ddUpper) invalidations.push('price > DD-upper — no longs (irrational)');

  // ── CVD slope with/against the thesis (validated discriminator) ──
  const cvdWith = dirSign * l3.cvd60;
  if (cvdWith >= C.cvdThresh) { score += C.cvdWith; confirms.push(`CVD60 ${l3.cvd60} WITH thesis (+${C.cvdWith})`); }
  else if (cvdWith <= -C.cvdThresh) { score += C.cvdAgainst; invalidations.push(`CVD60 ${l3.cvd60} AGAINST thesis (${C.cvdAgainst})`); }
  else confirms.push(`CVD60 ${l3.cvd60} neutral`);

  if (isBounce) {
    // BOUNCE — is the defended side actually HOLDING (trading-and-replenishing)?
    const aggrInto = l3.defendSide === 'bid' ? l3.aggrSell : l3.aggrBuy; // sells hit bids / buys hit asks
    if (l3.executedNear > 0 && aggrInto > 0 && (l3.nativeIce > 0 || l3.synthRefills > 0)) {
      score += C.refill;
      confirms.push(`ABSORBING + REFILLING — ${aggrInto} hit the ${l3.defendSide}, ice ${l3.nativeIce}/refills ${l3.synthRefills}, ${l3.executedNear} traded → real defense (+${C.refill})`);
    } else if (l3.executedNear > 0 && aggrInto > l3.wall) {
      score += C.absorb;
      confirms.push(`absorption — ${aggrInto} hit and held (+${C.absorb})`);
    }
    // SPOOF — wall pulled and barely traded
    if (l3.pull > Math.max(10, l3.wall) && l3.executedNear < l3.pull * 0.3) {
      score += C.pullSpoof;
      invalidations.push(`wall PULLED (${l3.pull} cancelled vs ${l3.executedNear} traded) → spoof, not defense (${C.pullSpoof})`);
    }
    if (l3.sweepAgainst) { score += C.sweepAgainst; invalidations.push(`SWEEP cleared the defended ${l3.defendSide} → bounce failing (${C.sweepAgainst})`); }
    if (l3.adds > l3.wall) { score += C.stacking; confirms.push(`stacking on ${l3.defendSide} (adds ${l3.adds} > wall ${l3.wall}) (+${C.stacking})`); }
  } else {
    // BREAK / RECLAIM — is the break actually happening in the thesis direction?
    if (l3.sweepWith) { score += C.sweepWith; confirms.push(`SWEEP with the break (+${C.sweepWith})`); }
    if (l3.sweepAgainst) { score += C.sweepAgainst; invalidations.push(`sweep AGAINST the break (${C.sweepAgainst})`); }
    if (cvdWith >= C.cvdThresh && l3.executedNear > 0) { /* already scored via CVD */ }
  }

  if (l3.clusterDominance >= 0.5) { score += C.cluster; confirms.push(`one aggressor dominant (${Math.round(l3.clusterDominance * 100)}% of volume) (+${C.cluster})`); }
  if (t.confluence >= 3) { score += C.confluence; confirms.push(`${t.confluence}-engine confluence (${t.engines.join('+')})`); }
  if (t.conflict.length) confirms.push(`note: ${t.conflict.join('+')} fired opposite here`);
  if (t.lmAgrees === true) { score += C.lm; confirms.push('LM agrees (+1)'); }
  else if (t.lmAgrees === false) { score -= C.lm; invalidations.push('LM disagrees (−1)'); }

  // ── verdict ──
  const hardVeto = invalidations.some(v => /sit out|long-only|irrational/.test(v));
  const verdict: 'take' | 'skip' = (!hardVeto && score >= C.takeScore) ? 'take' : 'skip';

  // ── size: framework base, trimmed by confirmation strength + stress ──
  let size: SizeTier | null = null;
  if (verdict === 'take') {
    size = t.sizeBase;
    if (ctx.gateSizeDown && size === 'N') size = 'M';
    if (score < C.takeScore + 2 && size === 'N') size = 'M';   // marginal confirm → trim full size
  }

  // ── break forming: a bounce thesis killed by a clean opposite break ──
  let breakForming: ConfirmResult['breakForming'] = null;
  if (isBounce && verdict === 'skip' && (l3.sweepAgainst || cvdWith <= -C.cvdThresh)) {
    const bd: 'long' | 'short' = t.direction === 'long' ? 'short' : 'long';
    breakForming = {
      dir: bd, trigger: t.level,
      note: `${t.direction}-bounce invalidated → ${bd} BREAK forming (sweep ${l3.sweepAgainst}, CVD60 ${l3.cvd60}, pull ${l3.pull})`,
    };
  }

  return { verdict, size, confirmationScore: score, confirms, invalidations, breakForming, diagnostic: narrate(t, l3, ctx, verdict, size, score, confirms, invalidations, breakForming) };
}

// Detailed human-readable diagnostic (Ravi wants these rich — engine thesis, the
// confluence, the exact L3 evidence, the verdict, and what's forming instead).
function narrate(t: Thesis, l3: L3Read, ctx: CtxRead, verdict: string, size: SizeTier | null,
                 score: number, confirms: string[], invalidations: string[],
                 bf: ConfirmResult['breakForming']): string {
  const head = `${t.engines.join('+')||'?'} fired ${t.direction.toUpperCase()}-${t.bounceVsBreak} at ${t.level}`
    + ` (conf ${t.confluence}, base_prob ${t.baseProb}, LM ${t.lmAgrees === null ? '—' : t.lmAgrees ? 'agrees' : 'disagrees'}, size ${t.sizeBase}).`;
  const book = `L3: wall ${l3.wall}/${l3.defendSide}, gap ${l3.impliedGap}, ice ${l3.nativeIce}+${l3.synthRefills}, traded ${l3.executedNear},`
    + ` pull ${l3.pull}, adds ${l3.adds}, CVD60 ${l3.cvd60}, aggr ${l3.aggrBuy}/${l3.aggrSell},`
    + ` sweep ${l3.sweepWith ? 'with' : l3.sweepAgainst ? 'against' : 'none'}, cluster ${Math.round(l3.clusterDominance * 100)}%.`;
  const ver = `→ ${verdict.toUpperCase()}${size ? ' ' + size : ''} (score ${score}/${C.takeScore}). `
    + `confirms[${confirms.join(' | ')}] vetoes[${invalidations.join(' | ')}].`;
  const brk = bf ? ` ⚠ ${bf.note}` : '';
  return head + ' ' + book + ' ' + ver + brk;
}
