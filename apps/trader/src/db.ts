import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../../data/positions.db');

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS positions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_ts     INTEGER NOT NULL UNIQUE,
    symbol        TEXT    NOT NULL,
    rule_id       TEXT    NOT NULL,
    direction     TEXT    NOT NULL,
    qty           INTEGER NOT NULL,
    sl_pts        REAL    NOT NULL,
    tp_pts        REAL    NOT NULL,

    -- order IDs from broker
    entry_order_id  TEXT,
    sl_order_id     TEXT,
    tp_order_id     TEXT,

    -- fill details
    fill_price      REAL,
    sl_price        REAL,
    tp_price        REAL,

    -- lifecycle
    status          TEXT NOT NULL DEFAULT 'pending_entry',
    -- pending_entry | filled_entry | closed_tp | closed_sl | closed_manual | error

    exit_price      REAL,
    exit_reason     TEXT,
    pnl_pts         REAL,
    pnl_usd         REAL,

    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS daily_pnl (
    trading_day   TEXT PRIMARY KEY,
    realized_usd  REAL NOT NULL DEFAULT 0
  );
`);

export interface Position {
  id: number;
  signal_ts: number;
  symbol: string;
  rule_id: string;
  direction: string;
  qty: number;
  sl_pts: number;
  tp_pts: number;
  entry_order_id: string | null;
  sl_order_id: string | null;
  tp_order_id: string | null;
  fill_price: number | null;
  sl_price: number | null;
  tp_price: number | null;
  status: string;
  exit_price: number | null;
  exit_reason: string | null;
  pnl_pts: number | null;
  pnl_usd: number | null;
  created_at: number;
  updated_at: number;
}

const insertPos = db.prepare(`
  INSERT INTO positions
    (signal_ts, symbol, rule_id, direction, qty, sl_pts, tp_pts, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_entry', ?, ?)
`);

const updateStatus = db.prepare(`
  UPDATE positions SET status=?, updated_at=? WHERE id=?
`);

const setEntryOrder = db.prepare(`
  UPDATE positions SET entry_order_id=?, status='pending_entry', updated_at=? WHERE id=?
`);

const setFill = db.prepare(`
  UPDATE positions
  SET fill_price=?, sl_price=?, tp_price=?, sl_order_id=?, tp_order_id=?, status='filled_entry', updated_at=?
  WHERE id=?
`);

const setClosed = db.prepare(`
  UPDATE positions
  SET status=?, exit_price=?, exit_reason=?, pnl_pts=?, pnl_usd=?, updated_at=?
  WHERE id=?
`);

const updateDailyPnl = db.prepare(`
  INSERT INTO daily_pnl (trading_day, realized_usd) VALUES (?, ?)
  ON CONFLICT(trading_day) DO UPDATE SET realized_usd = realized_usd + excluded.realized_usd
`);

export const posDb = {
  createPosition(p: {
    signal_ts: number; symbol: string; rule_id: string; direction: string;
    qty: number; sl_pts: number; tp_pts: number;
  }): number {
    const now = Date.now();
    const r = insertPos.run(p.signal_ts, p.symbol, p.rule_id, p.direction, p.qty, p.sl_pts, p.tp_pts, now, now);
    return r.lastInsertRowid as number;
  },

  setEntryOrder(id: number, orderId: string) {
    setEntryOrder.run(orderId, Date.now(), id);
  },

  setFill(id: number, fillPrice: number, slPrice: number, tpPrice: number, slOrderId: string, tpOrderId: string) {
    setFill.run(fillPrice, slPrice, tpPrice, slOrderId, tpOrderId, Date.now(), id);
  },

  setClosed(id: number, status: string, exitPrice: number, reason: string, pnlPts: number, pnlUsd: number) {
    setClosed.run(status, exitPrice, reason, pnlPts, pnlUsd, Date.now(), id);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    updateDailyPnl.run(day, pnlUsd);
  },

  setStatus(id: number, status: string) {
    updateStatus.run(status, Date.now(), id);
  },

  // Record a known entry fill price on an error row. Used when handleSignal's
  // catch fires AFTER the entry filled but BEFORE the bracket was attached.
  // The row stays in status='error_naked' (not closed yet) so position-watcher
  // can later compute PnL when the broker reports flat.
  setErrorWithFill(id: number, fillPrice: number) {
    db.prepare(`
      UPDATE positions
      SET fill_price=?, status='error_naked', updated_at=?
      WHERE id=?
    `).run(fillPrice, Date.now(), id);
  },

  openPositions(): Position[] {
    return db.prepare(`
      SELECT * FROM positions WHERE status IN ('pending_entry','filled_entry')
    `).all() as Position[];
  },

  // Open positions for a specific symbol (e.g. 'NQ'). Used by position-watcher
  // when a broker-side flat transition is detected — we need to mark the
  // corresponding DB row closed so max_positions doesn't silently block
  // future signals.
  // Includes both 'filled_entry' (normal) AND 'error_naked' (entry filled
  // but bracket failed). Both need closure reconciliation when the broker
  // reports the position flat.
  filledPositionsForSymbol(symbol: string): Position[] {
    return db.prepare(`
      SELECT * FROM positions
      WHERE status IN ('filled_entry','error_naked') AND symbol=?
    `).all(symbol) as Position[];
  },

  getById(id: number): Position | null {
    return db.prepare(`SELECT * FROM positions WHERE id=?`).get(id) as Position | null;
  },

  getBySignalTs(ts: number): Position | null {
    return db.prepare(`SELECT * FROM positions WHERE signal_ts=?`).get(ts) as Position | null;
  },

  todayPnl(): number {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    const row = db.prepare(`SELECT realized_usd FROM daily_pnl WHERE trading_day=?`).get(day) as { realized_usd: number } | null;
    return row?.realized_usd ?? 0;
  },
};
