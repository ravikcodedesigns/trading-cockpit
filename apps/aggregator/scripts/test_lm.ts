// Smoke test for the LM engine (Phase 3). Run: pnpm exec tsx scripts/test_lm.ts
import { lmRead, annotateWithLm, lmLegs } from '../src/rules-v2/lm-engine.js';
import { evaluateEst } from '../src/rules-v2/est-engine.js';
import type { MarketState, Gate } from '../src/rules-v2/engine-types.js';

const gate: Gate = { mode: 'normal', longOnly: false, sizeDown: false, reasons: [], ddBandBreak: {}, mhpBreak: {}, unusual: { indexDivergence: null, uvxyBullZoneBottom: null } };

function ms(lmCode: string | undefined, price = 30560, open = 30620): MarketState {
  return {
    symbol: 'NQ', tsET: 't', price, open, prevClose: 30200, halfGap: 30630,
    levels: { bzb: [30560], brzt: [30340], hp: 30410, mhp: 30476, dynHp: 30616, dynMhp: 30511, ddUpper: 30960, ddLower: 30440 },
    lmCode,
    confluence: { gm: 'bull', ddRatio: 0.66, resWhite: 73.8, resBlue: -29.3, resOrange: 49.9, mmBullish: true, vx: 16.8, bbb: 17.4, vvix: 90, vxAboveBBB: false, vvixElevated: false, isRational: true },
    gate,
  };
}

console.log('=== lmRead per code ===');
for (const c of ['BLU', 'BSU', 'BLD', 'BSD', 'BrLU', 'BrSU', 'BrLD', 'BrSD']) {
  const r = lmRead(ms(c));
  console.log(`  ${c.padEnd(5)} → bias ${r!.bias.padEnd(4)} target ${String(r!.target).padEnd(4)} @${r!.targetLevel}  p${(r!.prob * 100).toFixed(0)}%`);
}
console.log('  MR (open<WHP):', lmRead(ms(undefined, 30560, 30400))?.note);   // open 30400 < hp 30410
console.log('  MR (open>WHP):', lmRead(ms(undefined, 30560, 30500))?.note);   // open 30500 > hp 30410

console.log('\n=== EST setup annotated with LM (BLD: bull bias, price at BZB long) ===');
for (const s of annotateWithLm(ms('BLD'), evaluateEst(ms('BLD'))))
  console.log(`  ${s.pivot} ${s.direction} ${s.sizeTier}  | LM ${s.lmCode} bias=${s.lmBias} p${(s.lmProb * 100).toFixed(0)}% agrees=${s.lmAgrees}`);

console.log('\n=== EST short vs bullish LM (conflict surfaced) ===');
const bear = ms('BLD', 30341); bear.confluence.ddRatio = 0.35; bear.confluence.gm = 'bear';
for (const s of annotateWithLm(bear, evaluateEst(bear)))
  console.log(`  ${s.pivot} ${s.direction} ${s.sizeTier}  | LM ${s.lmCode} bias=${s.lmBias} agrees=${s.lmAgrees}`);

console.log('\n=== LM_PLAYBOOK legs · bull confluence (DD 0.66, Res +73.8, MRes +49.9) ===');
for (const c of ['IP', 'LP', 'BLD', 'BrLD', 'BrSU', 'BSU']) {
  const legs = lmLegs(ms(c));
  console.log(`  ${c.padEnd(4)} ` + legs.map(l => `${l.id}:${l.dir[0]}/${l.size}@${l.at}${l.breakOnly ? `(${l.breakOnly}brk)` : ''}`).join('  '));
}
console.log('\n=== same codes · bear confluence (DD 0.35, Res -20, MRes -30) ===');
const bear2 = (c: string) => { const m = ms(c); m.confluence.ddRatio = 0.35; m.confluence.resWhite = -20; m.confluence.resOrange = -30; return m; };
for (const c of ['IP', 'LP', 'BLD', 'BrLD', 'BrSU', 'BSU']) {
  const legs = lmLegs(bear2(c));
  console.log(`  ${c.padEnd(4)} ` + legs.map(l => `${l.id}:${l.dir[0]}/${l.size}@${l.at}`).join('  '));
}
