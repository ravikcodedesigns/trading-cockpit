/**
 * Backfill Conviction Ratings
 *
 * Reruns conviction scoring on all historical gold tier signals
 * and updates their payload with { conviction: '++'|'+'|null }
 *
 * Usage:
 *   pnpm --filter aggregator backfill:conviction
 *
 * Safe to run multiple times — updates in place.
 * Only touches gold tier signals (absorption 65-79, divergence 90+).
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreConvictionFromTicks } from '../src/rules-v2/conviction.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const tdb  = new Database(TICKS_DB,   { readonly: true });
const trdb = new Database(TRADING_DB);

const WINDOW_MS = 15 * 60 * 1000;

// Fetch all gold tier signals
const signals = trdb.prepare(`
  SELECT id, ts, rule_id, score, direction,
    json_extract(payload, '$.rationale') AS rationale,
    payload
  FROM signals
  WHERE rule_id IN ('absorption', 'delta-divergence')
    AND (
      (rule_id = 'absorption' AND score BETWEEN 65 AND 79)
      OR (rule_id = 'delta-divergence' AND score >= 90)
    )
  ORDER BY ts
`).all() as Array<{
  id: number; ts: number; rule_id: string; score: number;
  direction: string; rationale: string; payload: string;
}>;

console.log(`\nBackfilling conviction for ${signals.length} gold tier signals...\n`);

const updateStmt = trdb.prepare(
  `UPDATE signals SET payload = ? WHERE id = ?`
);

let counts = { plusplus: 0, plus: 0, none: 0, skipped: 0 };

for (const sig of signals) {
  // Fetch ticks for 15min window before signal
  const ticks = tdb.prepare(`
    SELECT ts, price, size, is_bid_aggressor
    FROM trades
    WHERE symbol = 'NQ'
      AND ts >= ? AND ts < ?
    ORDER BY ts
  `).all(sig.ts - WINDOW_MS, sig.ts) as Array<{
    ts: number; price: number; size: number; is_bid_aggressor: number;
  }>;

  if (ticks.length < 20) {
    counts.skipped++;
    continue;
  }

  // Convert is_bid_aggressor (0/1 int) to isBidAggressor boolean
  const normalizedTicks = ticks.map(t => ({
    ts: t.ts,
    price: t.price,
    size: t.size,
    isBidAggressor: t.is_bid_aggressor === 1,
  }));

  const conviction = scoreConvictionFromTicks(
    normalizedTicks,
    sig.direction as 'long' | 'short',
    sig.rule_id,
    sig.ts
  );

  // Update payload JSON with conviction field
  const payloadObj = JSON.parse(sig.payload);
  payloadObj.conviction = conviction;
  updateStmt.run(JSON.stringify(payloadObj), sig.id);

  if (conviction === '++') counts.plusplus++;
  else if (conviction === '+') counts.plus++;
  else counts.none++;
}

console.log('Backfill complete.\n');
console.log(`  ++ (high conviction): ${counts.plusplus}`);
console.log(`  +  (conviction):      ${counts.plus}`);
console.log(`  (none):               ${counts.none}`);
console.log(`  skipped (no ticks):   ${counts.skipped}`);
console.log(`  total processed:      ${counts.plusplus + counts.plus + counts.none}`);

// Show distribution by signal type
console.log('\n--- Distribution by signal type ---');
const byType = trdb.prepare(`
  SELECT
    rule_id,
    direction,
    json_extract(payload, '$.conviction') AS conviction,
    COUNT(*) AS n
  FROM signals
  WHERE rule_id IN ('absorption', 'delta-divergence')
    AND (
      (rule_id = 'absorption' AND score BETWEEN 65 AND 79)
      OR (rule_id = 'delta-divergence' AND score >= 90)
    )
  GROUP BY rule_id, direction, conviction
  ORDER BY rule_id, direction, conviction DESC
`).all() as Array<{ rule_id: string; direction: string; conviction: string; n: number }>;

for (const row of byType) {
  const conv = row.conviction ?? 'none';
  const ruleStr = row.rule_id.padEnd(20);
  const dirStr  = row.direction.padEnd(5);
  const convStr = conv.padEnd(6);
  console.log(`  ${ruleStr} ${dirStr} ${convStr}: ${row.n}`);
}

tdb.close();
trdb.close();
