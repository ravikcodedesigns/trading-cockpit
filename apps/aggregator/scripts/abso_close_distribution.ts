/**
 * abso_close_distribution.ts — for the same 224 RTH NQ abso longs,
 * surface the 75 CLOSE-at-bell trades: entry, fire time, minutes-to-close,
 * exit price, close PnL. Then bucket the PnL distribution.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const TP = 80, SL = 140;
const tdb = new Database(TRADING_DB, { readonly: true });
const xdb = new Database(TICKS_DB,   { readonly: true });

const tickFloor = (xdb.prepare(`SELECT MIN(ts) AS t FROM trades WHERE symbol='NQ'`).get() as {t:number}).t;

const rawSigs = tdb.prepare(`
  SELECT s.id, s.ts, s.symbol, s.direction, s.score,
         CAST(json_extract(s.payload,'$.entry') AS REAL) AS entry,
         s.payload
  FROM signals s
  WHERE s.rule_id = 'absorption' AND s.symbol = 'NQ' AND s.direction = 'long'
    AND s.ts >= ?
    AND time(s.ts/1000,'unixepoch','-4 hours') >= '09:30:00'
    AND time(s.ts/1000,'unixepoch','-4 hours') <  '16:00:00'
  ORDER BY s.ts
`).all(tickFloor) as Array<{id:number; ts:number; symbol:string; direction:string; score:number; entry:number; payload:string}>;

const reAbsorbedAt = /absorbed at (\d+\.?\d*)/;
for (const s of rawSigs) {
  if (!s.entry || s.entry <= 0) {
    const m = s.payload.match(reAbsorbedAt);
    if (m) s.entry = parseFloat(m[1]);
  }
}
const sigs = rawSigs.filter(s => s.entry && s.entry > 0);

function rthCloseMs(tsMs: number): number {
  const etDate = new Date(tsMs - 4 * 60 * 60_000);
  return Date.UTC(etDate.getUTCFullYear(), etDate.getUTCMonth(), etDate.getUTCDate(), 20, 0, 0, 0);
}

function etHHMM(tsMs: number): string {
  const d = new Date(tsMs - 4 * 60 * 60_000);
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}
function isoET(tsMs: number): string {
  const d = new Date(tsMs - 4 * 60 * 60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

const stmtTrades = xdb.prepare(`
  SELECT ts, price FROM trades
  WHERE symbol=? AND ts > ? AND ts <= ?
  ORDER BY ts ASC, id ASC
`).raw(true);

interface CloseRow {
  id:number; ts:number; etDate:string; etTime:string; minutesToClose:number;
  entry:number; exit:number; pnl:number;
}

const closeRows: CloseRow[] = [];
for (const s of sigs) {
  const closeMs = rthCloseMs(s.ts);
  if (closeMs <= s.ts) continue;
  let lastPx = s.entry;
  let outcome: 'WIN'|'LOSS'|'CLOSE' = 'CLOSE';
  const iter = stmtTrades.iterate(s.symbol, s.ts, closeMs) as IterableIterator<[number, number]>;
  for (const [, px] of iter) {
    lastPx = px;
    const fav = px - s.entry;
    const adv = s.entry - px;
    if (adv >= SL) { outcome = 'LOSS'; break; }
    if (fav >= TP) { outcome = 'WIN'; break; }
  }
  if (typeof (iter as any).return === 'function') (iter as any).return();
  if (outcome === 'CLOSE') {
    closeRows.push({
      id: s.id, ts: s.ts,
      etDate: isoET(s.ts), etTime: etHHMM(s.ts),
      minutesToClose: (closeMs - s.ts) / 60_000,
      entry: s.entry, exit: lastPx, pnl: lastPx - s.entry,
    });
  }
}

console.log(`Total CLOSE-at-bell trades: ${closeRows.length}\n`);

// Per-trade listing sorted by PnL ascending
closeRows.sort((a, b) => a.pnl - b.pnl);
console.log('etDate     etTime  minToClose  entry      exit       pnl');
for (const r of closeRows) {
  console.log(`${r.etDate}  ${r.etTime}   ${String(r.minutesToClose.toFixed(0)).padStart(4)}min     ${r.entry.toFixed(2).padStart(8)}   ${r.exit.toFixed(2).padStart(8)}   ${r.pnl.toFixed(1).padStart(7)}`);
}

// PnL distribution buckets
const buckets: Record<string, number> = {
  '< -100':0, '-100..-50':0, '-50..-20':0, '-20..-10':0, '-10..0':0,
  '0..10':0, '10..20':0, '20..50':0, '50..79':0,
};
for (const r of closeRows) {
  const p = r.pnl;
  if (p < -100) buckets['< -100']++;
  else if (p < -50) buckets['-100..-50']++;
  else if (p < -20) buckets['-50..-20']++;
  else if (p < -10) buckets['-20..-10']++;
  else if (p < 0)   buckets['-10..0']++;
  else if (p < 10)  buckets['0..10']++;
  else if (p < 20)  buckets['10..20']++;
  else if (p < 50)  buckets['20..50']++;
  else buckets['50..79']++;
}

console.log('\nPnL distribution (pts):');
for (const k of Object.keys(buckets)) {
  const v = buckets[k];
  if (v === 0) continue;
  console.log(`  ${k.padEnd(12)}  ${'#'.repeat(v)} (${v})`);
}

// Aggregate
const sum = closeRows.reduce((a, r) => a + r.pnl, 0);
const sorted = [...closeRows].map(r => r.pnl).sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length/2)];
const minP = sorted[0], maxP = sorted[sorted.length-1];
const wins = closeRows.filter(r => r.pnl > 0).length;
const losses = closeRows.filter(r => r.pnl <= 0).length;

console.log(`\nAggregates: sum=${sum.toFixed(1)}pt  avg=${(sum/closeRows.length).toFixed(2)}pt  median=${median.toFixed(1)}pt  min=${minP.toFixed(1)}pt  max=${maxP.toFixed(1)}pt`);
console.log(`Wins>0: ${wins}    Losses<=0: ${losses}`);

// Cluster by fire-time bucket
console.log(`\nFire-time bucket vs avg PnL:`);
const firetimeBuckets: Record<string, {n:number; sum:number}> = {};
for (const r of closeRows) {
  const hr = parseInt(r.etTime.slice(0,2),10);
  let bucket = '';
  if (hr < 10) bucket = '9:30-9:59';
  else if (hr < 11) bucket = '10:00-10:59';
  else if (hr < 12) bucket = '11:00-11:59';
  else if (hr < 13) bucket = '12:00-12:59';
  else if (hr < 14) bucket = '13:00-13:59';
  else if (hr < 15) bucket = '14:00-14:59';
  else bucket = '15:00-15:59';
  if (!firetimeBuckets[bucket]) firetimeBuckets[bucket] = {n:0, sum:0};
  firetimeBuckets[bucket].n++;
  firetimeBuckets[bucket].sum += r.pnl;
}
for (const k of Object.keys(firetimeBuckets).sort()) {
  const v = firetimeBuckets[k];
  console.log(`  ${k.padEnd(13)}  n=${String(v.n).padStart(2)}  sum=${v.sum.toFixed(0).padStart(5)}pt  avg=${(v.sum/v.n).toFixed(1)}pt`);
}

tdb.close(); xdb.close();
