// Backfill tradable_signals from the new signal-pipeline against ALL historical
// signals. Replays evaluateTechnical + evaluateActionability over every row in
// `signals`, reconstructing the per-symbol open-trade state from v3_decisions.
//
// Idempotent — upserts on signal_id. Re-runnable.
//
// Run: pnpm --filter @trading/aggregator exec tsx scripts/backfill_tradable_signals.ts

import { db } from '../src/db.js';
import { evaluateTechnical, evaluateActionability } from '../src/signal-pipeline.js';
import type { ConfluenceSignal } from '@trading/contracts';

interface SignalRow {
  id: number; ts: number; symbol: string; rule_id: string;
  strategy_version: string; direction: string; score: number;
  payload: string;
}

interface V3DecisionRow {
  ts: number; symbol: string; signal_id: number | null;
  action: string; cvd_session: number | null; rule_id: string;
}

console.log('Backfilling tradable_signals from signals table...\n');

const allSignals = db.query<SignalRow>(`
  SELECT id, ts, symbol, rule_id, strategy_version, direction, score, payload
  FROM signals
  ORDER BY ts ASC
`);
console.log(`  Loaded ${allSignals.length} historical signals`);

// V3 decisions chronologically so we can replay open-trade state. For pre-V3
// signals (before 2026-06-01) there are no OPENs, so the open map stays empty
// and the SKIP_COOLDOWN gate never fires — same as live behavior at the time.
const allV3 = db.query<V3DecisionRow>(`
  SELECT ts, symbol, signal_id, action, cvd_session, rule_id
  FROM v3_decisions
  WHERE action IN ('OPEN','CLOSE')
  ORDER BY ts ASC, action DESC
  -- action DESC puts OPEN before CLOSE at the same ts. Critical for
  -- replay correctness: a trade that opens and closes in the same
  -- millisecond (WBF fires this often) must net to empty state.
  -- CLOSE-first on an empty set is a no-op, then OPEN adds — false cooldown.
`);

// Index CLOSE rows by the signal_id that caused them — used to apply
// OPP_SIG_EXIT closures BEFORE the cooldown check when replaying that signal.
// V3 logs both events at the same ts; live ordering was CLOSE → cooldown
// check → OPEN, but a strict ts-< replay misses this and incorrectly flags
// the new OPEN as cooldown-skipped against the just-closed trade.
const closeBySignalId = new Map<number, V3DecisionRow>();
for (const v of allV3) {
  if (v.action === 'CLOSE' && v.signal_id != null) {
    closeBySignalId.set(v.signal_id, v);
  }
}
console.log(`  Loaded ${allV3.length} V3 OPEN/CLOSE decisions for state replay`);

// Index v3 decisions by signal_id so we can pull cvd_session for each signal.
// (cvd_session is needed by evaluateActionability and was V3's runtime value.)
const cvdBySignalId = new Map<number, number>();
for (const v of allV3) {
  if (v.signal_id != null && v.cvd_session != null) {
    cvdBySignalId.set(v.signal_id, v.cvd_session);
  }
}

// Walking pointer over v3 decisions, used to advance open-trade state up to
// each signal's ts.
let v3Cursor = 0;
const openSymbols = new Set<string>();

function advanceOpenStateUpTo(sigTs: number): void {
  while (v3Cursor < allV3.length && allV3[v3Cursor]!.ts <= sigTs) {
    const ev = allV3[v3Cursor]!;
    if (ev.action === 'OPEN')  openSymbols.add(ev.symbol);
    if (ev.action === 'CLOSE') openSymbols.delete(ev.symbol);
    v3Cursor++;
  }
}

const now = Date.now();
let written = 0;
let parseErrors = 0;
const actionCounts: Record<string, number> = {};

for (const row of allSignals) {
  let signal: ConfluenceSignal;
  try {
    signal = JSON.parse(row.payload) as ConfluenceSignal;
    // Reapply DB-row authoritative fields in case payload drifts.
    signal.ts        = row.ts;
    signal.symbol    = row.symbol as ConfluenceSignal['symbol'];
    signal.ruleId    = row.rule_id;
    signal.direction = row.direction as ConfluenceSignal['direction'];
    signal.score     = row.score;
    signal.strategyVersion = row.strategy_version as ConfluenceSignal['strategyVersion'];
  } catch {
    parseErrors++;
    continue;
  }

  // Advance open-trade state up to (and including) this signal's ts so the
  // hasOpenTrade flag matches what V3 saw at fire time.
  // NOTE: this signal's own OPEN (if any) was emitted AT signal.ts — at that
  // exact moment the cooldown check ran BEFORE the OPEN was logged. So we
  // advance to <sigTs (strict) to mirror the live ordering.
  while (v3Cursor < allV3.length && allV3[v3Cursor]!.ts < row.ts) {
    const ev = allV3[v3Cursor]!;
    if (ev.action === 'OPEN')  openSymbols.add(ev.symbol);
    if (ev.action === 'CLOSE') openSymbols.delete(ev.symbol);
    v3Cursor++;
  }
  // Same-ts OPP_SIG_EXIT: if THIS signal caused a CLOSE at the same ts,
  // apply that close NOW so the cooldown check sees the cleared state.
  // This mirrors live ordering — V3 closes the prior trade then evaluates
  // the new signal's entry gates, all within the same applySignalV3 call.
  const myClose = closeBySignalId.get(row.id);
  if (myClose && myClose.ts === row.ts) {
    openSymbols.delete(row.symbol);
  }

  const tech = evaluateTechnical(signal);
  const act  = evaluateActionability(signal, tech.qualified, tech.reason, {
    cvdSession:    cvdBySignalId.get(row.id) ?? 0,
    hasOpenTrade:  openSymbols.has(row.symbol),
  });

  db.tradable.upsert({
    signal_id:    row.id,
    signal_ts:    row.ts,
    symbol:       row.symbol,
    rule_id:      row.rule_id,
    pattern:      (signal as { pattern?: string }).pattern ?? null,
    direction:    row.direction as 'long' | 'short',
    score:        row.score,
    qualified:    tech.qualified,
    action:       act.action,
    reason:       act.reason,
    shadow:       act.action === 'SKIP_FORCE_SHADOW',
    cvd_session:  cvdBySignalId.get(row.id),
    entry:        (signal as { entry?: number }).entry,
    evaluated_at: now,
  });

  written++;
  actionCounts[act.action] = (actionCounts[act.action] ?? 0) + 1;

  if (written % 5000 === 0) {
    console.log(`    ...${written} / ${allSignals.length}`);
  }
}

// Wrap up — re-advance pointer in case any trailing CLOSEs remained.
void advanceOpenStateUpTo;   // satisfy lint; function kept for clarity in code

console.log(`\n  ── Backfill done ──`);
console.log(`  Signals written : ${written}`);
console.log(`  Parse errors    : ${parseErrors}`);
console.log(`\n  Action breakdown:`);
for (const [act, c] of Object.entries(actionCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${act.padEnd(22)} ${c.toString().padStart(7)}`);
}
console.log(`\n  Total tradable_signals rows: ${
  (db.query<{ c: number }>('SELECT COUNT(*) AS c FROM tradable_signals')[0]?.c ?? 0)
}`);
