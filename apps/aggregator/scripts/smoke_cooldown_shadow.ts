// Smoke test for cooldown-shadow. Verifies:
//   1. Schema migration added source/signal_id/rule_id columns to shadow_trades
//   2. cooldownShadow.recordSkippedSignal inserts a row with source='cooldown-skipped'
//   3. cooldownShadow.onTick walks to TP and closes the row
//   4. Read-back shows correct PnL

import { db } from '../src/db.js';
import { cooldownShadow } from '../src/cooldown-shadow.js';

// 1. Verify schema migration
const cols = db.query(`PRAGMA table_info(shadow_trades)`) as Array<{ name: string; notnull: number }>;
const haveSource = cols.find(c => c.name === 'source');
const haveSignalId = cols.find(c => c.name === 'signal_id');
const haveRuleId = cols.find(c => c.name === 'rule_id');
if (!haveSource || !haveSignalId || !haveRuleId) {
  console.error('FAIL: missing migrated columns', { haveSource: !!haveSource, haveSignalId: !!haveSignalId, haveRuleId: !!haveRuleId });
  process.exit(1);
}
console.log('✓ migration added source/signal_id/rule_id');

// 2. Record a synthetic cooldown-skipped signal
//    NQ long, clean-impulse, entry=20000, ts=now
const fakeSignalId = -1 * (Date.now() % 1000000);  // negative tags it as test
const openTs = Date.now();
cooldownShadow.recordSkippedSignal({
  symbol: 'NQ',
  signalId: fakeSignalId,
  ruleId: 'clean-impulse',
  direction: 'long',
  entry: 20000,
  ts: openTs,
});
console.log('✓ recordSkippedSignal called');

// 3. Read the open row
const opened = (db.query(
  `SELECT id, source, signal_id, rule_id, direction, tp_pt, sl_pt, tp_price, sl_price, classification, level_label, close_ts
   FROM shadow_trades WHERE signal_id = ?`,
  [fakeSignalId],
) as Array<any>)[0];
if (!opened) { console.error('FAIL: no row inserted'); process.exit(1); }
console.log(`✓ row inserted: source=${opened.source} dir=${opened.direction} TP=${opened.tp_pt} SL=${opened.sl_pt} class=${opened.classification} label=${opened.level_label}`);
if (opened.source !== 'cooldown-skipped') { console.error('FAIL: source != cooldown-skipped'); process.exit(1); }
if (opened.tp_pt !== 80 || opened.sl_pt !== 55) { console.error(`FAIL: expected TP=80 SL=55 for clean-impulse long, got ${opened.tp_pt}/${opened.sl_pt}`); process.exit(1); }

// 4. Walk to TP: send a tick at the TP price
cooldownShadow.onTick('NQ', openTs + 5000, 20080);
const closed = (db.query(
  `SELECT close_reason, close_price, pnl_pts, pnl_usd FROM shadow_trades WHERE signal_id = ?`,
  [fakeSignalId],
) as Array<any>)[0];
if (closed.close_reason !== 'TP') { console.error(`FAIL: expected close_reason=TP, got ${closed.close_reason}`); process.exit(1); }
if (closed.pnl_pts !== 80) { console.error(`FAIL: expected pnl_pts=80, got ${closed.pnl_pts}`); process.exit(1); }
if (closed.pnl_usd !== 160) { console.error(`FAIL: expected pnl_usd=160 (MNQ $2/pt), got ${closed.pnl_usd}`); process.exit(1); }
console.log(`✓ TP walk closed: reason=${closed.close_reason} pnl=${closed.pnl_pts}pt/$${closed.pnl_usd}`);

// 5. Cleanup marker rows
console.log(`(test row left in DB; cleanup with: sqlite3 data/trading.db "DELETE FROM shadow_trades WHERE signal_id = ${fakeSignalId};")`);
console.log('\nSmoke OK — cooldown-shadow schema, open, walk-to-TP, close all healthy.');
