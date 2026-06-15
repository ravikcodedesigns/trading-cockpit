// Phase 1 — Insert TEST-set FRESH touches as synthetic chart markers.
//
// Loads phase1-events-test.json, filters to FRESH on non-IB levels (the actual
// deployed signal), and inserts each as a row in:
//   • signals             (rule_id='KEY-LVL-FADE')
//   • tradable_signals    (action='OPEN', qualified=1 — the chart joins on this)
//   • qualified_signals   (kept for back-compat)
//
// The payload includes the touch context (level, entry, TP/SL, outcome) so you
// can hover/inspect each marker on the chart. sim_exit_reason / sim_pnl_pts are
// also written so post-entry coloring works.
//
// To clean up later:
//   tsx scripts/phase1/insert_test_markers.ts --clean
//
// Usage:
//   tsx scripts/phase1/insert_test_markers.ts          # insert
//   tsx scripts/phase1/insert_test_markers.ts --clean  # remove

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../../..');
const DB_PATH = path.join(REPO, 'data/trading.db');
const RULE_ID = 'KEY-LVL-FADE';
const NON_IB = ['PDH', 'PDL', 'PDC', 'POC', 'VAH', 'VAL'];
const TP_PT = 20;
const SL_PT = 5;

interface OutcomeResult { result: 'TP'|'SL'|'TIMEOUT'; raw_pnl_pts: number; slip_pnl_pts: number }
interface Event {
  day: string;
  level_label: string;
  level_price: number;
  touch_ts: number;
  touch_price: number;
  approach_dir: 'from_above' | 'from_below';
  approach_dist_5m_signed: number;
  approach_dist_10m_signed: number;
  atr_5m: number;
  atr_10m: number;
  touch_type: string;
  outcomes: Record<string, { fade: OutcomeResult; breakout: OutcomeResult }>;
}

