/**
 * abso_rth_longs_only.ts — RTH NQ absorption LONGs at TP=80/SL=140.
 * Trades bounded to RTH window of the same day (signal time to 16:00 ET).
 * If still open at 16:00 ET, exit at last RTH close price.
 *
 * Reports: (A) all raw absorption longs   (B) only qualified longs.
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
  id: number; ts: number; symbol: string; direction: 'long';
  score: number; entry: number; conviction: number | null;
  qualified: number;
  payload: string;
}

const tickFloor = (xdb.prepare(`SELECT MIN(ts) AS t FROM trades WHERE symbol='NQ'`).get() as {t:number}).t;

const rawSigs = tdb.prepare(`
  SELECT s.id, s.ts, s.symbol, s.direction, s.score,
         CAST(json_extract(s.payload,'$.entry') AS REAL) AS entry,
         CAST(json_extract(s.payload,'$.conviction') AS INTEGER) AS conviction,
         CASE WHEN q.signal_id IS NULL THEN 0 ELSE 1 END AS qualified,
         s.payload
  FROM signals s
  LEFT JOIN qualified_signals q ON q.signal_id = s.id
  WHERE s.rule_id = 'absorption'
    AND s.symbol  = 'NQ'
    AND s.direction = 'long'
    AND s.ts >= ?
    AND time(s.ts/1000,'unixepoch','-4 hours') >= '09:30:00'
    AND time(s.ts/1000,'unixepoch','-4 hours') <  '16:00:00'
  ORDER BY s.ts
`).all(tickFloor) as AbsoSig[];

// Recover entry from rationale text for older payloads ("absorbed at <price>")
const reAbsorbedAt = /absorbed at (\d+\.?\d*)/;
let recovered = 0;
for (const s of rawSigs) {
  if (!s.entry || s.entry <= 0) {
    const m = s.payload.match(reAbsorbedAt);
    if (m) { s.entry = parseFloat(m[1]); recovered++; }
  }
}
const dropped = rawSigs.filter(s => !s.entry || s.entry <= 0).length;
const sigs    = rawSigs.filter(s => s.entry && s.entry > 0);

console.log(`Raw fetched: ${rawSigs.length}, recovered ${recovered} entries from rationale, dropped ${dropped} unrecoverable, ${sigs.length} analyzed`);

// 16:00 ET = 20:00 UTC (assumes DST-on, May = EDT = UTC-4)
function rthCloseMsForSignal(tsMs: number): number {
  const d = new Date(tsMs);
  // Find the 16:00 ET of the SAME ET day. Build it as 20:00 UTC on the ET date.
  const etOffsetMs = 4 * 60 * 60_000;
  const etDate = new Date(tsMs - etOffsetMs); // shift into ET-naive
  const y = etDate.getUTCFullYear();
  const m = etDate.getUTCMonth();
  const day = etDate.getUTCDate();
  // 20:00 UTC on that ET date == 16:00 ET (assuming EDT)
  return Date.UTC(y, m, day, 20, 0, 0, 0);
}

const stmtTrades = xdb.prepare(`
  SELECT ts, price FROM trades
  WHERE symbol=? AND ts > ? AND ts <= ?
  ORDER BY ts ASC, id ASC
`).raw(true);

interface Row {
  sig: AbsoSig;
  outcome: 'WIN'|'LOSS'|'CLOSE'|'NO_DATA';
  pnl: number;        // pts; +TP, -SL, or close-PnL. 0 for NO_DATA (excluded from net)
  exitPrice: number;
}

function resolve(s: AbsoSig): Row {
  const rthCloseMs = rthCloseMsForSignal(s.ts);
  let lastPx = NaN;
  let sawAnyTick = false;
  const iter = stmtTrades.iterate(s.symbol, s.ts, rthCloseMs) as IterableIterator<[number, number]>;
  for (const [, px] of iter) {
    sawAnyTick = true;
    lastPx = px;
    const fav = px - s.entry;
    const adv = s.entry - px;
    if (adv >= SL) {
      if (typeof (iter as any).return === 'function') (iter as any).return();
      return { sig: s, outcome: 'LOSS', pnl: -SL, exitPrice: s.entry - SL };
    }
    if (fav >= TP) {
      if (typeof (iter as any).return === 'function') (iter as any).return();
      return { sig: s, outcome: 'WIN', pnl: TP, exitPrice: s.entry + TP };
    }
  }
  if (!sawAnyTick) return { sig: s, outcome: 'NO_DATA', pnl: 0, exitPrice: NaN };
  return { sig: s, outcome: 'CLOSE', pnl: lastPx - s.entry, exitPrice: lastPx };
}

const rows: Row[] = sigs.map(resolve);

function report(label: string, rs: Row[]) {
  const nd = rs.filter(r => r.outcome === 'NO_DATA').length;
  const eval_ = rs.filter(r => r.outcome !== 'NO_DATA');     // only the resolvable ones
  const w = eval_.filter(r => r.outcome === 'WIN').length;
  const l = eval_.filter(r => r.outcome === 'LOSS').length;
  const c = eval_.filter(r => r.outcome === 'CLOSE').length;
  const net = eval_.reduce((a, r) => a + r.pnl, 0);
  const closeNet = eval_.filter(r => r.outcome === 'CLOSE').reduce((a, r) => a + r.pnl, 0);
  const closeWins = eval_.filter(r => r.outcome === 'CLOSE' && r.pnl > 0).length;
  const closeLosses = eval_.filter(r => r.outcome === 'CLOSE' && r.pnl <= 0).length;
  const totalProfitable = w + closeWins;
  const overallWR = eval_.length ? (totalProfitable / eval_.length * 100) : 0;

  console.log(`\n=== ${label} (n=${rs.length} total; ${nd} no-data excluded; ${eval_.length} evaluable) ===`);
  console.log(`  WIN  (hit +${TP} before -${SL}):  ${w}    contribution +${w*TP}pt`);
  console.log(`  LOSS (hit -${SL} before +${TP}):  ${l}    contribution ${-l*SL}pt`);
  console.log(`  CLOSE (RTH close exit):         ${c}    contribution ${closeNet.toFixed(0)}pt  (wins ${closeWins} / losses ${closeLosses})`);
  console.log(`  Net PnL:                        ${net.toFixed(0)}pt`);
  console.log(`  Profitable outcomes (W+closeWin): ${totalProfitable}/${eval_.length} = ${overallWR.toFixed(1)}%`);
  console.log(`  PnL/signal (eval set):          ${(net/eval_.length).toFixed(1)}pt`);

  // Score interaction
  console.log(`  ---- score interaction ----`);
  for (const t of [60, 70, 75, 80, 85, 90, 95]) {
    const ss = rs.filter(r => r.sig.score >= t);
    if (ss.length === 0) continue;
    const ww = ss.filter(r => r.outcome === 'WIN').length;
    const ll = ss.filter(r => r.outcome === 'LOSS').length;
    const cc = ss.filter(r => r.outcome === 'CLOSE').length;
    const cwins = ss.filter(r => r.outcome === 'CLOSE' && r.pnl > 0).length;
    const nn = ss.reduce((a, r) => a + r.pnl, 0);
    const wr = ss.length ? ((ww + cwins)/ss.length*100) : 0;
    console.log(`    score>=${String(t).padStart(2)}  n=${String(ss.length).padStart(3)}  W=${String(ww).padStart(3)}  L=${String(ll).padStart(3)}  Cl=${String(cc).padStart(3)} (Cl-win=${String(cwins).padStart(2)})  WR=${wr.toFixed(0).padStart(3)}%  Net=${String(nn.toFixed(0)).padStart(6)}pt`);
  }
}

console.log(`\nNQ RTH absorption LONGs — TP=${TP}pt SL=${SL}pt — bounded to RTH close, exit at last RTH price if open`);
console.log(`Tick floor: ${new Date(tickFloor).toISOString()}`);

report('A — ALL RAW LONGS', rows);
report('B — QUALIFIED LONGS ONLY', rows.filter(r => r.sig.qualified === 1));

tdb.close(); xdb.close();
