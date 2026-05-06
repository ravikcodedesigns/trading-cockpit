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
  gain5: number; dd5: number;
  gain15: number; dd15: number;
  gain30: number; dd30: number;
  gain60: number; dd60: number;
  hit30_15: number; cln15: number;
  hit30_60: number; cln60: number;
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
    ROUND(AVG(w5_max_gain), 1)   AS gain5,
    ROUND(AVG(w5_max_drawdown), 1) AS dd5,
    ROUND(AVG(w15_max_gain), 1)  AS gain15,
    ROUND(AVG(w15_max_drawdown), 1) AS dd15,
    ROUND(AVG(w30_max_gain), 1)  AS gain30,
    ROUND(AVG(w30_max_drawdown), 1) AS dd30,
    ROUND(AVG(w60_max_gain), 1)  AS gain60,
    ROUND(AVG(w60_max_drawdown), 1) AS dd60,
    SUM(w15_hit30) AS hit30_15,
    SUM(w15_clean30) AS cln15,
    SUM(w60_hit30) AS hit30_60,
    SUM(w60_clean30) AS cln60
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

// Two-line header for readability
const header1 = pad('strategy', 10) + pad('rule', 20) + pad('ses', 5) + pad('n', 5) +
  pad('g@5', 7) + pad('dd@5', 7) +
  pad('g@15', 7) + pad('dd@15', 7) +
  pad('g@30', 7) + pad('dd@30', 7) +
  pad('g@60', 7) + pad('dd@60', 7) +
  pad('h30@15', 8) + pad('cln@15', 8) +
  pad('h30@60', 8) + pad('cln@60', 8);

console.log(header1);
console.log('-'.repeat(header1.length));

for (const row of rows) {
  const line =
    pad(row.strategy_version, 10) +
    pad(row.rule_id, 20) +
    pad(row.session, 5) +
    pad(row.n, 5) +
    pad(row.gain5?.toFixed(1) ?? '-', 7) +
    pad(row.dd5?.toFixed(1) ?? '-', 7) +
    pad(row.gain15?.toFixed(1) ?? '-', 7) +
    pad(row.dd15?.toFixed(1) ?? '-', 7) +
    pad(row.gain30?.toFixed(1) ?? '-', 7) +
    pad(row.dd30?.toFixed(1) ?? '-', 7) +
    pad(row.gain60?.toFixed(1) ?? '-', 7) +
    pad(row.dd60?.toFixed(1) ?? '-', 7) +
    pad(pct(row.hit30_15, row.n), 8) +
    pad(pct(row.cln15, row.n), 8) +
    pad(pct(row.hit30_60, row.n), 8) +
    pad(pct(row.cln60, row.n), 8);
  console.log(line);
}

console.log('');

// RTH 15-minute summary (primary trading window)
if (totalB.c >= 20) {
  const aRth = rows.filter(r => r.strategy_version === 'A' && r.session === 'RTH');
  const bRth = rows.filter(r => r.strategy_version === 'B' && r.session === 'RTH');
  const aHit30_15 = aRth.reduce((s, r) => s + r.hit30_15, 0);
  const aTotal = aRth.reduce((s, r) => s + r.n, 0);
  const bHit30_15 = bRth.reduce((s, r) => s + r.hit30_15, 0);
  const bTotal = bRth.reduce((s, r) => s + r.n, 0);

  if (aTotal > 0 && bTotal > 0) {
    const aPct = Math.round((aHit30_15 / aTotal) * 100);
    const bPct = Math.round((bHit30_15 / bTotal) * 100);
    console.log(`RTH hit@30 within 15min: A=${aPct}% (n=${aTotal})  B=${bPct}% (n=${bTotal})`);
    if (bPct > aPct + 5) {
      console.log('>> Strategy B outperforming A at RTH 15-min hit@30');
    } else if (aPct > bPct + 5) {
      console.log('>> Strategy A outperforming B at RTH 15-min hit@30');
    } else {
      console.log('>> Strategies comparable at RTH 15-min hit@30 (within 5%)');
    }
  }
} else {
  console.log(`Strategy B has ${totalB.c} matured signals. Need 20+ for reliable comparison.`);
}

console.log('');

// --- Absorption confluence split ---
// Shows confirmed (tape-speed agreed) vs unconfirmed absorption performance

const absorptionConfluence = db.prepare(`
  SELECT
    CASE
      WHEN json_extract(s.payload, '$.tapeSpeedConfirmed') = 1 THEN 'confirmed'
      ELSE 'unconfirmed'
    END AS confluence,
    CASE
      WHEN strftime('%H:%M', m.signal_ts/1000, 'unixepoch', 'localtime') >= '09:30'
        AND strftime('%H:%M', m.signal_ts/1000, 'unixepoch', 'localtime') < '16:00'
        AND strftime('%w', m.signal_ts/1000, 'unixepoch', 'localtime') IN ('1','2','3','4','5')
      THEN 'RTH' ELSE 'ON'
    END AS session,
    COUNT(*) AS n,
    ROUND(AVG(m.w60_max_gain), 1) AS avg_gain,
    ROUND(AVG(m.w60_max_drawdown), 1) AS avg_drawdown,
    ROUND(AVG(m.w60_net), 1) AS avg_net,
    ROUND(100.0 * SUM(m.w60_hit30) / COUNT(*), 0) AS hit30_pct,
    ROUND(100.0 * SUM(m.w60_clean30) / COUNT(*), 0) AS clean30_pct
  FROM signal_outcomes_matured m
  JOIN signals s ON s.id = m.signal_id
  WHERE m.rule_id = 'absorption' AND m.strategy_version = 'B'
  GROUP BY confluence, session
  ORDER BY session, confluence
`).all() as Array<{
  confluence: string; session: string; n: number;
  avg_gain: number; avg_drawdown: number; avg_net: number;
  hit30_pct: number; clean30_pct: number;
}>;

if (absorptionConfluence.length > 0) {
  console.log('');
  console.log('--- ABSORPTION: CONFIRMED vs UNCONFIRMED ---');
  console.log(pad('confluence', 14) + pad('session', 8) + pad('n', 6) +
    pad('avgGain', 9) + pad('avgDD', 9) + pad('avgNet', 9) +
    pad('hit30%', 8) + pad('clean30%', 10));
  console.log('-'.repeat(73));
  for (const row of absorptionConfluence) {
    console.log(
      pad(row.confluence, 14) + pad(row.session, 8) + pad(row.n, 6) +
      pad(row.avg_gain?.toFixed(1) ?? '-', 9) +
      pad(row.avg_drawdown?.toFixed(1) ?? '-', 9) +
      pad(row.avg_net?.toFixed(1) ?? '-', 9) +
      pad(row.hit30_pct + '%', 8) +
      pad(row.clean30_pct + '%', 10)
    );
  }
}
db.close();
