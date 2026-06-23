// L3 level-touch DECISION ENGINE — v1 (shadow only; NOT wired to the trader).
//
// At a touch of an RS level, fuse EVERYTHING we have — the live L3 book read +
// the full RS context (greater-market, the 3 resiliences, DD ratio, LM/MM, VX/
// BBB/VVIX, VX-gamma state, EM/DD bands, ETF-vs-MHP) — into one transparent
// long/short/skip call with a written rationale, so we can shadow it for a week
// and tune the rules before risking capital.
//
// Design principle (per project_level_autotrader): encode KNOWN framework rules +
// the validated observation that CVD CONTEXT (level + slope) — not the static wall
// size — separated winners from losers across 06-18/06-23. Every weight is a named
// constant so it's tunable from the shadow results. No fitted parameters.

export interface DecisionInput {
  symbol: string;
  level: { label: string; price: number; kind: string };
  approach: 'above' | 'below';   // price approached the level from above / below
  price: number;
  // ── live L3 book read at the touch ──
  defendSide: 'bid' | 'ask';
  wall: number;          // L2 depth within ±WALL of the level on the defending side
  l3Size: number;        // MBO-reconstructed size there
  impliedGap: number;    // wall − l3Size (hidden/iceberg liquidity)
  icebergs: number;      // # refilling orders at the level
  cvd: number;           // session cumulative CVD
  cvd60: number;         // CVD slope (last ~60s) — the key discriminator
  aggrBuy: number;       // aggressor buy vol into the level (last ~30s)
  aggrSell: number;
  // ── full RS context (rs-context.json, per symbol where available) ──
  gm: 'bull' | 'bear' | 'neutral';
  mmBullish: boolean | null;
  mhpResilience: number;
  hpResilience: number;
  redistResilience: number;
  ddRatio: number;
  lmCode: string | null;
  isRational: boolean;          // VX<BBB and VVIX not elevated
  vxAboveBBB: boolean;
  vvixElevated: boolean;
  vxVolState: 'pinned' | 'above-hp' | 'above-mhp' | null;  // VX vs its gamma walls
  ddUpper: number | null;
  ddLower: number | null;
  em1Low: number | null;
  em1High: number | null;
  em2Low: number | null;
  em2High: number | null;
}

export interface Decision {
  action: 'long' | 'short' | 'skip';
  setup: 'bounce' | 'break' | null;   // direction relative to the level
  size: 'S' | 'M' | 'L' | null;
  score: number;                       // signed conviction (+long / −short)
  reasons: string[];                   // every contribution, for audit
  vetoes: string[];                    // hard blocks applied
}

// ── tunable weights (calibrate from the shadow week) ─────────────────────────
const W = {
  gm: 2,            // greater-market directional bias
  cvd60Strong: 200, cvd60Weak: 60,   // CVD-slope thresholds
  cvd60: 2,         // weight when CVD slope is decisive
  mm: 1,            // monthly-map bias
  tapeMin: 25, tape: 1,              // aggressor-at-level imbalance
  resStrong: 30, resWeak: -50,      // summed-resilience thresholds
  res: 1,
  wallStrong: 60,   // a wall this big WITH absorption supports a fade (rare; 06-18 showed big walls often trap, so weighted low)
  takeScore: 3,     // |score| needed to act
};

