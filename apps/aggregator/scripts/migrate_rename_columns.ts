/**
 * Migration: rename MFE/MAE columns to max_gain/max_drawdown.
 *
 * SQLite has limited ALTER TABLE support, so we recreate the tables with
 * new column names and copy data over.
 *
 * Idempotent: checks if migration is already applied before running.
 *
 * Usage: pnpm --filter aggregator migrate:rename-outcome-columns
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../../data/trading.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

function tableExists(name: string): boolean {
  const r = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  return !!r;
}

function hasColumn(table: string, column: string): boolean {
  if (!tableExists(table)) return false;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some(c => c.name === column);
}

function migrateTable(name: string) {
  if (!tableExists(name)) {
    console.log(`Table ${name} doesn't exist, skipping`);
    return;
  }
  // If new column names already exist, we've already migrated.
  if (hasColumn(name, 'w5_max_gain')) {
    console.log(`Table ${name} already migrated`);
    return;
  }
  if (!hasColumn(name, 'w5_mfe')) {
    console.log(`Table ${name} has neither old nor new schema; skipping`);
    return;
  }

  console.log(`Migrating ${name}...`);

  const tmpName = `${name}_new`;

  // Create new table with renamed columns
  db.exec(`
    CREATE TABLE ${tmpName} (
      signal_id     INTEGER PRIMARY KEY,
      signal_ts     INTEGER NOT NULL,
      symbol        TEXT NOT NULL,
      rule_id       TEXT NOT NULL,
      score         INTEGER NOT NULL,
      direction     TEXT NOT NULL,
      signal_price  REAL NOT NULL,
      w5_end        REAL, w5_max_gain REAL, w5_max_drawdown REAL, w5_net REAL,
      w5_hit20 INTEGER, w5_hit30 INTEGER, w5_hit40 INTEGER,
      w5_clean20 INTEGER, w5_clean30 INTEGER, w5_clean40 INTEGER,
      w5_bars  INTEGER,
      w15_end       REAL, w15_max_gain REAL, w15_max_drawdown REAL, w15_net REAL,
      w15_hit20 INTEGER, w15_hit30 INTEGER, w15_hit40 INTEGER,
      w15_clean20 INTEGER, w15_clean30 INTEGER, w15_clean40 INTEGER,
      w15_bars INTEGER,
      w30_end       REAL, w30_max_gain REAL, w30_max_drawdown REAL, w30_net REAL,
      w30_hit20 INTEGER, w30_hit30 INTEGER, w30_hit40 INTEGER,
      w30_clean20 INTEGER, w30_clean30 INTEGER, w30_clean40 INTEGER,
      w30_bars INTEGER,
      w60_end       REAL, w60_max_gain REAL, w60_max_drawdown REAL, w60_net REAL,
      w60_hit20 INTEGER, w60_hit30 INTEGER, w60_hit40 INTEGER,
      w60_clean20 INTEGER, w60_clean30 INTEGER, w60_clean40 INTEGER,
      w60_bars INTEGER,
      last_scored_at INTEGER NOT NULL
    );
  `);

  // Copy data, mapping old names to new
  db.exec(`
    INSERT INTO ${tmpName}
      SELECT
        signal_id, signal_ts, symbol, rule_id, score, direction, signal_price,
        w5_end,  w5_mfe,  w5_mae,  w5_net,  w5_hit20,  w5_hit30,  w5_hit40,  w5_clean20,  w5_clean30,  w5_clean40,  w5_bars,
        w15_end, w15_mfe, w15_mae, w15_net, w15_hit20, w15_hit30, w15_hit40, w15_clean20, w15_clean30, w15_clean40, w15_bars,
        w30_end, w30_mfe, w30_mae, w30_net, w30_hit20, w30_hit30, w30_hit40, w30_clean20, w30_clean30, w30_clean40, w30_bars,
        w60_end, w60_mfe, w60_mae, w60_net, w60_hit20, w60_hit30, w60_hit40, w60_clean20, w60_clean30, w60_clean40, w60_bars,
        last_scored_at
      FROM ${name}
  `);

  // Swap
  db.exec(`DROP TABLE ${name}`);
  db.exec(`ALTER TABLE ${tmpName} RENAME TO ${name}`);

  // Recreate indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${name}_ts        ON ${name}(signal_ts);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${name}_rule      ON ${name}(rule_id, score);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${name}_direction ON ${name}(direction);`);

  const count = (db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get() as { c: number }).c;
  console.log(`  Migrated ${count} rows in ${name}`);
}

migrateTable('signal_outcomes_matured');
migrateTable('signal_outcomes_partial');

console.log('Migration complete.');
db.close();
