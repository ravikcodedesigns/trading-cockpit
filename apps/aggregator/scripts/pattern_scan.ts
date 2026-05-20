import Database from 'better-sqlite3';
const db = new Database('../../data/trading.db');

function isRTH(tsMs: number): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const parts = fmt.formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find((p: any) => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  const min = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  return ['Mon','Tue','Wed','Thu','Fri'].includes(weekday) && min >= 570 && min < 960;
}

// Check buyVolume population
const volCheck = db.prepare(`
  SELECT COUNT(*) as total,
    SUM(CASE WHEN json_extract(payload,'$.buyVolume') IS NOT NULL THEN 1 ELSE 0 END) as withVol
  FROM events WHERE source='bookmap' AND type='bar'
    AND json_extract(payload,'$.symbol')='NQ' AND json_extract(payload,'$.partial')=0
`).get() as any;
console.log(`Bar vol coverage: ${volCheck.withVol}/${volCheck.total} (${(volCheck.withVol/volCheck.total*100).toFixed(0)}%)`);

const bars = db.prepare(`
  SELECT ts, json_extract(payload,'$.high') as high, json_extract(payload,'$.low') as low,
         json_extract(payload,'$.close') as close,
         COALESCE(json_extract(payload,'$.buyVolume'),0) as bv,
         COALESCE(json_extract(payload,'$.sellVolume'),0) as sv
  FROM events WHERE source='bookmap' AND type='bar'
    AND json_extract(payload,'$.symbol')='NQ' AND json_extract(payload,'$.partial')=0
  ORDER BY ts ASC
`).all() as any[];

const goldSignals = db.prepare(`
  SELECT ts, direction FROM signals WHERE symbol='NQ' AND strategy_version IN ('H','EXPL','B') ORDER BY ts ASC
`).all() as any[];

const WINDOW = 45, TARGET = 40;
const moves: any[] = [];
let i = 0;
while (i < bars.length - WINDOW) {
  const bar = bars[i];
  if (!isRTH(bar.ts)) { i++; continue; }
  let maxUp = 0, maxDown = 0, hitUpAt = -1, hitDownAt = -1;
  for (let j = 1; j <= WINDOW && i+j < bars.length; j++) {
    const b = bars[i+j];
    if (b.high - bar.close > maxUp) { maxUp = b.high - bar.close; hitUpAt = j; }
    if (bar.close - b.low > maxDown) { maxDown = bar.close - b.low; hitDownAt = j; }
  }
  if (maxUp >= TARGET || maxDown >= TARGET) {
    const direction = maxUp >= maxDown ? 'long' : 'short';
    const barsToHit = direction === 'long' ? hitUpAt : hitDownAt;
    const caught = goldSignals.some((s: any) => s.direction===direction && s.ts>=bar.ts-5*60_000 && s.ts<=bar.ts+60_000);
    if (!caught) {
      const start = Math.max(0, i-15);
      let cDelta15 = 0;
      for (let k = start; k <= i; k++) cDelta15 += (bars[k].bv - bars[k].sv);
      const triggerDelta = bar.bv - bar.sv;
      moves.push({ ts: bar.ts, direction, magnitude: direction==='long'?maxUp:maxDown, barsToHit, cDelta15, triggerDelta });
    }
    i += barsToHit + 1;
  } else { i++; }
}

console.log(`\nTotal uncaught 40pt+ RTH moves: ${moves.length}`);
console.log(`  Longs: ${moves.filter(m=>m.direction==='long').length}`);
console.log(`  Shorts: ${moves.filter(m=>m.direction==='short').length}`);

const cDeltas = moves.map(m=>m.cDelta15).sort((a,b)=>a-b);
const trigDeltas = moves.map(m=>m.triggerDelta).sort((a,b)=>a-b);
console.log(`\ncDelta15 distribution over all 58 uncaught moves:`);
console.log(`  min=${cDeltas[0]?.toFixed(0)} p25=${cDeltas[Math.floor(cDeltas.length*0.25)]?.toFixed(0)} median=${cDeltas[Math.floor(cDeltas.length*0.5)]?.toFixed(0)} p75=${cDeltas[Math.floor(cDeltas.length*0.75)]?.toFixed(0)} max=${cDeltas.at(-1)?.toFixed(0)}`);
console.log(`  |cD15|>=500: ${cDeltas.filter(c=>Math.abs(c)>=500).length}  |cD15|>=1000: ${cDeltas.filter(c=>Math.abs(c)>=1000).length}  |cD15|>=2000: ${cDeltas.filter(c=>Math.abs(c)>=2000).length}  |cD15|>=3000: ${cDeltas.filter(c=>Math.abs(c)>=3000).length}`);
console.log(`\ntriggerDelta distribution:`);
console.log(`  min=${trigDeltas[0]?.toFixed(0)} median=${trigDeltas[Math.floor(trigDeltas.length*0.5)]?.toFixed(0)} max=${trigDeltas.at(-1)?.toFixed(0)}`);
console.log(`  |t|>=200: ${trigDeltas.filter(t=>Math.abs(t)>=200).length}  |t|>=400: ${trigDeltas.filter(t=>Math.abs(t)>=400).length}  |t|>=800: ${trigDeltas.filter(t=>Math.abs(t)>=800).length}`);

// Show first 15 moves
console.log('\nAll uncaught moves:');
moves.forEach(m => {
  const dt = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(m.ts));
  console.log(`  ${dt} ${m.direction.padEnd(5)} mag=${m.magnitude.toFixed(0).padStart(3)}  cD15=${m.cDelta15.toFixed(0).padStart(6)}  trigger=${m.triggerDelta.toFixed(0).padStart(6)}`);
});

