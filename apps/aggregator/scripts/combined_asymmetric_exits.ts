/**
 * combined_asymmetric_exits.ts — same combined-qualified-no-FLIP-shorts setup,
 * but LONG trades require qualified opposite signals to exit, while SHORT
 * trades accept any opposite signal (silenced or qualified) as an exit.
 *
 * Reports baseline, full-qualified-exits (variant 1), and asymmetric for comparison.
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
};

const dropFlipShorts = (s: SignalRow) =>
  !(s.ruleId === 'clean-impulse' && s.pattern === 'FLIP' && s.direction === 'short');
const qualifiedNoFlipShorts = (s: SignalRow) => s.qualified && dropFlipShorts(s);

console.log('────── BASELINE — any opp exits, both sides ──────');
const baseline = runCombinedCooldownBacktest({
  ...baseCfg, entryFilter: qualifiedNoFlipShorts, requireQualifiedExits: false,
});
summarize('Baseline', baseline, { tp: 80, sl: 'per-rule' as any });

console.log('\n────── VARIANT 1 — qualified exits for both sides ──────');
const v1 = runCombinedCooldownBacktest({
  ...baseCfg, entryFilter: qualifiedNoFlipShorts, requireQualifiedExits: true,
});
summarize('Variant 1 (both qualified)', v1, { tp: 80, sl: 'per-rule' as any });

console.log('\n────── VARIANT 2 — ASYMMETRIC: qualified exits for LONGS, any opp for SHORTS ──────');
const v2 = runCombinedCooldownBacktest({
  ...baseCfg,
  entryFilter: qualifiedNoFlipShorts,
  requireQualifiedExits: { long: true, short: false },
});
summarize('Variant 2 (asymmetric)', v2, { tp: 80, sl: 'per-rule' as any });

tdb.close(); xdb.close();
