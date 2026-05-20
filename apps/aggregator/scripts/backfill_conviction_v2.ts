/**
 * Backfill and validate single-marker conviction for absorption-v2 long signals.
 *
 * Reads tick data for each signal's 15-min pre-signal window, computes
 * conviction using the new seller-exhaustion rule, and reports win rates
 * for conviction vs no-conviction subsets.
 *
 * Run: npx tsx scripts/backfill_conviction_v2.ts
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { scoreConvictionFromTicks } from '../src/rules-v2/conviction.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH    = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_PATH = path.resolve(__dirname, '../../../data/ticks.db');

const db     = new Database(DB_PATH);
const ticksDb = new Database(TICKS_PATH, { readonly: true });

const WINDOW_MS = 15 * 60 * 1000;

const signals = db.prepare(`
  SELECT id, ts, symbol, direction, score,
    json_extract(payload,'$.entry') as entry
  FROM signals
  WHERE rule_id='absorption' AND symbol='NQ'
    AND rule_version='absorption-v2'
    AND direction='long'
    AND score >= 80
    AND json_extract(payload,'$.entry') IS NOT NULL
  ORDER BY ts
`).all() as { id: number; ts: number; symbol: string; direction: string; score: number; entry: number }[];

const getTicks = ticksDb.prepare(`
  SELECT ts, price, size, is_bid_aggressor as isBidAggressor
  FROM trades
  WHERE symbol=? AND ts >= ? AND ts < ?
  ORDER BY ts ASC
`);

const getOutcome = ticksDb.prepare(`
  SELECT ts, price FROM trades
  WHERE symbol='NQ' AND ts >= ? AND ts <= ?
  ORDER BY ts ASC
`);

type Result = { conviction: boolean; outcome: 'win' | 'fail' | 'open'; score: number };
const results: Result[] = [];

for (const sig of signals) {
  const preTicks = getTicks.all(sig.symbol, sig.ts - WINDOW_MS, sig.ts) as
    { ts: number; price: number; size: number; isBidAggressor: number }[];

  const conviction = scoreConvictionFromTicks(
    preTicks.map(t => ({ ...t, isBidAggressor: t.isBidAggressor === 1 })),
    'long', 'absorption', sig.ts
  );

  const fireTs = sig.ts + 60_000;
  const endTs  = fireTs + 4 * 60 * 60 * 1000;
  const ticks  = getOutcome.all(fireTs, endTs) as { ts: number; price: number }[];

  let winTs = null, ddTs = null;
  for (const t of ticks) {
    if (t.price - sig.entry >= 40 && !winTs) winTs = t.ts;
    if (sig.entry - t.price >= 20 && !ddTs) ddTs = t.ts;
    if (winTs && ddTs) break;
  }

  let outcome: 'win' | 'fail' | 'open';
  if (!winTs && !ddTs)              outcome = 'open';
  else if (!winTs)                  outcome = 'fail';
  else if (!ddTs || winTs <= ddTs)  outcome = 'win';
  else                              outcome = 'fail';

  results.push({ conviction: conviction === '+', outcome, score: sig.score });
}

ticksDb.close();
db.close();

const wr = (arr: Result[]) => {
  const closed = arr.filter(r => r.outcome !== 'open');
  const wins   = arr.filter(r => r.outcome === 'win');
  return closed.length === 0 ? 'n/a'
    : `${wins.length}/${closed.length} (${Math.round(wins.length/closed.length*100)}%)`;
};

const withConv    = results.filter(r => r.conviction);
const withoutConv = results.filter(r => !r.conviction);

console.log('\n=== CONVICTION VALIDATION — absorption-v2 NQ LONG score>=80 ===\n');
console.log(`Total signals:       ${results.length}`);
console.log(`With conviction (+): ${withConv.length}  (${Math.round(withConv.length/results.length*100)}%)`);
console.log(`Without conviction:  ${withoutConv.length}`);
console.log('');
console.log(`Win rate ALL:        ${wr(results)}`);
console.log(`Win rate WITH (+):   ${wr(withConv)}`);
console.log(`Win rate WITHOUT:    ${wr(withoutConv)}`);
console.log('');

// Break down by score band
for (const band of ['90+', '80-89'] as const) {
  const bandFilter = band === '90+' ? (r: Result) => r.score >= 90 : (r: Result) => r.score >= 80 && r.score < 90;
  const bandAll  = results.filter(bandFilter);
  const bandWith = withConv.filter(bandFilter);
  const bandWithout = withoutConv.filter(bandFilter);
  console.log(`${band}  all=${wr(bandAll)}  with(+)=${wr(bandWith)}  without=${wr(bandWithout)}`);
}
