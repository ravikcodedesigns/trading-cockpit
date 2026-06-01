/**
 * inspect_5_12_morning.ts — what happened on 2026-05-12 RTH morning
 * that caused 7 consecutive absorption-long stop-outs at -140?
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const tdb = new Database(TRADING_DB, { readonly: true });
const xdb = new Database(TICKS_DB,   { readonly: true });

// RTH window for 5/12 in UTC ms: 09:30 ET = 13:30 UTC, 16:00 ET = 20:00 UTC.
const RTH_OPEN  = Date.UTC(2026, 4, 12, 13, 30, 0, 0);
const RTH_CLOSE = Date.UTC(2026, 4, 12, 20, 0, 0, 0);

function etTime(tsMs: number): string {
  const d = new Date(tsMs - 4*60*60_000);
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`;
}

console.log('=== 2026-05-12 RTH MORNING POSTMORTEM ===\n');

// 1) Price snapshot — open, high, low, close, and progression every 10 min
const openPx = (xdb.prepare(`SELECT price FROM trades WHERE symbol='NQ' AND ts >= ? ORDER BY ts ASC LIMIT 1`).get(RTH_OPEN) as {price:number}|undefined)?.price;
const closePx = (xdb.prepare(`SELECT price FROM trades WHERE symbol='NQ' AND ts <= ? ORDER BY ts DESC LIMIT 1`).get(RTH_CLOSE) as {price:number}|undefined)?.price;
const hi = (xdb.prepare(`SELECT MAX(price) AS p FROM trades WHERE symbol='NQ' AND ts >= ? AND ts <= ?`).get(RTH_OPEN, RTH_CLOSE) as {p:number}).p;
const lo = (xdb.prepare(`SELECT MIN(price) AS p FROM trades WHERE symbol='NQ' AND ts >= ? AND ts <= ?`).get(RTH_OPEN, RTH_CLOSE) as {p:number}).p;
console.log(`NQ 5/12 RTH:  open=${openPx}  high=${hi}  low=${lo}  close=${closePx}  range=${(hi-lo).toFixed(1)}pt`);
console.log(`              net move open→close = ${(closePx! - openPx!).toFixed(1)}pt`);

// Price by minute (sample every 5 min for morning)
console.log('\nPrice trajectory (each 5 min, 09:30–12:30 ET):');
for (let m = 0; m <= 180; m += 5) {
  const t = RTH_OPEN + m * 60_000;
  const p = (xdb.prepare(`SELECT price FROM trades WHERE symbol='NQ' AND ts <= ? ORDER BY ts DESC LIMIT 1`).get(t) as {price:number}|undefined)?.price;
  if (p) console.log(`  ${etTime(t)}   ${p.toFixed(2)}    Δfrom open ${(p - openPx!).toFixed(1)}pt`);
}

// 2) CVD anchored at RTH open — buy aggressor convention: is_bid_aggressor=1 is BUY
console.log('\nCVD progression (anchored at RTH open):');
const cvdStmt = xdb.prepare(`
  SELECT
    SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE -size END) AS cvd
  FROM trades
  WHERE symbol='NQ' AND ts >= ? AND ts <= ?
`);
for (let m = 30; m <= 180; m += 15) {
  const t = RTH_OPEN + m * 60_000;
  const row = cvdStmt.get(RTH_OPEN, t) as {cvd:number};
  console.log(`  ${etTime(t)}   CVD = ${row.cvd}`);
}

// 3) All signals that day, full morning window
console.log('\nAll signals 09:30–12:00 ET on 5/12:');
const sigs = tdb.prepare(`
  SELECT s.id, s.ts, s.symbol AS symbol, s.rule_id, s.direction, s.score,
         json_extract(s.payload,'$.entry') AS entry,
         json_extract(s.payload,'$.pattern') AS pattern,
         CASE WHEN q.signal_id IS NULL THEN 'silenced' ELSE 'qualified' END AS gate
  FROM signals s
  LEFT JOIN qualified_signals q ON q.signal_id = s.id
  WHERE s.ts >= ? AND s.ts < ?
    AND s.symbol = 'NQ'
  ORDER BY s.ts
`).all(RTH_OPEN, RTH_OPEN + 150*60_000) as any[];

console.log(`  total: ${sigs.length}`);
for (const s of sigs) {
  const entry = s.entry ? Number(s.entry).toFixed(2) : '   -   ';
  const pat = s.pattern ?? '';
  console.log(`  ${etTime(s.ts)}  ${s.rule_id.padEnd(16)} ${(s.direction ?? '').padEnd(5)} score=${String(s.score).padStart(3)}  entry=${entry}  ${pat} [${s.gate}]`);
}

// 4) FLIP context — were there any same-dir FLIPs preceding the absorption longs?
console.log('\nFLIP signals (Strategy H) in 60min before each failed absorption long:');
const failedAbsoLongs = [
  { id: 3563, ts: Date.UTC(2026,4,12,13,39,0)+30_000, entry: 29229.00 },
  { id: 3567, ts: Date.UTC(2026,4,12,13,42,0), entry: 29250.00 },
  { id: 3575, ts: Date.UTC(2026,4,12,13,45,0), entry: 29291.50 },
  { id: 3580, ts: Date.UTC(2026,4,12,13,46,0), entry: 29256.25 },
  { id: 3599, ts: Date.UTC(2026,4,12,13,53,0), entry: 29225.50 },
  { id: 3698, ts: Date.UTC(2026,4,12,14,43,0), entry: 29122.00 },
  { id: 3773, ts: Date.UTC(2026,4,12,15,26,0), entry: 28889.25 },
];
const flipStmt = tdb.prepare(`
  SELECT ts, direction, json_extract(payload,'$.pattern') AS pattern,
         json_extract(payload,'$.entry') AS entry
  FROM signals
  WHERE symbol='NQ' AND strategy_version='H'
    AND ts >= ? AND ts < ?
  ORDER BY ts DESC
`);
for (const s of failedAbsoLongs) {
  const flips = flipStmt.all(s.ts - 60*60_000, s.ts) as any[];
  if (flips.length === 0) {
    console.log(`  ${etTime(s.ts)} long@${s.entry}:  no FLIP in 60min window`);
    continue;
  }
  const matchingLong = flips.find(f => f.direction === 'long');
  const lastFlip = flips[0];
  console.log(`  ${etTime(s.ts)} long@${s.entry}:  ${flips.length} FLIP(s) in window`);
  if (matchingLong) {
    const ago = Math.round((s.ts - matchingLong.ts) / 60_000);
    console.log(`     latest LONG FLIP @${etTime(matchingLong.ts)} (${ago}m ago) entry=${matchingLong.entry} ${matchingLong.pattern}`);
  } else {
    console.log(`     ❌ no LONG FLIP — most recent is ${lastFlip.direction} @${etTime(lastFlip.ts)} (${lastFlip.pattern})`);
  }
}

// 5) Any short signals that day — those would have been winners
console.log('\nShort signals on 5/12 RTH (would have been winners):');
const shortSigs = tdb.prepare(`
  SELECT s.id, s.ts, s.rule_id, s.score, json_extract(s.payload,'$.entry') AS entry,
         CASE WHEN q.signal_id IS NULL THEN 'silenced' ELSE 'qualified' END AS gate
  FROM signals s
  LEFT JOIN qualified_signals q ON q.signal_id = s.id
  WHERE s.symbol='NQ' AND s.direction='short' AND s.ts >= ? AND s.ts <= ?
  ORDER BY s.ts
`).all(RTH_OPEN, RTH_CLOSE) as any[];
for (const s of shortSigs) {
  console.log(`  ${etTime(s.ts)} ${s.rule_id.padEnd(16)} score=${String(s.score).padStart(3)}  entry=${s.entry}  [${s.gate}]`);
}

tdb.close(); xdb.close();
