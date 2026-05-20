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

const bars = db.prepare(`
  SELECT ts,
         json_extract(payload,'$.high') as high,
         json_extract(payload,'$.low') as low,
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

const moves: any[] = [];
let i = 0;
while (i < bars.length - 45) {
  const bar = bars[i];
  if (!isRTH(bar.ts)) { i++; continue; }
  let maxUp = 0, maxDown = 0, hitUpAt = -1, hitDownAt = -1;
  for (let j = 1; j <= 45 && i+j < bars.length; j++) {
    const b = bars[i+j];
    if (b.high - bar.close > maxUp) { maxUp = b.high - bar.close; hitUpAt = j; }
    if (bar.close - b.low > maxDown) { maxDown = bar.close - b.low; hitDownAt = j; }
  }
  if (maxUp >= 40 || maxDown >= 40) {
    const direction = maxUp >= maxDown ? 'long' : 'short';
    const barsToHit = direction === 'long' ? hitUpAt : hitDownAt;
    const caught = goldSignals.some((s: any) => s.direction===direction && s.ts>=bar.ts-5*60_000 && s.ts<=bar.ts+60_000);
    if (!caught) {
      const start = Math.max(0, i-15);
      let cDelta15 = 0;
      for (let k = start; k <= i; k++) cDelta15 += bars[k].bv - bars[k].sv;
      const triggerDelta = bar.bv - bar.sv;
      moves.push({ ts: bar.ts, direction, magnitude: direction==='long'?maxUp:maxDown, barsToHit, cDelta15, triggerDelta, idx: i });
    }
    i += barsToHit + 1;
  } else { i++; }
}

// Momentum continuation: CVD aligned + trigger also aligned (both same direction as move)
const momentum = moves.filter(m => {
  const alignedCvd = m.direction === 'long' ? m.cDelta15 >= 500 : m.cDelta15 <= -500;
  const alignedTrigger = m.direction === 'long' ? m.triggerDelta >= 100 : m.triggerDelta <= -100;
  return alignedCvd && alignedTrigger;
});

process.stdout.write(`Momentum continuation moves: ${momentum.length}\n`);
process.stdout.write('\nAll momentum moves:\n');
momentum.forEach(m => {
  const dt = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(m.ts));
  process.stdout.write(`  ${dt} ${m.direction.padEnd(5)} mag=${m.magnitude.toFixed(0).padStart(3)}  cD15=${m.cDelta15.toFixed(0).padStart(6)}  trigger=${m.triggerDelta.toFixed(0).padStart(5)}\n`);
});

// False positive rate: how many RTH bars fire the signal WITHOUT a 40pt move in 45 bars?
let fpCount = 0, tpCount = 0;
const moveTs = new Set(momentum.map(m => m.ts));
for (let k = 15; k < bars.length - 45; k++) {
  const bar = bars[k];
  if (!isRTH(bar.ts)) continue;
  let cDelta15 = 0;
  for (let j = k-15; j <= k; j++) cDelta15 += bars[j].bv - bars[j].sv;
  const triggerDelta = bar.bv - bar.sv;
  const longFires = cDelta15 >= 500 && triggerDelta >= 100;
  const shortFires = cDelta15 <= -500 && triggerDelta <= -100;
  if (!longFires && !shortFires) continue;
  if (moveTs.has(bar.ts)) { tpCount++; continue; }
  let hasMove = false;
  for (let j = 1; j <= 45 && k+j < bars.length; j++) {
    if (bars[k+j].high - bar.close >= 40 || bar.close - bars[k+j].low >= 40) { hasMove = true; break; }
  }
  if (!hasMove) fpCount++;
}

const rthBars = bars.filter(b => isRTH(b.ts)).length;
const sessions = Math.round(rthBars / 390);
const totalFires = fpCount + tpCount;
process.stdout.write(`\nFalse positives (no 40pt move follows): ${fpCount}\n`);
process.stdout.write(`True positives (uncaught momentum onset): ${tpCount}\n`);
process.stdout.write(`Total signal fires across ${sessions} sessions: ${totalFires}\n`);
process.stdout.write(`Fires per session: ~${(totalFires/sessions).toFixed(0)}\n`);
process.stdout.write(`Precision: ${(tpCount/totalFires*100).toFixed(1)}%\n`);
