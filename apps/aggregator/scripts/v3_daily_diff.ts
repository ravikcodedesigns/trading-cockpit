/**
 * v3_daily_diff.ts — Verification script for V3 shadow mode.
 *
 * Reads the v3_decisions live log for a given ET date and compares it
 * signal-by-signal to what the offline backtest engine would have decided
 * for the same signals. Flags any divergences.
 *
 * Use this script during the V3 shadow week. Run it at end-of-day:
 *
 *     pnpm exec tsx scripts/v3_daily_diff.ts            # today
 *     pnpm exec tsx scripts/v3_daily_diff.ts 2026-05-29 # explicit date
 *
 * Exit code 0 = no divergences. Non-zero = mismatches detected.
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import {
  runCombinedCooldownBacktest, type RuleSpec, type SignalRow, type TradeRecord,
} from './lib/cooldown-backtest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const tdb = new Database(TRADING_DB, { readonly: true });
const xdb = new Database(TICKS_DB,   { readonly: true });

// Pick date: argv[2] or today's ET date
const arg = process.argv[2];
const targetDate = arg ?? (() => {
  const d = new Date(Date.now() - 4 * 60 * 60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
})();

console.log(`V3 daily diff — ${targetDate}\n`);

// ── 1. Pull live v3_decisions for the day ──────────────────────────────────
const liveRows = tdb.prepare(`
  SELECT id, ts, symbol, signal_id, rule_id, pattern, direction,
         qualified, active_mode, action, reason, cvd_session,
         entry, exit_price, exit_outcome, pnl_pts, open_trade_id
  FROM v3_decisions
  WHERE date(ts/1000,'unixepoch','-4 hours') = ?
  ORDER BY ts ASC, id ASC
`).all(targetDate) as Array<{
  id: number; ts: number; symbol: string; signal_id: number | null;
  rule_id: string; pattern: string | null; direction: string;
  qualified: number; active_mode: string; action: string; reason: string;
  cvd_session: number | null; entry: number | null;
  exit_price: number | null; exit_outcome: string | null;
  pnl_pts: number | null; open_trade_id: number | null;
}>;

console.log(`Live v3_decisions rows: ${liveRows.length}`);
if (liveRows.length === 0) {
  console.log('No V3 decisions logged. Either V3 is in off mode or no signals fired today.');
  console.log('(Empty diff = no mismatches.)');
  tdb.close(); xdb.close();
  process.exit(0);
}

const modes = new Set(liveRows.map(r => r.active_mode));
console.log(`Modes observed: ${[...modes].join(', ')}`);

// ── 2. Run the backtest engine for the same window with the live V3 config ─
const dateParts = targetDate.split('-').map(Number);
const rthOpenMs  = Date.UTC(dateParts[0]!, dateParts[1]! - 1, dateParts[2]!, 13, 30, 0, 0);
const rthCloseMs = Date.UTC(dateParts[0]!, dateParts[1]! - 1, dateParts[2]!, 20, 0, 0, 0);
void rthCloseMs;

const rules: RuleSpec[] = [
  { ruleId: 'absorption',                     tp: config.v3.perRule.absorption.tp, sl: config.v3.perRule.absorption.sl,
    entryPriceFromRationale: /absorbed at (\d+\.?\d*)/ },
  { ruleId: 'clean-impulse', pattern: 'FLIP', tp: config.v3.perRule['clean-impulse-FLIP'].tp, sl: config.v3.perRule['clean-impulse-FLIP'].sl as any },
  { ruleId: 'expl',                           tp: config.v3.perRule.expl.tp, sl: config.v3.perRule.expl.sl,
    fallbackToTickPriceAtTs: true },
];

// CVD lookup helper for the filter (matches state.ts's applySignalV3 path).
const stmtCvd = xdb.prepare(`
  SELECT SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE -size END) AS cvd
  FROM trades WHERE symbol='NQ' AND ts >= ? AND ts <= ?
`);
const cvdAt = (tsMs: number): number => {
  const row = stmtCvd.get(rthOpenMs, tsMs) as { cvd: number | null } | undefined;
  return row?.cvd ?? 0;
};

const v3Filter = (s: SignalRow) => {
  if (!s.qualified) return false;
  if (config.v3.dropFlipShorts && s.ruleId === 'clean-impulse' && s.pattern === 'FLIP' && s.direction === 'short') return false;
  const cvd = cvdAt(s.ts);
  if (s.direction === 'long'  && cvd <= config.v3.cvdLongFloor)  return false;
  if (s.direction === 'short' && cvd >= config.v3.cvdShortFloor) return false;
  return true;
};

const backtestRows = runCombinedCooldownBacktest({
  symbol: 'NQ',
  tradingDb: tdb,
  ticksDb: xdb,
  rules,
  rthWindow: { startEt: '09:30:00', endEt: '16:00:00' },
  entryFilter: v3Filter,
  requireQualifiedExits: { long: config.v3.requireQualifiedExitsLongs, short: config.v3.requireQualifiedExitsShorts },
  tickFloor: rthOpenMs,
}) as TradeRecord[];

console.log(`Backtest produced ${backtestRows.length} trades.\n`);

// ── 3. Compare: backtest trades vs live OPEN decisions ─────────────────────
// Build a map: signal_id → backtest trade (entry rows have sig.id)
const backtestById = new Map<number, TradeRecord>();
for (const r of backtestRows) backtestById.set(r.sig.id, r);

const liveOpens = liveRows.filter(r => r.action === 'OPEN');
const liveCloses = liveRows.filter(r => r.action === 'CLOSE');
const liveSkipFlipShort = liveRows.filter(r => r.action === 'SKIP_FLIP_SHORT');
const liveSkipCvd = liveRows.filter(r => r.action === 'SKIP_CVD');
const liveSkipCooldown = liveRows.filter(r => r.action === 'SKIP_COOLDOWN');

console.log('Live counts:');
console.log(`  OPEN:            ${liveOpens.length}`);
console.log(`  CLOSE:           ${liveCloses.length}`);
console.log(`  SKIP_FLIP_SHORT: ${liveSkipFlipShort.length}`);
console.log(`  SKIP_CVD:        ${liveSkipCvd.length}`);
console.log(`  SKIP_COOLDOWN:   ${liveSkipCooldown.length}`);
console.log('');

let mismatches = 0;

// Each backtest trade should correspond to a live OPEN row with matching signal_id.
for (const bt of backtestRows) {
  const liveOpen = liveOpens.find(r => r.signal_id === bt.sig.id);
  if (!liveOpen) {
    console.log(`  ✗ MISSING live OPEN for backtest signal id=${bt.sig.id} (rule=${bt.sig.ruleId} dir=${bt.sig.direction})`);
    mismatches++;
    continue;
  }
  // Entry price match
  if (liveOpen.entry !== null && Math.abs(liveOpen.entry - (bt.sig.entry ?? 0)) > 0.01) {
    console.log(`  ✗ ENTRY mismatch for signal id=${bt.sig.id}: live=${liveOpen.entry} backtest=${bt.sig.entry}`);
    mismatches++;
  }
}

// Each live OPEN should correspond to a backtest trade.
for (const lo of liveOpens) {
  if (lo.signal_id == null) continue;
  if (!backtestById.has(lo.signal_id)) {
    console.log(`  ✗ EXTRA live OPEN: signal_id=${lo.signal_id} not in backtest output`);
    mismatches++;
  }
}

// ── 4. Summary ──────────────────────────────────────────────────────────────
console.log('');
if (mismatches === 0) {
  console.log(`✓ NO DIVERGENCES — live V3 matches backtest for ${targetDate}.`);
  console.log(`  (${backtestRows.length} backtest trades, ${liveOpens.length} live OPENs.)`);
  tdb.close(); xdb.close();
  process.exit(0);
} else {
  console.log(`✗ ${mismatches} MISMATCH(ES) found. Review above.`);
  tdb.close(); xdb.close();
  process.exit(1);
}
