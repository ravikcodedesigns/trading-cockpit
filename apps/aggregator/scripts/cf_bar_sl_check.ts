import Database from 'better-sqlite3';

const trDb    = new Database('data/trading.db',   { readonly: true });
const ticksDb = new Database('data/ticks.db',     { readonly: true });
const TP = 80;

function isRTH(ms: number): boolean {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms));
  const wd = p.find(x => x.type === 'weekday')!.value;
  const h = parseInt(p.find(x => x.type === 'hour')!.value, 10);
  const m = parseInt(p.find(x => x.type === 'minute')!.value, 10);
  return ['Mon','Tue','Wed','Thu','Fri'].includes(wd) && h*60+m >= 570 && h*60+m < 960;
}
function rthEnd(ms: number): number {
  const s = new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  const [m, d, y] = s.split('/').map(Number);
  const e = new Date(`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}T00:00:00`);
  e.setUTCHours(20,0,0,0); if (e.getTime() <= ms) e.setUTCHours(21,0,0,0); return e.getTime();
}
const fwd  = ticksDb.prepare(`SELECT ts, price FROM trades WHERE symbol='NQ' AND ts > ? AND ts <= ? ORDER BY ts ASC`);
const ep_q = ticksDb.prepare(`SELECT price FROM trades WHERE symbol='NQ' AND ts >= ? ORDER BY ts ASC LIMIT 1`);
function sim(ts: number, ep: number, dir: 'long'|'short', sl: number): 'TP'|'SL'|'EOD' {
  for (const t of fwd.all(ts, rthEnd(ts)) as any[]) {
    const pnl = dir === 'long' ? t.price - ep : ep - t.price;
    if (pnl >= TP) return 'TP'; if (pnl <= -sl) return 'SL';
  }
  return 'EOD';
}

const rows = trDb.prepare(`
  SELECT q.signal_ts AS ts, q.direction, s.payload, q.context_json
  FROM qualified_signals q JOIN signals s ON s.id = q.signal_id
  WHERE q.rule_id = 'clean-impulse' AND q.symbol = 'NQ'
  ORDER BY q.signal_ts
`).all() as any[];

for (const dir of ['long', 'short'] as const) {
  const curSL = dir === 'long' ? 55 : 105;
  const label = dir === 'long' ? 'CF↑ bar low vs 55pt' : 'CF↓ bar high vs 105pt';
  const sigs = rows.filter(r => r.direction === dir && isRTH(r.ts));
  let bothWin=0, filtered=0, earlyClose=0, eod=0, skip=0, savedTotal=0;
  const filteredList: string[] = [], earlyList: string[] = [];

  for (const r of sigs) {
    const ctx = r.context_json ? JSON.parse(r.context_json) : {};
    const structSL = ctx.stopDist > 0 ? ctx.stopDist : null;
    if (!structSL) { skip++; continue; }
    const ep = ctx.entry > 1000 ? ctx.entry : ((ep_q.get(r.ts) as any)?.price ?? 0);
    if (!ep) { skip++; continue; }
    const atS = sim(r.ts, ep, dir, structSL);
    const atC = sim(r.ts, ep, dir, curSL);
    const dt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).format(new Date(r.ts)).replace(',','');
    if (atC==='TP' && atS==='TP') bothWin++;
    else if (atC==='TP' && atS==='SL') { filtered++; filteredList.push(`  ${dt}  ep=${ep.toFixed(2)}  bar-SL=${structSL.toFixed(1)}`); }
    else if (atC==='SL' && atS==='SL') { earlyClose++; savedTotal += curSL - structSL; earlyList.push(`  ${dt}  ep=${ep.toFixed(2)}  bar-SL=${structSL.toFixed(1)}  saved=${(curSL-structSL).toFixed(1)}pts`); }
    else eod++;
  }
  const avg = earlyClose > 0 ? savedTotal/earlyClose : 0;
  console.log(`\n── ${label}  n=${sigs.length - skip}`);
  console.log(`   BOTH WIN          : ${bothWin}`);
  console.log(`   WINNER FILTERED   : ${filtered}  ← stopped at bar-SL, recovered to TP`);
  console.log(`   LOSER CLOSED EARLY: ${earlyClose}  avg saved ${avg.toFixed(1)}pts each`);
  console.log(`   EOD/other         : ${eod}`);
  console.log(`   Net: ${((earlyClose*avg) - filtered*(curSL+TP)).toFixed(0)}pt vs current SL`);
  if (filteredList.length) { console.log('   Filtered winners:'); filteredList.forEach(l=>console.log(l)); }
  if (earlyList.length) { console.log('   Losers closed early:'); earlyList.forEach(l=>console.log(l)); }
}
trDb.close(); ticksDb.close();
