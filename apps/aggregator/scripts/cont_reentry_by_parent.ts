// For every cont-reentry signal, identify its parent's rule_id and compute WR per parent type.

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'), { readonly: true });

const TP = 80, SL = 70, FWD = 120*60_000;

const conts = db.prepare(`
  SELECT id, ts, symbol, direction, score, payload
  FROM signals
  WHERE rule_id='cont-reentry'
  ORDER BY ts ASC
`).all() as Array<{ id: number; ts: number; symbol: string; direction: 'long'|'short'; score: number; payload: string }>;

const findParent = db.prepare(`
  SELECT id, rule_id, score,
         json_extract(payload,'$.pattern') AS pattern,
         json_extract(payload,'$.entry') AS entry
  FROM signals
  WHERE symbol=? AND direction=? AND ts=?
  LIMIT 1
`);

const fwd = ticksDb.prepare(`SELECT price FROM trades WHERE symbol=? AND ts > ? AND ts <= ? ORDER BY ts ASC`);

function simulate(entry: number, ts: number, sym: string, dir: 'long'|'short') {
  const ticks = fwd.all(sym, ts, ts + FWD) as Array<{ price: number }>;
  for (const t of ticks) {
    const m = dir === 'long' ? t.price - entry : entry - t.price;
    if (m >=  TP) return { o: 'W', pts:  TP };
    if (m <= -SL) return { o: 'L', pts: -SL };
  }
  if (!ticks.length) return { o: 'O', pts: 0 };
  const last = ticks[ticks.length-1]!.price;
  const m = dir === 'long' ? last - entry : entry - last;
  return { o: m>0?'W':m<0?'L':'O', pts: m };
}

interface Row { contId: number; sym: string; dir: string; parentRule: string; parentPattern: string|null; outcome: string; pts: number; }
const rows: Row[] = [];

for (const c of conts) {
  const p = JSON.parse(c.payload);
  const parentTs = p.parentTs;
  if (!parentTs) {
    rows.push({ contId: c.id, sym: c.symbol, dir: c.direction, parentRule: '(no_parent_ts)', parentPattern: null, outcome: '?', pts: 0 });
    continue;
  }
  // Find parent by exact ts match (cont-reentry stores parent's signal.ts)
  const parent = findParent.get(c.symbol, c.direction, parentTs) as any;
  const parentRule    = parent?.rule_id ?? '(parent_not_found)';
  const parentPattern = parent?.pattern ?? null;
  const result = simulate(p.entry, c.ts, c.symbol, c.direction);
  rows.push({ contId: c.id, sym: c.symbol, dir: c.direction, parentRule, parentPattern, outcome: result.o, pts: result.pts });
}

console.log('═══ cont-reentry signals by parent type ═══');
const byParent = new Map<string, Row[]>();
for (const r of rows) {
  const k = r.parentPattern ? `${r.parentRule}:${r.parentPattern}` : r.parentRule;
  if (!byParent.has(k)) byParent.set(k, []);
  byParent.get(k)!.push(r);
}
console.log(`${'parent'.padEnd(28)}  n   W   L   WR   netPts`);
const sorted = [...byParent.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [parent, arr] of sorted) {
  const w = arr.filter(x => x.outcome === 'W').length;
  const l = arr.filter(x => x.outcome === 'L').length;
  const o = arr.filter(x => x.outcome === 'O').length;
  const wr = (w+l) ? (w/(w+l)*100).toFixed(0) : '--';
  const pts = arr.reduce((s, x) => s + x.pts, 0);
  console.log(`${parent.padEnd(28)}  ${String(arr.length).padStart(2)}  ${String(w).padStart(2)}  ${String(l).padStart(2)}  ${String(wr).padStart(3)}%  ${pts.toFixed(0).padStart(6)}`);
}

console.log('\n═══ EXPL-parent detail ═══');
const exol = rows.filter(r => r.parentRule === 'expl');
console.log(`Total cont-reentry with EXPL parent: ${exol.length}`);
console.log(`  W: ${exol.filter(r => r.outcome === 'W').length}`);
console.log(`  L: ${exol.filter(r => r.outcome === 'L').length}`);
for (const e of exol) {
  console.log(`  contId=${e.contId} ${e.sym} ${e.dir} ${e.outcome} ${e.pts.toFixed(1)}pts`);
}