export function decide(i: DecisionInput): Decision {
  const reasons: string[] = [];
  const vetoes: string[] = [];
  // fade = trade away from the level (bounce); break = continue through it
  const fadeDir: 'long' | 'short' = i.approach === 'above' ? 'long' : 'short';
  const breakDir: 'long' | 'short' = i.approach === 'above' ? 'short' : 'long';

  let score = 0; // + = long lean, − = short lean

  // 1) Greater market (framework §2): bull → long bias; bear → symmetric.
  if (i.gm === 'bull') { score += W.gm; reasons.push(`GM bull (+${W.gm} long)`); }
  else if (i.gm === 'bear') { score -= W.gm; reasons.push(`GM bear (−${W.gm} short)`); }
  else reasons.push('GM neutral');

  // 2) CVD slope — the validated discriminator (06-18/06-23). Trend in the flow.
  if (i.cvd60 >= W.cvd60Strong) { score += W.cvd60; reasons.push(`CVD60 +${i.cvd60} buyers (+${W.cvd60})`); }
  else if (i.cvd60 <= -W.cvd60Strong) { score -= W.cvd60; reasons.push(`CVD60 ${i.cvd60} sellers (−${W.cvd60})`); }
  else if (Math.abs(i.cvd60) < W.cvd60Weak) reasons.push(`CVD60 ${i.cvd60} flat (chop risk)`);

  // 3) Monthly map.
  if (i.mmBullish === true) { score += W.mm; reasons.push(`MM bull (+${W.mm})`); }
  else if (i.mmBullish === false) { score -= W.mm; reasons.push(`MM bear (−${W.mm})`); }

  // 4) Aggressor at the level (last 30s).
  if (i.aggrBuy > 2 * Math.max(1, i.aggrSell) && i.aggrBuy > W.tapeMin) { score += W.tape; reasons.push(`buyers into level (+${W.tape})`); }
  else if (i.aggrSell > 2 * Math.max(1, i.aggrBuy) && i.aggrSell > W.tapeMin) { score -= W.tape; reasons.push(`sellers into level (−${W.tape})`); }

  // 5) Resilience (level strength). Strong → the level holds → favor the FADE;
  //    weak → it breaks → favor the BREAK. Adds to score in the relevant dir.
  const resSum = i.mhpResilience + i.hpResilience + i.redistResilience;
  if (resSum >= W.resStrong) { score += (fadeDir === 'long' ? W.res : -W.res); reasons.push(`strong resilience ${resSum.toFixed(0)} → favor fade`); }
  else if (resSum <= W.resWeak) { score += (breakDir === 'long' ? W.res : -W.res); reasons.push(`weak resilience ${resSum.toFixed(0)} → favor break`); }

  // 6) L3 absorption (weighted low — big static walls trap, per 06-18). A wall
  //    that is BOTH big and being refilled (iceberg / hidden gap) supports a fade.
  if (i.wall >= W.wallStrong && (i.icebergs > 0 || i.impliedGap > i.wall * 0.3)) {
    score += (fadeDir === 'long' ? 1 : -1);
    reasons.push(`absorbing wall ${i.wall} (ice ${i.icebergs}, gap ${i.impliedGap}) → fade`);
  }

  // ── VETOES (hard gates) ──
  let sizeCap: 'S' | 'M' | 'L' | null = null;
  if (!i.isRational) { sizeCap = 'M'; reasons.push('not rational (VX>BBB / VVIX) → cap size'); }
  if (i.vxVolState === 'above-mhp') { vetoes.push('VX above gamma-MHP — vol inflection, sit out'); }
  // irrational territory (rs-level-scorer rule): no shorts below DD-lower, no longs above DD-upper
  const belowDD = i.ddLower != null && i.price < i.ddLower;
  const aboveDD = i.ddUpper != null && i.price > i.ddUpper;
  if (belowDD) vetoes.push('price < DD-lower — no shorts (irrational)');
  if (aboveDD) vetoes.push('price > DD-upper — no longs (irrational)');

  // ── resolve ──
  let action: 'long' | 'short' | 'skip' = 'skip';
  if (score >= W.takeScore) action = 'long';
  else if (score <= -W.takeScore) action = 'short';

  if (action === 'short' && belowDD) { action = 'skip'; vetoes.push('short vetoed (below DD-lower)'); }
  if (action === 'long' && aboveDD) { action = 'skip'; vetoes.push('long vetoed (above DD-upper)'); }
  if (vetoes.some(v => v.includes('sit out'))) action = 'skip';

  const setup = action === 'skip' ? null : (action === fadeDir ? 'bounce' : 'break');
  let size: 'S' | 'M' | 'L' | null = null;
  if (action !== 'skip') {
    const a = Math.abs(score);
    size = a >= 6 ? 'L' : a >= 4 ? 'M' : 'S';
    if (sizeCap && size === 'L') size = sizeCap;   // cap on stress
  }
  return { action, setup, size, score, reasons, vetoes };
}
