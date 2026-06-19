// Smoke test for the RDZ engine (Phase 6). Run: pnpm exec tsx scripts/test_rdz.ts
import { evaluateRdz, gapFillTargets } from '../src/rules-v2/rdz-engine.js';
import type { MarketState, Gate } from '../src/rules-v2/engine-types.js';

const gate: Gate = { mode: 'normal', longOnly: false, sizeDown: false, reasons: [], ddBandBreak: {}, mhpBreak: {}, unusual: { indexDivergence: null, uvxyBullZoneBottom: null } };

function ms(opts: { price?: number; open?: number; close?: number; hg?: number; resW?: number; rational?: boolean; gate?: Partial<Gate> } = {}): MarketState {
  const open = opts.open ?? 30620, close = opts.close ?? 30200, hg = opts.hg ?? 30410;
  return {
    symbol: 'NQ', tsET: 't', price: opts.price ?? hg, open, prevClose: close, halfGap: hg,
    levels: { bzb: [30560], brzt: [30340], hp: 30410, mhp: 30476, ddUpper: 30960, ddLower: 30150 },
    lmCode: 'BLD',
    confluence: { gm: 'bull', ddRatio: 0.66, resWhite: opts.resW ?? 73, resBlue: -29, resOrange: 50, mmBullish: true, vx: 16.8, bbb: 17.4, vvix: 90, vxAboveBBB: false, vvixElevated: false, isRational: opts.rational ?? true },
    gate: { ...gate, ...opts.gate },
  };
}

const show = (label: string, m: MarketState) => {
  const s = evaluateRdz(m);
  console.log(`\n● ${label}`);
  if (!s.length) { console.log('   — none —'); return; }
  for (const x of s) console.log(`   ${x.pivot} ${x.direction} ${x.sizeTier}  entry ${x.entry} stop ${x.stop} → [${x.targets.join(', ')}]  (p${x.baseProb})\n     ${x.confluenceNote}`);
};

show('at HG, Res>0 → long to top of box', ms({ resW: 73 }));
show('at HG, Res<0 → short to bottom of box', ms({ resW: -73 }));
show('at HG, Res<0 + gate long-only → no short', ms({ resW: -73, gate: { longOnly: true } }));
show('flat day (gap 20 < strike, |Res| 20 ≤ 50) → none', ms({ open: 30620, close: 30600, hg: 30610, price: 30610, resW: 20 }));
show('flat day but |Res| 60 > 50 → fires', ms({ open: 30620, close: 30600, hg: 30610, price: 30610, resW: 60 }));
show('irrational (vol) → none', ms({ resW: 73, rational: false }));
show('gate strong-pivots-small → none (RDZ is B+)', ms({ resW: 73, gate: { mode: 'strong-pivots-small' } }));
show('not at HG → none', ms({ price: 30560, resW: 73 }));
console.log('\ngapFillTargets:', gapFillTargets(ms({})));
