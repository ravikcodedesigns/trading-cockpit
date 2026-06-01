// End-to-end smoke test of state.applySignal across V3 modes.
//
// Verifies the three critical guarantees:
//   1. mode='off'    → behavior identical to pre-V3 (gold broadcasts, silenced doesn't).
//                       No rows written to v3_decisions or open_trades.
//   2. mode='shadow' → broadcasts unchanged from off mode AND v3_decisions
//                       row written for every signal evaluation.
//   3. mode='live'   → only V3-passing signals broadcast; V3-rejected (FLIP shorts,
//                       cooldown) silently dropped; v3_decisions written for all.
//
// Cleans up its own rows at the end.

import Database from 'better-sqlite3';
import { config } from '../src/config.js';
import { db } from '../src/db.js';
import { state } from '../src/state.js';
import { tradeManager } from '../src/trade-manager.js';
import type { ConfluenceSignal } from '@trading/contracts';

function makeSig(args: {
  ts: number; ruleId: string; pattern?: string;
  direction: 'long'|'short'; score: number;
  entry: number; symbol?: string;
  delta5?: number; delta15?: number;
}): ConfluenceSignal {
  return {
    ts: args.ts, symbol: (args.symbol ?? 'NQ') as any,
    ruleId: args.ruleId, score: args.score,
    direction: args.direction, source: 'rules-v2', type: 'confluence',
    strategyVersion: args.ruleId === 'absorption' ? 'B'
                    : args.ruleId === 'clean-impulse' ? 'H'
                    : args.ruleId === 'expl' ? 'EXPL' : 'A',
    ruleVersion: `${args.ruleId}-v1`,
    rationale: 'smoke',
    ...(args.pattern && { pattern: args.pattern } as any),
    ...(args.delta5  !== undefined && { delta5:  args.delta5  } as any),
    ...(args.delta15 !== undefined && { delta15: args.delta15 } as any),
    ...{ entry: args.entry } as any,
  } as any;
}

function countDecisions(since: number): number {
  return (db.query(`SELECT COUNT(*) AS c FROM v3_decisions WHERE ts >= ?`, [since])[0] as { c: number }).c;
}
function clearTestRows(_since: number) {
  // Use a dedicated handle for DELETE (the db module's query helper uses .all()).
  const xdb = new Database(config.dbPath);
  try {
    xdb.prepare(`DELETE FROM v3_decisions WHERE ts >= ?`).run(T0 - 120_000);
    xdb.prepare(`DELETE FROM open_trades WHERE open_ts >= ?`).run(T0 - 120_000);
    xdb.prepare(`DELETE FROM signals WHERE ts >= ?`).run(T0 - 120_000);
  } finally { xdb.close(); }
}

let broadcasts: ConfluenceSignal[] = [];
state.onSignal(s => broadcasts.push(s));

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('  ❌ FAIL:', msg); process.exit(1); }
  console.log('  ✓', msg);
}

// Use a clearly-test ts range (year-2099 ms) so it can't collide with anything real.
const T0 = Date.parse('2099-05-29T13:30:00Z');

// The absorption-B quality gate requires a same-direction H FLIP within 60min.
// Insert one LONG and one SHORT fake FLIP at T0-60s so subsequent absos qualify.
function insertFakeFlip(ts: number, direction: 'long'|'short', entry: number) {
  db.logSignal({
    ts, symbol: 'NQ' as any, ruleId: 'clean-impulse', score: 95, direction,
    source: 'rules-v2' as any, type: 'confluence' as any,
    strategyVersion: 'H', ruleVersion: 'clean-impulse-v1',
    rationale: 'smoke fake flip',
    ...({ pattern: 'FLIP', entry } as any),
  } as any);
}
// Clean any leftover test rows from previous runs BEFORE we start.
{
  const xdb = new Database(config.dbPath);
  try {
    xdb.prepare(`DELETE FROM v3_decisions WHERE ts >= ?`).run(T0 - 120_000);
    xdb.prepare(`DELETE FROM open_trades WHERE open_ts >= ?`).run(T0 - 120_000);
    xdb.prepare(`DELETE FROM signals WHERE ts >= ?`).run(T0 - 120_000);
  } finally { xdb.close(); }
  // Also clear any TradeManager in-memory state from prior runs.
  (tradeManager as any).open?.clear?.();
}
// Only insert a LONG FLIP precursor — the absorption gate requires
// same-direction FLIP in window, so we keep all test absos as LONGs.
// (db.lastFlipInWindow doesn't filter by direction, so adding a SHORT FLIP
// here would race with the LONG one on equal-ts ordering.)
insertFakeFlip(T0 - 60_000, 'long',  30005);

