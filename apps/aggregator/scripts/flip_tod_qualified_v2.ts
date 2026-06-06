// FLIP LONG/SHORT WR by 30-min TOD bucket — QUALIFIED signals only (post-quality.ts gate).
// This is what the trader will actually see at RTH (gold-tier broadcast).
// Uses trader's actual TP/SL: long TP=80/SL=55, short TP=80/SL=105.
// Outcome resolution: walk ticks to TP, SL, or RTH close (15:54 ET) — whichever first.

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db        = new Database(path.resolve(__dirname, '../../../data/trading.db'),   { readonly: true });
const ticksDb   = new Database(path.resolve(__dirname, '../../../data/ticks.db'),     { readonly: true });

const TP = 80, SL_LONG = 55, SL_SHORT = 105;

const rows = db.prepare(`
  SELECT s.id, s.ts, s.symbol, s.direction, s.score,
         json_extract(s.payload, '$.entry')   AS entry_price
  FROM qualified_signals q
  JOIN signals s ON s.id = q.signal_id
  WHERE s.rule_id = 'clean-impulse'
    AND json_extract(s.payload, '$.pattern') = 'FLIP'
  ORDER BY s.ts ASC
`).all() as any[];

console.log(`Qualified FLIPs: ${rows.length}`);

const fwdQuery = ticksDb.prepare(
  `SELECT price, ts FROM trades WHERE symbol=? AND ts > ? AND ts <= ? ORDER BY ts ASC`
);

function getETMin(ts: number): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ts));
  return parseInt(p.find(x => x.type === 'hour')?.value ?? '0', 10) * 60
       + parseInt(p.find(x => x.type === 'minute')?.value ?? '0', 10);
}
function fmt(min: number): string { return `${String(Math.floor(min/60)).padStart(2,'0')}:${String(min%60).padStart(2,'0')}`; }

interface Result { dir: 'long'|'short'; etMin: number; pnlPts: number; outcome: 'W'|'L'|'O'; }
const results: Result[] = [];

for (const r of rows) {
  const etMin = getETMin(r.ts);
  if (etMin < 570 || etMin >= 960) continue;
  const entry = r.entry_price;
  if (!entry) continue;
  const dir: 'long'|'short' = r.direction;
  const sl = dir === 'long' ? SL_LONG : SL_SHORT;

  // RTH close at 15:54 ET == 954 minutes. Convert to a ts cap.
  const sigDate = new Date(r.ts);
  const closeOfDayEt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(sigDate);
  const closeUtcMs = new Date(`${closeOfDayEt}T19:54:00Z`).getTime(); // 15:54 ET = 19:54 UTC (EDT)
  const cap = Math.min(r.ts + 6 * 60 * 60_000, closeUtcMs);

  const fwd = fwdQuery.all(r.symbol, r.ts, cap) as { price: number }[];
  let outcome: 'W'|'L'|'O' = 'O', pnl = 0;
  for (const t of fwd) {
    const move = dir === 'long' ? t.price - entry : entry - t.price;
    if (move >=  TP) { outcome = 'W'; pnl = TP;  break; }
    if (move <= -sl) { outcome = 'L'; pnl = -sl; break; }
  }
  if (outcome === 'O' && fwd.length) {
    const last = fwd[fwd.length - 1]!.price;
    const closeMove = dir === 'long' ? last - entry : entry - last;
    pnl = closeMove;  // mark-to-close
    outcome = closeMove > 0 ? 'W' : closeMove < 0 ? 'L' : 'O';
  }
  results.push({ dir, etMin, pnlPts: pnl, outcome });
}

