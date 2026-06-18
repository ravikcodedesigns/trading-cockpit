// Smoke test for deriveGate / deriveMarketState (Phase 1). Uses the live irrational
// rows read tonight + a mock context/levels. Run: pnpm exec tsx scripts/test_derive.ts
import { deriveGate, deriveMarketState } from '../src/rules-v2/derive-market-state.js';
import type { RSContext, IrrationalRule } from '../src/rs-context.js';
import type { DailyLevels } from '@trading/contracts';

const irrational: IrrationalRule[] = [
  { section: 'Irrational Rules:', name: '/EP DD-Band Break', state: 'yellow', dir: 'up' },
  { section: 'Irrational Rules:', name: '/ENQ DD-Band Break', state: 'red', dir: 'up' },
  { section: 'Irrational Rules:', name: '/RTY DD-Band Break', state: 'green', dir: null },
  { section: 'Irrational Rules:', name: 'SPY MHP Break', state: 'green', dir: null },
  { section: 'Irrational Rules:', name: 'QQQ MHP Break', state: 'red', dir: 'up' },
  { section: 'Irrational Rules:', name: 'IWM MHP Break', state: 'red', dir: 'up' },
  { section: 'Irrational Rules:', name: 'UVXY MHP Break', state: 'red', dir: 'down' },
  { section: 'Unusual Rules:', name: 'Index Divergence', state: 'yellow', dir: null },
  { section: 'Unusual Rules:', name: 'UVXY Bull Zone Bottom', state: 'green', dir: null },
];

const rs: RSContext = {
  greaterMarket: 'bull', ddRatio: 0.66,
  mhpResilience: 49.87, hpResilience: -29.29, redistResilience: 73.82, resilience: 73.82,
  vx: 16.82, bbb: 17.4, vvix: 90.06,
  vxAboveBBB: false, vvixElevated: false, vvixGolden: false, isRational: true,
  qqq: 725.79,  // live QQQ (Yahoo) — used for ETF→futures conversion of dyn HP/MHP
  irrational,
  bySymbol: { NQ: { mhpResilience: 49.87, hpResilience: -29.29, redistResilience: 73.82, resilience: 73.82, mmBullish: true, gm: 'bull',
    dynHpEtf: 725, dynMhpEtf: 722.5, dynCloseEtf: 725.79 } },
  lmCode: 'BLD',
  setAt: '2026-06-18T19:51:40-04:00', tradingDay: '2026-06-18',
};

const levels: DailyLevels = {
  ts: 0, source: 'levels', type: 'daily', symbol: 'NQ', tradingDay: '2026-06-18',
  bullZone: { low: 30560, high: 30700 }, bearZone: { low: 30200, high: 30340 },
  ddBands: { upper: 30960, lower: 30440 }, hedgePressure: 30410, mhp: 30476,
  openPrice: 30620, zones: { bull: [{ low: 30560, high: 30700 }], bear: [{ low: 30200, high: 30340 }] },
  additionalLevels: [{ price: 30630, label: 'HG' }, { price: 30413.43, label: 'ON HP' }, { price: 30475.84, label: 'ON MHP' }],
};

console.log('=== deriveGate(NQ) ===');
console.log(JSON.stringify(deriveGate('NQ', rs), null, 2));

console.log('\n=== deriveMarketState(NQ) ===');
const ms = deriveMarketState({ symbol: 'NQ', rs, levels, price: 30650, open: 30620, tsET: '2026-06-18 19:51:40' });
console.log(JSON.stringify(ms, null, 2));
