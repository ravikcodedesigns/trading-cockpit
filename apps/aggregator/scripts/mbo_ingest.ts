// MBO ingest — stream a captured JSONL log into mbo.db.
//
// Usage:
//   pnpm exec tsx scripts/mbo_ingest.ts [--rebuild] [--file <path>] [--all]
//
//   --rebuild         Drop and recreate all tables before ingest
//   --file <path>     Ingest a single specific .log file
//   --all             Ingest every *_BMD.log file in ~/cockpit-mbo-capture/
//
// Defaults: ingest every *_BMD.log that has new bytes since last run (incremental).
// Capture files grow as Bookmap writes; we resume from the last saved byte offset.
//
// Handles the three gaps identified in the audit:
//   1. NO MBO SNAPSHOT AT ATTACH — orphan replace/cancel (no prior send) creates
//      an mbo_orders row with status='orphan' and unknown is_bid/initial price.
//   2. ORDER PRIORITY — not stored explicitly; computable downstream by
//      sorting mbo_events of kind='send' by ts within (symbol, is_bid, price).
//   3. REPLACE LACKS is_bid — we maintain an in-process orderId→is_bid map
//      populated by send events and look up on replace.
//
// Performance: SQLite WAL mode + transaction batching every 10k events.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { SCHEMA_SQL, DROP_ALL_SQL } from './lib/mbo-schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const MBO_DB_PATH = path.join(PROJECT_ROOT, 'data', 'mbo.db');
const CAPTURE_DIR = path.join(process.env.HOME ?? '', 'cockpit-mbo-capture');

// ─── CLI args ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const wantRebuild = args.includes('--rebuild');
const wantAll = args.includes('--all');
const fileArgIdx = args.indexOf('--file');
const fileArg = fileArgIdx >= 0 ? args[fileArgIdx + 1] : null;

