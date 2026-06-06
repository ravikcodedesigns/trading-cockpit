/**
 * pnl_all_qualified.ts
 *
 * Computes trade-by-trade PnL for every signal in qualified_signals.
 *
 * Exit logic (in priority order):
 *   1. TP hit first  → PnL = +TP.  maxDD = max adverse excursion from entry until TP tick.
 *   2. SL hit first  → PnL = -SL.  No maxDD column (it just hit the stop).
 *   3. Neither by EOD → exit at last RTH tick price. PnL = actual exit pnl.
 *                       maxDD = max adverse excursion from entry to close.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const trDb    = new Database(path.resolve(__dirname, '../../../data/trading.db'),   { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'),     { readonly: true });

const TP = 80;

function getSL(ruleId: string, direction: string): number | null {
  if (ruleId === 'clean-impulse' && direction === 'long')  return 55;
  if (ruleId === 'clean-impulse' && direction === 'short') return 105;
  if (ruleId === 'expl')                                    return 70;
  if (ruleId === 'absorption' && direction === 'long')      return 140;
  if (ruleId === 'absorption' && direction === 'short')     return 60;
  return null;
}

function etParts(ms: number) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
}
function isRTH(ms: number): boolean {
  const p = etParts(ms);
  const wd = p.find(x => x.type === 'weekday')!.value;
  const h  = parseInt(p.find(x => x.type === 'hour')!.value, 10);
  const m  = parseInt(p.find(x => x.type === 'minute')!.value, 10);
  return ['Mon','Tue','Wed','Thu','Fri'].includes(wd) && h * 60 + m >= 570 && h * 60 + m < 960;
}
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

type ExitKind = 'TP' | 'SL' | 'EOD';
interface TradeResult {
  kind:   ExitKind;
  pnl:    number;
  maxDD:  number | null; // null for SL exits (not meaningful)
  label:  string;
}

function simulate(ts: number, ep: number, dir: 'long' | 'short', sl: number): TradeResult {
  const end    = rthEnd(ts);
  const trades = fwdQuery.all(ts, end) as { ts: number; price: number }[];

  let maxDD     = 0;
  let lastPrice = ep;

  for (const t of trades) {
    const pnl = dir === 'long' ? t.price - ep : ep - t.price;
    lastPrice  = t.price;

    // Track max adverse excursion as we go
    if (pnl < 0 && -pnl > maxDD) maxDD = -pnl;

    if (pnl >= TP) {
      // TP hit — maxDD is everything adverse up to this tick
      return { kind: 'TP', pnl: TP, maxDD, label: `✓ TP +${TP}` };
    }
    if (pnl <= -sl) {
      // SL hit — no maxDD reported (it's just the stop)
      return { kind: 'SL', pnl: -sl, maxDD: null, label: `✗ SL -${sl}` };
    }
  }

  // Neither hit — exit at last available RTH tick
  const exitPnl = dir === 'long' ? lastPrice - ep : ep - lastPrice;
  const sign    = exitPnl >= 0 ? '+' : '';
  return {
    kind:  'EOD',
    pnl:   exitPnl,
    maxDD, // max adverse excursion during the whole held period
    label: `~ EOD ${sign}${exitPnl.toFixed(1)}`,
  };
}

// ── Load all qualified signals ───────────────────────────────────────────────
// ABSO excluded 2026-06-02: per user direction, absorption is no longer counted
// in WR/PnL aggregates for V3/qualified-eligible signals. Detection and
// qualified_signals logging continue — use scripts/abso_*.ts for ABSO-only
// analyses. This script's "all qualified" intentionally excludes ABSO now.
const rows = trDb.prepare(`
  SELECT q.signal_id, q.signal_ts, q.symbol, q.rule_id, q.direction, q.score, s.payload
  FROM qualified_signals q
  JOIN signals s ON s.id = q.signal_id
  WHERE q.rule_id != 'absorption'
  ORDER BY q.signal_ts ASC
`).all() as any[];

console.log(`\nPnL — ${rows.length} qualified signals | TP=${TP}pts | SL per strategy`);
console.log(`Exit: TP hit → +${TP} | SL hit → -SL | Neither by RTH close → exit at last tick\n`);
console.log('─'.repeat(88));
console.log(
  'date+time'.padEnd(14) + 'signal'.padEnd(10) + 'entry'.padEnd(9) +
  'result'.padEnd(18) + 'maxDD'.padEnd(8) + 'cumPnL'
);
console.log('─'.repeat(88));

type Group = { n: number; tp: number; sl: number; eod: number; pnl: number; sumMaxDD: number; nMaxDD: number };
const groups = new Map<string, Group>();

let cumPnL  = 0;
let skipped = 0;

for (const row of rows) {
  const sl = getSL(row.rule_id, row.direction);
  if (sl === null || row.symbol !== 'NQ' || !isRTH(row.signal_ts)) { skipped++; continue; }

  const ep = getEntry(row.signal_ts, row.payload);
  if (ep <= 0) { skipped++; continue; }

  const res = simulate(row.signal_ts, ep, row.direction as 'long' | 'short', sl);
  cumPnL += res.pnl;

  const arrow = row.direction === 'long' ? '↑' : '↓';
  const rule  = row.rule_id === 'clean-impulse' ? 'CF' : row.rule_id === 'absorption' ? 'ABSO' : row.rule_id.toUpperCase();
  const key   = `${row.rule_id}|${row.direction}`;

  const g = groups.get(key) ?? { n: 0, tp: 0, sl: 0, eod: 0, pnl: 0, sumMaxDD: 0, nMaxDD: 0 };
  g.n++; g.pnl += res.pnl;
  if (res.kind === 'TP')  g.tp++;
  if (res.kind === 'SL')  g.sl++;
  if (res.kind === 'EOD') g.eod++;
  if (res.maxDD !== null) { g.sumMaxDD += res.maxDD; g.nMaxDD++; }
  groups.set(key, g);

  const maxDDStr = res.maxDD !== null ? res.maxDD.toFixed(1) : '—';
  const cumSign  = cumPnL >= 0 ? '+' : '';

  console.log(
    etLabel(row.signal_ts).padEnd(14) +
    `${rule}${arrow} ${row.score}`.padEnd(10) +
    ep.toFixed(2).padEnd(9) +
    res.label.padEnd(18) +
    maxDDStr.padEnd(8) +
    `${cumSign}${cumPnL.toFixed(0)}`
  );
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log('─'.repeat(88));
console.log('\nSummary:\n');
console.log(
  'signal'.padEnd(26) + 'n'.padEnd(5) + 'TP'.padEnd(5) + 'SL'.padEnd(5) + 'EOD'.padEnd(6) +
  'TP%'.padEnd(7) + 'total'.padEnd(12) + 'avg/trade'.padEnd(12) + 'avgMaxDD(TP/EOD)'
);
console.log('─'.repeat(84));

let totN = 0, totTP = 0, totSL = 0, totEOD = 0, totPnl = 0;

for (const key of Array.from(groups.keys()).sort()) {
  const g   = groups.get(key)!;
  const tpPct = Math.round(g.tp / g.n * 100);
  const avg   = (g.pnl / g.n).toFixed(1);
  const avgDD = g.nMaxDD > 0 ? (g.sumMaxDD / g.nMaxDD).toFixed(1) : '—';
  console.log(
    key.padEnd(26) + String(g.n).padEnd(5) +
    String(g.tp).padEnd(5) + String(g.sl).padEnd(5) + String(g.eod).padEnd(6) +
    `${tpPct}%`.padEnd(7) +
    `${g.pnl >= 0 ? '+' : ''}${g.pnl.toFixed(0)}pts`.padEnd(12) +
    `${avg}pts`.padEnd(12) +
    avgDD
  );
  totN += g.n; totTP += g.tp; totSL += g.sl; totEOD += g.eod; totPnl += g.pnl;
}

if (skipped > 0) console.log(`\n  (${skipped} skipped: non-NQ, no entry, undefined SL, or overnight)`);

console.log('─'.repeat(84));
console.log(
  'TOTAL'.padEnd(26) + String(totN).padEnd(5) +
  String(totTP).padEnd(5) + String(totSL).padEnd(5) + String(totEOD).padEnd(6) +
  `${Math.round(totTP / totN * 100)}%`.padEnd(7) +
  `${totPnl >= 0 ? '+' : ''}${totPnl.toFixed(0)}pts`.padEnd(12) +
  `${(totPnl / totN).toFixed(1)}pts`
);
console.log(`\nTP=${TP}pts  SL: CF↑55 · CF↓105 · EXPL70 · ABSO↑140 · ABSO↓60`);
console.log('maxDD = max adverse excursion from entry to TP tick (wins) or to RTH close (EOD exits)');

trDb.close();
ticksDb.close();
