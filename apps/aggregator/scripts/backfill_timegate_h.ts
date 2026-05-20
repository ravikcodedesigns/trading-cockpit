/**
 * Backfill time-gate filter for strategy H NQ long signals.
 *
 * Suppressed windows (ET):
 *   before 10:45  — market hasn't established direction (30% win rate)
 *   14:00–16:00   — afternoon trend continuation zone (65% pass rate)
 *
 * Sets rs_hard_filtered=1 / rs_filter_reason='time-gate' for blocked signals,
 * clears those fields for signals that now pass.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../../data/trading.db');

const db = new Database(DB_PATH);

function etMins(tsMs: number): number {
  const ET_OFFSET = 4 * 60 * 60 * 1000;
  const d = new Date(tsMs - ET_OFFSET);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function isTimeGateSuppressed(fireTs: number): boolean {
  const m = etMins(fireTs);
  if (m < 645)              return true;   // before 10:45 ET
  if (m >= 840 && m < 960) return true;   // 14:00–16:00 ET
  return false;
}

const signals = db.prepare(`
  SELECT id, ts FROM signals
  WHERE strategy_version = 'H' AND direction = 'long' AND symbol = 'NQ'
`).all() as { id: number; ts: number }[];

const setBlocked = db.prepare(`
  UPDATE signals SET rs_hard_filtered = 1, rs_filter_reason = 'time-gate'
  WHERE id = ?
`);
const clearBlocked = db.prepare(`
  UPDATE signals SET rs_hard_filtered = 0, rs_filter_reason = NULL
  WHERE id = ?
`);

let blocked = 0, cleared = 0;

db.transaction(() => {
  for (const sig of signals) {
    const fireTs = sig.ts + 60_000;
    if (isTimeGateSuppressed(fireTs)) {
      setBlocked.run(sig.id);
      blocked++;
    } else {
      clearBlocked.run(sig.id);
      cleared++;
    }
  }
})();

console.log(`Done. Blocked: ${blocked}  Passing: ${cleared}  Total: ${signals.length}`);

db.close();
