// Breakdown of the pipeline's tradable wins by rule + direction, paired
// against actual V3 historical CLOSE outcomes. Uses the same per-symbol
// pendingOpen pairing as diff_pipeline_vs_v3.ts so phantom OPENs don't
// double-count.
//
// Run: pnpm --filter @trading/aggregator exec tsx scripts/pipeline_breakdown.ts

import { db } from '../src/db.js';

interface V3Row { ts: number; symbol: string; signal_id: number | null; rule_id: string; direction: string; action: string; reason: string; }

const v3 = db.query<V3Row>(`
  SELECT ts, symbol, signal_id, rule_id, direction, action, reason
  FROM v3_decisions_pre_refactor
  ORDER BY ts ASC, action DESC
`);

const pipelineOpens = new Set<number>(
  db.query<{signal_id: number}>(
    `SELECT signal_id FROM tradable_signals WHERE action='OPEN'`
  ).map(r => r.signal_id)
);

interface Outcome { rule: string; dir: string; pnl: number; }
const outcomes: Outcome[] = [];

const pending = new Map<string, V3Row>();
for (const r of v3) {
  if (r.action === 'OPEN' && r.signal_id != null) {
    if (pending.has(r.symbol)) continue;   // phantom
    pending.set(r.symbol, r);
  } else if (r.action === 'CLOSE') {
    const open = pending.get(r.symbol);
    if (open && open.signal_id != null) {
      const m = r.reason.match(/pnl=(-?\d+(\.\d+)?)/);
      const pnl = m ? parseFloat(m[1]!) : 0;
      // Only count if the pipeline would have also OPENed this signal
      if (pipelineOpens.has(open.signal_id)) {
        outcomes.push({ rule: open.rule_id, dir: open.direction, pnl });
      }
      pending.delete(r.symbol);
    }
  }
}

// Aggregate
interface Bucket { trades: number; wins: number; losses: number; pnl: number; }
const byRuleDir = new Map<string, Bucket>();
for (const o of outcomes) {
  const k = `${o.rule}|${o.dir}`;
  const b = byRuleDir.get(k) ?? { trades: 0, wins: 0, losses: 0, pnl: 0 };
  b.trades++;
  if (o.pnl > 0) b.wins++;
  else if (o.pnl < 0) b.losses++;
  b.pnl += o.pnl;
  byRuleDir.set(k, b);
}

console.log(`\n┌──────────────────────┬────────┬────────┬───────┬───────┬───────────┐`);
console.log(`│ Rule                 │ Dir    │ Trades │ Wins  │ Losses│ Net pts   │`);
console.log(`├──────────────────────┼────────┼────────┼───────┼───────┼───────────┤`);
const sorted = Array.from(byRuleDir.entries()).sort((a, b) => b[1].pnl - a[1].pnl);
let totalT = 0, totalW = 0, totalL = 0, totalP = 0;
for (const [k, b] of sorted) {
  const [rule, dir] = k.split('|');
  console.log(
    `│ ${rule!.padEnd(20)} │ ${dir!.padEnd(6)} │ ${String(b.trades).padStart(6)} │ ` +
    `${String(b.wins).padStart(5)} │ ${String(b.losses).padStart(5)} │ ${(b.pnl >= 0 ? '+' : '') + b.pnl.toFixed(1)}`.padEnd(80).slice(0, 79) + '│'
  );
  totalT += b.trades; totalW += b.wins; totalL += b.losses; totalP += b.pnl;
}
console.log(`├──────────────────────┴────────┼────────┼───────┼───────┼───────────┤`);
console.log(
  `│ TOTAL                         │ ${String(totalT).padStart(6)} │ ${String(totalW).padStart(5)} │ ` +
  `${String(totalL).padStart(5)} │ ${(totalP >= 0 ? '+' : '') + totalP.toFixed(1)}`.padEnd(80).slice(0, 79) + '│'
);
console.log(`└───────────────────────────────┴────────┴───────┴───────┴───────────┘`);
console.log(`\nWR = ${totalW} / ${totalW + totalL} = ${(totalW / (totalW + totalL) * 100).toFixed(1)}%`);
