// Persist tick-accurate simulated trade outcomes into tradable_signals so
// downstream analysis doesn't need to re-walk ticks every time it wants the
// historical P&L per signal.
//
// What it does:
//   1. ALTER TABLE tradable_signals to add four nullable outcome columns
//      (idempotent — try/catch each ALTER):
//        sim_exit_ts      INTEGER
//        sim_exit_price   REAL
//        sim_exit_reason  TEXT     -- 'TP' | 'SL' | 'OPP' | 'RTH'
//        sim_pnl_pts      REAL     -- positive=win, negative=loss
//   2. Runs the same Variant-A tick-accurate simulation as
//      backtest_a_conditional_ev.ts over every action='OPEN' FLIP/CONT
//      signal in tradable_signals, ordered chronologically. Tracks per-symbol
//      open trades, walks ticks for TP/SL exits, applies per-day RTH 15:54
//      close + opposing-signal exits.
//   3. For each completed trade, UPDATEs the matching tradable_signals row
//      with the sim_* outcome fields. signal_id is the join key.
//   4. For "phantom OPEN" signals (rows where action='OPEN' but the
//      simulation determined a prior tick-tracked trade was still open and
//      same-side → SKIP_COOLDOWN), demotes the action to SKIP_COOLDOWN with
//      a marker reason so the row reflects what would actually have happened.
//
// Idempotent — re-runnable. Each run overwrites sim_* fields and may shift
// action between OPEN ↔ SKIP_COOLDOWN as the upstream data evolves.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tradingDb = new Database(path.resolve(__dirname, '../../../data/trading.db'));
const ticksDb   = new Database(path.resolve(__dirname, '../../../data/ticks.db'),   { readonly: true });

const DOLLAR_PER_PT = 2;