function main() {
  const argv = process.argv.slice(2);
  const cleanMode = argv.includes('--clean');
  const db = new Database(DB_PATH);

  if (cleanMode) {
    // Also clean up the prior name in case it's still around
    const OLD_RULE_ID = 'phase1-test-fresh-fade';
    const r1 = db.prepare(`DELETE FROM qualified_signals WHERE rule_id IN (?, ?)`).run(RULE_ID, OLD_RULE_ID);
    const r2 = db.prepare(`DELETE FROM tradable_signals  WHERE rule_id IN (?, ?)`).run(RULE_ID, OLD_RULE_ID);
    const r3 = db.prepare(`DELETE FROM signals           WHERE rule_id IN (?, ?)`).run(RULE_ID, OLD_RULE_ID);
    console.log(`Removed ${r1.changes} qualified_signals + ${r2.changes} tradable_signals + ${r3.changes} signals`);
    return;
  }

  const events: Event[] = JSON.parse(fs.readFileSync(path.join(REPO, 'phase1-events-test.json'), 'utf8')).events;
  const targets = events.filter(e => e.touch_type === 'FRESH' && NON_IB.includes(e.level_label));
  console.log(`Found ${targets.length} FRESH non-IB touches in test set`);

  // Wipe any prior insertions (this rule + the older name) for idempotence
  const OLD_RULE_ID = 'phase1-test-fresh-fade';
  db.prepare(`DELETE FROM qualified_signals WHERE rule_id IN (?, ?)`).run(RULE_ID, OLD_RULE_ID);
  db.prepare(`DELETE FROM tradable_signals  WHERE rule_id IN (?, ?)`).run(RULE_ID, OLD_RULE_ID);
  db.prepare(`DELETE FROM signals           WHERE rule_id IN (?, ?)`).run(RULE_ID, OLD_RULE_ID);

  const insertSignal = db.prepare(`
    INSERT INTO signals (ts, symbol, rule_id, score, direction, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertQualified = db.prepare(`
    INSERT INTO qualified_signals
      (signal_id, signal_ts, symbol, rule_id, strategy_version, direction, score, session, gate_ver, reason, qualified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // tradable_signals: the chart's qualified-marker query JOINS this table, so we
  // need a row here too. action='OPEN', qualified=1, shadow=0 → shows up under
  // the "TRADABLE" filter on the chart.
  const insertTradable = db.prepare(`
    INSERT INTO tradable_signals
      (signal_id, signal_ts, symbol, rule_id, pattern, direction, score, qualified, action, reason,
       shadow, entry, evaluated_at, sim_exit_ts, sim_exit_price, sim_exit_reason, sim_pnl_pts)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'OPEN', ?, 0, ?, ?, ?, ?, ?, ?)
  `);

  let n = 0;
  const txn = db.transaction((rows: Event[]) => {
    for (const e of rows) {
      // FADE direction maps approach to entry direction:
      //   from_above  → LONG  (price falling into level, expecting bounce up)
      //   from_below  → SHORT (price rising into level, expecting rejection)
      const direction = e.approach_dir === 'from_above' ? 'long' : 'short';
      const entry = e.touch_price;
      const tpPrice = direction === 'long' ? entry + TP_PT : entry - TP_PT;
      const slPrice = direction === 'long' ? entry - SL_PT : entry + SL_PT;
      const outcome = e.outcomes['20/5']!.fade;

      const rationale =
        `[PHASE1-TEST] FRESH ${direction.toUpperCase()} fade at ${e.level_label} ` +
        `(${e.level_price.toFixed(2)}). Approach ${e.approach_dir} +${e.approach_dist_5m_signed.toFixed(1)}pt/5m. ` +
        `TP=${tpPrice.toFixed(2)} (+${TP_PT}) SL=${slPrice.toFixed(2)} (-${SL_PT}). ` +
        `Outcome: ${outcome.result} (raw ${outcome.raw_pnl_pts}pt, slip ${outcome.slip_pnl_pts}pt).`;

      const payload = {
        ts: e.touch_ts,
        source: 'phase1-test',
        type: 'confluence',
        symbol: 'NQ',
        ruleId: RULE_ID,
        score: 100,
        direction,
        rationale,
        strategyVersion: 'PH1',
        ruleVersion: 'phase1-test-fresh-fade-v1',
        pattern: 'FRESH',
        entry,
        stopLevel: slPrice,
        stopDist: SL_PT,
        // Phase 1 context
        levelLabel: e.level_label,
        levelPrice: e.level_price,
        approachDir: e.approach_dir,
        approachDist5m: e.approach_dist_5m_signed,
        approachDist10m: e.approach_dist_10m_signed,
        atr5m: e.atr_5m,
        atr10m: e.atr_10m,
        touchType: e.touch_type,
        // Outcome (so chart hover can show it)
        tpPrice, slPrice, tpPt: TP_PT, slPt: SL_PT,
        outcomeResult: outcome.result,
        outcomeSlipPnlPts: outcome.slip_pnl_pts,
      };

      const sigInfo = insertSignal.run(e.touch_ts, 'NQ', RULE_ID, 100, direction, JSON.stringify(payload));
      const signalId = sigInfo.lastInsertRowid as number;
      insertQualified.run(
        signalId, e.touch_ts, 'NQ', RULE_ID, 'PH1', direction, 100, 'rth',
        99, // gate_ver=99 to distinguish synthetic
        rationale, Date.now(),
      );
      // tradable_signals row — gives the chart's qualified-marker join a hit
      const simExitTs = outcome.result === 'TIMEOUT' ? null : e.touch_ts + 5 * 60_000; // approx 5min after open
      const simExitPrice = outcome.result === 'TP' ? tpPrice : outcome.result === 'SL' ? slPrice : null;
      insertTradable.run(
        signalId, e.touch_ts, 'NQ', RULE_ID, 'FRESH', direction, 100,
        rationale, entry, Date.now(),
        simExitTs, simExitPrice, outcome.result, outcome.slip_pnl_pts,
      );
      n++;
    }
  });

  txn(targets);
  console.log(`Inserted ${n} FRESH non-IB test touches into signals + qualified_signals`);
  console.log(`rule_id='${RULE_ID}' — filter or clean up via this tag.`);

  // Summary by day
  const byDay = new Map<string, number>();
  for (const e of targets) byDay.set(e.day, (byDay.get(e.day) ?? 0) + 1);
  console.log(`\nPer-day counts:`);
  for (const [day, c] of [...byDay.entries()].sort()) console.log(`  ${day}: ${c}`);

  // Outcome summary
  const wins = targets.filter(e => e.outcomes['20/5']!.fade.result === 'TP').length;
  const losses = targets.filter(e => e.outcomes['20/5']!.fade.result === 'SL').length;
  const timeouts = targets.length - wins - losses;
  console.log(`\nExpected outcomes (20/5 fade): ${wins} TP / ${losses} SL / ${timeouts} TIMEOUT`);
  console.log(`Win rate: ${(wins / (wins + losses) * 100).toFixed(1)}% (closed)`);
}

main();
