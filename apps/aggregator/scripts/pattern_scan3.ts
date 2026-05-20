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

// Rebuild uncaught moves list
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

// Absorbed counter-spike: CVD background aligned (>=1500) + trigger bar OPPOSED (>=300 in opposite direction)
function firesAbsorbedSpike(cDelta15: number, triggerDelta: number): 'long' | 'short' | null {
  // Long: buyers background, seller spike absorbed
  if (cDelta15 >= 1500 && triggerDelta <= -300) return 'long';
  // Short: sellers background, buyer spike absorbed
  if (cDelta15 <= -1500 && triggerDelta >= 300) return 'short';
  return null;
}

const absorbed = moves.filter(m => firesAbsorbedSpike(m.cDelta15, m.triggerDelta) === m.direction);

process.stdout.write(`Absorbed counter-spike moves (of 58 uncaught): ${absorbed.length}\n\n`);
absorbed.forEach(m => {
  const dt = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(m.ts));
  process.stdout.write(`  ${dt} ${m.direction.padEnd(5)} mag=${m.magnitude.toFixed(0).padStart(3)}  cD15=${m.cDelta15.toFixed(0).padStart(7)}  trigger=${m.triggerDelta.toFixed(0).padStart(6)}\n`);
});

// False positive scan across ALL RTH bars
// For each bar that fires the absorbed-spike condition, check if a 40pt move follows in 45 bars
// in the SAME direction as the signal
let fp = 0, tp = 0, wrongDir = 0;
const absorbedTs = new Set(absorbed.map(m => m.ts));

for (let k = 15; k < bars.length - 45; k++) {
  const bar = bars[k];
  if (!isRTH(bar.ts)) continue;
  let cDelta15 = 0;
  for (let j = k-15; j <= k; j++) cDelta15 += bars[j].bv - bars[j].sv;
  const triggerDelta = bar.bv - bar.sv;
  const signalDir = firesAbsorbedSpike(cDelta15, triggerDelta);
  if (!signalDir) continue;

  if (absorbedTs.has(bar.ts)) { tp++; continue; }

  // Check if a 40pt move follows in the SIGNAL direction
  let movesWithSignal = false;
  let movesAgainst = false;
  for (let j = 1; j <= 45 && k+j < bars.length; j++) {
    if (signalDir === 'long' && bars[k+j].high - bar.close >= 40) { movesWithSignal = true; break; }
    if (signalDir === 'short' && bar.close - bars[k+j].low >= 40) { movesWithSignal = true; break; }
  }
  // Also check opposite direction (already caught by gold signal or missed?)
  if (!movesWithSignal) {
    for (let j = 1; j <= 45 && k+j < bars.length; j++) {
      if (signalDir === 'long' && bar.close - bars[k+j].low >= 40) { movesAgainst = true; break; }
      if (signalDir === 'short' && bars[k+j].high - bar.close >= 40) { movesAgainst = true; break; }
    }
    if (movesAgainst) wrongDir++;
    else fp++;
  }
}

const rthBars = bars.filter(b => isRTH(b.ts)).length;
const sessions = Math.round(rthBars / 390);
const totalFires = fp + tp + wrongDir;

process.stdout.write(`\n--- False positive analysis (|cD15|>=1500, opposed trigger >=300) ---\n`);
process.stdout.write(`Total signal fires across ${sessions} sessions: ${totalFires}\n`);
process.stdout.write(`  TP: signal fires on uncaught move onset: ${tp}\n`);
process.stdout.write(`  FP: fires, no 40pt move in that direction: ${fp}\n`);
process.stdout.write(`  Wrong dir: fires, but 40pt move goes the other way: ${wrongDir}\n`);
process.stdout.write(`Fires per session: ~${(totalFires/sessions).toFixed(1)}\n`);
process.stdout.write(`Precision (TP / total fires): ${(tp/totalFires*100).toFixed(1)}%\n`);
process.stdout.write(`\n`);

// Try tighter thresholds and see the tradeoff
const thresholds = [
  { cvd: 2000, trigger: 300 },
  { cvd: 2000, trigger: 500 },
  { cvd: 2500, trigger: 300 },
  { cvd: 3000, trigger: 300 },
  { cvd: 1500, trigger: 500 },
  { cvd: 1500, trigger: 800 },
];

process.stdout.write(`Threshold sensitivity:\n`);
process.stdout.write(`${'cvd'.padStart(6)} ${'trig'.padStart(5)} ${'fires/sess'.padStart(11)} ${'TP'.padStart(4)} ${'FP'.padStart(5)} ${'precision'.padStart(10)}\n`);

for (const t of thresholds) {
  function fires2(cd: number, td: number): 'long'|'short'|null {
    if (cd >= t.cvd && td <= -t.trigger) return 'long';
    if (cd <= -t.cvd && td >= t.trigger) return 'short';
    return null;
  }
  const tpSet = new Set(moves.filter(m => fires2(m.cDelta15, m.triggerDelta) === m.direction).map(m => m.ts));
  let tfp = 0, ttp = 0;
  for (let k = 15; k < bars.length - 45; k++) {
    const bar = bars[k];
    if (!isRTH(bar.ts)) continue;
    let cd15 = 0;
    for (let j = k-15; j <= k; j++) cd15 += bars[j].bv - bars[j].sv;
    const td = bar.bv - bar.sv;
    const dir = fires2(cd15, td);
    if (!dir) continue;
    if (tpSet.has(bar.ts)) { ttp++; continue; }
    let hit = false;
    for (let j = 1; j <= 45 && k+j < bars.length; j++) {
      if (dir==='long' && bars[k+j].high - bar.close >= 40) { hit = true; break; }
      if (dir==='short' && bar.close - bars[k+j].low >= 40) { hit = true; break; }
    }
    if (!hit) tfp++;
  }
  const tot = ttp + tfp;
  if (tot === 0) { process.stdout.write(`${String(t.cvd).padStart(6)} ${String(t.trigger).padStart(5)} ${'0'.padStart(11)} ${'0'.padStart(4)} ${'0'.padStart(5)} ${'n/a'.padStart(10)}\n`); continue; }
  process.stdout.write(`${String(t.cvd).padStart(6)} ${String(t.trigger).padStart(5)} ${(tot/sessions).toFixed(1).padStart(11)} ${String(ttp).padStart(4)} ${String(tfp).padStart(5)} ${(ttp/tot*100).toFixed(1).padStart(9)}%\n`);
}
