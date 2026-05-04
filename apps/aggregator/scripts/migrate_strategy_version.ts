/**
 * Migration: add strategy_version and rule_version to signals table.
 *
 * strategy_version: 'A' (bar-based) or 'B' (tick-based)
 * rule_version:     specific rule identifier e.g. 'sweep-v1', 'absorption-v1'
 *
 * Idempotent - safe to run multiple times.
 *
 * Usage: pnpm --filter aggregator migrate:strategy-version
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../../data/trading.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

function hasColumn(table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some(c => c.name === column);
}

function tableExists(table: string): boolean {
  const r = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
  return !!r;
}

let changed = 0;

// --- signals table ---
if (tableExists('signals')) {
  if (!hasColumn('signals', 'strategy_version')) {
    db.exec(`ALTER TABLE signals ADD COLUMN strategy_version TEXT NOT NULL DEFAULT 'A'`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_signals_strategy ON signals(strategy_version)`);
    console.log("signals.strategy_version added (default 'A' for all existing rows)");
    changed++;
  } else {
    console.log('signals.strategy_version already exists');
  }

  if (!hasColumn('signals', 'rule_version')) {
    db.exec(`ALTER TABLE signals ADD COLUMN rule_version TEXT NOT NULL DEFAULT 'sweep-v1'`);

    // Backfill rule_version for existing rows based on rule_id
    db.exec(`
      UPDATE signals SET rule_version = CASE
        WHEN rule_id = 'sweep' THEN 'sweep-v1'
        WHEN rule_id = 'delta-divergence' THEN 'divergence-v1'
        ELSE rule_id || '-v1'
      END
      WHERE rule_version = 'sweep-v1' AND strategy_version = 'A'
    `);
    console.log('signals.rule_version added and backfilled');
    changed++;
  } else {
    console.log('signals.rule_version already exists');
  }
}

// --- signal_outcomes_matured table ---
if (tableExists('signal_outcomes_matured')) {
  if (!hasColumn('signal_outcomes_matured', 'strategy_version')) {
    db.exec(`ALTER TABLE signal_outcomes_matured ADD COLUMN strategy_version TEXT NOT NULL DEFAULT 'A'`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_matured_strategy ON signal_outcomes_matured(strategy_version)`);
    console.log("signal_outcomes_matured.strategy_version added");
    changed++;
  } else {
    console.log('signal_outcomes_matured.strategy_version already exists');
  }
}

// --- signal_outcomes_partial table ---
if (tableExists('signal_outcomes_partial')) {
  if (!hasColumn('signal_outcomes_partial', 'strategy_version')) {
    db.exec(`ALTER TABLE signal_outcomes_partial ADD COLUMN strategy_version TEXT NOT NULL DEFAULT 'A'`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_partial_strategy ON signal_outcomes_partial(strategy_version)`);
    console.log("signal_outcomes_partial.strategy_version added");
    changed++;
  } else {
    console.log('signal_outcomes_partial.strategy_version already exists');
  }
}

console.log('');
console.log(changed > 0 ? `Migration complete (${changed} changes applied)` : 'Already up to date');
db.close();
