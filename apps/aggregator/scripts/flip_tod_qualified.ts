// FLIP LONG/SHORT win-rate by 30-min TOD bucket — using QUALIFIED v3_decisions only.
// This is the data source the trader actually acts on: ruleId='clean-impulse',
// pattern='FLIP', qualified=1, action='OPEN'. Joins with CLOSE rows for outcome.

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });

interface Row {
  open_id: number; ts: number; symbol: string; direction: 'long' | 'short';
  exit_outcome: string | null; pnl_pts: number | null;
}

const rows = db.prepare(`
  SELECT o.id AS open_id, o.ts, o.symbol, o.direction,
         c.exit_outcome, c.pnl_pts
  FROM v3_decisions o
  LEFT JOIN v3_decisions c
       ON c.action='CLOSE' AND c.open_trade_id = o.id
  WHERE o.rule_id='clean-impulse' AND o.pattern='FLIP'
    AND o.qualified=1 AND o.action='OPEN'
  ORDER BY o.ts ASC
`).all() as Row[];

console.log(`Total qualified FLIP OPEN decisions (long+short): ${rows.length}`);

function getETMin(ts: number): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ts));
  return parseInt(p.find(x => x.type === 'hour')?.value ?? '0', 10) * 60
       + parseInt(p.find(x => x.type === 'minute')?.value ?? '0', 10);
}

function fmt(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// Normalize outcome to W/L/O. WIN counts as W, LOSS/OPP_SIG_EXIT/CLOSE_AT_BELL with negative pnl = L, otherwise O.
function outcomeOf(r: Row): 'W' | 'L' | 'O' {
  if (r.exit_outcome === 'WIN') return 'W';
  if (r.exit_outcome === 'LOSS') return 'L';
  if ((r.pnl_pts ?? 0) > 0) return 'W';
  if ((r.pnl_pts ?? 0) < 0) return 'L';
  return 'O';
}

function summarize(rs: Row[], label: string) {
  const buckets = new Map<number, Row[]>();
  for (const r of rs) {
    const etMin = getETMin(r.ts);
    if (etMin < 570 || etMin >= 960) continue;
    const b = Math.floor(etMin / 30) * 30;
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b)!.push(r);
  }
  console.log(`\n══ ${label} ══`);
  console.log('bucket        n    W    L    O   WR%   netPts   $@MNQ');
  const totals = { n: 0, w: 0, l: 0, o: 0, pts: 0 };
  for (const [b, arr] of [...buckets.entries()].sort((a,b) => a[0]-b[0])) {
    const ws = arr.filter(x => outcomeOf(x) === 'W').length;
    const ls = arr.filter(x => outcomeOf(x) === 'L').length;
    const os = arr.filter(x => outcomeOf(x) === 'O').length;
    const wr = (ws + ls) ? (ws / (ws + ls) * 100).toFixed(0) : '--';
    const pts = arr.reduce((s, x) => s + (x.pnl_pts ?? 0), 0);
    console.log(`${fmt(b)}-${fmt(b+30)}  ${String(arr.length).padStart(2)}  ${String(ws).padStart(3)}  ${String(ls).padStart(3)}  ${String(os).padStart(3)}  ${String(wr).padStart(4)}   ${pts >= 0 ? '+' : ''}${pts.toFixed(0).padStart(5)}   ${(pts*2 >= 0 ? '+$' : '-$') + Math.abs(pts*2).toFixed(0)}`);
    totals.n += arr.length; totals.w += ws; totals.l += ls; totals.o += os; totals.pts += pts;
  }
  const twr = (totals.w + totals.l) ? (totals.w / (totals.w + totals.l) * 100).toFixed(0) : '--';
  console.log(`TOTAL        ${String(totals.n).padStart(2)}  ${String(totals.w).padStart(3)}  ${String(totals.l).padStart(3)}  ${String(totals.o).padStart(3)}  ${String(twr).padStart(4)}   ${totals.pts >= 0 ? '+' : ''}${totals.pts.toFixed(0).padStart(5)}   ${(totals.pts*2 >= 0 ? '+$' : '-$') + Math.abs(totals.pts*2).toFixed(0)}`);
}

summarize(rows.filter(r => r.direction === 'long'),  'FLIP LONG  (qualified, V3 sim)');
summarize(rows.filter(r => r.direction === 'short'), 'FLIP SHORT (qualified, V3 sim)');
