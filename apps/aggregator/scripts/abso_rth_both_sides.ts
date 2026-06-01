/**
 * abso_rth_both_sides.ts — RTH NQ absorption at TP=80/SL=140, RTH-bounded,
 * NO_DATA excluded. Reports LONG and SHORT separately, and shows max
 * consecutive losses in time-ordered sequence (per direction and combined).
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

interface AbsoSig {
  id: number; ts: number; symbol: string; direction: 'long'|'short';
  score: number; entry: number; conviction: number | null;
  qualified: number; payload: string;
}

const rawSigs = tdb.prepare(`
  SELECT s.id, s.ts, s.symbol, s.direction, s.score,
         CAST(json_extract(s.payload,'$.entry') AS REAL) AS entry,
         CAST(json_extract(s.payload,'$.conviction') AS INTEGER) AS conviction,
         CASE WHEN q.signal_id IS NULL THEN 0 ELSE 1 END AS qualified,
         s.payload
  FROM signals s
  LEFT JOIN qualified_signals q ON q.signal_id = s.id
  WHERE s.rule_id = 'absorption' AND s.symbol = 'NQ'
    AND s.ts >= ?
    AND time(s.ts/1000,'unixepoch','-4 hours') >= '09:30:00'
    AND time(s.ts/1000,'unixepoch','-4 hours') <  '16:00:00'
  ORDER BY s.ts
`).all(tickFloor) as AbsoSig[];

const reAbsorbedAt = /absorbed at (\d+\.?\d*)/;
for (const s of rawSigs) {
  if (!s.entry || s.entry <= 0) {
    const m = s.payload.match(reAbsorbedAt);
    if (m) s.entry = parseFloat(m[1]);
  }
}
const sigs = rawSigs.filter(s => s.entry && s.entry > 0);

function rthCloseMs(tsMs: number): number {
  const d = new Date(tsMs - 4 * 60 * 60_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 20, 0, 0, 0);
}
function etISO(tsMs: number): string {
  const d = new Date(tsMs - 4 * 60 * 60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}

const stmtTrades = xdb.prepare(`
  SELECT ts, price FROM trades
  WHERE symbol=? AND ts > ? AND ts <= ?
  ORDER BY ts ASC, id ASC
`).raw(true);

interface Row {
  sig: AbsoSig;
  outcome: 'WIN'|'LOSS'|'CLOSE'|'NO_DATA';
  pnl: number;
}

function resolve(s: AbsoSig): Row {
  const closeMs = rthCloseMs(s.ts);
  let lastPx = NaN, saw = false;
  const iter = stmtTrades.iterate(s.symbol, s.ts, closeMs) as IterableIterator<[number, number]>;
  for (const [, px] of iter) {
    saw = true; lastPx = px;
    const fav = s.direction === 'long' ? px - s.entry : s.entry - px;
    const adv = s.direction === 'long' ? s.entry - px : px - s.entry;
    if (adv >= SL) { if ((iter as any).return) (iter as any).return(); return { sig: s, outcome: 'LOSS', pnl: -SL }; }
    if (fav >= TP) { if ((iter as any).return) (iter as any).return(); return { sig: s, outcome: 'WIN',  pnl: TP }; }
  }
  if (!saw) return { sig: s, outcome: 'NO_DATA', pnl: 0 };
  const pnl = s.direction === 'long' ? (lastPx - s.entry) : (s.entry - lastPx);
  return { sig: s, outcome: 'CLOSE', pnl };
}

const rows: Row[] = sigs.map(resolve).filter(r => r.outcome !== 'NO_DATA');

// Treat CLOSE with pnl<=0 as a "loss-like" for streak purposes? The user asked for "consecutive losses"
// which I interpret as -SL hits. CLOSE with negative pnl is separate; I'll show both views.

function maxConsec(arr: Row[], pred: (r:Row)=>boolean): {len:number; from:string; to:string} {
  let best = 0, cur = 0;
  let bestStart = -1, bestEnd = -1, curStart = -1;
  for (let i = 0; i < arr.length; i++) {
    if (pred(arr[i])) {
      if (cur === 0) curStart = i;
      cur++;
      if (cur > best) { best = cur; bestStart = curStart; bestEnd = i; }
    } else {
      cur = 0;
    }
  }
  return {
    len: best,
    from: bestStart >= 0 ? etISO(arr[bestStart].sig.ts) : '',
    to:   bestEnd   >= 0 ? etISO(arr[bestEnd].sig.ts)   : '',
  };
}

function report(label: string, rs: Row[]) {
  const w = rs.filter(r => r.outcome === 'WIN').length;
  const l = rs.filter(r => r.outcome === 'LOSS').length;
  const c = rs.filter(r => r.outcome === 'CLOSE').length;
  const closeWins = rs.filter(r => r.outcome === 'CLOSE' && r.pnl > 0).length;
  const closeLosses = rs.filter(r => r.outcome === 'CLOSE' && r.pnl <= 0).length;
  const net = rs.reduce((a, r) => a + r.pnl, 0);
  const totProf = w + closeWins;
  const wr = rs.length ? (totProf / rs.length * 100) : 0;
  console.log(`\n=== ${label} (n=${rs.length}) ===`);
  console.log(`  WIN ${w}    LOSS ${l}    CLOSE ${c} (cw=${closeWins} cl=${closeLosses})`);
  console.log(`  Net: ${net.toFixed(0)}pt    Profitable: ${totProf}/${rs.length} = ${wr.toFixed(1)}%    PnL/sig: ${(net/rs.length).toFixed(1)}pt`);
  const slStreak = maxConsec(rs, r => r.outcome === 'LOSS');
  const slOrCloseLossStreak = maxConsec(rs, r => r.outcome === 'LOSS' || (r.outcome === 'CLOSE' && r.pnl <= 0));
  console.log(`  Max consec SL-LOSS:        ${slStreak.len}   (${slStreak.from} → ${slStreak.to})`);
  console.log(`  Max consec losing trade:   ${slOrCloseLossStreak.len}   (${slOrCloseLossStreak.from} → ${slOrCloseLossStreak.to})   [SL or CLOSE-negative]`);
}

console.log(`NQ RTH absorption — TP=${TP}pt SL=${SL}pt — RTH-bounded — NO_DATA excluded`);
console.log(`Evaluable signals: ${rows.length} (of ${sigs.length}; ${sigs.length - rows.length} no-data)`);

const longs  = rows.filter(r => r.sig.direction === 'long');
const shorts = rows.filter(r => r.sig.direction === 'short');

console.log(`\nDirection split: LONG=${longs.length}  SHORT=${shorts.length}`);

report('LONGS — all raw', longs);
report('LONGS — qualified', longs.filter(r => r.sig.qualified === 1));
report('SHORTS — all raw', shorts);
report('SHORTS — qualified', shorts.filter(r => r.sig.qualified === 1));
report('BOTH — all raw (time-ordered combined)', rows);
report('BOTH — qualified (time-ordered combined)', rows.filter(r => r.sig.qualified === 1));

// List the failures
console.log(`\n--- LONG failures (LOSS at -${SL}): ${longs.filter(r => r.outcome==='LOSS').length} ---`);
for (const r of longs.filter(r => r.outcome === 'LOSS')) {
  console.log(`  ${etISO(r.sig.ts)}  id=${r.sig.id}  score=${r.sig.score}  entry=${r.sig.entry.toFixed(2)}  qualified=${r.sig.qualified}`);
}
console.log(`\n--- SHORT failures (LOSS at -${SL}): ${shorts.filter(r => r.outcome==='LOSS').length} ---`);
for (const r of shorts.filter(r => r.outcome === 'LOSS')) {
  console.log(`  ${etISO(r.sig.ts)}  id=${r.sig.id}  score=${r.sig.score}  entry=${r.sig.entry.toFixed(2)}  qualified=${r.sig.qualified}`);
}

tdb.close(); xdb.close();
