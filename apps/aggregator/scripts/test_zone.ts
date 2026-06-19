// Smoke test for the sandwich/zone-combination engine (Phase 4). Run: pnpm exec tsx scripts/test_zone.ts
import { evaluateSandwich } from '../src/rules-v2/zone-engine.js';
import type { MarketState, Gate } from '../src/rules-v2/engine-types.js';

const gate: Gate = { mode: 'normal', longOnly: false, sizeDown: false, reasons: [], ddBandBreak: {}, mhpBreak: {}, unusual: { indexDivergence: null, uvxyBullZoneBottom: null } };

function ms(price: number, bzb: number[], brzt: number[], over: Partial<Gate> = {}, dd = 0.66): MarketState {
  return {
    symbol: 'NQ', tsET: 't', price, open: 30620, prevClose: 30200, halfGap: 30630,
    levels: { bzb, brzt, hp: 30410, mhp: 30476, ddUpper: 30960, ddLower: 30440 },
    lmCode: 'BLD',
    confluence: { gm: 'bull', ddRatio: dd, resWhite: 73, resBlue: -29, resOrange: 50, mmBullish: true, vx: 16.8, bbb: 17.4, vvix: 90, vxAboveBBB: false, vvixElevated: false, isRational: true },
    gate: { ...gate, ...over },
  };
}

const show = (label: string, m: MarketState) => {
  const s = evaluateSandwich(m);
  console.log(`\n● ${label} (price ${m.price})`);
  if (!s.length) { console.log('   — none —'); return; }
  for (const x of s) console.log(`   ${x.pivot} ${x.direction} ${x.sizeTier}  entry ${x.entry} stop ${x.stop} → [${x.targets.join(', ')}]  (${x.bounceVsBreak})\n     ${x.confluenceNote}`);
};

// Case A — sandwich hold-through: at BZB 30560, above = BrZT 30700 then BZB 30900.
show('A: at BZB, BrZT+BZB above → hold-through BZB→BZB', ms(30560, [30560, 30900], [30700]));
// Case B — two-step: at BrZT 30340 (from below), above = BZB 30560 then BrZT 30900.
show('B: at BrZT from below, BZB+BrZT above → two-step leg 1', ms(30340, [30560], [30340, 30900]));
// DD<0.5 → M instead of N
show('A with DD<0.5 → M', ms(30560, [30560, 30900], [30700], {}, 0.4));
// gate sizeDown → step down
show('A with sizeDown → N→M', ms(30560, [30560, 30900], [30700], { sizeDown: true }));
// no stacking → none
show('no sandwich pattern (single BZB)', ms(30560, [30560], [30340]));
// sit-out → none
show('gate sit-out → none', ms(30560, [30560, 30900], [30700], { mode: 'sit-out' }));
