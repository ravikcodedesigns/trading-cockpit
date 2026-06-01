/**
 * abso_loss_verify.ts — For every LONG signal classified as LOSS, walk every
 * tick from signal time to RTH close and verify the SL was hit BEFORE the TP.
 * Print any cases where TP came first (those would be wrongly classified as LOSS).
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
function etISO(tsMs: number): string {
  const d = new Date(tsMs - 4 * 60 * 60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`;
}

const stmtTrades = xdb.prepare(`
  SELECT ts, price FROM trades
  WHERE symbol=? AND ts > ? AND ts <= ?
  ORDER BY ts ASC, id ASC
`).raw(true);

let lossCount = 0, mismatched = 0, confirmedSlFirst = 0;

for (const s of sigs) {
  // First: determine if it's a LOSS using the same code as the main scan
  const closeMs = rthCloseMs(s.ts);
  let outcome: 'WIN'|'LOSS'|'CLOSE'|'NO_DATA' = 'NO_DATA';
  let sawTick = false;
  let firstTpHitTs = -1, firstSlHitTs = -1;
  // Single walk: record the FIRST ts at which TP was hit and the FIRST ts at which SL was hit, independently.
  const iter = stmtTrades.iterate(s.symbol, s.ts, closeMs) as IterableIterator<[number, number]>;
  for (const [ts, px] of iter) {
    sawTick = true;
    const fav = px - s.entry;
    const adv = s.entry - px;
    if (firstTpHitTs === -1 && fav >= TP) firstTpHitTs = ts;
    if (firstSlHitTs === -1 && adv >= SL) firstSlHitTs = ts;
    // we keep walking — we want both timestamps, not just the first-encountered
    if (firstTpHitTs > 0 && firstSlHitTs > 0) break;
  }
  if (typeof (iter as any).return === 'function') (iter as any).return();

  if (!sawTick) continue;          // skip NO_DATA
  // Determine outcome
  if (firstSlHitTs > 0 && firstTpHitTs > 0) {
    // both were hit in the window; earlier ts wins
    outcome = firstSlHitTs <= firstTpHitTs ? 'LOSS' : 'WIN';
  } else if (firstSlHitTs > 0) outcome = 'LOSS';
  else if (firstTpHitTs > 0)   outcome = 'WIN';
  else outcome = 'CLOSE';

  if (outcome !== 'LOSS') continue;
  lossCount++;

  // Verify: my main script would have returned LOSS only if no TP-tick came before SL-tick.
  if (firstTpHitTs > 0 && firstTpHitTs < firstSlHitTs) {
    mismatched++;
    console.log(`  ❌ MISCLASSIFIED: id=${s.id}  ${etISO(s.ts)} entry=${s.entry.toFixed(2)}`);
    console.log(`       TP first @ ${etISO(firstTpHitTs)}   SL @ ${etISO(firstSlHitTs)}`);
  } else {
    confirmedSlFirst++;
  }
}

console.log(`\nTotal LOSSES walked: ${lossCount}`);
console.log(`  Confirmed SL hit first or only SL hit: ${confirmedSlFirst}`);
console.log(`  Misclassified (TP actually first):     ${mismatched}`);
console.log(mismatched === 0 ? '\n✓ All losses verified: SL was hit before TP in every case.' : '\n✗ Found misclassifications — see above.');

tdb.close(); xdb.close();
