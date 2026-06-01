/**
 * flip_cooldown_report.ts — clean-impulse FLIP backtest at TP=80/SL=140
 * with absorption + EXPL as structural exit triggers, RTH-bounded.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { runCooldownBacktest, summarize, type BacktestConfig } from './lib/cooldown-backtest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const tdb = new Database(TRADING_DB, { readonly: true });
const xdb = new Database(TICKS_DB,   { readonly: true });

const baseCfg: Omit<BacktestConfig, 'entryFilter'> = {
  symbol: 'NQ',
  tradingDb: tdb,
  ticksDb: xdb,
  tp: 80,
  sl: { long: 55, short: 105 },
  entry: { ruleId: 'clean-impulse', pattern: 'FLIP' },
  structuralExits: [
    { ruleId: 'absorption' },
    { ruleId: 'expl' },
  ],
  rthWindow: { startEt: '09:30:00', endEt: '16:00:00' },
};

const rowsRaw = runCooldownBacktest({ ...baseCfg, entryFilter: 'raw' });
summarize('A — RAW FLIP entries (all gates)', rowsRaw, { tp: baseCfg.tp, sl: baseCfg.sl });

const rowsQual = runCooldownBacktest({ ...baseCfg, entryFilter: 'qualified' });
summarize('B — QUALIFIED FLIP entries', rowsQual, { tp: baseCfg.tp, sl: baseCfg.sl });

tdb.close(); xdb.close();
