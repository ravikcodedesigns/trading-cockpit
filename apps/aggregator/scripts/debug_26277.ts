import { db } from '../src/db.js';

const r = db.query<{ts:number; symbol:string; signal_id: number | null; action:string}>(`
  SELECT ts, symbol, signal_id, action FROM v3_decisions
  WHERE action IN ('OPEN','CLOSE')
  ORDER BY ts ASC
`);

const target = 1780580633999;
const open: Set<string> = new Set();
const log: string[] = [];
for (const e of r) {
  if (e.ts < target && e.symbol === 'NQ') {
    if (e.action === 'OPEN')  { open.add(e.symbol);    log.push(`+ ${e.ts} OPEN  (sig=${e.signal_id})  → has NQ=${open.has('NQ')}`); }
    if (e.action === 'CLOSE') { open.delete(e.symbol); log.push(`- ${e.ts} CLOSE (sig=${e.signal_id})  → has NQ=${open.has('NQ')}`); }
  }
}
console.log('Last 10 state updates before 26277 (NQ only):');
log.slice(-10).forEach(l => console.log('  ' + l));
console.log(`\nFinal openSymbols.has(NQ) at 26277 fire time: ${open.has('NQ')}`);
