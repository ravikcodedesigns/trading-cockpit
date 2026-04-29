import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import type { AggregatorEvent, ConfluenceSignal } from '@trading/contracts';

// Ensure data directory exists
const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const _db = new Database(config.dbPath);
_db.pragma('journal_mode = WAL');
_db.pragma('synchronous = NORMAL');

_db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    source TEXT NOT NULL,
    type TEXT NOT NULL,
    symbol TEXT,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_source_type ON events(source, type);
  CREATE INDEX IF NOT EXISTS idx_events_symbol ON events(symbol);

  CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    score INTEGER NOT NULL,
    direction TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);
  CREATE INDEX IF NOT EXISTS idx_signals_rule ON signals(rule_id);
`);

const stmtInsertEvent = _db.prepare(
  'INSERT INTO events (ts, source, type, symbol, payload) VALUES (?, ?, ?, ?, ?)'
);
const stmtInsertSignal = _db.prepare(
  'INSERT INTO signals (ts, symbol, rule_id, score, direction, payload) VALUES (?, ?, ?, ?, ?, ?)'
);
const stmtCountEvents = _db.prepare('SELECT COUNT(*) AS c FROM events');
const stmtRecentSignals = _db.prepare(
  'SELECT payload FROM signals ORDER BY ts DESC LIMIT ?'
);
const stmtRecentEvents = _db.prepare(
  'SELECT payload FROM events ORDER BY ts DESC LIMIT ?'
);

export const db = {
  logEvent(evt: AggregatorEvent): number {
    const result = stmtInsertEvent.run(
      evt.ts,
      evt.source,
      evt.type,
      (evt as { symbol?: string }).symbol ?? null,
      JSON.stringify(evt)
    );
    return Number(result.lastInsertRowid);
  },

  logSignal(sig: ConfluenceSignal): number {
    const result = stmtInsertSignal.run(
      sig.ts,
      sig.symbol,
      sig.ruleId,
      sig.score,
      sig.direction,
      JSON.stringify(sig)
    );
    return Number(result.lastInsertRowid);
  },

  eventCount(): number {
    return (stmtCountEvents.get() as { c: number }).c;
  },

  recentSignals(n: number): ConfluenceSignal[] {
    return stmtRecentSignals
      .all(n)
      .map((r) => JSON.parse((r as { payload: string }).payload));
  },

  recentEvents(n: number): AggregatorEvent[] {
    return stmtRecentEvents
      .all(n)
      .map((r) => JSON.parse((r as { payload: string }).payload));
  },

  close() {
    _db.close();
  },
};

logger.info({ path: config.dbPath }, 'database ready');
