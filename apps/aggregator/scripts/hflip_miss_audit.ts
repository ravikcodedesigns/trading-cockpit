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

// All H/EXPL signals (any tier) — we log all to DB regardless of gold/silenced
const allHSignals = db.prepare(`
  SELECT ts, direction, score,
         json_extract(payload,'$.pattern') as pattern,
         json_extract(payload,'$.delta5') as delta5,
         json_extract(payload,'$.delta15') as delta15,
         json_extract(payload,'$.deltaT') as deltaT,
         json_extract(payload,'$.isPositionFlip') as isPositionFlip,
         payload
  FROM signals
  WHERE symbol='NQ' AND strategy_version='H' AND json_extract(payload,'$.pattern')='FLIP'
  ORDER BY ts ASC
`).all() as any[];

// Rebuild uncaught move list (reversal/spike buckets only)
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
      const magnitude = direction==='long' ? maxUp : maxDown;
      // Only reversal/spike patterns: absorbed counter-spike or exhaustion reversal
      const absorbedSpike = direction==='long' ? (cDelta15>=1500&&triggerDelta<=-300) : (cDelta15<=-1500&&triggerDelta>=300);
      const exhaustionReversal = direction==='long' ? cDelta15<=-2000 : cDelta15>=2000;
      if (absorbedSpike || exhaustionReversal) {
        moves.push({ ts: bar.ts, direction, magnitude, barsToHit, cDelta15, triggerDelta, absorbedSpike, exhaustionReversal, idx: i });
      }
    }
    i += barsToHit + 1;
  } else { i++; }
}

const fmt = (ts: number) => new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(ts));

process.stdout.write(`Reversal/spike uncaught moves: ${moves.length}\n`);
process.stdout.write(`\n${'Move'.padEnd(14)} ${'Dir'.padEnd(6)} ${'Mag'.padStart(4)}  ${'Type'.padEnd(15)} ${'cD15'.padStart(7)}  H-FLIP within 10m?\n`);
process.stdout.write(`${'─'.repeat(95)}\n`);

let noHFlip = 0, hFlipGold = 0, hFlipSilenced = 0;
const silenceReasons: Record<string, number> = {};

for (const m of moves) {
  const type = m.absorbedSpike ? 'absorbed-spike' : 'exhaustion-rev';
  // Look for H FLIP signals within 10 min of move onset (either direction or same dir)
  const window = 10 * 60_000;
  const nearby = allHSignals.filter((s: any) => Math.abs(s.ts - m.ts) <= window && s.direction === m.direction);
  const nearbyAny = allHSignals.filter((s: any) => Math.abs(s.ts - m.ts) <= window);

  // Check if any of the same-dir nearby are gold (caught by snapshot path)
  const isGold = goldSignals.some((s: any) => s.direction===m.direction && s.ts>=m.ts-5*60_000 && s.ts<=m.ts+5*60_000);

  let hFlipNote = '';
  if (nearby.length === 0 && nearbyAny.length === 0) {
    hFlipNote = 'NO H FLIP fired at all';
    noHFlip++;
  } else if (nearby.length > 0) {
    // H FLIP fired in same direction — was it gold or silenced?
    const p = JSON.parse(nearby[0].payload);
    const d5 = Math.abs(nearby[0].delta5 ?? 0);
    const d15 = nearby[0].delta15 ?? null;
    const dT = Math.abs(nearby[0].deltaT ?? 0);
    const denom = Math.max(d5, Math.abs(p.delta_last3 ?? 0));
    const ratio = denom === 0 ? 999 : dT / denom;
    const isPosFlip = nearby[0].isPositionFlip;

    if (isGold) {
      hFlipNote = `GOLD ${fmt(nearby[0].ts)} score=${nearby[0].score}`;
      hFlipGold++;
    } else {
      // Silenced — figure out why
      let why = '';
      if (d15 !== null && m.direction==='long' && d15 >= 500) why = `delta15=+${d15} (>500 blocked)`;
      else if (d5 < (ratio <= 0.25 ? 800 : 1000)) why = `delta5=${nearby[0].delta5} too weak`;
      else if (ratio > 0.25 && ratio < 999) why = `EXPL-conflict ratio=${ratio.toFixed(2)}`;
      else why = `score=${nearby[0].score} d5=${nearby[0].delta5} d15=${d15} posFlip=${isPosFlip}`;
      hFlipNote = `SILENCED ${fmt(nearby[0].ts)} — ${why}`;
      hFlipSilenced++;
      silenceReasons[why.split(' ')[0]!] = (silenceReasons[why.split(' ')[0]!] ?? 0) + 1;
    }
  } else if (nearbyAny.length > 0) {
    // H FLIP fired but in opposite direction
    hFlipNote = `FLIP fired OPPOSITE dir (${nearbyAny[0].direction}) ${fmt(nearbyAny[0].ts)}`;
    noHFlip++;
  }

  process.stdout.write(`${fmt(m.ts).padEnd(14)} ${m.direction.padEnd(6)} ${m.magnitude.toFixed(0).padStart(4)}  ${type.padEnd(15)} ${m.cDelta15.toFixed(0).padStart(7)}  ${hFlipNote}\n`);
}

process.stdout.write(`\n--- Summary ---\n`);
process.stdout.write(`No H FLIP fired (tape pattern absent):  ${noHFlip}\n`);
process.stdout.write(`H FLIP fired but SILENCED by quality gate: ${hFlipSilenced}\n`);
process.stdout.write(`H FLIP fired and was GOLD (should have caught): ${hFlipGold}\n`);

if (Object.keys(silenceReasons).length > 0) {
  process.stdout.write(`\nSilence reason breakdown:\n`);
  for (const [k,v] of Object.entries(silenceReasons).sort((a,b)=>b[1]-a[1])) {
    process.stdout.write(`  ${k}: ${v}\n`);
  }
}

// Full H FLIP signal count for context
const totalHFlips = db.prepare(`SELECT COUNT(*) as n FROM signals WHERE symbol='NQ' AND strategy_version='H' AND json_extract(payload,'$.pattern')='FLIP'`).get() as any;
const goldHFlips = db.prepare(`SELECT COUNT(*) as n FROM signals WHERE symbol='NQ' AND strategy_version='H' AND json_extract(payload,'$.pattern')='FLIP' AND score >= 0`).get() as any;
process.stdout.write(`\nTotal H FLIP signals in DB: ${totalHFlips.n}\n`);
