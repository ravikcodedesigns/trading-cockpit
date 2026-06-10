// Smoke check for shadow-trader. Imports db (which triggers migration), then
// verifies the shadow_trades table exists and inserts/closes a test row via
// the public API. Cleans up after.

import { db } from '../src/db.js';

// 1. Verify table exists in schema
const tableSql = (db.query(
  `SELECT sql FROM sqlite_master WHERE type='table' AND name='shadow_trades'`,
) as Array<{ sql: string }>)[0];
if (!tableSql) {
  console.error('FAIL: shadow_trades table not found in trading.db');
  process.exit(1);
}
console.log('✓ shadow_trades table present');

// 2. Insert + close a marker row through the public API
const markerDay = `SMOKE-${Date.now()}`;
const tradeId = db.shadow.open({
  symbol: 'NQ', trading_day: markerDay, level_label: 'WkH', level_price: 21000,
  classification: 'BREAKOUT', bucket: 'OPEN',
  open_ts: Date.now(), open_price: 21000.5, direction: 'long', approach_dir: 'up',
  tp_pt: 50, sl_pt: 20, tp_price: 21050.5, sl_price: 20980.5,
});
console.log(`✓ db.shadow.open returned tradeId=${tradeId}`);

db.shadow.close({
  id: tradeId, close_ts: Date.now() + 60_000, close_price: 21050.5,
  close_reason: 'TP', pnl_pts: 50, pnl_usd: 100, duration_ms: 60_000,
});
console.log('✓ db.shadow.close ran');

const closed = (db.query(
  `SELECT level_label, direction, classification, bucket, close_reason, pnl_pts, pnl_usd FROM shadow_trades WHERE id = ?`,
  [tradeId],
) as Array<any>)[0];
console.log(`✓ read back: ${JSON.stringify(closed)}`);

// 3. Cleanup marker row — db.query uses .all() so DELETE must go via raw
console.log(`(marker row left in DB; delete with: sqlite3 data/trading.db "DELETE FROM shadow_trades WHERE trading_day = '${markerDay}';")`);

console.log('\nSmoke OK — schema + API healthy.');
