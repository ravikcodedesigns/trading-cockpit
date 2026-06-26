// tradables_report.ts — the canonical tradables scorecard (per-signal / re-entry model).
// Reads the persisted outcomes on tradable_signals (sim_* columns, filled by
// persist_simulated_outcomes.ts). Prints:
//   1. Lifetime vs RECENT per signal type — the decay detector. A positive lifetime
//      PnL can hide a turned edge (cumulative never forgets old wins), so we put the
//      last-N-trades EV/WR next to lifetime so decay shows immediately.
//   2. Weekly rollup (per-signal model).
// Run: pnpm --filter @trading/aggregator exec tsx scripts/tradables_report.ts [--recent 20]
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });

const RECENT_N = Number((process.argv.find(a => a.startsWith('--recent='))?.split('=')[1])
  ?? (process.argv.includes('--recent') ? process.argv[process.argv.indexOf('--recent') + 1] : 20));

type Row = { rule_id: string; direction: string; signal_ts: number; sim_exit_reason: string | null; sim_pnl_pts: number };
const rows = db.prepare(
  `SELECT rule_id, direction, signal_ts, sim_exit_reason, sim_pnl_pts
   FROM tradable_signals WHERE action='OPEN' AND sim_pnl_pts IS NOT NULL
   ORDER BY signal_ts`).all() as Row[];

const label = (r: string) => (r === 'clean-impulse' ? 'FLIP' : r === 'cont-reentry' ? 'CONT' : r);
const usd = (n: number) => (n >= 0 ? '+$' : '-$') + Math.abs(Math.round(n));

function stats(rs: Row[]) {
  const n = rs.length;
  const tp = rs.filter(r => r.sim_exit_reason === 'TP').length;
  const sl = rs.filter(r => r.sim_exit_reason === 'SL').length;
  const pts = rs.reduce((s, r) => s + r.sim_pnl_pts, 0);
  return { n, tp, sl, wr: tp + sl ? Math.round((100 * tp) / (tp + sl)) : 0, ev: n ? (pts / n) * 2 : 0, pnl: pts * 2 };
}

// ── 1. Lifetime vs Recent per type ──────────────────────────────────────────
const types: { key: string; rule: string; dir: string }[] = [
  { key: 'FLIP long', rule: 'clean-impulse', dir: 'long' },
  { key: 'FLIP short', rule: 'clean-impulse', dir: 'short' },
  { key: 'CONT long', rule: 'cont-reentry', dir: 'long' },
  { key: 'CONT short', rule: 'cont-reentry', dir: 'short' },
];
console.log(`\nTRADABLES REPORT — per-signal (re-entry) model`);
console.log(`${rows.length} trades · ${rows[0] && new Date(rows[0].signal_ts).toLocaleDateString('en-CA')} → ${rows.at(-1) && new Date(rows.at(-1)!.signal_ts).toLocaleDateString('en-CA')} · lifetime ${usd(stats(rows).pnl)}`);
console.log(`\n── Lifetime vs RECENT (last ${RECENT_N}/type) — decay detector ──`);
console.log('type        │ life_n  life_WR  life_EV │ rec_n  rec_WR  rec_EV │  ΔEV    trend');
console.log('─'.repeat(82));
for (const t of types) {
  const all = rows.filter(r => r.rule_id === t.rule && r.direction === t.dir);
  const rec = all.slice(-RECENT_N);
  const L = stats(all), R = stats(rec);
  const dEv = R.ev - L.ev;
  const trend = R.ev < 0 ? '🔴 negative now'
    : dEv < -15 ? '🟠 decaying'
    : dEv > 15 ? '🟢 improving'
    : '⚪ stable';
  console.log(
    `${t.key.padEnd(11)} │ ${String(L.n).padStart(5)}  ${(L.wr + '%').padStart(6)}  ${usd(L.ev).padStart(6)} │ ` +
    `${String(R.n).padStart(4)}  ${(R.wr + '%').padStart(5)}  ${usd(R.ev).padStart(6)} │ ${usd(dEv).padStart(6)}  ${trend}`);
}

// ── 2. Weekly rollup ────────────────────────────────────────────────────────
const etDate = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));
const mondayOf = (ms: number) => {
  const d = new Date(etDate(ms) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const byWeek = new Map<string, Row[]>();
for (const r of rows) { const w = mondayOf(r.signal_ts); (byWeek.get(w) ?? byWeek.set(w, []).get(w)!).push(r); }
console.log(`\n── Weekly (per-signal) ──`);
console.log('week(Mon)  │ trades  W   L   WR   │ FLIP/CONT │  PnL');
console.log('─'.repeat(58));
for (const [w, rs] of [...byWeek].sort()) {
  const s = stats(rs);
  const flip = rs.filter(r => r.rule_id === 'clean-impulse').length;
  const cont = rs.filter(r => r.rule_id === 'cont-reentry').length;
  console.log(`${w} │ ${String(s.n).padStart(6)} ${String(s.tp).padStart(3)} ${String(s.sl).padStart(3)} ${(s.wr + '%').padStart(5)} │ ${String(flip).padStart(4)}/${String(cont).padEnd(4)} │ ${usd(s.pnl).padStart(7)}`);
}
console.log();
