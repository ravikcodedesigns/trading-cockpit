// Backfill tradable_signals.dflag for historical FLIP/CONT rows.
//
// DANGER-FLAG (registered DANGER-FLAG-CONFIRM 2026-07-08): flag-up = 3-bar
// range ≥ DFLAG_CRNG_MIN AND 11-bar volume ≥ DFLAG_VOL_MIN at the signal bar
// (frozen thresholds in @trading/contracts). Features come from the EXPL-short
// design-study candidate set (data/expl_short_candidates.json — one row per
// RTH minute, 09:40–15:20 closes, 45 days), keyed (day, bar-start-ms) which
// equals (trading day, signal_ts). Rows outside coverage keep dflag = NULL.
//
// Idempotent — re-runnable; only fills FLIP/CONT NQ rows.
// Run: pnpm --filter @trading/aggregator exec tsx scripts/backfill_dflag.ts
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dangerFlag } from '@trading/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const db = new Database(path.join(ROOT, 'data/trading.db'));

const candidates = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/expl_short_candidates.json'), 'utf8')) as
  [string, number, { crng: number; vol: number }, number, number][];
const byKey = new Map<number, { crng: number; vol: number }>();
for (const [, ts, fe] of candidates) byKey.set(ts, { crng: fe.crng, vol: fe.vol });

const rows = db.prepare(`
  SELECT signal_id, signal_ts FROM tradable_signals
  WHERE symbol='NQ' AND rule_id IN ('clean-impulse','cont-reentry')`).all() as { signal_id: number; signal_ts: number }[];

const upd = db.prepare(`UPDATE tradable_signals SET dflag = ? WHERE signal_id = ?`);
let up = 0, down = 0, uncovered = 0;
const tx = db.transaction(() => {
  for (const r of rows) {
    const fe = byKey.get(r.signal_ts);
    if (!fe) { uncovered++; continue; }
    const f = dangerFlag(fe.crng, fe.vol);
    if (f === undefined) { uncovered++; continue; }
    upd.run(f ? 1 : 0, r.signal_id);
    if (f) up++; else down++;
  }
});
tx();
console.log(`backfilled ${up + down}/${rows.length} FLIP/CONT rows: ${up} flag-UP 🟩 · ${down} flag-DOWN 🟥 · ${uncovered} uncovered (outside 09:40–15:20 or pre-coverage)`);
const chk = db.prepare(`SELECT action, dflag, COUNT(*) n FROM tradable_signals
  WHERE rule_id IN ('clean-impulse','cont-reentry') AND action='OPEN' AND dflag IS NOT NULL GROUP BY dflag`).all();
console.log('OPEN book:', JSON.stringify(chk));
db.close();
