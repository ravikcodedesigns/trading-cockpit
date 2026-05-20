// Verify: does bar-level buyVolume = bid-aggressor ticks (buyers lifting ask)?
// Cross-reference with ticks.db for the same minute.
import Database from 'better-sqlite3';
const ticksDb  = new Database('../../data/ticks.db', { readonly: true });
const tradingDb = new Database('../../data/trading.db', { readonly: true });

const fmt = (ts: number) => new Intl.DateTimeFormat('en-US',{
  timeZone:'America/New_York',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,
}).format(new Date(ts));

// Pick 5 bars from 05/11 (known to have ticks) and compare
const bars = tradingDb.prepare(`
  SELECT ts,
         json_extract(payload,'$.close') as close,
         json_extract(payload,'$.buyVolume') as bvBar,
         json_extract(payload,'$.sellVolume') as svBar
  FROM events WHERE source='bookmap' AND type='bar'
    AND json_extract(payload,'$.symbol')='NQ' AND json_extract(payload,'$.partial')=0
    AND ts >= 1746954600000 AND ts < 1746960000000  -- 05/11 11:30-13:00 ET roughly
  ORDER BY ts ASC LIMIT 10
`).all() as any[];

process.stdout.write(`${'Bar time'.padEnd(22)} ${'bvBar'.padStart(7)} ${'svBar'.padStart(7)} ${'barΔ'.padStart(7)}  ${'tickBv'.padStart(7)} ${'tickSv'.padStart(7)} ${'tickΔ'.padStart(7)}  ${'match?'.padStart(8)}\n`);
process.stdout.write(`${'─'.repeat(80)}\n`);

for (const bar of bars) {
  const from = bar.ts;
  const to   = bar.ts + 60_000;
  const res = ticksDb.prepare(`
    SELECT
      SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE 0 END) as tickBv,
      SUM(CASE WHEN is_bid_aggressor=0 THEN size ELSE 0 END) as tickSv
    FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?
  `).get(from, to) as any;

  const barD  = (bar.bvBar ?? 0) - (bar.svBar ?? 0);
  const tickD = (res.tickBv ?? 0) - (res.tickSv ?? 0);
  const match = Math.sign(barD) === Math.sign(tickD) ? 'YES' : 'NO ←';

  process.stdout.write(`${fmt(bar.ts).padEnd(22)} ${String(bar.bvBar??0).padStart(7)} ${String(bar.svBar??0).padStart(7)} ${barD.toString().padStart(7)}  ${String(res.tickBv??0).padStart(7)} ${String(res.tickSv??0).padStart(7)} ${tickD.toString().padStart(7)}  ${match.padStart(8)}\n`);
}

// Now specifically check 05/15 10:24 (the SHORT 97pts bar with apparent conflict)
process.stdout.write(`\n05/15 10:24 SHORT bar:\n`);
const targetTs = Date.parse('2026-05-15T14:24:00Z'); // 10:24 ET = 14:24 UTC
const barCheck = tradingDb.prepare(`
  SELECT ts, json_extract(payload,'$.buyVolume') as bvBar, json_extract(payload,'$.sellVolume') as svBar
  FROM events WHERE source='bookmap' AND type='bar'
    AND json_extract(payload,'$.symbol')='NQ' AND json_extract(payload,'$.partial')=0
    AND ts >= ? AND ts < ?
`).all(targetTs - 90_000, targetTs + 90_000) as any[];

for (const bar of barCheck) {
  const res = ticksDb.prepare(`
    SELECT SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE 0 END) as tickBv, SUM(CASE WHEN is_bid_aggressor=0 THEN size ELSE 0 END) as tickSv
    FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?
  `).get(bar.ts, bar.ts + 60_000) as any;
  const barD = (bar.bvBar??0) - (bar.svBar??0);
  const tickD = (res.tickBv??0) - (res.tickSv??0);
  process.stdout.write(`  ${fmt(bar.ts)}: barBv=${bar.bvBar} barSv=${bar.svBar} barΔ=${barD}  tickBv=${res.tickBv} tickSv=${res.tickSv} tickΔ=${tickD}  match=${Math.sign(barD)===Math.sign(tickD)?'YES':'NO'}\n`);
}