// ── Schema migration (idempotent) ───────────────────────────────────────────
for (const [col, type] of [
  ['sim_exit_ts',     'INTEGER'],
  ['sim_exit_price',  'REAL'],
  ['sim_exit_reason', 'TEXT'],
  ['sim_pnl_pts',     'REAL'],
] as [string, string][]) {
  try { tradingDb.exec(`ALTER TABLE tradable_signals ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
}

// ── Simulation helpers ──────────────────────────────────────────────────────
function tpsl(ruleId: string, direction: 'long' | 'short'): { tp: number; sl: number } {
  if (ruleId === 'clean-impulse') return { tp: 80, sl: direction === 'long' ? 55 : 105 };
  if (ruleId === 'cont-reentry')  return { tp: 80, sl: 70 };
  throw new Error(`No TP/SL for ${ruleId}`);
}
const fmtEtDate = (tsMs: number) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(tsMs));
  const [mm, dd, yyyy] = p.split('/');
  return `${yyyy}-${mm}-${dd}`;
};
const rthCloseTs = (tsMs: number): number => Date.parse(`${fmtEtDate(tsMs)}T15:54:00-04:00`);

const tickQuery = ticksDb.prepare('SELECT ts, price FROM trades WHERE symbol = ? AND ts > ? AND ts <= ? ORDER BY ts ASC');
function walkForExit(symbol: string, openTs: number, exitTs: number, entry: number, dir: 'long'|'short', tp: number, sl: number) {
  const tpPx = dir === 'long' ? entry + tp : entry - tp;
  const slPx = dir === 'long' ? entry - sl : entry + sl;
  for (const r of tickQuery.iterate(symbol, openTs, exitTs) as IterableIterator<{ts:number; price:number}>) {
    if (dir === 'long') {
      if (r.price <= slPx) return { ts: r.ts, price: slPx, reason: 'SL' as const };
      if (r.price >= tpPx) return { ts: r.ts, price: tpPx, reason: 'TP' as const };
    } else {
      if (r.price >= slPx) return { ts: r.ts, price: slPx, reason: 'SL' as const };
      if (r.price <= tpPx) return { ts: r.ts, price: tpPx, reason: 'TP' as const };
    }
  }
  return null;
}
const lastTickStmt = ticksDb.prepare('SELECT price FROM trades WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT 1');

interface OpenSig { signal_id: number; ts: number; symbol: string; rule_id: string; direction: 'long'|'short'; entry: number; }
const allSigs = tradingDb.prepare(`
  SELECT signal_id, signal_ts AS ts, symbol, rule_id, direction, entry
  FROM tradable_signals
  WHERE action='OPEN' AND rule_id IN ('clean-impulse','cont-reentry') AND entry IS NOT NULL
  ORDER BY signal_ts ASC
`).all() as OpenSig[];

interface Trade {
  signal_id: number;
  symbol: string; rule_id: string; direction: 'long'|'short';
  open_ts: number; entry: number; et_date: string;
  close_ts: number; close_price: number; close_reason: 'TP'|'SL'|'OPP'|'RTH';
  pnl_pts: number;
}
const completed: Trade[] = [];
const blockedSignalIds: number[] = [];   // OPEN signals the simulation cooldown'd
const open = new Map<string, Trade>();

function finalize(t: Trade, closeTs: number, closePx: number, reason: Trade['close_reason']) {
  t.close_ts = closeTs; t.close_price = closePx; t.close_reason = reason;
  t.pnl_pts = t.direction === 'long' ? closePx - t.entry : t.entry - closePx;
  completed.push(t);
}
function tryCloseOpenTradeByTick(symbol: string, untilTs: number) {
  const t = open.get(symbol);
  if (!t) return;
  const { tp, sl } = tpsl(t.rule_id, t.direction);
  const hit = walkForExit(symbol, t.open_ts, untilTs, t.entry, t.direction, tp, sl);
  if (hit) { finalize(t, hit.ts, hit.price, hit.reason); open.delete(symbol); }
}
function closeAllAtRth(rthTs: number) {
  for (const sym of [...open.keys()]) {
    tryCloseOpenTradeByTick(sym, rthTs);
    if (!open.has(sym)) continue;
    const t = open.get(sym)!;
    const r = lastTickStmt.get(sym, rthTs) as { price: number } | undefined;
    finalize(t, rthTs, r?.price ?? t.entry, 'RTH');
    open.delete(sym);
  }
}

// ── Simulation loop ─────────────────────────────────────────────────────────
let prevEtDate: string | null = null;
for (let i = 0; i < allSigs.length; i++) {
  const s = allSigs[i]!;
  const etDate = fmtEtDate(s.ts);

  if (prevEtDate && etDate !== prevEtDate) {
    closeAllAtRth(rthCloseTs(allSigs[i - 1]!.ts));
  }
  prevEtDate = etDate;

  tryCloseOpenTradeByTick(s.symbol, s.ts);

  const ex = open.get(s.symbol);
  if (ex) {
    if (ex.direction === s.direction) {
      // Same-side cooldown — this signal's tradable_signals row says OPEN but
      // tick-walking proves a prior trade was still on the same side. Record
      // it as a phantom-OPEN for the downstream demotion step.
      blockedSignalIds.push(s.signal_id);
      continue;
    }
    // Opposite direction — close prior, then open new (Variant A symmetric).
    finalize(ex, s.ts, s.entry, 'OPP');
    open.delete(s.symbol);
  }

  open.set(s.symbol, {
    signal_id: s.signal_id, symbol: s.symbol, rule_id: s.rule_id,
    direction: s.direction, open_ts: s.ts, entry: s.entry, et_date: etDate,
    close_ts: 0, close_price: 0, close_reason: 'TP', pnl_pts: 0,
  });
}
if (prevEtDate) closeAllAtRth(rthCloseTs(allSigs[allSigs.length - 1]!.ts));

// ── Persist results back into tradable_signals ──────────────────────────────
const stmtUpdateOutcome = tradingDb.prepare(`
  UPDATE tradable_signals
     SET sim_exit_ts     = ?,
         sim_exit_price  = ?,
         sim_exit_reason = ?,
         sim_pnl_pts     = ?
   WHERE signal_id = ?
`);
const stmtDemoteToCooldown = tradingDb.prepare(`
  UPDATE tradable_signals
     SET action = 'SKIP_COOLDOWN',
         reason = '[sim] tick-walking determined prior pipeline trade still open at signal ts'
   WHERE signal_id = ? AND action = 'OPEN'
`);

const writeTxn = tradingDb.transaction(() => {
  for (const t of completed) {
    stmtUpdateOutcome.run(t.close_ts, t.close_price, t.close_reason, t.pnl_pts, t.signal_id);
  }
  for (const id of blockedSignalIds) {
    stmtDemoteToCooldown.run(id);
  }
});
writeTxn();

// ── Summary ─────────────────────────────────────────────────────────────────
const wins   = completed.filter(t => t.pnl_pts > 0).length;
const losses = completed.filter(t => t.pnl_pts < 0).length;
const totalPts = completed.reduce((s, t) => s + t.pnl_pts, 0);
const wrPct  = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0;

console.log(`\n──────── persist_simulated_outcomes ────────`);
console.log(`Source rows (action='OPEN' FLIP/CONT, has entry) : ${allSigs.length}`);
console.log(`Trades simulated (real OPENs after cooldown sim) : ${completed.length}`);
console.log(`Phantom-OPENs demoted → SKIP_COOLDOWN            : ${blockedSignalIds.length}`);
console.log(`\nCumulative WR + PnL:`);
console.log(`  W/L   : ${wins}W / ${losses}L  (${wrPct.toFixed(1)}% WR)`);
console.log(`  Points: ${(totalPts >= 0 ? '+' : '') + totalPts.toFixed(1)} pts`);
console.log(`  MNQ $ : ${(totalPts * DOLLAR_PER_PT >= 0 ? '+$' : '-$') + Math.abs(totalPts * DOLLAR_PER_PT).toFixed(0)}`);
console.log(`\nNow queryable directly from tradable_signals:`);
console.log(`  SELECT COUNT(*) FROM tradable_signals WHERE sim_pnl_pts IS NOT NULL;   -- ${completed.length}`);
console.log(`  SELECT SUM(sim_pnl_pts) * 2 AS mnq_dollars FROM tradable_signals;       -- ${(totalPts * DOLLAR_PER_PT).toFixed(0)}`);
console.log(`  Reason marker for demoted rows: '[sim] tick-walking determined prior pipeline trade still open at signal ts'\n`);
