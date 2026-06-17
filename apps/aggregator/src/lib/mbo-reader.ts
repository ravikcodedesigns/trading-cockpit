/**
 * mbo-reader — DuckDB-backed query layer over the Parquet MBO store.
 *
 * Replaces direct better-sqlite3 access to data/mbo.db. The Parquet files
 * are written by scripts/mbo_parquet_converter.py and laid out as:
 *
 *   data/mbo-parquet/
 *     trades/symbol={NQ|ES}/date=YYYY-MM-DD/*.parquet
 *     depth/...
 *     mbo/...
 *
 * On open() we register three SQL views that expose the partitioned parquet
 * with the legacy mbo.db table names (mbo_trades / mbo_depth / mbo_events)
 * so existing queries port over with minimal SQL changes — just swap the
 * connection and the `symbol` value ('NQ'/'ES' instead of 'MNQ'/'MES').
 */

import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PARQUET_ROOT =
  process.env.MBO_PARQUET_ROOT ??
  path.resolve(__dirname, '../../../../data/mbo-parquet');

// L1 trades + L2 depth converted from ticks.db (scripts/ticks_to_parquet.py).
// For NEW strategy/analysis code only — the LIVE pipeline keeps reading
// ticks.db (SQLite) directly. Views: ticks_trades / ticks_depth.
export const TICKS_PARQUET_ROOT =
  process.env.TICKS_PARQUET_ROOT ??
  path.resolve(__dirname, '../../../../data/ticks-parquet');

export type Symbol = 'NQ' | 'ES';

let _conn: DuckDBConnection | null = null;

/** True if `dir` contains at least one .parquet file in any subdir. */
function directoryHasParquet(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  const stack: string[] = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // skip .tmp files and dot-dirs
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith('.parquet')) return true;
    }
  }
  return false;
}

/**
 * Open (or reuse) the DuckDB connection with the three MBO views registered.
 *
 * Reuse is safe because the underlying duckdb in-memory database is
 * connection-scoped and queries are stateless. Callers should not close
 * the returned connection; let the process own its lifecycle.
 */
export async function openMbo(): Promise<DuckDBConnection> {
  if (_conn) return _conn;
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();

  // Empty-typed views for tables with no parquet files yet — DuckDB
  // read_parquet errors when the glob matches nothing, so we fall back to
  // a 0-row SELECT with the right schema. The hive partition cols
  // (date/symbol) are appended too so callers see a consistent shape.
  // `contract` is the venue-native code (MNQM6 / MNQU6 / MESM6 / MESU6 / ...);
  // queries that want a single contract MUST filter on it (post-roll the
  // data store interleaves front-month and back-month under symbol=NQ/ES).
  const TABLES: Array<{ name: string; sub: string; cols: string }> = [
    {
      name: 'mbo_trades', sub: 'trades',
      cols: `
        NULL::BIGINT AS ts_ms, NULL::VARCHAR AS contract,
        NULL::INTEGER AS price_int, NULL::DOUBLE AS price,
        NULL::INTEGER AS size, NULL::BOOLEAN AS is_bid_aggressor,
        NULL::VARCHAR AS aggressor_order_id, NULL::VARCHAR AS passive_order_id,
        NULL::BOOLEAN AS is_execution_start, NULL::BOOLEAN AS is_execution_end,
        NULL::BOOLEAN AS is_otc, NULL::DATE AS date, NULL::VARCHAR AS symbol`,
    },
    {
      name: 'mbo_depth', sub: 'depth',
      cols: `
        NULL::BIGINT AS ts_ms, NULL::VARCHAR AS contract,
        NULL::INTEGER AS price_int, NULL::DOUBLE AS price,
        NULL::INTEGER AS size, NULL::BOOLEAN AS is_bid,
        NULL::DATE AS date, NULL::VARCHAR AS symbol`,
    },
    {
      name: 'mbo_events', sub: 'mbo',
      cols: `
        NULL::BIGINT AS ts_ms, NULL::VARCHAR AS contract,
        NULL::VARCHAR AS action, NULL::VARCHAR AS order_id,
        NULL::INTEGER AS price_int, NULL::DOUBLE AS price, NULL::INTEGER AS size,
        NULL::BOOLEAN AS is_bid, NULL::DATE AS date, NULL::VARCHAR AS symbol`,
    },
  ];

  for (const t of TABLES) {
    const hasFiles = directoryHasParquet(path.join(PARQUET_ROOT, t.sub));
    const body = hasFiles
      ? `SELECT * FROM read_parquet('${PARQUET_ROOT}/${t.sub}/**/*.parquet', hive_partitioning=true)`
      : `SELECT ${t.cols} WHERE 1=0`;
    await conn.run(`CREATE OR REPLACE VIEW ${t.name} AS ${body};`);
  }

  // ticks-parquet views (L1/L2 from ticks.db). `symbol` and `date` come from
  // the hive partition path, not the file. is_bid_aggressor / is_replace are
  // BOOLEAN; side is TINYINT (0=bid, 1=ask).
  const TICK_TABLES: Array<{ name: string; sub: string; cols: string }> = [
    {
      name: 'ticks_trades', sub: 'trades',
      cols: `
        NULL::BIGINT AS ts, NULL::DOUBLE AS price, NULL::INTEGER AS size,
        NULL::BOOLEAN AS is_bid_aggressor, NULL::DATE AS date, NULL::VARCHAR AS symbol`,
    },
    {
      name: 'ticks_depth', sub: 'depth',
      cols: `
        NULL::BIGINT AS ts, NULL::TINYINT AS side, NULL::DOUBLE AS price,
        NULL::INTEGER AS size, NULL::BOOLEAN AS is_replace,
        NULL::DATE AS date, NULL::VARCHAR AS symbol`,
    },
  ];
  for (const t of TICK_TABLES) {
    const hasFiles = directoryHasParquet(path.join(TICKS_PARQUET_ROOT, t.sub));
    const body = hasFiles
      ? `SELECT * FROM read_parquet('${TICKS_PARQUET_ROOT}/${t.sub}/**/*.parquet', hive_partitioning=true)`
      : `SELECT ${t.cols} WHERE 1=0`;
    await conn.run(`CREATE OR REPLACE VIEW ${t.name} AS ${body};`);
  }

  _conn = conn;
  return conn;
}

