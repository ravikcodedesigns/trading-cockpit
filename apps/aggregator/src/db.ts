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
  'INSERT INTO signals (ts, symbol, rule_id, score, direction, strategy_version, rule_version, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);
const stmtCountEvents = _db.prepare('SELECT COUNT(*) AS c FROM events');
const stmtRecentSignals = _db.prepare(
  'SELECT payload FROM signals ORDER BY ts DESC LIMIT ?'
);
const stmtRecentEvents = _db.prepare(
  'SELECT payload FROM events ORDER BY ts DESC LIMIT ?'
);

// Returns final bars for a symbol, deduplicated by bar-start timestamp.
// The addon emits partial bars every second AND a final bar at minute close.
// We pick MAX(ts) per bucket which prefers the LAST emit per bar (the most
// complete version). Since both partial and final bars share the same
// bucket-start in their payload, but different ts values, we use payload's
// open timestamp as the bucket key.
const stmtRecentBars = _db.prepare(`
  SELECT payload FROM events
  WHERE source = 'bookmap'
    AND type = 'bar'
    AND symbol = ?
    AND ts >= ?
  ORDER BY ts ASC
`);

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
      sig.strategyVersion ?? 'A',
      sig.ruleVersion ?? (sig.ruleId + '-v1'),
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

  // Returns one bar per minute-bucket for the given symbol, deduplicated
  // by the bar's own ts (bucket start) field. When the addon emits both
  // partial and final bars for the same minute, the most recently inserted
  // wins (which will be the final/most-complete bar).
  recentBars(symbol: string, sinceMs: number): unknown[] {
    const rows = stmtRecentBars.all(symbol, sinceMs) as { payload: string }[];
    const byBucket = new Map<number, unknown>();
    for (const r of rows) {
      const bar = JSON.parse(r.payload) as { ts: number };
      // ts on the bar IS the bucket-start; later inserts overwrite earlier
      // ones, leaving us with the most recent payload per bucket.
      byBucket.set(bar.ts, bar);
    }
    return Array.from(byBucket.values()).sort(
      (a, b) => (a as { ts: number }).ts - (b as { ts: number }).ts
    );
  },

  close() {
    _db.close();
  },
};

logger.info({ path: config.dbPath }, 'database ready');
