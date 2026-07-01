// Smoke test for the sandwich/zone engine (rewired 2026-06-29 to consume ms.pockets from
// zone-pockets.ts). Builds full zone rectangles, lets classifyPockets validate the 50pt gap +
// 150pt walls, then shows what evaluateSandwich fires. Run: pnpm exec tsx scripts/test_zone.ts
// (Assertion coverage lives in scripts/zone_pockets_demo.ts.)
import { evaluateSandwich } from '../src/rules-v2/zone-engine.js';
import { classifyPockets } from '../src/rules-v2/zone-pockets.js';
import type { MarketState, Gate } from '../src/rules-v2/engine-types.js';

const gate: Gate = { mode: 'normal', longOnly: false, sizeDown: false, reasons: [], ddBandBreak: {}, mhpBreak: {}, unusual: { indexDivergence: null, uvxyBullZoneBottom: null } };
type Z = { low: number; high: number };

function ms(price: number, bull: Z[], bear: Z[], over: Partial<Gate> = {}, dd = 0.66): MarketState {
  return {
    symbol: 'NQ', tsET: 't', price, open: 30620, prevClose: 30200, halfGap: 30630,
    levels: { bzb: bull.map(z => z.low), brzt: bear.map(z => z.high), hp: 30410, mhp: 30476, ddUpper: 30960, ddLower: 30440 },
    lmCode: 'BLD',
    confluence: { gm: 'bull', ddRatio: dd, resWhite: 73, resBlue: -29, resOrange: 50, mmBullish: true, vx: 16.8, bbb: 17.4, vvix: 90, vxAboveBBB: false, vvixElevated: false, isRational: true },
    gate: { ...gate, ...over },
    pockets: classifyPockets(bull, bear, { symbol: 'NQ' }),
  };
}

const show = (label: string, m: MarketState) => {
  const s = evaluateSandwich(m);
  console.log(`\n● ${label} (price ${m.price})`);
  if (!s.length) { console.log('   — none —'); return; }
  for (const x of s) console.log(`   ${x.pivot} ${x.direction} ${x.sizeTier}  entry ${x.entry} stop ${x.stop} → [${x.targets.join(', ')}]  (${x.bounceVsBreak})\n     ${x.confluenceNote}`);
};

// A — bear in middle (bull·bear·bull), tight gaps → Sandwich-A hold-through at the bottom BZB.
show('A: bull·bear·bull, gaps ≤50 → Sandwich-A', ms(30560, [{ low: 30560, high: 30575 }, { low: 30660, high: 30675 }], [{ low: 30605, high: 30620 }]));
// B — bull in middle (bear·bull·bear), tight gaps → Sandwich-B two-step at the bottom BrZT.
show('B: bear·bull·bear, gaps ≤50 → Sandwich-B leg1', ms(30575, [{ low: 30605, high: 30620 }], [{ low: 30560, high: 30575 }, { low: 30660, high: 30675 }]));
// gaps too wide (>50) → no sandwich (the old adjacency engine WOULD have fired here).
show('gaps >50 → none (old engine would fire)', ms(30560, [{ low: 30560, high: 30575 }, { low: 30900, high: 30915 }], [{ low: 30700, high: 30715 }]));
// middle zone is a wall (>150pt body) → suppressed.
show('middle wall (>150pt) → none', ms(30575, [{ low: 30605, high: 30900 }], [{ low: 30560, high: 30575 }, { low: 30940, high: 30955 }]));
// sit-out gate → none.
show('gate sit-out → none', ms(30560, [{ low: 30560, high: 30575 }, { low: 30660, high: 30675 }], [{ low: 30605, high: 30620 }], { mode: 'sit-out' }));
