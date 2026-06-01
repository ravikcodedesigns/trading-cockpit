/**
 * combined_cooldown_report.ts — single shared cooldown across
 * absorption + clean-impulse FLIP + EXPL, with per-rule TP/SL.
 *
 * In this combined mode, any opposite-direction signal from any of the three
 * rules acts as an exit trigger AND can open the next trade.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { runCombinedCooldownBacktest, summarize, type RuleSpec } from './lib/cooldown-backtest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const tdb = new Database(TRADING_DB, { readonly: true });
const xdb = new Database(TICKS_DB,   { readonly: true });

const rules: RuleSpec[] = [
  {
    ruleId: 'absorption',
    tp: 80, sl: 140,
    entryPriceFromRationale: /absorbed at (\d+\.?\d*)/,
  },
  {
    ruleId: 'clean-impulse', pattern: 'FLIP',
    tp: 80, sl: { long: 55, short: 105 },
  },
  {
    ruleId: 'expl',
    tp: 80, sl: 70,
    fallbackToTickPriceAtTs: true,
  },
];

const baseCfg = {
  symbol: 'NQ' as const,
  tradingDb: tdb,
  ticksDb: xdb,
  rules,
  rthWindow: { startEt: '09:30:00', endEt: '16:00:00' },
};

console.log('────── COMBINED A — RAW entries (all gates) ──────');
const rowsRaw = runCombinedCooldownBacktest({ ...baseCfg, entryFilter: 'raw' });
summarize('Combined RAW', rowsRaw, { tp: 80, sl: 'L:55/70/140  S:105/70/140' as any });

console.log('\n────── COMBINED B — QUALIFIED entries ──────');
const rowsQ = runCombinedCooldownBacktest({ ...baseCfg, entryFilter: 'qualified' });
summarize('Combined QUALIFIED', rowsQ, { tp: 80, sl: 'L:55/70/140  S:105/70/140' as any });

tdb.close(); xdb.close();
