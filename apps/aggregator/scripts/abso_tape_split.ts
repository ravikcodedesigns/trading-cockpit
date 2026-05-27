/**
 * abso_tape_split.ts
 *
 * Splits qualified absorption signals by tapeSpeedConfirmed (from context_json)
 * and computes WR + PnL for each group.
 * Also breaks down by conviction level for shorts.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const trDb    = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'),   { readonly: true });

const TP       = 80;
const SL_LONG  = 140;
const SL_SHORT = 60;

function rthEnd(ms: number): number {
  const etStr = new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  const [m, d, y] = etStr.split('/').map(Number);
  const end = new Date(`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}T00:00:00`);
  end.setUTCHours(20, 0, 0, 0);
  if (end.getTime() <= ms) end.setUTCHours(21, 0, 0, 0);
  return end.getTime();
}
function etLabel(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms)).replace(',', '');
}

const fwdQuery = ticksDb.prepare(
  `SELECT ts, price FROM trades WHERE symbol='NQ' AND ts > ? AND ts <= ? ORDER BY ts ASC`
);
const entryQuery = ticksDb.prepare(
  `SELECT price FROM trades WHERE symbol='NQ' AND ts >= ? ORDER BY ts ASC LIMIT 1`
);

function getEntry(ts: number, payload: string): number {
  const p = JSON.parse(payload);
  if (p.entry && p.entry > 1000) return p.entry;
  const row = entryQuery.get(ts) as any;
  return row?.price ?? 0;
}

function outcome(ts: number, ep: number, dir: 'long' | 'short'): { pnl: number; maxGain: number; maxDD: number; label: string } {
  if (ep <= 0) return { pnl: 0, maxGain: 0, maxDD: 0, label: 'no-entry' };
  const sl  = dir === 'long' ? SL_LONG : SL_SHORT;
  const end = rthEnd(ts);
  const trades = fwdQuery.all(ts, end) as { ts: number; price: number }[];
  let maxGain = 0, maxDD = 0, tpTs: number | null = null, slTs: number | null = null;
  for (const t of trades) {
    const pnl = dir === 'long' ? t.price - ep : ep - t.price;
    if (pnl > maxGain) maxGain = pnl;
    if (-pnl > maxDD)  maxDD = -pnl;
    if (tpTs === null && pnl >= TP)  tpTs = t.ts;
    if (slTs === null && pnl <= -sl) slTs = t.ts;
  }
  if (tpTs !== null && (slTs === null || tpTs <= slTs)) return { pnl: TP,  maxGain, maxDD, label: `✓ TP +${TP}` };
  if (slTs !== null)                                    return { pnl: -sl, maxGain, maxDD, label: `✗ SL -${sl}` };
  return { pnl: 0, maxGain, maxDD, label: '~ scratch' };
}

const rows = trDb.prepare(`
  SELECT q.signal_id, q.signal_ts, q.direction, q.score, s.payload,
    json_extract(q.context_json, '$.tapeSpeedConfirmed') AS tape,
    json_extract(q.context_json, '$.conviction')         AS conviction,
    json_extract(q.context_json, '$.trendAligned')       AS trend_aligned
  FROM qualified_signals q
  JOIN signals s ON s.id = q.signal_id
  WHERE q.rule_id = 'absorption' AND q.symbol = 'NQ'
  ORDER BY q.signal_ts ASC
`).all() as any[];

console.log(`\nAbsorption tape-speed confirmation split — n=${rows.length} qualified signals\n`);

// ── Per-signal table ─────────────────────────────────────────────────────────
console.log('date+time     dir    sc  tape  conviction  trendAl  result      maxGain  maxDD');
console.log('─'.repeat(86));

type Bucket = { n: number; wins: number; losses: number; scratches: number; pnl: number };
const byTape: Record<string, Bucket> = {};

for (const row of rows) {
  const ep  = getEntry(row.signal_ts, row.payload);
  const dir = row.direction as 'long' | 'short';
  const res = outcome(row.signal_ts, ep, dir);

  const tape   = row.tape === 1 ? 'yes' : 'no';
  const conv   = row.conviction ?? '-';
  const trend  = row.trend_aligned === null ? '-' : row.trend_aligned ? 'Y' : 'N';
  const key    = `${dir}|tape=${tape}`;

  const b = byTape[key] ?? { n: 0, wins: 0, losses: 0, scratches: 0, pnl: 0 };
  b.n++;
  if (res.pnl > 0) b.wins++;
  else if (res.pnl < 0) b.losses++;
  else b.scratches++;
  b.pnl += res.pnl;
  byTape[key] = b;

  const arrow = dir === 'long' ? '↑' : '↓';
  console.log(
    etLabel(row.signal_ts).padEnd(14) +
    `ABSO${arrow}`.padEnd(7) +
    String(row.score).padEnd(4) +
    tape.padEnd(6) +
    String(conv).padEnd(12) +
    trend.padEnd(9) +
    res.label.padEnd(12) +
    res.maxGain.toFixed(1).padEnd(9) +
    res.maxDD.toFixed(1)
  );
}

// ── Summary table ────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(72));
console.log('\nSummary — tapeSpeedConfirmed split:\n');
console.log('group'.padEnd(24) + 'n'.padEnd(5) + 'WR%'.padEnd(7) + 'total'.padEnd(10) + 'avg/trade');
console.log('─'.repeat(52));

for (const key of Object.keys(byTape).sort()) {
  const b = byTape[key]!;
  const wr  = Math.round(b.wins / b.n * 100);
  const avg = (b.pnl / b.n).toFixed(1);
  const flag = b.n < 10 ? ' ⚠ low-n' : '';
  console.log(
    key.padEnd(24) +
    String(b.n).padEnd(5) +
    `${wr}%`.padEnd(7) +
    `${b.pnl >= 0 ? '+' : ''}${b.pnl}pts`.padEnd(10) +
    `${avg} pts/trade${flag}`
  );
}

console.log(`\nTP=${TP}pts  SL: ABSO↑${SL_LONG} · ABSO↓${SL_SHORT}  (confirmed = tapeSpeedConfirmed=1 in absorption payload)`);
trDb.close();
ticksDb.close();
