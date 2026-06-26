// One-shot: does the RS framework propose ANY trade at NQ QQQ Open (29718.75) on 06-23?
// Runs the real engines via buildThesis. rs-context is CURRENT (not historized) — used as
// a proxy for gate/confluence; the engine *level* firing depends on the 06-23 levels, not rs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContext, getContext } from '../src/rs-context.js';
import { deriveMarketState } from '../src/rules-v2/derive-market-state.js';
import { buildThesis } from '../src/l3/engine-thesis.js';
import type { DailyLevels } from '@trading/contracts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DAY = '2026-06-23';
const PRICE_AT_TOUCH = 29718.75; // QQQ Open — the genuine touch was ~14:24

const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'daily_levels.json'), 'utf8'));
const lv = doc.days[DAY].levels.find((x: any) => x.symbol === 'NQ');
const levels = { ts: 0, source: 'levels', type: 'daily', tradingDay: DAY, ...lv } as DailyLevels;

loadContext();
const rs = getContext('NQ');
const ms = deriveMarketState({ symbol: 'NQ', rs, levels, price: PRICE_AT_TOUCH });

console.log('06-23 NQ levels in file:');
console.log('  ddBands:', lv.ddBands, '  hedgePressure(HP):', lv.hedgePressure, '  mhp:', lv.mhp);
const qqqo = (lv.additionalLevels || []).find((a: any) => /QQQ Open/i.test(a.label))?.price;
console.log('  QQQ Open:', qqqo, '  (price at touch =', PRICE_AT_TOUCH, ')');
console.log('  derived gate:', JSON.stringify(ms.gate), ' gm:', ms.confluence?.gm, ' rational:', ms.confluence?.isRational);
console.log('  ddUpper/ddLower in MS:', ms.levels?.ddUpper, ms.levels?.ddLower);
console.log('');

// test buildThesis at QQQ Open AND at the real engine levels for comparison
const candidates: Array<[string, number | undefined]> = [
  ['QQQ Open', qqqo],
  ['HP', lv.hedgePressure],
  ['MHP', lv.mhp],
  ['DD upper', lv.ddBands?.upper],
  ['DD lower', lv.ddBands?.lower],
];
for (const z of (lv.zones?.bull || [])) candidates.push([`BullZone low ${z.low}`, z.low]);
for (const z of (lv.zones?.bear || [])) candidates.push([`BearZone high ${z.high}`, z.high]);

console.log('buildThesis at each candidate level:');
for (const [name, p] of candidates) {
  if (p == null) { console.log(`  ${name}: (no price in file)`); continue; }
  const t = buildThesis(ms, p);
  if (!t) { console.log(`  ${name.padEnd(22)} @${p}: NO THESIS (no engine fires here)`); }
  else console.log(`  ${name.padEnd(22)} @${p}: THESIS ${t.direction}/${t.bounceVsBreak} engines=${t.engines.join('+')} conf=${t.confluence} size=${t.sizeBase}`);
}
