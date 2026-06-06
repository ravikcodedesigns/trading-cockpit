// FLIP LONG/SHORT win-rate by 30-min time-of-day bucket.
// Uses trader's actual TP/SL: long TP=80/SL=55, short TP=80/SL=105.
// 120-min window after entry.

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'), { readonly: true });

const TP = 80;
const SL_LONG = 55;
const SL_SHORT = 105;
const WINDOW_MS = 120 * 60_000;

const signals = db.prepare(`
  SELECT id, ts, symbol, direction, score,
    json_extract(payload, '$.entry')   AS entry_price,
    json_extract(payload, '$.pattern') AS pattern
  FROM signals
  WHERE rule_id = 'clean-impulse'
  ORDER BY ts ASC
`).all() as any[];

const flips = signals.filter(s => s.pattern === 'FLIP' && s.entry_price);
console.log(`Total clean-impulse FLIP signals (long+short): ${flips.length}`);

const fwdQuery = ticksDb.prepare(
  `SELECT price FROM trades WHERE symbol=? AND ts > ? AND ts <= ? ORDER BY ts ASC`
);

function getETMin(ts: number): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ts));
  return parseInt(p.find(x => x.type === 'hour')?.value ?? '0', 10) * 60
       + parseInt(p.find(x => x.type === 'minute')?.value ?? '0', 10);
}

interface Result {
  dir: 'long' | 'short';
  sym: string;
  etMin: number;
  score: number;
  pnlPts: number;
  outcome: 'W' | 'L' | 'O';
}

const results: Result[] = [];

for (const sig of flips) {
  const etMin = getETMin(sig.ts);
  if (etMin < 570 || etMin >= 960) continue;  // RTH 9:30-16:00 only

  const entry = sig.entry_price as number;
  const dir = sig.direction as 'long' | 'short';
  const sl = dir === 'long' ? SL_LONG : SL_SHORT;
  const fwd = fwdQuery.all(sig.symbol, sig.ts, sig.ts + WINDOW_MS) as { price: number }[];

  let pnl = 0;
  let outcome: 'W' | 'L' | 'O' = 'O';
  for (const tick of fwd) {
    const move = dir === 'long' ? tick.price - entry : entry - tick.price;
    if (move >= TP) { outcome = 'W'; pnl =  TP; break; }
    if (move <= -sl) { outcome = 'L'; pnl = -sl; break; }
  }
  results.push({ dir, sym: sig.symbol, etMin, score: sig.score, pnlPts: pnl, outcome });
}

console.log(`Resolved: ${results.length} (W/L/O timed-out included)`);

// Bucket by 30-min TOD
function bucketStart(min: number): number { return Math.floor(min / 30) * 30; }
function fmt(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function summarize(rs: Result[], label: string) {
  const buckets = new Map<number, Result[]>();
  for (const r of rs) {
    const b = bucketStart(r.etMin);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b)!.push(r);
  }
  console.log(`\n══ ${label} (n=${rs.length}) ══`);
  console.log('bucket        n    W    L    O   WR%   netPts   $@MNQ($2/pt)');
  const totals = { n: 0, w: 0, l: 0, o: 0, pts: 0 };
  for (const [b, arr] of [...buckets.entries()].sort((a,b) => a[0]-b[0])) {
    const w = arr.filter(x => x.outcome === 'W').length;
    const l = arr.filter(x => x.outcome === 'L').length;
    const o = arr.filter(x => x.outcome === 'O').length;
    const resolved = w + l;
    const wr = resolved ? (w / resolved * 100).toFixed(0) : '--';
    const pts = arr.reduce((s, x) => s + x.pnlPts, 0);
    const dollars = pts * 2;
    console.log(`${fmt(b)}-${fmt(b+30)}  ${String(arr.length).padStart(2)}  ${String(w).padStart(3)}  ${String(l).padStart(3)}  ${String(o).padStart(3)}  ${String(wr).padStart(4)}   ${pts >= 0 ? '+' : ''}${pts.toFixed(0).padStart(5)}   ${(dollars >= 0 ? '+$' : '-$') + Math.abs(dollars).toFixed(0).padStart(5)}`);
    totals.n += arr.length; totals.w += w; totals.l += l; totals.o += o; totals.pts += pts;
  }
  const tWr = (totals.w + totals.l) ? (totals.w / (totals.w + totals.l) * 100).toFixed(0) : '--';
  console.log(`TOTAL        ${String(totals.n).padStart(2)}  ${String(totals.w).padStart(3)}  ${String(totals.l).padStart(3)}  ${String(totals.o).padStart(3)}  ${String(tWr).padStart(4)}   ${totals.pts >= 0 ? '+' : ''}${totals.pts.toFixed(0).padStart(5)}   ${(totals.pts*2 >= 0 ? '+$' : '-$') + Math.abs(totals.pts*2).toFixed(0)}`);
}

