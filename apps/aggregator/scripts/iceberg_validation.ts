// Validate iceberg candidates: did price actually reject from the iceberg
// level after confirmation? An iceberg ASK is real if price drops away
// from it; an iceberg BID is real if price bounces UP from it.
//
// Method: for each candidate, look at price action 1m/3m/5m AFTER confirmation
// and measure max favorable excursion (in the direction the iceberg implies).

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TICKS_DB = path.resolve(__dirname, '../../../data/ticks.db');
const xdb = new Database(TICKS_DB, { readonly: true });

interface Candidate {
  confirmedAt: number;   // ms epoch
  price: number;
  side: 0 | 1;           // 0 BID 1 ASK
  symbol: string;
}

// The 3 candidates from the HIGH-CONVICTION smoke
const candidates: Candidate[] = [
  { confirmedAt: Date.UTC(2026, 4, 28, 18, 16, 58), price: 30319.75, side: 1, symbol: 'NQ' },
  { confirmedAt: Date.UTC(2026, 4, 28, 13, 57, 3),  price: 29985.25, side: 1, symbol: 'NQ' },
  { confirmedAt: Date.UTC(2026, 4, 28, 14, 10, 10), price: 30038.75, side: 1, symbol: 'NQ' },
];

const tradeStmt = xdb.prepare(`
  SELECT ts, price
  FROM trades
  WHERE symbol = ? AND ts >= ? AND ts <= ?
  ORDER BY ts ASC
`);

console.log(`\n══ Iceberg-bounce validation ══`);
console.log(`Question: did price reject from each iceberg level?`);
console.log(`\n  confirmed_at(ET)  level     side  T+1m   T+3m   T+5m  signal`);

for (const c of candidates) {
  const sideStr = c.side === 0 ? 'BID' : 'ASK';
  // For ASK iceberg: favorable move = price DOWN (price gets capped)
  // For BID iceberg: favorable move = price UP (price gets supported)
  const direction = c.side === 1 ? -1 : 1;

  // Get all trades from confirmation to +5min
  const after = tradeStmt.all(c.symbol, c.confirmedAt, c.confirmedAt + 5 * 60_000) as Array<{ ts: number; price: number }>;
  if (after.length === 0) {
    console.log(`  (no data for ${new Date(c.confirmedAt).toISOString()})`);
    continue;
  }

  // Confirmation price (first tick after)
  const confirmPrice = after[0]!.price;

  // Max favorable excursion at each horizon
  const horizons = [60_000, 180_000, 300_000];
  const results: number[] = [];
  for (const h of horizons) {
    const cutoff = c.confirmedAt + h;
    let maxFav = 0;
    for (const t of after) {
      if (t.ts > cutoff) break;
      const move = direction * (t.price - confirmPrice);
      if (move > maxFav) maxFav = move;
    }
    results.push(maxFav);
  }

  const t1 = results[0]!.toFixed(2).padStart(5);
  const t3 = results[1]!.toFixed(2).padStart(5);
  const t5 = results[2]!.toFixed(2).padStart(5);
  const ts = new Date(c.confirmedAt - 4*60*60_000).toISOString().substring(11, 19);
  const signal = results[2]! >= 5 ? '✓ REAL' : results[2]! >= 2 ? '~ weak' : '✗ false';

  console.log(
    `  ${ts}          ${c.price.toFixed(2)}  ${sideStr}    ` +
    `${t1}  ${t3}  ${t5}  ${signal}`
  );
}

xdb.close();
