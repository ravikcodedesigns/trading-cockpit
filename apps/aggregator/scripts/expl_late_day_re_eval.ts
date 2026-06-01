/**
 * expl_late_day_re_eval.ts — re-evaluate the 14:30 ET EXPL silencing gate at
 * V3's current TP/SL (80/70). The gate was calibrated against an older
 * stop-width assumption. Check whether late-day EXPLs are still anti-edge
 * at V3 sizing.
 *
 * Filter: EXPL LONG, RTH only (14:30-16:00 ET fires), passes the OTHER
 * EXPL gates (>=1 stacked bid zone, rangePct >= 0.5). Drops EXPL SHORTs
 * (hard-silenced) and EXPL LONGs that fail the structural gates.
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const TP = 80, SL = 70;

const tdb = new Database(TRADING_DB, { readonly: true });
const xdb = new Database(TICKS_DB,   { readonly: true });
const tickFloor = (xdb.prepare(`SELECT MIN(ts) AS t FROM trades WHERE symbol='NQ'`).get() as {t:number}).t;

// Pull all EXPL LONG signals after 14:30 ET, RTH-bounded, in the tick-coverage window
const rows = tdb.prepare(`
  SELECT s.id, s.ts, s.direction, s.score,
         json_extract(s.payload,'$.stackedBidZones') AS bidZonesJson,
         CAST(json_extract(s.payload,'$.rangePct') AS REAL) AS rangePct
  FROM signals s
  WHERE s.symbol='NQ' AND s.rule_id='expl' AND s.direction='long'
    AND s.ts >= ?
    AND time(s.ts/1000,'unixepoch','-4 hours') >= '14:30:00'
    AND time(s.ts/1000,'unixepoch','-4 hours') <  '16:00:00'
  ORDER BY s.ts
`).all(tickFloor) as any[];

// Filter to those that pass the OTHER EXPL gates (bidZones count >= 1, rangePct >= 0.5)
const sigs = rows.filter(r => {
  const bidZones = r.bidZonesJson ? JSON.parse(r.bidZonesJson) : null;
  if (!bidZones || !Array.isArray(bidZones) || bidZones.length === 0) return false;
  if (r.rangePct === null || r.rangePct === undefined || r.rangePct < 0.5) return false;
  return true;
});

console.log(`Late-day (≥14:30 ET) EXPL LONGs passing structural gates: ${sigs.length}`);
console.log(`(Of ${rows.length} total post-14:30 EXPL LONGs that would have fired)\n`);

// For each: resolve at TP=80/SL=70 within RTH close
function rthCloseMs(tsMs: number): number {
  const d = new Date(tsMs - 4*60*60_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 20, 0, 0, 0);
}
function etTime(tsMs: number): string {
  const d = new Date(tsMs - 4*60*60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}
const stmtFirstTick = xdb.prepare(`SELECT price FROM trades WHERE symbol='NQ' AND ts >= ? ORDER BY ts ASC LIMIT 1`);
const stmtTicks = xdb.prepare(`SELECT ts, price FROM trades WHERE symbol='NQ' AND ts > ? AND ts <= ? ORDER BY ts ASC, id ASC`).raw(true);

interface Outcome { id: number; ts: number; entry: number; result: 'WIN'|'LOSS'|'CLOSE'|'NO_DATA'; pnl: number; }
const outcomes: Outcome[] = [];

for (const s of sigs) {
  const entryRow = stmtFirstTick.get(s.ts) as { price: number } | undefined;
  if (!entryRow) { outcomes.push({ id: s.id, ts: s.ts, entry: 0, result: 'NO_DATA', pnl: 0 }); continue; }
  const entry = entryRow.price;
  const closeMs = rthCloseMs(s.ts);
  let lastPx = entry, result: Outcome['result'] = 'NO_DATA';
  const iter = stmtTicks.iterate(s.ts, closeMs) as IterableIterator<[number, number]>;
  for (const [, px] of iter) {
    lastPx = px;
    const fav = px - entry;
    const adv = entry - px;
    if (adv >= SL) { result = 'LOSS'; if ((iter as any).return) (iter as any).return(); break; }
    if (fav >= TP) { result = 'WIN';  if ((iter as any).return) (iter as any).return(); break; }
  }
  if (result === 'NO_DATA') result = 'CLOSE';
  const pnl = result === 'WIN' ? TP : result === 'LOSS' ? -SL : lastPx - entry;
  outcomes.push({ id: s.id, ts: s.ts, entry, result, pnl });
}

console.log('Per-signal:');
for (const o of outcomes) {
  console.log(`  ${etTime(o.ts)}  id=${o.id}  entry=${o.entry.toFixed(2)}  result=${o.result.padEnd(5)}  pnl=${o.pnl.toFixed(1)}`);
}

const w = outcomes.filter(o => o.result === 'WIN').length;
const l = outcomes.filter(o => o.result === 'LOSS').length;
const c = outcomes.filter(o => o.result === 'CLOSE').length;
const cWin = outcomes.filter(o => o.result === 'CLOSE' && o.pnl > 0).length;
const cLoss = outcomes.filter(o => o.result === 'CLOSE' && o.pnl < 0).length;
const net = outcomes.reduce((a, o) => a + o.pnl, 0);
const prof = outcomes.filter(o => o.pnl > 0).length;

console.log('\n────── Summary ──────');
console.log(`n = ${outcomes.length}`);
console.log(`WIN @+80:  ${w}    contribution +${w*TP}`);
console.log(`LOSS @-70: ${l}    contribution ${-l*SL}`);
console.log(`CLOSE @bell: ${c}  (${cWin} positive close, ${cLoss} negative close)`);
console.log(`Net PnL: ${net.toFixed(0)} pt`);
console.log(`Profitable: ${prof}/${outcomes.length} = ${(prof/outcomes.length*100).toFixed(0)}%`);
console.log(`PnL/sig:    ${(net/outcomes.length).toFixed(1)} pt`);

tdb.close(); xdb.close();
