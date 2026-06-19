// Smoke test for the DD-bands engine (Phase 5). Run: pnpm exec tsx scripts/test_dd.ts
import { evaluateDdBands } from '../src/rules-v2/dd-engine.js';
import type { MarketState, Gate } from '../src/rules-v2/engine-types.js';

const gate: Gate = { mode: 'normal', longOnly: false, sizeDown: false, reasons: [], ddBandBreak: {}, mhpBreak: {}, unusual: { indexDivergence: null, uvxyBullZoneBottom: null } };

function ms(price: number, dd = 0.66, over: Partial<Gate> = {}): MarketState {
  return {
    symbol: 'NQ', tsET: 't', price, open: 30620, prevClose: 30200, halfGap: 30630,
    levels: { bzb: [30560], brzt: [30340], hp: 30410, mhp: 30476, ddUpper: 30960, ddLower: 30440 },
    lmCode: 'BLD',
    confluence: { gm: 'bull', ddRatio: dd, resWhite: 73, resBlue: -29, resOrange: 50, mmBullish: true, vx: 16.8, bbb: 17.4, vvix: 90, vxAboveBBB: false, vvixElevated: false, isRational: true },
    gate: { ...gate, ...over },
  };
}

const show = (label: string, m: MarketState) => {
  const s = evaluateDdBands(m);
  console.log(`\n● ${label} (price ${m.price}, DD ${m.confluence.ddRatio})`);
  if (!s.length) { console.log('   — none —'); return; }
  for (const x of s) console.log(`   ${x.pivot} ${x.direction} ${x.sizeTier}  entry ${x.entry} stop ${x.stop} → [${x.targets.join(', ')}]  (${x.bounceVsBreak}, p${x.baseProb})\n     ${x.confluenceNote}`);
};

show('lower band, DD>0.5 → long N', ms(30440, 0.66));
show('lower band, DD<0.5 → long M', ms(30440, 0.40));
show('upper band, DD<0.5 → short N (DD<0.5 ONLY)', ms(30960, 0.40));
show('upper band, DD>0.5 → no entry (exit target, no fade in bull)', ms(30960, 0.66));
show('upper band, DD<0.5 but gate long-only → no short', ms(30960, 0.40, { mode: 'strong-pivots-small', longOnly: true }));
show('lower band, gate sizeDown → N→M', ms(30440, 0.66, { sizeDown: true }));
show('mid-range, no band nearby → none', ms(30700, 0.66));
show('gate sit-out → none', ms(30440, 0.66, { mode: 'sit-out' }));
