/**
 * Strategy A vs B Comparison Report
 *
 * Shows side-by-side performance metrics for Strategy A (bar-based)
 * and Strategy B (tick-based) signals. Helps decide when/whether
 * to migrate from A to B or run both permanently.
 *
 * Usage: pnpm --filter aggregator compare
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../../data/trading.db');
const db = new Database(DB_PATH, { readonly: true });

function pad(val: unknown, width: number): string {
  const s = String(val ?? '-');
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function pct(num: number, den: number): string {
  if (den === 0) return '-';
  return Math.round((num / den) * 100) + '%';
}

interface SummaryRow {
  strategy_version: string;
  rule_id: string;
  session: string;
  n: number;
  avg_gain: number;
  avg_drawdown: number;
  avg_net: number;
  hit20: number;
  hit30: number;
  hit40: number;
  clean30: number;
}

const rows = db.prepare(`
  SELECT
    strategy_version,
    rule_id,
    CASE
      WHEN strftime('%w', signal_ts/1000, 'unixepoch', 'localtime') IN ('1','2','3','4','5')
        AND strftime('%H:%M', signal_ts/1000, 'unixepoch', 'localtime') >= '09:30'
        AND strftime('%H:%M', signal_ts/1000, 'unixepoch', 'localtime') < '16:00'
      THEN 'RTH'
      ELSE 'ON'
    END AS session,
    COUNT(*) AS n,
    ROUND(AVG(w60_max_gain), 1) AS avg_gain,
    ROUND(AVG(w60_max_drawdown), 1) AS avg_drawdown,
    ROUND(AVG(w60_net), 1) AS avg_net,
    SUM(w60_hit20) AS hit20,
    SUM(w60_hit30) AS hit30,
    SUM(w60_hit40) AS hit40,
    SUM(w60_clean30) AS clean30
  FROM signal_outcomes_matured
  GROUP BY strategy_version, rule_id, session
  ORDER BY strategy_version, rule_id, session
`).all() as SummaryRow[];

const totalA = db.prepare(`SELECT COUNT(*) AS c FROM signal_outcomes_matured WHERE strategy_version='A'`).get() as { c: number };
const totalB = db.prepare(`SELECT COUNT(*) AS c FROM signal_outcomes_matured WHERE strategy_version='B'`).get() as { c: number };
const pendingA = db.prepare(`SELECT COUNT(*) AS c FROM signal_outcomes_partial WHERE strategy_version='A'`).get() as { c: number };
const pendingB = db.prepare(`SELECT COUNT(*) AS c FROM signal_outcomes_partial WHERE strategy_version='B'`).get() as { c: number };

console.log('');
console.log('========================================');
console.log('   STRATEGY COMPARISON REPORT');
console.log('========================================');
console.log(`Strategy A matured: ${totalA.c}  (pending: ${pendingA.c})`);
console.log(`Strategy B matured: ${totalB.c}  (pending: ${pendingB.c})`);
console.log('');

const header = pad('strategy', 10) + pad('rule', 20) + pad('session', 8) +
  pad('n', 6) + pad('avgGain60', 11) + pad('avgDD60', 11) +
  pad('avgNet60', 10) + pad('hit30%', 8) + pad('hit40%', 8) + pad('clean30%', 10);

console.log(header);
console.log('-'.repeat(header.length));

for (const row of rows) {
  const line =
    pad(row.strategy_version, 10) +
    pad(row.rule_id, 20) +
    pad(row.session, 8) +
    pad(row.n, 6) +
    pad(row.avg_gain?.toFixed(1) ?? '-', 11) +
    pad(row.avg_drawdown?.toFixed(1) ?? '-', 11) +
    pad(row.avg_net?.toFixed(1) ?? '-', 10) +
    pad(pct(row.hit30, row.n), 8) +
    pad(pct(row.hit40, row.n), 8) +
    pad(pct(row.clean30, row.n), 10);
  console.log(line);
}

console.log('');

// Show if B is outperforming A
if (totalB.c >= 20) {
  const aRth = rows.filter(r => r.strategy_version === 'A' && r.session === 'RTH');
  const bRth = rows.filter(r => r.strategy_version === 'B' && r.session === 'RTH');
  const aHit30 = aRth.reduce((s, r) => s + r.hit30, 0);
  const aTotal = aRth.reduce((s, r) => s + r.n, 0);
  const bHit30 = bRth.reduce((s, r) => s + r.hit30, 0);
  const bTotal = bRth.reduce((s, r) => s + r.n, 0);

  if (aTotal > 0 && bTotal > 0) {
    const aPct = Math.round((aHit30 / aTotal) * 100);
    const bPct = Math.round((bHit30 / bTotal) * 100);
    console.log(`RTH hit@30 summary: A=${aPct}% (n=${aTotal})  B=${bPct}% (n=${bTotal})`);
    if (bPct > aPct + 5) {
      console.log('>> Strategy B is outperforming A at RTH hit@30 (>5% margin)');
    } else if (aPct > bPct + 5) {
      console.log('>> Strategy A is outperforming B at RTH hit@30 (>5% margin)');
    } else {
      console.log('>> Strategies are comparable at RTH hit@30 (within 5% margin)');
    }
  }
} else {
  console.log(`Strategy B has ${totalB.c} matured signals. Need 20+ for reliable comparison.`);
}

console.log('');
db.close();
