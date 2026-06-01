/**
 * backfill_abso_tape_short.ts
 *
 * Retroactively sets tapeSpeedConfirmed in qualified_signals.context_json for
 * ABSO short signals, using the corrected logic: check for long tape-speed
 * (buy urgency being absorbed at resistance) within 60 seconds before the signal.
 *
 * Run once after deploying the confluence-tracker fix.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.resolve(__dirname, '../../../data/trading.db'));
db.pragma('journal_mode = WAL');

const WINDOW_MS = 60_000; // same as CONFLUENCE_WINDOW_MS in confluence-tracker.ts

const shorts = db.prepare(`
  SELECT q.signal_id, q.signal_ts, q.symbol, q.context_json
  FROM qualified_signals q
  WHERE q.rule_id = 'absorption' AND q.direction = 'short'
`).all() as { signal_id: number; signal_ts: number; symbol: string; context_json: string }[];

const stmtTape = db.prepare(`
  SELECT COUNT(*) AS n FROM signals
  WHERE rule_id = 'tape-speed'
    AND symbol = ?
    AND direction = 'long'
    AND ts >= ? AND ts <= ?
`);

const stmtUpdate = db.prepare(`
  UPDATE qualified_signals
  SET context_json = json_set(context_json, '$.tapeSpeedConfirmed', ?)
  WHERE signal_id = ?
`);

console.log(`\nBackfilling tapeSpeedConfirmed for ${shorts.length} qualified ABSO short signals...\n`);
console.log('signal_ts'.padEnd(14) + 'tape_in_60s'.padEnd(14) + 'old_value → new_value');
console.log('─'.repeat(55));

const run = db.transaction(() => {
  for (const row of shorts) {
    const { n } = stmtTape.get(
      row.symbol,
      row.signal_ts - WINDOW_MS,
      row.signal_ts
    ) as { n: number };

    const newVal  = n > 0 ? 1 : 0;
    const ctx     = JSON.parse(row.context_json);
    const oldVal  = ctx.tapeSpeedConfirmed ?? null;

    const et = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(row.signal_ts)).replace(',', '');

    console.log(
      et.padEnd(14) +
      String(n).padEnd(14) +
      `${oldVal} → ${newVal}`
    );

    stmtUpdate.run(newVal, row.signal_id);
  }
});

run();

console.log('\nDone.\n');
db.close();
