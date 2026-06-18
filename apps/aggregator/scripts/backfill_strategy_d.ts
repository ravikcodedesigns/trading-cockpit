/**
 * Backfill Historical Strategy D Signals
 *
 * Inserts the 4 validated compression-breakout signals identified
 * from backtest analysis (May 5-7 2026) into the signals table.
 * These will then appear on the 15-min chart as COMP markers.
 *
 * Usage:
 *   pnpm --filter aggregator backfill:strategy-d
 *
 * Safe to run multiple times — skips if already present.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');

const db = new Database(TRADING_DB);

// 4 validated signals from backtest
// All passed: comp_pos 0.30-0.70, trend aligned, dir_eff >= 0.30
const signals = [
  {
    // May 5 08:00 ET — long, comp_pos=0.57, macro=+79.2pts, dir_eff=0.55 → 162pts
    ts: new Date('2026-05-05T08:00:00-04:00').getTime(),
    symbol: 'NQ',
    direction: 'long',
    compLow: 27900.75, compHigh: 27948.0,
    compPos: 0.57, dirEff: 0.55, macroMove: 79.2,
    stopLevel: 27900.75, entry: 27952.0,
    outcome: 162.0,
  },
  {
    // May 5 23:00 ET — long, comp_pos=0.44, macro=+154.2pts, dir_eff=0.43 → 63pts
    ts: new Date('2026-05-05T23:00:00-04:00').getTime(),
    symbol: 'NQ',
    direction: 'long',
    compLow: 28255.0, compHigh: 28291.0,
    compPos: 0.44, dirEff: 0.43, macroMove: 154.2,
    stopLevel: 28255.0, entry: 28294.0,
    outcome: 63.8,
  },
  {
    // May 6 04:00 ET — long, comp_pos=0.42, macro=+33.0pts, dir_eff=0.31 → 275pts
    ts: new Date('2026-05-06T04:00:00-04:00').getTime(),
    symbol: 'NQ',
    direction: 'long',
    compLow: 28315.0, compHigh: 28360.0,
    compPos: 0.42, dirEff: 0.31, macroMove: 33.0,
    stopLevel: 28315.0, entry: 28363.0,
    outcome: 275.2,
  },
  {
    // May 7 01:30 ET — long, comp_pos=0.67, macro=+26.0pts, dir_eff=0.33 → 89pts
    ts: new Date('2026-05-07T01:30:00-04:00').getTime(),
    symbol: 'NQ',
    direction: 'long',
    compLow: 28710.0, compHigh: 28734.0,
    compPos: 0.67, dirEff: 0.33, macroMove: 26.0,
    stopLevel: 28710.0, entry: 28736.0,
    outcome: 89.8,
  },
];

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO signals
    (ts, symbol, rule_id, score, direction, strategy_version, rule_version, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

// Check for existing
const existing = db.prepare(`
  SELECT COUNT(*) as n FROM signals
  WHERE rule_id = 'compression-breakout'
    AND strategy_version = 'D'
`).get() as { n: number };

if (existing.n > 0) {
  console.log(`Already have ${existing.n} Strategy D signals — skipping.`);
  process.exit(0);
}

console.log(`\nBackfilling ${signals.length} historical Strategy D signals...\n`);

let inserted = 0;
for (const s of signals) {
  const compRange = s.compHigh - s.compLow;
  const stopDist  = Math.abs(s.entry - s.stopLevel);

  const payload = JSON.stringify({
    rationale:
      `COMPRESSION-BREAKOUT [15m→5m]: 75-min range ${compRange.toFixed(1)}pts ` +
      `(${s.compLow}–${s.compHigh}). ` +
      `comp_pos=${s.compPos.toFixed(2)} (middle of range). ` +
      `Macro move +${s.macroMove.toFixed(1)}pts, dir_eff=${s.dirEff.toFixed(2)}. ` +
      `Stop: ${s.stopLevel} (${stopDist.toFixed(1)}pts). ` +
      `[BACKFILLED — outcome: +${s.outcome}pts]`,
    compHigh: s.compHigh,
    compLow: s.compLow,
    compRange,
    compPos: s.compPos,
    dirEff: s.dirEff,
    macroMove: s.macroMove,
    stopLevel: s.stopLevel,
    stopDist,
    entry: s.entry,
    outcome: s.outcome,
    backfilled: true,
  });

  const result = insertStmt.run(
    s.ts, s.symbol, 'compression-breakout', 100,
    s.direction, 'D', 'compression-v2', payload
  );

  if (result.changes > 0) {
    const dt = new Date(s.ts).toLocaleString('en-US', { timeZone: 'America/New_York' });
    console.log(`  ✓ ${dt}  ${s.direction.toUpperCase()}  outcome=+${s.outcome}pts`);
    inserted++;
  }
}

console.log(`\nInserted ${inserted} signals.`);
console.log(`Restart the aggregator and hard-refresh the cockpit to see them on the 15m chart.`);

db.close();