console.log('\n=== [Mode: off] (default) ===');
(config.v3 as any).activeMode = 'off';
broadcasts = [];
const before1 = Date.now();
state.applySignal(makeSig({ ts: T0,        ruleId: 'absorption', direction: 'long', score: 85, entry: 30000 }));
state.applySignal(makeSig({ ts: T0 + 1000, ruleId: 'absorption', direction: 'long', score: 25, entry: 30001 })); // silenced (low score)
assert(broadcasts.length === 1, 'off mode: gold-tier broadcasts, silenced does not');
assert(countDecisions(before1) === 0, 'off mode: no v3_decisions written');
assert(tradeManager.getOpen('NQ') === null, 'off mode: no open trade');

console.log('\n=== [Mode: shadow] ===');
(config.v3 as any).activeMode = 'shadow';
broadcasts = [];
const before2 = Date.now();
// Absorption LONG (qualified, has LONG FLIP precursor) — broadcasts under legacy + V3 OPEN + decision logged.
state.applySignal(makeSig({ ts: T0 + 10000, ruleId: 'absorption', direction: 'long', score: 90, entry: 30010 }));
// Silenced absorption LONG (score below 80) — legacy doesn't broadcast; V3 logs SKIP_SILENCED.
// Use abso (not FLIP) so we don't pollute lastFlipInWindow for subsequent abso tests.
state.applySignal(makeSig({ ts: T0 + 11000, ruleId: 'absorption', direction: 'long', score: 25, entry: 30015 }));
console.log('  shadow broadcasts:', broadcasts.map(b => `${b.ruleId}/${b.direction}/${(b as any).entry}/score=${b.score}`));
assert(broadcasts.length === 1, 'shadow: legacy broadcasts still gold-tier only');
const sCount = countDecisions(before2);
assert(sCount >= 2, `shadow: V3 decisions written (got ${sCount})`);

// In shadow mode, V3 should have opened a trade in-sync with the broadcast.
const ot = tradeManager.getOpen('NQ');
assert(ot !== null && ot.direction === 'long' && ot.entry === 30010, 'shadow: TradeManager tracking the abso long');

console.log('\n=== [Mode: live] ===');
(config.v3 as any).activeMode = 'live';
broadcasts = [];

// At entry to live mode, TradeManager still holds the abso LONG from shadow.
// Send a same-direction qualified abso LONG → SKIP_COOLDOWN (no broadcast).
state.applySignal(makeSig({ ts: T0 + 20000, ruleId: 'absorption', direction: 'long', score: 90, entry: 30020 }));

// Close the open LONG by forcing TP hit on the in-memory trade.
tradeManager.closeTrade('NQ', 30090, T0 + 20500, 'TP_HIT', null);

// Diagnostic: state of TradeManager before signal 2 + FLIP lookup
console.log('  open after manual close:', tradeManager.getOpen('NQ'));
console.log('  lastFlipInWindow for abso@T0+21000:', db.lastFlipInWindow('NQ', T0 + 21000 - 60*60_000, T0 + 21000));

// Now send a fresh qualified abso LONG → should OPEN (V3 broadcast).
// IMPORTANT: this must come BEFORE the FLIP-short test, otherwise the SHORT FLIP
// inserted by that test would poison db.lastFlipInWindow for this abso LONG.
state.applySignal(makeSig({ ts: T0 + 21000, ruleId: 'absorption', direction: 'long', score: 90, entry: 30100 }));
console.log('  broadcasts after signal 2:', broadcasts.length, 'open:', tradeManager.getOpen('NQ'));

// Qualified FLIP short (delta5=+1500 satisfies the gate) → V3 drops it.
state.applySignal(makeSig({ ts: T0 + 22000, ruleId: 'clean-impulse', pattern: 'FLIP', direction: 'short', score: 95, entry: 30105, delta5: 1500 }));

console.log('  live broadcasts:', broadcasts.map(b => `${b.ruleId}/${b.direction}/${(b as any).entry}`));
assert(broadcasts.length === 1, 'live: 1 broadcast (the re-opened abso LONG); cooldown skip and FLIP-short did NOT broadcast');
assert(broadcasts[0]!.direction === 'long' && (broadcasts[0] as any).entry === 30100, 'live: broadcasted signal is the abso LONG that re-opened');

// Decisions: SKIP_COOLDOWN, CLOSE, OPEN, SKIP_FLIP_SHORT
const recent = db.query<{ action: string; reason: string }>(
  `SELECT action, reason FROM v3_decisions WHERE ts >= ? ORDER BY id`, [T0 + 20000 - 1]
);
console.log('  live decisions:', recent.map(r => r.action));
assert(recent.some(r => r.action === 'SKIP_COOLDOWN'),   'live: SKIP_COOLDOWN logged');
assert(recent.some(r => r.action === 'CLOSE'),           'live: CLOSE logged (TP hit)');
assert(recent.some(r => r.action === 'OPEN'),            'live: OPEN logged');
assert(recent.some(r => r.action === 'SKIP_FLIP_SHORT'), 'live: SKIP_FLIP_SHORT logged');

// Cleanup
clearTestRows(0);
(config.v3 as any).activeMode = 'off';
console.log('\nALL state.applySignal V3 SMOKE TESTS PASSED');
