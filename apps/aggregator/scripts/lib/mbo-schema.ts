// MBO database schema. Single source of truth for the mbo.db structure.
//
// Tables:
//   mbo_events           — raw MBO event stream (send, replace, cancel)
//   mbo_orders           — derived: order lifecycle summary keyed by order_id
//   mbo_trades           — trades with both order IDs + execution flags
//   mbo_depth            — L2 depth events (kept for top-of-book context)
//   mbo_executions       — derived: trades grouped by aggressor_order_id (= one sweep)
//   mbo_capture_files    — provenance: which capture files have been ingested
//
// Symbol vs contract:
//   "symbol"   — short code (e.g. 'MNQ', 'MES'). Used for analysis grouping across rolls.
//   "contract" — full alias (e.g. 'MNQM6.CME@BMD'). Preserved for traceability.

export const SCHEMA_SQL = `
-- ─── Raw event stream ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mbo_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms       INTEGER NOT NULL,
  symbol      TEXT NOT NULL,
  contract    TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('send','replace','cancel')),
  order_id    TEXT NOT NULL,
  is_bid      INTEGER,            -- 0/1; NULL for replace/cancel of orphan orders
  price       REAL,               -- NULL for cancel
  size        INTEGER             -- NULL for cancel
);
CREATE INDEX IF NOT EXISTS idx_mbo_events_symbol_ts ON mbo_events(symbol, ts_ms);
CREATE INDEX IF NOT EXISTS idx_mbo_events_order     ON mbo_events(order_id, ts_ms);

-- ─── Order lifecycle ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mbo_orders (
  order_id        TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  contract        TEXT NOT NULL,
  is_bid          INTEGER,         -- NULL for orphan (no send observed)
  send_ts_ms      INTEGER,
  send_price      REAL,
  send_size       INTEGER,
  last_ts_ms      INTEGER NOT NULL,
  last_price      REAL,
  last_size       INTEGER,
  status          TEXT NOT NULL CHECK (status IN ('active','cancelled','filled','partial','orphan')),
  cancel_ts_ms    INTEGER,
  fill_size       INTEGER NOT NULL DEFAULT 0,    -- cumulative trade size against this passive order
  num_replaces    INTEGER NOT NULL DEFAULT 0,
  num_fills       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (order_id, symbol)
);
CREATE INDEX IF NOT EXISTS idx_mbo_orders_symbol_status ON mbo_orders(symbol, status);
CREATE INDEX IF NOT EXISTS idx_mbo_orders_send_ts      ON mbo_orders(symbol, send_ts_ms);
CREATE INDEX IF NOT EXISTS idx_mbo_orders_last_ts      ON mbo_orders(symbol, last_ts_ms);
CREATE INDEX IF NOT EXISTS idx_mbo_orders_pricerace    ON mbo_orders(symbol, is_bid, last_price);

-- ─── Trades with order-ID linkage ────────────────────────────────────
CREATE TABLE IF NOT EXISTS mbo_trades (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms                INTEGER NOT NULL,
  symbol               TEXT NOT NULL,
  contract             TEXT NOT NULL,
  price                REAL NOT NULL,
  size                 INTEGER NOT NULL,
  is_bid_aggressor     INTEGER NOT NULL,
  aggressor_order_id   TEXT,
  passive_order_id     TEXT,
  is_execution_start   INTEGER NOT NULL,
  is_execution_end     INTEGER NOT NULL,
  is_otc               INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mbo_trades_symbol_ts  ON mbo_trades(symbol, ts_ms);
CREATE INDEX IF NOT EXISTS idx_mbo_trades_aggressor  ON mbo_trades(aggressor_order_id, ts_ms);
CREATE INDEX IF NOT EXISTS idx_mbo_trades_passive    ON mbo_trades(passive_order_id, ts_ms);

-- ─── L2 depth events (for context / top-of-book) ────────────────────
CREATE TABLE IF NOT EXISTS mbo_depth (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms       INTEGER NOT NULL,
  symbol      TEXT NOT NULL,
  contract    TEXT NOT NULL,
  is_bid      INTEGER NOT NULL,
  price       REAL NOT NULL,
  size        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mbo_depth_symbol_ts ON mbo_depth(symbol, ts_ms);

-- ─── Sweep groupings — one row per aggressor execution ──────────────
CREATE TABLE IF NOT EXISTS mbo_executions (
  aggressor_order_id   TEXT NOT NULL,
  symbol               TEXT NOT NULL,
  start_ts_ms          INTEGER NOT NULL,
  end_ts_ms            INTEGER NOT NULL,
  is_bid_aggressor     INTEGER NOT NULL,
  num_legs             INTEGER NOT NULL,
  total_size           INTEGER NOT NULL,
  first_price          REAL NOT NULL,
  last_price           REAL NOT NULL,
  min_price            REAL NOT NULL,
  max_price            REAL NOT NULL,
  distinct_prices      INTEGER NOT NULL,
  PRIMARY KEY (aggressor_order_id, symbol)
);
CREATE INDEX IF NOT EXISTS idx_mbo_executions_symbol_ts ON mbo_executions(symbol, start_ts_ms);
CREATE INDEX IF NOT EXISTS idx_mbo_executions_size      ON mbo_executions(symbol, total_size);
CREATE INDEX IF NOT EXISTS idx_mbo_executions_levels    ON mbo_executions(symbol, distinct_prices);

-- ─── Provenance ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mbo_capture_files (
  file_path           TEXT PRIMARY KEY,
  symbol              TEXT NOT NULL,
  contract            TEXT NOT NULL,
  capture_date        TEXT NOT NULL,
  ingested_at_ms      INTEGER NOT NULL,
  bytes_at_ingest     INTEGER NOT NULL,
  num_events          INTEGER NOT NULL,
  num_trades          INTEGER NOT NULL,
  num_orders          INTEGER NOT NULL,
  num_orphans         INTEGER NOT NULL,
  num_depth           INTEGER NOT NULL
);
`;

/** Drop helpers — used by --rebuild flag */
export const DROP_ALL_SQL = `
DROP TABLE IF EXISTS mbo_executions;
DROP TABLE IF EXISTS mbo_capture_files;
DROP TABLE IF EXISTS mbo_depth;
DROP TABLE IF EXISTS mbo_trades;
DROP TABLE IF EXISTS mbo_orders;
DROP TABLE IF EXISTS mbo_events;
`;
