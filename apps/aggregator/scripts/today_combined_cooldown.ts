/**
 * today_combined_cooldown.ts — same combined cooldown engine, scoped to
 * today's RTH session (2026-05-28). Reports RAW and QUALIFIED, plus the
 * no-FLIP-shorts variant.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { runCombinedCooldownBacktest, summarize, type RuleSpec, type SignalRow } from './lib/cooldown-backtest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const tdb = new Database(TRADING_DB, { readonly: true });
const xdb = new Database(TICKS_DB,   { readonly: true });

// Today's RTH open in UTC ms = 2026-05-28 13:30 UTC (09:30 ET, EDT).
const TODAY_RTH_OPEN = Date.UTC(2026, 4, 28, 13, 30, 0, 0);

const rules: RuleSpec[] = [
  { ruleId: 'absorption',                     tp: 80, sl: 140,
    entryPriceFromRationale: /absorbed at (\d+\.?\d*)/ },
  { ruleId: 'clean-impulse', pattern: 'FLIP', tp: 80, sl: { long: 55, short: 105 } },
  { ruleId: 'expl',                           tp: 80, sl: 70, fallbackToTickPriceAtTs: true },
];

const baseCfg = {
  symbol: 'NQ' as const,
  tradingDb: tdb,
  ticksDb: xdb,
  rules,
  rthWindow: { startEt: '09:30:00', endEt: '16:00:00' },
  tickFloor: TODAY_RTH_OPEN,
};

const dropFlipShorts = (s: SignalRow) =>
  !(s.ruleId === 'clean-impulse' && s.pattern === 'FLIP' && s.direction === 'short');
const qualifiedNoFlipShorts = (s: SignalRow) => s.qualified && dropFlipShorts(s);

console.log(`═════════════════════════════════════════════════════`);
console.log(`Today (2026-05-28 RTH NQ) — combined cooldown report`);
console.log(`Per-rule TP/SL: abso 80/140 · FLIP 80/L:55,S:105 · EXPL 80/70`);
console.log(`═════════════════════════════════════════════════════\n`);

// Diagnostic: how many signals fired today?
const counts = tdb.prepare(`
  SELECT s.rule_id AS ruleId,
         json_extract(s.payload,'$.pattern') AS pattern,
         s.direction,
         COUNT(*) AS n,
         SUM(CASE WHEN q.signal_id IS NULL THEN 0 ELSE 1 END) AS qualified
  FROM signals s LEFT JOIN qualified_signals q ON q.signal_id = s.id
  WHERE s.symbol='NQ' AND s.ts >= ?
    AND time(s.ts/1000,'unixepoch','-4 hours') >= '09:30:00'
    AND time(s.ts/1000,'unixepoch','-4 hours') <  '16:00:00'
    AND (s.rule_id='absorption'
      OR (s.rule_id='clean-impulse' AND json_extract(s.payload,'$.pattern')='FLIP')
      OR s.rule_id='expl')
  GROUP BY s.rule_id, pattern, s.direction
  ORDER BY s.rule_id, s.direction
`).all(TODAY_RTH_OPEN) as any[];
console.log('Signal counts today (RTH):');
for (const c of counts) {
  const tag = `${c.ruleId}${c.pattern ? '/'+c.pattern : ''}  ${c.direction}`;
  console.log(`  ${tag.padEnd(28)}  n=${String(c.n).padStart(2)}  qualified=${c.qualified}`);
}

console.log('\n────── A — RAW entries (all gates) ──────');
const rowsRaw = runCombinedCooldownBacktest({ ...baseCfg, entryFilter: 'raw' });
summarize('A: Today RAW', rowsRaw, { tp: 80, sl: 'per-rule' as any });

console.log('\n────── B — QUALIFIED entries ──────');
const rowsQ = runCombinedCooldownBacktest({ ...baseCfg, entryFilter: 'qualified' });
summarize('B: Today QUALIFIED', rowsQ, { tp: 80, sl: 'per-rule' as any });

console.log('\n────── C — RAW, no FLIP shorts ──────');
const rowsRawC = runCombinedCooldownBacktest({ ...baseCfg, entryFilter: dropFlipShorts });
summarize('C: Today RAW (no FLIP shorts)', rowsRawC, { tp: 80, sl: 'per-rule' as any });

console.log('\n────── D — QUALIFIED, no FLIP shorts ──────');
const rowsQD = runCombinedCooldownBacktest({ ...baseCfg, entryFilter: qualifiedNoFlipShorts });
summarize('D: Today QUALIFIED (no FLIP shorts)', rowsQD, { tp: 80, sl: 'per-rule' as any });

// Per-trade listing for the QUALIFIED variant (most actionable view)
function etISO(tsMs: number): string {
  const d = new Date(tsMs - 4*60*60_000);
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`;
}
console.log('\n────── Per-trade detail (B — QUALIFIED) ──────');
console.log('entryTime  rule           dir   entry      exitTime  outcome         pnl   exitRule');
for (const r of rowsQ) {
  const tag = `${r.sig.ruleId}${r.sig.pattern ? '/'+r.sig.pattern : ''}`;
  console.log(
    `${etISO(r.sig.ts).padEnd(9)}  ${tag.padEnd(15)}${r.sig.direction.padEnd(6)}` +
    `${(r.sig.entry ?? 0).toFixed(2).padStart(8)}   ${etISO(r.exitTs).padEnd(9)}  ` +
    `${r.outcome.padEnd(15)} ${String(r.pnl.toFixed(1)).padStart(7)}   ${r.exitRuleId ?? '-'}`
  );
}

tdb.close(); xdb.close();
