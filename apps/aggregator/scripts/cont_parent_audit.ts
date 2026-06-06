// For each cont-reentry signal, list ALL signals in the 90-min lookback
// that would have qualified as parents under the current SQL — not just
// the most-recent (winning) one. This shows whether tape-speed/large-print
// ever made it into the candidate pool at all.
//
// Critical: this script reads the DB AS IT IS NOW (post-WBF backfill),
// so it includes the WBF rows that were just promoted out of 'B'.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });

const PARENT_WINDOW_MS = 90 * 60_000;

const conts = db.prepare(`
  SELECT id, ts, symbol, direction
  FROM signals
  WHERE rule_id = 'cont-reentry'
  ORDER BY ts ASC
`).all() as Array<{ id: number; ts: number; symbol: string; direction: 'long'|'short' }>;

// All qualifying candidates per parent SQL (post-WBF cleanup)
const findCandidates = db.prepare(`
  SELECT id, ts, rule_id, strategy_version, score
  FROM signals
  WHERE symbol = ? AND direction = ?
    AND ts >= ? AND ts < ?
    AND rs_hard_filtered IS NOT 1
    AND (
      (strategy_version = 'H')
      OR (strategy_version = 'EXPL' AND direction = 'long')
      OR (strategy_version = 'B' AND score >= 80)
      OR (strategy_version = 'WBF')
    )
  ORDER BY ts DESC
`);

interface CandidateRow {
  contId: number;
  rank: number;            // 1 = winner (most recent), 2 = 2nd most recent, etc.
  ruleId: string;
  sv: string;
  score: number;
  ageMin: number;          // minutes before cont signal
}

const rows: CandidateRow[] = [];

for (const c of conts) {
  const start = c.ts - PARENT_WINDOW_MS;
  const cands = findCandidates.all(c.symbol, c.direction, start, c.ts) as Array<{
    id: number; ts: number; rule_id: string; strategy_version: string; score: number;
  }>;
  cands.forEach((cd, i) => {
    rows.push({
      contId: c.id,
      rank: i + 1,
      ruleId: cd.rule_id,
      sv: cd.strategy_version,
      score: cd.score,
      ageMin: Math.round((c.ts - cd.ts) / 60_000),
    });
  });
}

// Aggregate by rule_id × rank
const byRuleRank = new Map<string, { winner: number; runnerUp: number; deeper: number; total: number }>();
for (const r of rows) {
  const k = `${r.ruleId}`;
  if (!byRuleRank.has(k)) byRuleRank.set(k, { winner: 0, runnerUp: 0, deeper: 0, total: 0 });
  const slot = byRuleRank.get(k)!;
  slot.total++;
  if (r.rank === 1) slot.winner++;
  else if (r.rank === 2) slot.runnerUp++;
  else slot.deeper++;
}

console.log(`═══ Parent-pool audit across ${conts.length} cont-reentry signals ═══\n`);
console.log(`For each cont-reentry, "winner" = most-recent qualifying parent (what the SQL picks),`);
console.log(`"runnerUp" = 2nd most recent, "deeper" = 3rd+ — these were eligible but overridden.\n`);
console.log(`${'rule_id'.padEnd(28)}  winner  runnerUp  deeper  total`);
console.log(`${'-'.padEnd(28, '-')}  ------  --------  ------  -----`);
const sorted = [...byRuleRank.entries()].sort((a, b) => b[1].total - a[1].total);
for (const [rule, s] of sorted) {
  console.log(`${rule.padEnd(28)}  ${String(s.winner).padStart(6)}  ${String(s.runnerUp).padStart(8)}  ${String(s.deeper).padStart(6)}  ${String(s.total).padStart(5)}`);
}

// How many cont-reentry had ZERO candidates? (shouldn't be any — strategy requires a parent)
const contIdsWithCands = new Set(rows.map(r => r.contId));
const noParent = conts.filter(c => !contIdsWithCands.has(c.id));
console.log(`\nCont-reentry signals with NO qualifying candidate in 90min window: ${noParent.length}`);

// Direction × rule_id check — maybe tape-speed/large-print never fire same-direction as cont
console.log(`\n═══ Same-direction signal availability check ═══`);
console.log(`How many tape-speed / large-print / absorption signals existed in the 90min`);
console.log(`window BEFORE each cont-reentry (same symbol+direction, before RS/score filters)?\n`);
const presence = db.prepare(`
  SELECT rule_id, COUNT(*) AS n
  FROM signals s
  WHERE rule_id IN ('absorption', 'tape-speed', 'large-print')
    AND EXISTS (
      SELECT 1 FROM signals c
      WHERE c.rule_id = 'cont-reentry'
        AND c.symbol = s.symbol
        AND c.direction = s.direction
        AND s.ts < c.ts
        AND s.ts >= c.ts - ?
    )
  GROUP BY rule_id
`).all(PARENT_WINDOW_MS) as Array<{ rule_id: string; n: number }>;
for (const p of presence) {
  console.log(`  ${p.rule_id.padEnd(20)} ${p.n} signals same-symbol+direction within 90min of SOME cont`);
}

// Now apply the score≥80 filter to see who survives
console.log(`\n═══ With score>=80 filter ═══`);
const presenceFiltered = db.prepare(`
  SELECT rule_id, COUNT(*) AS n
  FROM signals s
  WHERE rule_id IN ('absorption', 'tape-speed', 'large-print')
    AND score >= 80
    AND rs_hard_filtered IS NOT 1
    AND EXISTS (
      SELECT 1 FROM signals c
      WHERE c.rule_id = 'cont-reentry'
        AND c.symbol = s.symbol
        AND c.direction = s.direction
        AND s.ts < c.ts
        AND s.ts >= c.ts - ?
    )
  GROUP BY rule_id
`).all(PARENT_WINDOW_MS) as Array<{ rule_id: string; n: number }>;
for (const p of presenceFiltered) {
  console.log(`  ${p.rule_id.padEnd(20)} ${p.n} signals qualifying in some cont's lookback`);
}