function summarize(rs: Result[], label: string) {
  const buckets = new Map<number, Result[]>();
  for (const r of rs) {
    const b = Math.floor(r.etMin / 30) * 30;
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b)!.push(r);
  }
  console.log(`\n══ ${label} (n=${rs.length}) ══`);
  console.log('bucket        n    W    L    O   WR%   netPts   $@MNQ');
  const totals = { n: 0, w: 0, l: 0, o: 0, pts: 0 };
  for (const [b, arr] of [...buckets.entries()].sort((a,b) => a[0]-b[0])) {
    const w = arr.filter(x => x.outcome === 'W').length;
    const l = arr.filter(x => x.outcome === 'L').length;
    const o = arr.filter(x => x.outcome === 'O').length;
    const wr = (w + l) ? (w / (w + l) * 100).toFixed(0) : '--';
    const pts = arr.reduce((s, x) => s + x.pnlPts, 0);
    console.log(`${fmt(b)}-${fmt(b+30)}  ${String(arr.length).padStart(2)}  ${String(w).padStart(3)}  ${String(l).padStart(3)}  ${String(o).padStart(3)}  ${String(wr).padStart(4)}   ${pts >= 0 ? '+' : ''}${pts.toFixed(0).padStart(5)}   ${(pts*2 >= 0 ? '+$' : '-$') + Math.abs(pts*2).toFixed(0)}`);
    totals.n += arr.length; totals.w += w; totals.l += l; totals.o += o; totals.pts += pts;
  }
  const twr = (totals.w + totals.l) ? (totals.w / (totals.w + totals.l) * 100).toFixed(0) : '--';
  console.log(`TOTAL        ${String(totals.n).padStart(2)}  ${String(totals.w).padStart(3)}  ${String(totals.l).padStart(3)}  ${String(totals.o).padStart(3)}  ${String(twr).padStart(4)}   ${totals.pts >= 0 ? '+' : ''}${totals.pts.toFixed(0).padStart(5)}   ${(totals.pts*2 >= 0 ? '+$' : '-$') + Math.abs(totals.pts*2).toFixed(0)}`);
}

summarize(results.filter(r => r.dir === 'long'),  'QUALIFIED FLIP LONG  (TP=80 SL=55)');
summarize(results.filter(r => r.dir === 'short'), 'QUALIFIED FLIP SHORT (TP=80 SL=105)');

// "Trade from X onward" cumulative
function cumulFrom(rs: Result[], label: string) {
  console.log(`\n══ ${label} cumulative if we trade from X onward ══`);
  console.log('fromTime    n    W    L   WR%   netPts   $@MNQ');
  for (let cutoff = 570; cutoff <= 870; cutoff += 30) {
    const arr = rs.filter(r => r.etMin >= cutoff);
    const w = arr.filter(x => x.outcome === 'W').length;
    const l = arr.filter(x => x.outcome === 'L').length;
    const wr = (w + l) ? (w / (w + l) * 100).toFixed(0) : '--';
    const pts = arr.reduce((s, x) => s + x.pnlPts, 0);
    console.log(`${fmt(cutoff)}+      ${String(arr.length).padStart(2)}  ${String(w).padStart(3)}  ${String(l).padStart(3)}  ${String(wr).padStart(4)}   ${pts >= 0 ? '+' : ''}${pts.toFixed(0).padStart(5)}   ${(pts*2 >= 0 ? '+$' : '-$') + Math.abs(pts*2).toFixed(0)}`);
  }
}
function cumulUntil(rs: Result[], label: string) {
  console.log(`\n══ ${label} cumulative if we stop at time X ══`);
  console.log('untilTime   n    W    L   WR%   netPts   $@MNQ');
  for (let cutoff = 600; cutoff <= 960; cutoff += 30) {
    const arr = rs.filter(r => r.etMin < cutoff);
    const w = arr.filter(x => x.outcome === 'W').length;
    const l = arr.filter(x => x.outcome === 'L').length;
    const wr = (w + l) ? (w / (w + l) * 100).toFixed(0) : '--';
    const pts = arr.reduce((s, x) => s + x.pnlPts, 0);
    console.log(`<${fmt(cutoff)}    ${String(arr.length).padStart(2)}  ${String(w).padStart(3)}  ${String(l).padStart(3)}  ${String(wr).padStart(4)}   ${pts >= 0 ? '+' : ''}${pts.toFixed(0).padStart(5)}   ${(pts*2 >= 0 ? '+$' : '-$') + Math.abs(pts*2).toFixed(0)}`);
  }
}

cumulFrom (results.filter(r => r.dir === 'long'),  'QUALIFIED FLIP LONG');
cumulUntil(results.filter(r => r.dir === 'long'),  'QUALIFIED FLIP LONG');
cumulFrom (results.filter(r => r.dir === 'short'), 'QUALIFIED FLIP SHORT');
cumulUntil(results.filter(r => r.dir === 'short'), 'QUALIFIED FLIP SHORT');