// ─── Open DB and ensure schema ──────────────────────────────────────
const db = new Database(MBO_DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -65536');  // 64MB page cache
db.pragma('temp_store = MEMORY');

if (wantRebuild) {
  console.log('[rebuild] dropping all tables');
  db.exec(DROP_ALL_SQL);
}
db.exec(SCHEMA_SQL);

// ─── Discover files ─────────────────────────────────────────────────
function pickFiles(): string[] {
  if (fileArg) return [path.resolve(fileArg)];
  const all = fs.readdirSync(CAPTURE_DIR)
    .filter(f => f.endsWith('_BMD.log'))
    .map(f => path.join(CAPTURE_DIR, f))
    .sort();
  if (wantAll) return all;
  // Default: include any file that has new bytes since last ingest (incremental)
  const stateRows = db.prepare(`
    SELECT file_path, bytes_at_ingest FROM mbo_capture_files
  `).all() as Array<{file_path: string; bytes_at_ingest: number}>;
  const state = new Map(stateRows.map(r => [r.file_path, r.bytes_at_ingest]));
  return all.filter(f => {
    const prior = state.get(f);
    if (prior === undefined) return true;
    const curBytes = fs.statSync(f).size;
    return curBytes > prior;
  });
}

// ─── Symbol/contract derivation ─────────────────────────────────────
// Filename: 2026-06-02-MNQM6_CME_BMD.log → contract='MNQM6_CME_BMD', symbol='MNQ'
function parseFilename(p: string): { date: string; alias: string; symbol: string } {
  const base = path.basename(p, '.log');
  // Expecting YYYY-MM-DD-<alias>
  const m = base.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
  if (!m) throw new Error(`Cannot parse filename: ${p}`);
  const date = m[1]!;
  const alias = m[2]!;
  // Symbol = leading alpha chars (e.g. MNQ from MNQM6, MES from MESM6)
  const sm = alias.match(/^([A-Z]+)/);
  const symbol = sm ? sm[1]! : alias;
  return { date, alias, symbol };
}

// ─── Prepared statements ────────────────────────────────────────────
const insEvent = db.prepare(`
  INSERT INTO mbo_events (ts_ms, symbol, contract, kind, order_id, is_bid, price, size)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const insTrade = db.prepare(`
  INSERT INTO mbo_trades
    (ts_ms, symbol, contract, price, size, is_bid_aggressor,
     aggressor_order_id, passive_order_id,
     is_execution_start, is_execution_end, is_otc)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insDepth = db.prepare(`
  INSERT INTO mbo_depth (ts_ms, symbol, contract, is_bid, price, size) VALUES (?,?,?,?,?,?)
`);
const upsertOrderSend = db.prepare(`
  INSERT INTO mbo_orders
    (order_id, symbol, contract, is_bid, send_ts_ms, send_price, send_size,
     last_ts_ms, last_price, last_size, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  ON CONFLICT (order_id, symbol) DO UPDATE SET
    -- Edge case: send arrives after we already saw a replace/cancel (out-of-order capture)
    is_bid     = COALESCE(mbo_orders.is_bid, excluded.is_bid),
    send_ts_ms = COALESCE(mbo_orders.send_ts_ms, excluded.send_ts_ms),
    send_price = COALESCE(mbo_orders.send_price, excluded.send_price),
    send_size  = COALESCE(mbo_orders.send_size,  excluded.send_size),
    last_ts_ms = MAX(mbo_orders.last_ts_ms, excluded.last_ts_ms),
    status     = CASE WHEN mbo_orders.status = 'cancelled' THEN 'cancelled' ELSE 'active' END
`);
const upsertOrderReplace = db.prepare(`
  INSERT INTO mbo_orders
    (order_id, symbol, contract, is_bid, last_ts_ms, last_price, last_size, status, num_replaces)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'orphan', 1)
  ON CONFLICT (order_id, symbol) DO UPDATE SET
    last_ts_ms   = excluded.last_ts_ms,
    last_price   = excluded.last_price,
    last_size    = excluded.last_size,
    num_replaces = mbo_orders.num_replaces + 1
`);
const upsertOrderCancel = db.prepare(`
  INSERT INTO mbo_orders
    (order_id, symbol, contract, last_ts_ms, status, cancel_ts_ms)
  VALUES (?, ?, ?, ?, 'cancelled', ?)
  ON CONFLICT (order_id, symbol) DO UPDATE SET
    last_ts_ms   = excluded.last_ts_ms,
    status       = 'cancelled',
    cancel_ts_ms = excluded.cancel_ts_ms
`);
const updateOrderFill = db.prepare(`
  UPDATE mbo_orders
  SET fill_size = fill_size + ?,
      num_fills = num_fills + 1,
      last_ts_ms = MAX(last_ts_ms, ?)
  WHERE order_id = ? AND symbol = ?
`);
const upsertCaptureRow = db.prepare(`
  INSERT INTO mbo_capture_files
    (file_path, symbol, contract, capture_date, ingested_at_ms,
     bytes_at_ingest, num_events, num_trades, num_orders, num_orphans, num_depth)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (file_path) DO UPDATE SET
    ingested_at_ms  = excluded.ingested_at_ms,
    bytes_at_ingest = excluded.bytes_at_ingest,
    num_events      = excluded.num_events,
    num_trades      = excluded.num_trades,
    num_orders      = excluded.num_orders,
    num_orphans     = excluded.num_orphans,
    num_depth       = excluded.num_depth
`);
const getPriorIngest = db.prepare(`
  SELECT bytes_at_ingest, num_events, num_trades, num_orders, num_orphans, num_depth
  FROM mbo_capture_files WHERE file_path = ?
`);

// ─── Ingest one file ────────────────────────────────────────────────
interface FileStats {
  events: number;
  trades: number;
  orders: number;
  orphans: number;
  depth: number;
  totalLines: number;
  errorLines: number;
}

async function ingestFile(filePath: string): Promise<FileStats> {
  const { date, alias, symbol } = parseFilename(filePath);
  const sizeBytes = fs.statSync(filePath).size;
  console.log(`\n[ingest] ${path.basename(filePath)}`);
  console.log(`         symbol=${symbol} contract=${alias} bytes=${(sizeBytes/1024/1024).toFixed(1)}MB`);

  // Resume support: if we've ingested this file before, start from the saved offset.
  const prior = getPriorIngest.get(filePath) as
    | { bytes_at_ingest: number; num_events: number; num_trades: number;
        num_orders: number; num_orphans: number; num_depth: number }
    | undefined;
  const startByte = prior?.bytes_at_ingest ?? 0;
  const isResume = startByte > 0;
  if (startByte >= sizeBytes) {
    console.log(`         already at EOF (${startByte.toLocaleString()}/${sizeBytes.toLocaleString()} bytes), nothing to ingest`);
    return { events: 0, trades: 0, orders: 0, orphans: 0, depth: 0, totalLines: 0, errorLines: 0 };
  }
  if (isResume) {
    const pct = (startByte / sizeBytes) * 100;
    console.log(`         resuming from byte ${startByte.toLocaleString()} (${pct.toFixed(1)}% already ingested, ${((sizeBytes-startByte)/1024/1024).toFixed(1)}MB remaining)`);
  }

  const rs = fs.createReadStream(filePath, { start: startByte });
  const rl = readline.createInterface({ input: rs, crlfDelay: Infinity });

  // In-process state to look up is_bid for replace events
  const orderSide = new Map<string, boolean>();
  const orderSeen = new Set<string>();

  // On resume, pre-load order state from DB so replace/cancel events for orders
  // sent BEFORE this resume point can still resolve is_bid.
  //
  // IMPORTANT (2026-06-03 fix): only load orders that might STILL receive future
  // events — i.e., status='active' or 'partial'. Orders with status='cancelled'
  // or 'filled' won't see new events tied to their order_id, so they don't need
  // to be in the lookup map. This bounds the map size to active book depth
  // (~10-50k orders) instead of total daily orders (~20M+), which hit V8's
  // Map size limit (~16.7M entries).
  if (isResume) {
    const sideRows = db.prepare(
      `SELECT order_id, is_bid FROM mbo_orders
       WHERE symbol = ? AND is_bid IS NOT NULL AND status IN ('active','partial')`
    ).all(symbol) as Array<{order_id: string; is_bid: number}>;
    for (const r of sideRows) orderSide.set(r.order_id, r.is_bid === 1);
    const seenRows = db.prepare(
      `SELECT order_id FROM mbo_orders WHERE symbol = ? AND status IN ('active','partial')`
    ).all(symbol) as Array<{order_id: string}>;
    for (const r of seenRows) orderSeen.add(r.order_id);
    console.log(`         preloaded ${orderSide.size.toLocaleString()} order-sides + ${orderSeen.size.toLocaleString()} order-ids for resume (active+partial only)`);
  }

  const stats: FileStats = { events: 0, trades: 0, orders: 0, orphans: 0, depth: 0, totalLines: 0, errorLines: 0 };

  // Track running byte offset for incremental checkpoint (line.length + 1 for LF)
  let bytesProcessed = startByte;

  // Transaction batching for performance
  let batchOpen = false;
  const beginTxn = db.prepare('BEGIN');
  const commitTxn = db.prepare('COMMIT');
  const BATCH_SIZE = 10_000;
  let opsInBatch = 0;
  const startBatch = () => { if (!batchOpen) { beginTxn.run(); batchOpen = true; } };
  const flushBatch = () => { if (batchOpen) { commitTxn.run(); batchOpen = false; opsInBatch = 0; } };

  startBatch();

  for await (const line of rl) {
    stats.totalLines++;
    bytesProcessed += Buffer.byteLength(line, 'utf8') + 1;  // +1 for LF
    if (!line || line[0] !== '{') continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { stats.errorLines++; continue; }
    const ts = rec.ts_ms as number;
    const kind = rec.kind as string;
    const data = rec.data ?? {};

    switch (kind) {
      case 'init':
        // Contract metadata already captured at open; nothing to insert per-row
        break;

      case 'mbo_send': {
        const orderId = String(data.order_id);
        const isBid = !!data.is_bid;
        const price = Number(data.price);
        const size = Number(data.size);
        insEvent.run(ts, symbol, alias, 'send', orderId, isBid ? 1 : 0, price, size);
        upsertOrderSend.run(orderId, symbol, alias, isBid ? 1 : 0, ts, price, size, ts, price, size);
        orderSide.set(orderId, isBid);
        if (!orderSeen.has(orderId)) { orderSeen.add(orderId); stats.orders++; }
        stats.events++;
        opsInBatch += 2;
        break;
      }

      case 'mbo_replace': {
        const orderId = String(data.order_id);
        const price = Number(data.price);
        const size = Number(data.size);
        const isBid = orderSide.get(orderId);
        insEvent.run(ts, symbol, alias, 'replace', orderId,
                     isBid === undefined ? null : (isBid ? 1 : 0),
                     price, size);
        upsertOrderReplace.run(orderId, symbol, alias,
                               isBid === undefined ? null : (isBid ? 1 : 0),
                               ts, price, size);
        if (!orderSeen.has(orderId)) {
          orderSeen.add(orderId);
          stats.orphans++;
          stats.orders++;
        }
        stats.events++;
        opsInBatch += 2;
        break;
      }

      case 'mbo_cancel': {
        const orderId = String(data.order_id);
        const isBid = orderSide.get(orderId);
        insEvent.run(ts, symbol, alias, 'cancel', orderId,
                     isBid === undefined ? null : (isBid ? 1 : 0),
                     null, null);
        upsertOrderCancel.run(orderId, symbol, alias, ts, ts);
        if (!orderSeen.has(orderId)) {
          orderSeen.add(orderId);
          stats.orphans++;
          stats.orders++;
        }
        stats.events++;
        opsInBatch += 2;
        break;
      }

      case 'trade': {
        const price = Number(data.price);
        const size = Number(data.size);
        const isBidAggressor = !!data.is_bid_aggressor;
        const aggId = data.aggressor_order_id || '';
        const passId = data.passive_order_id || '';
        const isExecStart = !!data.is_execution_start;
        const isExecEnd = !!data.is_execution_end;
        const isOtc = !!data.is_otc;
        insTrade.run(
          ts, symbol, alias, price, size,
          isBidAggressor ? 1 : 0,
          aggId, passId,
          isExecStart ? 1 : 0, isExecEnd ? 1 : 0,
          isOtc ? 1 : 0,
        );
        if (passId && size > 0) {
          updateOrderFill.run(size, ts, passId, symbol);
        }
        stats.trades++;
        opsInBatch += 1;
        break;
      }

      case 'depth': {
        const isBid = !!data.is_bid;
        const price = Number(data.price);
        const size = Number(data.size);
        insDepth.run(ts, symbol, alias, isBid ? 1 : 0, price, size);
        stats.depth++;
        opsInBatch += 1;
        break;
      }
    }

    if (opsInBatch >= BATCH_SIZE) {
      flushBatch();
      startBatch();
    }
  }
  flushBatch();

  // Final pass: compute the TRUE status based on fill_size + cancel state.
  // Bookmap fires mbo_cancel both for user-cancels AND for fully-filled orders
  // being removed from the book — we have to disambiguate from fill_size.
  db.prepare(`
    UPDATE mbo_orders
    SET status = CASE
      WHEN send_size IS NULL                              THEN 'orphan'
      WHEN fill_size >= send_size                         THEN 'filled'
      WHEN fill_size > 0  AND cancel_ts_ms IS NOT NULL    THEN 'partial'
      WHEN fill_size = 0  AND cancel_ts_ms IS NOT NULL    THEN 'cancelled'
      WHEN fill_size > 0                                  THEN 'partial'
      ELSE 'active'
    END
    WHERE symbol = ?
  `).run(symbol);

  // Record the file's progress (upsert with cumulative counts).
  // bytes_at_ingest stores the final processed offset so subsequent runs resume from here.
  // stats.orders/orphans are pass-local; orderSeen.size is the running cumulative total.
  const finalBytes = Math.min(bytesProcessed, sizeBytes);
  const cumEvents  = (prior?.num_events  ?? 0) + stats.events;
  const cumTrades  = (prior?.num_trades  ?? 0) + stats.trades;
  const cumOrphans = (prior?.num_orphans ?? 0) + stats.orphans;
  const cumDepth   = (prior?.num_depth   ?? 0) + stats.depth;
  const cumOrders  = orderSeen.size;  // total unique orders seen for this symbol

  upsertCaptureRow.run(
    filePath, symbol, alias, date, Date.now(),
    finalBytes, cumEvents, cumTrades, cumOrders, cumOrphans, cumDepth
  );

  console.log(`         lines=${stats.totalLines.toLocaleString()} events=${stats.events.toLocaleString()} ` +
              `trades=${stats.trades.toLocaleString()} orders+=${stats.orders.toLocaleString()} ` +
              `orphans+=${stats.orphans.toLocaleString()} depth=${stats.depth.toLocaleString()} ` +
              `parse_errors=${stats.errorLines}`);
  console.log(`         offset: ${finalBytes.toLocaleString()}/${sizeBytes.toLocaleString()} bytes (${((finalBytes/sizeBytes)*100).toFixed(1)}%) | cum: events=${cumEvents.toLocaleString()} trades=${cumTrades.toLocaleString()} orders=${cumOrders.toLocaleString()} depth=${cumDepth.toLocaleString()}`);

  return stats;
}

// ─── Compute mbo_executions ─────────────────────────────────────────
function rebuildExecutions(symbol: string): number {
  console.log(`[executions] rebuilding sweep groupings for ${symbol}`);
  db.prepare(`DELETE FROM mbo_executions WHERE symbol = ?`).run(symbol);
  // Only trades that have an aggressor_order_id and size > 0 (skip end-markers)
  const inserted = db.prepare(`
    INSERT INTO mbo_executions
      (aggressor_order_id, symbol, start_ts_ms, end_ts_ms, is_bid_aggressor,
       num_legs, total_size, first_price, last_price, min_price, max_price, distinct_prices)
    SELECT
      aggressor_order_id,
      symbol,
      MIN(ts_ms),
      MAX(ts_ms),
      MAX(is_bid_aggressor),
      COUNT(*),
      SUM(size),
      (SELECT price FROM mbo_trades WHERE aggressor_order_id = t.aggressor_order_id AND symbol = t.symbol ORDER BY ts_ms ASC LIMIT 1),
      (SELECT price FROM mbo_trades WHERE aggressor_order_id = t.aggressor_order_id AND symbol = t.symbol ORDER BY ts_ms DESC LIMIT 1),
      MIN(price),
      MAX(price),
      COUNT(DISTINCT price)
    FROM mbo_trades t
    WHERE symbol = ?
      AND aggressor_order_id IS NOT NULL AND aggressor_order_id != ''
      AND size > 0
    GROUP BY aggressor_order_id
  `).run(symbol).changes;
  return inserted;
}

// ─── Main ───────────────────────────────────────────────────────────
const files = pickFiles();
if (files.length === 0) {
  console.log('No files to ingest. (Use --all to re-ingest, --rebuild to wipe DB first.)');
  process.exit(0);
}
console.log(`MBO ingest — ${files.length} file(s) → ${MBO_DB_PATH}`);
const symbolsTouched = new Set<string>();
for (const f of files) {
  try {
    const stats = await ingestFile(f);
    const { symbol } = parseFilename(f);
    symbolsTouched.add(symbol);
  } catch (e) {
    console.error(`[error] ${f}: ${e}`);
  }
}
for (const sym of symbolsTouched) {
  const n = rebuildExecutions(sym);
  console.log(`         ${sym}: ${n.toLocaleString()} executions written to mbo_executions`);
}

// ─── Summary ────────────────────────────────────────────────────────
console.log('\n══ Summary ══');
const sym = db.prepare(`
  SELECT
    symbol,
    COUNT(DISTINCT contract) as contracts,
    SUM(CASE WHEN kind='send'    THEN 1 ELSE 0 END) as sends,
    SUM(CASE WHEN kind='replace' THEN 1 ELSE 0 END) as replaces,
    SUM(CASE WHEN kind='cancel'  THEN 1 ELSE 0 END) as cancels
  FROM mbo_events
  GROUP BY symbol
`).all() as Array<{symbol:string; contracts:number; sends:number; replaces:number; cancels:number}>;
for (const r of sym) {
  console.log(`  ${r.symbol}: ${r.contracts} contract(s) | sends=${r.sends.toLocaleString()} replaces=${r.replaces.toLocaleString()} cancels=${r.cancels.toLocaleString()}`);
}
const ords = db.prepare(`
  SELECT symbol, status, COUNT(*) as n FROM mbo_orders GROUP BY symbol, status ORDER BY symbol, status
`).all() as Array<{symbol:string; status:string; n:number}>;
console.log(`\n  Order statuses:`);
for (const r of ords) console.log(`    ${r.symbol} ${r.status.padEnd(10)} ${r.n.toLocaleString()}`);

const trd = db.prepare(`
  SELECT symbol, COUNT(*) as trades, SUM(size) as total_size,
         SUM(CASE WHEN is_execution_start=1 THEN 1 ELSE 0 END) as exec_starts,
         SUM(CASE WHEN is_execution_end=1 AND size=0 THEN 1 ELSE 0 END) as end_markers
  FROM mbo_trades GROUP BY symbol
`).all() as Array<{symbol:string; trades:number; total_size:number; exec_starts:number; end_markers:number}>;
console.log(`\n  Trades:`);
for (const r of trd) console.log(`    ${r.symbol}: ${r.trades.toLocaleString()} events (${r.exec_starts.toLocaleString()} exec_starts, ${r.end_markers.toLocaleString()} end_markers), total_size=${(r.total_size ?? 0).toLocaleString()}`);

const exc = db.prepare(`
  SELECT symbol, COUNT(*) as n, AVG(num_legs) as avg_legs, MAX(num_legs) as max_legs,
         SUM(CASE WHEN distinct_prices > 1 THEN 1 ELSE 0 END) as multi_level
  FROM mbo_executions GROUP BY symbol
`).all() as Array<{symbol:string; n:number; avg_legs:number; max_legs:number; multi_level:number}>;
console.log(`\n  Executions (sweep groupings):`);
for (const r of exc) console.log(`    ${r.symbol}: ${r.n.toLocaleString()} executions, avg_legs=${r.avg_legs.toFixed(2)}, max_legs=${r.max_legs}, multi-level=${r.multi_level.toLocaleString()}`);

const dbSize = fs.statSync(MBO_DB_PATH).size;
console.log(`\n  mbo.db size: ${(dbSize/1024/1024).toFixed(1)} MB`);

db.close();
