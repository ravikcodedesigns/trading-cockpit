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

// The 23 move timestamps with no H FLIP (from audit)
const missedTs = [
  new Date('2026-04-30T14:56:00Z').getTime(), // 10:56 ET
  new Date('2026-04-30T15:48:00Z').getTime(), // 11:48 ET
  new Date('2026-04-30T16:15:00Z').getTime(), // 12:15 ET
  new Date('2026-04-30T16:58:00Z').getTime(), // 12:58 ET
  new Date('2026-05-01T13:30:00Z').getTime(), // 09:30 ET
  new Date('2026-05-01T14:38:00Z').getTime(), // 10:38 ET
  new Date('2026-05-01T15:24:00Z').getTime(), // 11:24 ET
  new Date('2026-05-01T18:15:00Z').getTime(), // 14:15 ET
  new Date('2026-05-01T18:47:00Z').getTime(), // 14:47 ET
  new Date('2026-05-04T14:13:00Z').getTime(), // 10:13 ET
  new Date('2026-05-04T15:23:00Z').getTime(), // 11:23 ET
  new Date('2026-05-04T16:09:00Z').getTime(), // 12:09 ET
  new Date('2026-05-04T17:12:00Z').getTime(), // 13:12 ET
  new Date('2026-05-04T17:38:00Z').getTime(), // 13:38 ET
  new Date('2026-05-04T18:46:00Z').getTime(), // 14:46 ET
  new Date('2026-05-07T15:27:00Z').getTime(), // 11:27 ET
  new Date('2026-05-07T17:21:00Z').getTime(), // 13:21 ET
  new Date('2026-05-07T18:51:00Z').getTime(), // 14:51 ET
  new Date('2026-05-11T15:31:00Z').getTime(), // 11:31 ET
  new Date('2026-05-13T15:45:00Z').getTime(), // 11:45 ET
  new Date('2026-05-14T15:18:00Z').getTime(), // 11:18 ET
  new Date('2026-05-15T14:24:00Z').getTime(), // 10:24 ET
];

// Use actual DB timestamps instead — query the bar events for these approx times
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

// All H signals in DB regardless of tier (FLIP and CONT)
const allH = db.prepare(`
  SELECT ts, direction, score,
         json_extract(payload,'$.pattern') as pattern,
         json_extract(payload,'$.delta5') as delta5,
         json_extract(payload,'$.delta15') as delta15,
         json_extract(payload,'$.deltaT') as deltaT,
         json_extract(payload,'$.isPositionFlip') as isPositionFlip
  FROM signals WHERE symbol='NQ' AND strategy_version='H'
  ORDER BY ts ASC
`).all() as any[];

const goldSignals = db.prepare(`SELECT ts, direction FROM signals WHERE symbol='NQ' AND strategy_version IN ('H','EXPL','B') ORDER BY ts ASC`).all() as any[];

// Rebuild missed moves
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
      const absorbedSpike = direction==='long' ? (cDelta15>=1500&&triggerDelta<=-300) : (cDelta15<=-1500&&triggerDelta>=300);
      const exhaustionReversal = direction==='long' ? cDelta15<=-2000 : cDelta15>=2000;
      if (absorbedSpike || exhaustionReversal) {
        // Was there ANY H signal within 10 min?
        const window = 10 * 60_000;
        const nearbyFlip = allH.filter((s: any) => s.pattern==='FLIP' && Math.abs(s.ts-bar.ts)<=window && s.direction===direction);
        const nearbyCont = allH.filter((s: any) => s.pattern==='CONT' && Math.abs(s.ts-bar.ts)<=window && s.direction===direction);
        const anyFlipOpp = allH.filter((s: any) => s.pattern==='FLIP' && Math.abs(s.ts-bar.ts)<=window && s.direction!==direction);
        const anyContOpp = allH.filter((s: any) => s.pattern==='CONT' && Math.abs(s.ts-bar.ts)<=window && s.direction!==direction);

        if (nearbyFlip.length === 0) {
          moves.push({ ts: bar.ts, direction, magnitude, cDelta15, triggerDelta,
            absorbedSpike, exhaustionReversal,
            nearbyCont: nearbyCont.length, flipOpp: anyFlipOpp.length, contOpp: anyContOpp.length,
            contSample: nearbyCont[0] ?? null });
        }
      }
    }
    i += barsToHit + 1;
  } else { i++; }
}

const fmt = (ts: number) => new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(ts));

process.stdout.write(`Moves with NO same-dir FLIP within 10min: ${moves.length}\n\n`);
process.stdout.write(`${'Move'.padEnd(14)} ${'Dir'.padEnd(6)} ${'Mag'.padStart(4)}  ${'cD15'.padStart(7)}  ${'CONT-same'.padStart(10)} ${'FLIP-opp'.padStart(9)} ${'CONT-opp'.padStart(9)}\n`);
process.stdout.write(`${'─'.repeat(75)}\n`);

let hasCont = 0, hasNothing = 0, hasFlipOpp = 0;
for (const m of moves) {
  if (m.nearbyCont > 0) hasCont++;
  else if (m.flipOpp > 0 || m.contOpp > 0) hasFlipOpp++;
  else hasNothing++;
  const contNote = m.nearbyCont > 0 ? `${m.nearbyCont} CONT` : 'none';
  const flipOppNote = m.flipOpp > 0 ? `${m.flipOpp} FLIP` : '-';
  const contOppNote = m.contOpp > 0 ? `${m.contOpp} CONT` : '-';
  process.stdout.write(`${fmt(m.ts).padEnd(14)} ${m.direction.padEnd(6)} ${m.magnitude.toFixed(0).padStart(4)}  ${m.cDelta15.toFixed(0).padStart(7)}  ${contNote.padStart(10)} ${flipOppNote.padStart(9)} ${contOppNote.padStart(9)}\n`);
}

process.stdout.write(`\n--- What's at the tape when FLIP doesn't fire ---\n`);
process.stdout.write(`Same-dir CONT signal within 10m:   ${hasCont}\n`);
process.stdout.write(`Opposing FLIP or CONT within 10m:  ${hasFlipOpp}\n`);
process.stdout.write(`Tape completely silent both ways:  ${hasNothing}\n`);

// Overall H signal pattern distribution
const flipCount = db.prepare(`SELECT COUNT(*) as n FROM signals WHERE symbol='NQ' AND strategy_version='H' AND json_extract(payload,'$.pattern')='FLIP'`).get() as any;
const contCount = db.prepare(`SELECT COUNT(*) as n FROM signals WHERE symbol='NQ' AND strategy_version='H' AND json_extract(payload,'$.pattern')='CONT'`).get() as any;
process.stdout.write(`\nTotal H signals in DB: FLIP=${flipCount.n} CONT=${contCount.n}\n`);