summarize(results.filter(r => r.dir === 'long'),  'FLIP LONG  by 30-min TOD');
summarize(results.filter(r => r.dir === 'short'), 'FLIP SHORT by 30-min TOD');

// Aux: cumulative pnl by "trade from N onward"
function cumulFromOnward(rs: Result[], label: string) {
  console.log(`\n══ ${label} — cumulative WR/pts if we trade from time X onward ══`);
  console.log('fromTime    n    W    L   WR%   netPts   $@MNQ');
  for (let cutoff = 570; cutoff <= 870; cutoff += 30) {
    const arr = rs.filter(r => r.etMin >= cutoff);
    const w = arr.filter(x => x.outcome === 'W').length;
    const l = arr.filter(x => x.outcome === 'L').length;
    const resolved = w + l;
    const wr = resolved ? (w / resolved * 100).toFixed(0) : '--';
    const pts = arr.reduce((s, x) => s + x.pnlPts, 0);
    console.log(`${fmt(cutoff)}+      ${String(arr.length).padStart(2)}  ${String(w).padStart(3)}  ${String(l).padStart(3)}  ${String(wr).padStart(4)}   ${pts >= 0 ? '+' : ''}${pts.toFixed(0).padStart(5)}   ${(pts*2 >= 0 ? '+$' : '-$') + Math.abs(pts*2).toFixed(0)}`);
  }
}

cumulFromOnward(results.filter(r => r.dir === 'long'),  'FLIP LONG');
cumulFromOnward(results.filter(r => r.dir === 'short'), 'FLIP SHORT');

// Aux: cumulative pnl by "trade UNTIL time X"
function cumulUntil(rs: Result[], label: string) {
  console.log(`\n══ ${label} — cumulative WR/pts if we stop at time X (entries up to X) ══`);
  console.log('untilTime   n    W    L   WR%   netPts   $@MNQ');
  for (let cutoff = 600; cutoff <= 960; cutoff += 30) {
    const arr = rs.filter(r => r.etMin < cutoff);
    const w = arr.filter(x => x.outcome === 'W').length;
    const l = arr.filter(x => x.outcome === 'L').length;
    const resolved = w + l;
    const wr = resolved ? (w / resolved * 100).toFixed(0) : '--';
    const pts = arr.reduce((s, x) => s + x.pnlPts, 0);
    console.log(`<${fmt(cutoff)}    ${String(arr.length).padStart(2)}  ${String(w).padStart(3)}  ${String(l).padStart(3)}  ${String(wr).padStart(4)}   ${pts >= 0 ? '+' : ''}${pts.toFixed(0).padStart(5)}   ${(pts*2 >= 0 ? '+$' : '-$') + Math.abs(pts*2).toFixed(0)}`);
  }
}

cumulUntil(results.filter(r => r.dir === 'long'),  'FLIP LONG');
cumulUntil(results.filter(r => r.dir === 'short'), 'FLIP SHORT');
