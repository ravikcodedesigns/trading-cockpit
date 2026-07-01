// l2-decider.ts — Stage 3 of the L2 Touch Decider (L2_TOUCH_DECIDER_PLAN.md §3 Stage 3).
//
// The L2 confirm/veto layer. The levels ENGINE has already gated the touch and emitted a
// DIRECTION (the framework prior — bullish at BrZT/LP/IP). This module NEVER picks direction
// cold: it APPROVES the engine's direction from causal order-flow, or VETOES it.
//
// Discipline (plan §0):
//   • Forward-only / causal — the caller computes every feature up to the decision tick.
//   • RELATIVE, not absolute — EVERY input here is an inherently-bounded RATIO (aggressor share,
//     net/gross flow, book-imbalance), so it generalizes across days with NO baseline and NO
//     fixed-magnitude threshold. Hard values (raw fought-volume, raw CVD) FAIL OOS and are banned.
//   • L2 only — no L3 (icebergs/true-aggressor) until BMD v1.2 exchange-time is validated (#13).
//   • NO `absorption` label — Stage 2 (06-25/06-26) showed it's a coin flip (absorb 49% / neutral
//     57%) and direction-unreliable; dropped as a differentiator.
//   • Posture: the engine already approved, so DEFAULT to confirm and let flow VETO when it
//     actively goes against the direction.
//
// SHADOW-ONLY. Bar (plan §0.6): beats taking every engine-approved touch in its prior direction,
// OUT OF SAMPLE, with slippage. Two days is not that. Nothing here arms a trade.

export type L2Features = {
  engineDir: 'long' | 'short';
  aggrRatio: number | null;   // buy% of fought volume at the level, 30s reaction window [0,1] — PRIMARY direction read
  cvdNorm: number | null;     // net/gross signed flow over 60s [-1,1] — scale-free flow direction
  imbalance: number | null;   // near_bid/(near_bid+near_ask) [0,1] — resting-support ratio (weak per Stage 2)
  regimeClass: string;        // camp | trend | flush | unknown
};

export type Verdict = {
  decision: 'CONFIRM' | 'VETO';
  score: number;              // >= CONFIRM_TH → CONFIRM
  reasons: string[];
};

// PER-FAMILY calibration. The order-flow read that confirms a setup depends on the level TYPE:
//   • 'pocket' (BrZT/LP/IP/BZB — a gap TRAVERSE): conviction-driven → AGGRESSION leads.
//   • 'line'   (MHP/DD/HP — a single-line BOUNCE): for a bounce-from-above the at-touch flow is
//     tautologically the SELLING approach, so aggr/cvd read bearish and (mis)veto the bounce
//     (observed on DDlo: 5 winners VETO'd). So downweight approach-flow, LEAD with RESTING SUPPORT
//     (imbalance), and lower the veto bar (negative threshold = confirm unless flow STRONGLY objects).
// ⚠️ Weights are PRINCIPLE-based defaults, NOT data-fit — Stage-2 (multi-day) must validate/tune them.
export type SetupClass = 'pocket' | 'line';
interface ClassW { aggr: number; cvd: number; imb: number; flush: number; th: number; }
const CLASS_W: Record<SetupClass, ClassW> = {
  pocket: { aggr: 1.0, cvd: 0.8, imb: 0.3, flush: 0.8, th: 0 },
  line:   { aggr: 0.3, cvd: 0.4, imb: 1.0, flush: 0.5, th: -0.3 },
};
/** Map a touch family → decider class. BZB is the IP entry (pocket); MHP/DD/HP are line bounces. */
export const setupClassOf = (family: string): SetupClass =>
  (['MHP', 'ONMHP', 'DDlo', 'DDup'].includes(family) ? 'line' : 'pocket');

export function l2Decide(f: L2Features, opts: { setupClass?: SetupClass } = {}): Verdict {
  const w = CLASS_W[opts.setupClass ?? 'pocket'];
  const dir = f.engineDir === 'long' ? 1 : -1;
  let score = 0;
  const reasons: string[] = [];
  const add = (pts: number, why: string) => { if (pts !== 0) { score += pts; reasons.push(`${pts > 0 ? '+' : ''}${pts.toFixed(2)} ${why}`); } };

  // 1) Aggressor share — buyers vs sellers hitting the level (centered at 0.5 → [-1,1]).
  if (f.aggrRatio != null) add(dir * w.aggr * (f.aggrRatio - 0.5) * 2, `aggr_ratio=${f.aggrRatio}`);
  // 2) Normalized CVD — net flow direction, scale-free.
  if (f.cvdNorm != null) add(dir * w.cvd * f.cvdNorm, `cvd_norm=${f.cvdNorm}`);
  // 3) Resting-support imbalance (PRIMARY for line-bounces; centered at 0.5 → [-1,1]).
  if (f.imbalance != null) add(dir * w.imb * (f.imbalance - 0.5) * 2, `imbalance=${f.imbalance}`);
  // 4) Flush regime with flow AGAINST the direction = knife still falling → wait.
  if (f.regimeClass === 'flush' && f.cvdNorm != null && dir * f.cvdNorm < 0) add(-w.flush, `flush against flow`);

  return { decision: score >= w.th ? 'CONFIRM' : 'VETO', score: +score.toFixed(3), reasons };
}
