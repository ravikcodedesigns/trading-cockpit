// Verify the fake FLIP is queryable.
import Database from 'better-sqlite3';
import { config } from '../src/config.js';
import { db } from '../src/db.js';

const T0 = Date.parse('2099-05-29T13:30:00Z');

// Insert a fake SHORT FLIP at T0-60s
db.logSignal({
  ts: T0 - 60_000, symbol: 'NQ' as any, ruleId: 'clean-impulse', score: 95, direction: 'short',
  source: 'rules-v2' as any, type: 'confluence' as any,
  strategyVersion: 'H', ruleVersion: 'clean-impulse-v1',
  rationale: 'flip debug',
  ...({ pattern: 'FLIP', entry: 30055 } as any),
} as any);

// Query via db.lastFlipInWindow
const flip = db.lastFlipInWindow('NQ', T0 + 10_000 - 60 * 60_000, T0 + 10_000);
console.log('db.lastFlipInWindow returned:', flip);

// Raw query to verify presence
const xdb = new Database(config.dbPath, { readonly: true });
const row = xdb.prepare(`
  SELECT id, ts, direction, strategy_version, json_extract(payload, '$.pattern') AS pattern,
         json_extract(payload, '$.entry') AS entry
  FROM signals
  WHERE symbol='NQ' AND ts >= ? AND ts < ?
    AND strategy_version='H'
    AND json_extract(payload, '$.pattern')='FLIP'
  ORDER BY ts DESC LIMIT 1
`).get(T0 + 10_000 - 60 * 60_000, T0 + 10_000);
console.log('Raw query returned:', row);

// Cleanup
const xdbW = new Database(config.dbPath);
xdbW.prepare(`DELETE FROM signals WHERE ts >= ?`).run(T0 - 120_000);
xdbW.close();
xdb.close();
