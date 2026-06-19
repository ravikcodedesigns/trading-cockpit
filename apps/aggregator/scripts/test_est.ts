// Smoke test for the EST engine (Phase 2). Run: pnpm exec tsx scripts/test_est.ts
import { evaluateEst } from '../src/rules-v2/est-engine.js';
import type { MarketState, Gate } from '../src/rules-v2/engine-types.js';

const baseGate: Gate = {
  mode: 'normal', longOnly: false, sizeDown: false, reasons: [],
  ddBandBreak: {}, mhpBreak: {}, unusual: { indexDivergence: null, uvxyBullZoneBottom: null },
};

function ms(price: number, gate: Partial<Gate> = {}): MarketState {
  return {
    symbol: 'NQ', tsET: '2026-06-18 19:55:00', price, open: 30620,
    prevClose: 30200, halfGap: 30630,
    levels: { bzb: [30560], brzt: [30340], hp: 30410, mhp: 30476, dynHp: 30616, dynMhp: 30511,
      onHp: 30413, onMhp: 30476, ddUpper: 30960, ddLower: 30440 },
    lmCode: 'BLD',
    confluence: { gm: 'bull', ddRatio: 0.66, resWhite: 73.8, resBlue: -29.3, resOrange: 49.9,
      mmBullish: true, vx: 16.8, bbb: 17.4, vvix: 90, vxAboveBBB: false, vvixElevated: false, isRational: true },
    gate: { ...baseGate, ...gate },
  };
}

const show = (label: string, m: MarketState) => {
  const s = evaluateEst(m);
  console.log(`\n● ${label}  (price ${m.price}, gate ${m.gate.mode})`);
  if (!s.length) { console.log('   — no setups —'); return; }
  for (const x of s) console.log(`   ${x.pivot} ${x.direction} ${x.sizeTier}  entry ${x.entry} stop ${x.stop} → [${x.targets.join(', ')}]  (${x.bounceVsBreak}, p≈${x.baseProb}) · ${x.confluenceNote}`);
};

show('at MHP (resOrange>0 → N long)', ms(30476));
show('at lower DD band (DD>0.5 → N)', ms(30440));
const ddBear = ms(30440); ddBear.confluence.ddRatio = 0.40;
show('at lower DD band (DD<0.5 → M, still long)', ddBear);
show('at BZB (DD>0.5 → N long)', ms(30560));
show('at BrZT from below (hold-through long)', ms(30339));
show('no level nearby', ms(30505));
show('GATE strong-pivots-small + long-only @ MHP (size capped S)', ms(30476, { mode: 'strong-pivots-small', longOnly: true, reasons: ['NQ DD-Band break up'] }));
show('GATE sit-out @ BZB', ms(30560, { mode: 'sit-out', reasons: ['VX>BBB & VVIX>100'] }));
show('GATE sizeDown @ BZB (N → M)', ms(30560, { sizeDown: true, reasons: ['UVXY MHP break up'] }));
// bear case: DD<0.5 + GM bear, at BrZT from above → short
const bear = ms(30341); bear.confluence.ddRatio = 0.35; bear.confluence.gm = 'bear';
show('BEAR: at BrZT from above, DD<0.5 + GM bear → short', bear);
