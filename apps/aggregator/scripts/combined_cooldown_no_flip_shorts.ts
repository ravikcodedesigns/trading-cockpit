/**
 * combined_cooldown_no_flip_shorts.ts — same combined cooldown as
 * combined_cooldown_report.ts, but FLIP SHORTS are excluded from entries.
 * They still act as exit triggers if they fire (any opposite-dir signal exits),
 * but they cannot open a trade.
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
  { ruleId: 'absorption',                   tp: 80, sl: 140,
    entryPriceFromRationale: /absorbed at (\d+\.?\d*)/ },
  { ruleId: 'clean-impulse', pattern: 'FLIP', tp: 80, sl: { long: 55, short: 105 } },
  { ruleId: 'expl',                         tp: 80, sl: 70, fallbackToTickPriceAtTs: true },
];

const baseCfg = {
  symbol: 'NQ' as const,
  tradingDb: tdb,
  ticksDb: xdb,
  rules,
  rthWindow: { startEt: '09:30:00', endEt: '16:00:00' },
};

// Drop FLIP SHORTS from the entry set.
const dropFlipShorts = (s: SignalRow) =>
  !(s.ruleId === 'clean-impulse' && s.pattern === 'FLIP' && s.direction === 'short');
// And the "qualified" version: drop FLIP SHORTS + require qualified gate.
const qualifiedNoFlipShorts = (s: SignalRow) => s.qualified && dropFlipShorts(s);

console.log('────── COMBINED (no FLIP shorts) — RAW entries ──────');
const rowsRaw = runCombinedCooldownBacktest({ ...baseCfg, entryFilter: dropFlipShorts });
summarize('Combined RAW — no FLIP shorts', rowsRaw, { tp: 80, sl: 'per-rule' as any });

console.log('\n────── COMBINED (no FLIP shorts) — QUALIFIED entries ──────');
const rowsQ = runCombinedCooldownBacktest({ ...baseCfg, entryFilter: qualifiedNoFlipShorts });
summarize('Combined QUALIFIED — no FLIP shorts', rowsQ, { tp: 80, sl: 'per-rule' as any });

tdb.close(); xdb.close();
