// rs-shadow-resolve — post-close outcome resolution for the EST shadow harness.
// For each unresolved shadow_setups row whose session has ENDED, walk ticks.db
// forward from the emit tick to session close (15:54 ET) and record WIN/LOSS/OPEN
// at the structural stop vs the first interrupt (targets[0]). WIN/LOSS/OPEN only —
// NEVER MFE/MAE. Then print WR by pivot / size-tier vs the framework base prob.
//
//   pnpm exec tsx scripts/rs-shadow-resolve.ts
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const SHADOW_DB = path.join(ROOT, 'data/rs-shadow.db');
const TICKS_DB = path.join(ROOT, 'data/ticks.db');

// Session close (15:54 ET = MOC, matching the backtest convention) for a YYYY-MM-DD
// trading day, DST-correct: try both ET offsets, keep the one whose wall-clock is 15:54.
function etCloseMs(day: string): number {
  for (const off of ['-04:00', '-05:00']) {
    const d = new Date(`${day}T15:54:00${off}`);
    const wall = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    if (wall === '15:54') return d.getTime();
  }
  return new Date(`${day}T15:54:00-05:00`).getTime();
}

interface Row {
  id: number; trading_day: string; ts_ms: number; symbol: string;
  direction: string; entry: number; stop: number; targets: string; pivot: string; size_tier: string; base_prob: number;
}

const db = new Database(SHADOW_DB);
const ticks = new Database(TICKS_DB, { readonly: true, fileMustExist: true });
const walkQ = ticks.prepare('SELECT ts, price FROM trades WHERE symbol=? AND ts>? AND ts<=? ORDER BY ts');
const update = db.prepare('UPDATE shadow_setups SET outcome=?, exit_price=?, exit_ts_ms=?, pnl_pts=?, resolved_at=? WHERE id=?');

const nowMs = Date.now();
const rows = db.prepare('SELECT id,trading_day,ts_ms,symbol,direction,entry,stop,targets,pivot,size_tier,base_prob FROM shadow_setups WHERE outcome IS NULL').all() as Row[];

let resolved = 0, skipped = 0;
for (const r of rows) {
  const closeMs = etCloseMs(r.trading_day);
  if (closeMs > nowMs) { skipped++; continue; }            // session not over yet
  const long = r.direction === 'long';
  const tp = (JSON.parse(r.targets || '[]') as number[])[0];  // first interrupt = TP
  let outcome = 'OPEN'; let exitPrice: number | null = null; let exitTs: number | null = null;
  for (const t of walkQ.iterate(r.symbol, r.ts_ms, closeMs) as IterableIterator<{ ts: number; price: number }>) {
    const p = t.price;
    if (tp != null && (long ? p >= tp : p <= tp)) { outcome = 'WIN'; exitPrice = tp; exitTs = t.ts; break; }
    if (long ? p <= r.stop : p >= r.stop) { outcome = 'LOSS'; exitPrice = r.stop; exitTs = t.ts; break; }
  }
  const pnl = exitPrice == null ? null : +(long ? exitPrice - r.entry : r.entry - exitPrice).toFixed(2);
  update.run(outcome, exitPrice, exitTs, pnl, nowMs, r.id);
  resolved++;
}
console.error(`resolved ${resolved} row(s); ${skipped} still in-session (skipped)`);

// --- Summary: WR by pivot, then by size-tier (resolved WIN/LOSS only). ---
function table(groupBy: 'pivot' | 'size_tier') {
  const g = db.prepare(`SELECT ${groupBy} k,
      SUM(outcome='WIN') w, SUM(outcome='LOSS') l, SUM(outcome='OPEN') o,
      AVG(CASE WHEN outcome IN ('WIN','LOSS') THEN pnl_pts END) avgpnl, AVG(base_prob) bp
    FROM shadow_setups WHERE outcome IS NOT NULL GROUP BY ${groupBy} ORDER BY (w+l) DESC`).all() as
    Array<{ k: string; w: number; l: number; o: number; avgpnl: number | null; bp: number }>;
  if (!g.length) { console.log(`  (no resolved rows)`); return; }
  console.log(`  ${'group'.padEnd(10)} ${'n'.padStart(4)} ${'W'.padStart(3)} ${'L'.padStart(3)} ${'O'.padStart(3)} ${'WR%'.padStart(5)} ${'avgPnl'.padStart(7)} ${'baseP'.padStart(6)}`);
  for (const r of g) {
    const dec = r.w + r.l;
    const wr = dec ? (100 * r.w / dec).toFixed(0) : '—';
    console.log(`  ${String(r.k).padEnd(10)} ${String(dec + r.o).padStart(4)} ${String(r.w).padStart(3)} ${String(r.l).padStart(3)} ${String(r.o).padStart(3)} ${wr.padStart(5)} ${(r.avgpnl ?? 0).toFixed(1).padStart(7)} ${(100 * r.bp).toFixed(0).padStart(5)}%`);
  }
}
console.log('\n=== WR by pivot (vs framework baseP) ==='); table('pivot');
console.log('\n=== WR by size tier ==='); table('size_tier');
db.close(); ticks.close();
