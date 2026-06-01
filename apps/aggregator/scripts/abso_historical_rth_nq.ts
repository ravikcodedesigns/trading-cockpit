/**
 * abso_historical_rth_nq.ts — Walk every RTH NQ absorption signal and
 * resolve at TP=80 / SL=140 (unbounded). Pure WIN/LOSS/OPEN — no MFE/MAE.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const TP = 80;
const SL = 140;

const tdb = new Database(TRADING_DB, { readonly: true });
const xdb = new Database(TICKS_DB,   { readonly: true });

interface AbsoSig {
  id: number; ts: number; symbol: string; direction: 'long'|'short';
  score: number; entry: number; conviction: number | null;
  silenced: number;
}

const tickFloor = (xdb.prepare(`SELECT MIN(ts) AS t FROM trades WHERE symbol='NQ'`).get() as {t:number}).t;

const rawSigs = tdb.prepare(`
  SELECT s.id, s.ts, s.symbol, s.direction, s.score,
         CAST(json_extract(s.payload,'$.entry') AS REAL) AS entry,
         CAST(json_extract(s.payload,'$.conviction') AS INTEGER) AS conviction,
         CASE WHEN q.signal_id IS NULL THEN 1 ELSE 0 END AS silenced
  FROM signals s
  LEFT JOIN qualified_signals q ON q.signal_id = s.id
  WHERE s.rule_id = 'absorption'
    AND s.symbol  = 'NQ'
    AND s.ts >= ?
    AND time(s.ts/1000,'unixepoch','-4 hours') >= '09:30:00'
    AND time(s.ts/1000,'unixepoch','-4 hours') <  '16:00:00'
  ORDER BY s.ts
`).all(tickFloor) as AbsoSig[];

const dropped = rawSigs.filter(s => !s.entry || s.entry <= 0).length;
const sigs    = rawSigs.filter(s => s.entry && s.entry > 0);

const stmtTrades = xdb.prepare(`
  SELECT ts, price FROM trades
  WHERE symbol=? AND ts > ?
  ORDER BY ts ASC, id ASC
`).raw(true);

interface Row {
  sig: AbsoSig;
  outcome: 'WIN'|'LOSS'|'OPEN';
}

const rows: Row[] = [];
for (const s of sigs) {
  let outcome: 'WIN'|'LOSS'|'OPEN' = 'OPEN';
  const iter = stmtTrades.iterate(s.symbol, s.ts) as IterableIterator<[number, number]>;
  for (const [, px] of iter) {
    const fav = s.direction === 'long' ? px - s.entry : s.entry - px;
    const adv = s.direction === 'long' ? s.entry - px : px - s.entry;
    if (adv >= SL) { outcome = 'LOSS'; break; }
    if (fav >= TP) { outcome = 'WIN';  break; }
  }
  if (typeof (iter as any).return === 'function') (iter as any).return();
  rows.push({ sig: s, outcome });
}

function summarize(label: string, rs: Row[]) {
  const w = rs.filter(r => r.outcome === 'WIN').length;
  const l = rs.filter(r => r.outcome === 'LOSS').length;
  const o = rs.filter(r => r.outcome === 'OPEN').length;
  const dec = w + l;
  const wr  = dec ? (w/dec*100) : 0;
  const net = w * TP - l * SL;
  console.log(`  ${label.padEnd(28)}  n=${String(rs.length).padStart(4)}  W=${String(w).padStart(3)}  L=${String(l).padStart(3)}  O=${String(o).padStart(2)}  WR=${wr.toFixed(0).padStart(3)}%  Net=${String(net).padStart(7)}pt`);
}

console.log(`Historical NQ absorption — RTH only — TP=${TP}pt SL=${SL}pt (unbounded)`);
console.log(`Tick floor: ${new Date(tickFloor).toISOString()}`);
console.log(`Sample: ${rawSigs.length} fetched, ${dropped} dropped (null entry), ${sigs.length} analyzed\n`);

console.log('OVERALL');
summarize('all', rows);

console.log('\nBY DIRECTION');
summarize('LONG',  rows.filter(r => r.sig.direction === 'long'));
summarize('SHORT', rows.filter(r => r.sig.direction === 'short'));

console.log('\nBY SCORE THRESHOLD');
for (const t of [60, 70, 75, 80, 85, 90, 95]) {
  summarize(`score >= ${t}`, rows.filter(r => r.sig.score >= t));
}

console.log('\nBY CONVICTION');
summarize('conviction = 0', rows.filter(r => r.sig.conviction === 0));
summarize('conviction = 1', rows.filter(r => r.sig.conviction === 1));
summarize('conviction null', rows.filter(r => r.sig.conviction === null));

console.log('\nBY SILENCED-FLAG');
summarize('qualified (gate-passed)', rows.filter(r => r.sig.silenced === 0));
summarize('silenced (gate-blocked)', rows.filter(r => r.sig.silenced === 1));

console.log('\nLONG ONLY — score interaction');
for (const t of [60, 70, 75, 80, 85, 90, 95]) {
  summarize(`L score >= ${t}`, rows.filter(r => r.sig.direction === 'long' && r.sig.score >= t));
}

console.log('\nSHORT ONLY — score interaction');
for (const t of [60, 70, 75, 80, 85, 90, 95]) {
  summarize(`S score >= ${t}`, rows.filter(r => r.sig.direction === 'short' && r.sig.score >= t));
}

tdb.close(); xdb.close();
