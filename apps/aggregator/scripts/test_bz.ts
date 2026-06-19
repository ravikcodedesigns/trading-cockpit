// Smoke test for the bull/bear-zone (DD-Ratio matrix) engine. Run: pnpm exec tsx scripts/test_bz.ts
import { evaluateBullBearZone, openZone } from '../src/rules-v2/bz-engine.js';
import type { MarketState, Gate } from '../src/rules-v2/engine-types.js';

const gate: Gate = { mode: 'normal', longOnly: false, sizeDown: false, reasons: [], ddBandBreak: {}, mhpBreak: {}, unusual: { indexDivergence: null, uvxyBullZoneBottom: null } };

function ms(price: number, lmCode: string | undefined, dd: number, over: Partial<Gate> = {}): MarketState {
  return {
    symbol: 'NQ', tsET: 't', price, open: 30450, prevClose: 30200, halfGap: 30630,
    levels: { bzb: [30560], brzt: [30340], hp: 30410, mhp: 30476, ddUpper: 30960, ddLower: 30150 },
    lmCode,
    confluence: { gm: 'bull', ddRatio: dd, resWhite: 73, resBlue: -29, resOrange: 50, mmBullish: true, vx: 16.8, bbb: 17.4, vvix: 90, vxAboveBBB: false, vvixElevated: false, isRational: true },
    gate: { ...gate, ...over },
  };
}

const show = (label: string, m: MarketState) => {
  const s = evaluateBullBearZone(m);
  console.log(`\n● ${label} (open-zone ${openZone(m.lmCode)}, DD ${m.confluence.ddRatio})`);
  if (!s.length) { console.log('   — none —'); return; }
  for (const x of s) console.log(`   ${x.pivot} ${x.direction} ${x.sizeTier}  entry ${x.entry} stop ${x.stop} → [${x.targets.join(', ')}]  (p${x.baseProb})\n     ${x.confluenceNote}`);
};

show('Open B @BZB, DD>0.5 → long N', ms(30560, 'BLD', 0.66));
show('Open B @BZB, DD<0.5 → long M', ms(30560, 'BLD', 0.40));
show('Open Br @BrZT, DD>0.5 → long N (tap only)', ms(30340, 'BrLD', 0.66));
show('Open Br @BrZT, DD<0.5 → short N (down)', ms(30340, 'BrLD', 0.40));
show('Open MR pocket, DD>0.5 → long N (upside)', ms(30450, undefined, 0.66));
show('Open MR pocket, DD<0.5 → short S (downside)', ms(30450, undefined, 0.40));
show('Open Br @BrZT, DD<0.5 but long-only gate → none', ms(30340, 'BrLD', 0.40, { mode: 'strong-pivots-small', longOnly: true }));
show('Open B but price not at BZB → none', ms(30450, 'BLD', 0.66));
show('gate sit-out → none', ms(30560, 'BLD', 0.66, { mode: 'sit-out' }));
