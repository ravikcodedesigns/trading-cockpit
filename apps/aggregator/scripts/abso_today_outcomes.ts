/**
 * abso_today_outcomes.ts — for each absorption signal today, scan forward
 * ticks 30 min and compute MFE / MAE. Reveal silenced winners.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const TARGET_PTS = 80;
const MAX_DD_PTS = 140;

const tdb = new Database(TRADING_DB, { readonly: true });
const xdb = new Database(TICKS_DB,   { readonly: true });

interface AbsoSig {
  id: number; ts: number; symbol: string; direction: 'long'|'short';
  score: number; entry: number; conviction: number | null;
}

// RTH only (9:30–16:00 ET) and NQ only
const sigs = tdb.prepare(`
  SELECT id, ts, symbol, direction, score,
         CAST(json_extract(payload,'$.entry') AS REAL) AS entry,
         CAST(json_extract(payload,'$.conviction') AS INTEGER) AS conviction
  FROM signals
  WHERE date(ts/1000,'unixepoch','-4 hours') = '2026-05-28'
    AND rule_id = 'absorption'
    AND symbol  = 'NQ'
    AND time(ts/1000,'unixepoch','-4 hours') >= '09:30:00'
    AND time(ts/1000,'unixepoch','-4 hours') <  '16:00:00'
  ORDER BY ts
`).all() as AbsoSig[];

const stmtTrades = xdb.prepare(`
  SELECT ts, price FROM trades
  WHERE symbol=? AND ts > ?
  ORDER BY ts ASC, id ASC
`);

function etHHMM(tsMs: number): string {
  const d = new Date(tsMs - 4 * 60 * 60_000);
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}

console.log(`Horizon=UNBOUNDED  TP=${TARGET_PTS}pt  SL=${MAX_DD_PTS}pt`);
console.log('id    et    sym dir   entry      score conv  mfe    mae    outcome    resolve');
let wins = 0, losses = 0, openP = 0;
const nowMs = Date.now();
for (const s of sigs) {
  const trades = stmtTrades.all(s.symbol, s.ts) as { ts: number; price: number }[];
  let mfe = 0, mae = 0;
  let result: 'WIN'|'LOSS'|'OPEN' = 'OPEN';
  let resolveMs = nowMs - s.ts;
  for (const t of trades) {
    const px = t.price;
    const fav = s.direction === 'long' ? px - s.entry : s.entry - px;
    const adv = s.direction === 'long' ? s.entry - px : px - s.entry;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
    if (adv >= MAX_DD_PTS) { result = 'LOSS'; resolveMs = t.ts - s.ts; break; }
    if (fav >= TARGET_PTS) { result = 'WIN'; resolveMs = t.ts - s.ts; break; }
  }
  if (result === 'WIN') wins++;
  else if (result === 'LOSS') losses++;
  else openP++;
  const resolveStr = result === 'OPEN' ? `OPEN(${(resolveMs/60_000).toFixed(0)}m)` : `${(resolveMs/60_000).toFixed(0)}m`;
  console.log(
    `${String(s.id).padStart(5)} ${etHHMM(s.ts)} ${s.symbol.padEnd(3)} ${s.direction.padEnd(5)} ` +
    `${s.entry.toFixed(2).padStart(8)}  ${String(s.score).padStart(3)}   ${String(s.conviction ?? '-').padStart(2)}  ` +
    `${mfe.toFixed(1).padStart(5)}  ${mae.toFixed(1).padStart(5)}  ${result.padEnd(5)}   ${resolveStr}`
  );
}
console.log(`\nTotal: ${sigs.length} silenced absorption signals`);
console.log(`WINS  (MFE ≥${TARGET_PTS} before DD ${MAX_DD_PTS}): ${wins}/${sigs.length} = ${(wins/sigs.length*100).toFixed(0)}%`);
console.log(`LOSS  (DD ≥${MAX_DD_PTS} before TP): ${losses}/${sigs.length} = ${(losses/sigs.length*100).toFixed(0)}%`);
console.log(`OPEN  (still unresolved at now): ${openP}/${sigs.length} = ${(openP/sigs.length*100).toFixed(0)}%`);
// Decided WR + net PnL
const decided = wins + losses;
const wr = decided ? (wins / decided) * 100 : 0;
const netPnl = wins * TARGET_PTS - losses * MAX_DD_PTS;
console.log(`Decided WR: ${wr.toFixed(1)}%   Net PnL @ ${TARGET_PTS}/${MAX_DD_PTS}: ${netPnl}pt across ${sigs.length} signals`);

tdb.close(); xdb.close();
