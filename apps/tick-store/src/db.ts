import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import type { TickEvent, TickTrade, TickDepth } from '@trading/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../../data/ticks.db');

const _db = new Database(DB_PATH);

// WAL mode is critical for tick volume — readers don't block writers, and
// vice versa. synchronous=NORMAL is safe with WAL and ~3x faster than FULL.
_db.pragma('journal_mode = WAL');
_db.pragma('synchronous = NORMAL');
_db.pragma('cache_size = -65536');  // 64MB page cache
_db.pragma('temp_store = MEMORY');

// --- Schema ---
//
// Two tables: trades and depth. Both indexed on (symbol, ts) for time-range
// queries. WITHOUT ROWID would save space but conflicts with INTEGER PRIMARY
// KEY autoincrement, so we keep rowid for now.
_db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    price REAL NOT NULL,
    size INTEGER NOT NULL,
    is_bid_aggressor INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trades_symbol_ts ON trades(symbol, ts);

  CREATE TABLE IF NOT EXISTS depth (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    side INTEGER NOT NULL,      -- 0 = bid, 1 = ask
    price REAL NOT NULL,
    size INTEGER NOT NULL,      -- 0 means level removed
    is_replace INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_depth_symbol_ts ON depth(symbol, ts);
`);

// --- Prepared statements ---

const stmtInsertTrade = _db.prepare(`
  INSERT INTO trades (ts, symbol, price, size, is_bid_aggressor)
  VALUES (?, ?, ?, ?, ?)
`);

const stmtInsertDepth = _db.prepare(`
  INSERT INTO depth (ts, symbol, side, price, size, is_replace)
  VALUES (?, ?, ?, ?, ?, ?)
`);

// Batched insert wrapped in a single transaction for performance.
// SQLite can sustain 20k-50k inserts/sec with WAL+batched, vs ~1k/sec
// with one-row-per-transaction. Critical for news-print bursts.
const insertBatch = _db.transaction((events: TickEvent[]) => {
  for (const ev of events) {
    if (ev.type === 'trade') {
      stmtInsertTrade.run(
        ev.ts,
        ev.symbol,
        ev.price,
        ev.size,
        ev.isBidAggressor ? 1 : 0,
      );
    } else if (ev.type === 'depth') {
      stmtInsertDepth.run(
        ev.ts,
        ev.symbol,
        ev.side === 'bid' ? 0 : 1,
        ev.price,
        ev.size,
        ev.isReplace ? 1 : 0,
      );
    }
  }
});

// --- Public API ---

export const tickDb = {
  /**
   * Insert a batch of tick events in a single transaction.
   * Returns counts of trades and depth events written.
   */
  writeBatch(events: TickEvent[]): { trades: number; depth: number } {
    let trades = 0;
    let depth = 0;
    for (const ev of events) {
      if (ev.type === 'trade') trades++;
      else if (ev.type === 'depth') depth++;
    }
    if (events.length === 0) return { trades: 0, depth: 0 };

    const t0 = Date.now();
    insertBatch(events);
    const elapsed = Date.now() - t0;

    if (elapsed > 100) {
      logger.warn({ count: events.length, elapsed }, 'slow batch insert');
    }
    return { trades, depth };
  },

  /**
   * Range query: trades for symbol between [fromMs, toMs].
   * Used by Strategy B rules engine and analytics.
   */
  getTrades(symbol: string, fromMs: number, toMs: number): TickTrade[] {
    return _db.prepare(`
      SELECT ts, symbol, price, size, is_bid_aggressor
      FROM trades
      WHERE symbol = ? AND ts BETWEEN ? AND ?
      ORDER BY ts ASC, id ASC
    `).all(symbol, fromMs, toMs).map((r: unknown) => {
      const row = r as { ts: number; symbol: string; price: number; size: number; is_bid_aggressor: number };
      return {
        type: 'trade' as const,
        ts: row.ts,
        symbol: row.symbol as TickTrade['symbol'],
        price: row.price,
        size: row.size,
        isBidAggressor: row.is_bid_aggressor === 1,
      };
    });
  },

  /**
   * Range query: depth events for symbol between [fromMs, toMs].
   * Used to reconstruct order book state at any moment via replay.
   */
  getDepth(symbol: string, fromMs: number, toMs: number): TickDepth[] {
    return _db.prepare(`
      SELECT ts, symbol, side, price, size, is_replace
      FROM depth
      WHERE symbol = ? AND ts BETWEEN ? AND ?
      ORDER BY ts ASC, id ASC
    `).all(symbol, fromMs, toMs).map((r: unknown) => {
      const row = r as { ts: number; symbol: string; side: number; price: number; size: number; is_replace: number };
      return {
        type: 'depth' as const,
        ts: row.ts,
        symbol: row.symbol as TickDepth['symbol'],
        side: row.side === 0 ? 'bid' as const : 'ask' as const,
        price: row.price,
        size: row.size,
        isReplace: row.is_replace === 1,
      };
    });
  },

  tradeCount(): number {
    return (_db.prepare('SELECT COUNT(*) AS c FROM trades').get() as { c: number }).c;
  },

  depthCount(): number {
    return (_db.prepare('SELECT COUNT(*) AS c FROM depth').get() as { c: number }).c;
  },

  close(): void {
    _db.close();
  },
};

logger.info({ path: DB_PATH }, 'tick-store db initialized');