/** Convert DuckDB column-result rows to plain JS objects. */
async function fetchAll(conn: DuckDBConnection, sql: string, params: unknown[] = []): Promise<any[]> {
  const reader = await conn.runAndReadAll(sql, params as any);
  return reader.getRowObjectsJson();
}

// ─── Convenience queries ─────────────────────────────────────────────────

export interface Trade {
  ts_ms: bigint;
  price: number;
  size: number;
  is_bid_aggressor: boolean | null;
  aggressor_order_id: string | null;
  passive_order_id: string | null;
}

/**
 * Trades for a symbol within [fromTs, toTs] inclusive (ms).
 * Returns objects with bigint ts_ms — convert with Number() if needed.
 */
export async function getTrades(
  args: { symbol: Symbol; fromTs: number; toTs: number; limit?: number },
): Promise<Trade[]> {
  const conn = await openMbo();
  const limit = args.limit ? `LIMIT ${Math.floor(args.limit)}` : '';
  const sql = `
    SELECT ts_ms, price, size, is_bid_aggressor,
           aggressor_order_id, passive_order_id
    FROM mbo_trades
    WHERE symbol = ? AND ts_ms BETWEEN ? AND ?
    ORDER BY ts_ms ASC
    ${limit}
  `;
  return fetchAll(conn, sql, [args.symbol, args.fromTs, args.toTs]);
}

export interface DepthRow {
  ts_ms: bigint;
  price: number;
  size: number;
  is_bid: boolean;
}

/**
 * Depth updates for a symbol within [fromTs, toTs] inclusive (ms).
 */
export async function getDepth(
  args: { symbol: Symbol; fromTs: number; toTs: number; limit?: number },
): Promise<DepthRow[]> {
  const conn = await openMbo();
  const limit = args.limit ? `LIMIT ${Math.floor(args.limit)}` : '';
  const sql = `
    SELECT ts_ms, price, size, is_bid
    FROM mbo_depth
    WHERE symbol = ? AND ts_ms BETWEEN ? AND ?
    ORDER BY ts_ms ASC
    ${limit}
  `;
  return fetchAll(conn, sql, [args.symbol, args.fromTs, args.toTs]);
}

/**
 * Per-day row counts for a table. Useful for verifying backfill completeness.
 */
export async function countByDay(args: {
  symbol: Symbol;
  table: 'mbo_trades' | 'mbo_depth' | 'mbo_events';
}): Promise<Array<{ date: string; n: bigint }>> {
  const conn = await openMbo();
  const sql = `
    SELECT date::VARCHAR AS date, COUNT(*) AS n
    FROM ${args.table}
    WHERE symbol = ?
    GROUP BY 1 ORDER BY 1
  `;
  return fetchAll(conn, sql, [args.symbol]);
}

/**
 * Escape hatch for ad-hoc SQL against the views.
 * Prefer the typed helpers above for production code.
 */
export async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const conn = await openMbo();
  return fetchAll(conn, sql, params) as Promise<T[]>;
}
