// Diff report — new signal-pipeline vs the live V3 cascade (snapshotted to
// v3_decisions_pre_refactor before the refactor began).
//
// For every signal V3 evaluated, compare the actions. For DIVERGENCES on OPEN
// (either "lost OPEN" = V3 opened but pipeline skips, or "gained OPEN" =
// pipeline opens but V3 skipped), pair with the corresponding V3 CLOSE row to
// determine if that trade was a winner / loser / neutral.
//
// Acceptance criterion (from user, 2026-06-08):
//   - zero UNEXPECTED lost winners (a V3-OPENed winner in a still-tradable
//     rule must NOT be skipped by pipeline; intentional rule removals are OK)
//   - net WR change ≥ 0  (computed over the still-tradable rule set)
//   - net PnL change ≥ 0 (computed over the still-tradable rule set)
//
// INTENTIONAL_REMOVALS = rules deliberately dropped from the new pipeline:
//   - wall-broken-fade: removed 2026-06-08 per user direction (worst perf).
//   - expl: silenced + force-shadow due to losing LONG (30% WR) + SHORT (4% WR).
//   - es-flip: force-shadow pending OOS validation.
// V3 OPENs in these rules ARE counted as divergences but DON'T fail acceptance.
//
// Run: pnpm --filter @trading/aggregator exec tsx scripts/diff_pipeline_vs_v3.ts

import { db } from '../src/db.js';

// Rules the new pipeline deliberately does not trade. Divergences on these
// are EXPECTED and don't count against the acceptance check.
const INTENTIONAL_REMOVALS = new Set([
  'wall-broken-fade',  // dropped from pipeline 2026-06-08
  'expl',              // silenced + force-shadow (losing both sides)
  'es-flip',           // force-shadow pending OOS validation
]);

interface V3Row {
  ts: number; symbol: string; signal_id: number | null;
  rule_id: string; direction: string; action: string;
  reason: string; cvd_session: number | null;
}
interface PipelineRow {
  signal_id: number; symbol: string; rule_id: string;
  direction: string; action: string; reason: string;
}

// ── Load both sides ─────────────────────────────────────────────────────────

const v3All = db.query<V3Row>(`
  SELECT ts, symbol, signal_id, rule_id, direction, action, reason, cvd_session
  FROM v3_decisions_pre_refactor
  ORDER BY ts ASC, action DESC
  -- action DESC puts OPEN before CLOSE at the same ts so same-tick OPEN/CLOSE
  -- pairs net correctly (see backfill_tradable_signals.ts for full reasoning).
`);

const v3BySignalId = new Map<number, V3Row>();
for (const r of v3All) {
  // entry-decision rows have a non-null signal_id; CLOSE rows may have null
  if (r.signal_id != null && r.action !== 'CLOSE') v3BySignalId.set(r.signal_id, r);
}

const pipelineRows = db.query<PipelineRow>(`
  SELECT signal_id, symbol, rule_id, direction, action, reason
  FROM tradable_signals
`);
const pipelineBySignalId = new Map<number, PipelineRow>();
for (const r of pipelineRows) pipelineBySignalId.set(r.signal_id, r);

console.log(`  V3 entry decisions (pre-refactor): ${v3BySignalId.size}`);
console.log(`  Pipeline decisions               : ${pipelineBySignalId.size}`);

// ── Pair V3 OPENs with their next CLOSE (chronological per symbol) ─────────

interface OpenWithOutcome {
  signal_id: number; symbol: string; rule_id: string; direction: string;
  open_ts: number; close_ts: number | null; pnl_pts: number | null;
  outcome: 'WIN' | 'LOSS' | 'NEUTRAL' | 'OPEN';
}
const v3OpenOutcomes = new Map<number, OpenWithOutcome>();

// Walk all v3 rows chronologically, track per-symbol pending OPEN.
// IMPORTANT: when an OPEN fires while a previous OPEN on the same symbol
// hasn't closed yet, treat the new one as a PHANTOM (V3's cooldown gate
// should have blocked it, but V3 logged it anyway). Phantom OPENs are NOT
// real trades — they pair with no CLOSE and would be incorrectly counted as
// "lost winners" by a naive next-CLOSE pairing. We skip them here so the
// acceptance check reflects only genuine trades V3 actually had on.
const pendingOpen = new Map<string, V3Row>();   // symbol → OPEN row
let phantomOpens = 0;
for (const r of v3All) {
  if (r.action === 'OPEN' && r.signal_id != null) {
    if (pendingOpen.has(r.symbol)) {
      // Phantom: previous OPEN still pending. Skip — not a real trade.
      phantomOpens++;
      continue;
    }
    pendingOpen.set(r.symbol, r);
  } else if (r.action === 'CLOSE') {
    const open = pendingOpen.get(r.symbol);
    if (open && open.signal_id != null) {
      // parse pnl from CLOSE reason: "TP_HIT px=X pnl=Y", "SL_HIT ...", "OPP_SIG_EXIT ..."
      const m = r.reason.match(/pnl=(-?\d+(\.\d+)?)/);
      const pnl = m ? parseFloat(m[1]!) : null;
      const outcome = pnl == null ? 'NEUTRAL'
                    : pnl > 0  ? 'WIN'
                    : pnl < 0  ? 'LOSS'
                                : 'NEUTRAL';
      v3OpenOutcomes.set(open.signal_id, {
        signal_id: open.signal_id, symbol: open.symbol,
        rule_id: open.rule_id, direction: open.direction,
        open_ts: open.ts, close_ts: r.ts, pnl_pts: pnl, outcome,
      });
      pendingOpen.delete(r.symbol);
    }
  }
}
// Any leftover OPENs are still open at end of data
for (const [_, open] of pendingOpen) {
  if (open.signal_id != null) {
    v3OpenOutcomes.set(open.signal_id, {
      signal_id: open.signal_id, symbol: open.symbol,
      rule_id: open.rule_id, direction: open.direction,
      open_ts: open.ts, close_ts: null, pnl_pts: null, outcome: 'OPEN',
    });
  }
}

console.log(`  V3 OPEN rows with outcomes paired: ${v3OpenOutcomes.size}`);
console.log(`  V3 phantom OPENs filtered out    : ${phantomOpens}`);

// ── Action-by-action comparison ─────────────────────────────────────────────

let nMatch = 0;
const lostOpens: OpenWithOutcome[]  = [];        // V3 OPEN but pipeline says SKIP
const gainedOpens: { signal_id: number; symbol: string; rule_id: string; direction: string }[] = [];
const skipReasonDifferent: { signal_id: number; v3: string; pipeline: string }[] = [];

for (const [sigId, v3] of v3BySignalId) {
  const pipe = pipelineBySignalId.get(sigId);
  if (!pipe) continue;   // not yet backfilled (shouldn't happen post-backfill)

  if (v3.action === pipe.action) {
    nMatch++;
    continue;
  }

  if (v3.action === 'OPEN' && pipe.action !== 'OPEN') {
    const outcome = v3OpenOutcomes.get(sigId);
    if (outcome) lostOpens.push(outcome);
  } else if (pipe.action === 'OPEN' && v3.action !== 'OPEN') {
    gainedOpens.push({
      signal_id: sigId, symbol: v3.symbol, rule_id: v3.rule_id, direction: v3.direction,
    });
  } else {
    // Both are SKIP but different reasons — informational only
    skipReasonDifferent.push({ signal_id: sigId, v3: v3.action, pipeline: pipe.action });
  }
}

// ── Split lost OPENs into intentional vs unexpected ─────────────────────────
// Intentional = rule_id ∈ INTENTIONAL_REMOVALS (we deliberately stopped trading
// these). Unexpected = anything else — these are the ones that fail acceptance.

const lostIntentional = lostOpens.filter(o => INTENTIONAL_REMOVALS.has(o.rule_id));
const lostUnexpected  = lostOpens.filter(o => !INTENTIONAL_REMOVALS.has(o.rule_id));

const tallyOutcomes = (rows: OpenWithOutcome[]) => {
  const t = { WIN: 0, LOSS: 0, NEUTRAL: 0, OPEN: 0 };
  let pnl = 0;
  for (const o of rows) { t[o.outcome]++; if (o.pnl_pts != null) pnl += o.pnl_pts; }
  return { t, pnl };
};
const intent = tallyOutcomes(lostIntentional);
const unexp  = tallyOutcomes(lostUnexpected);

// ── Baseline V3 stats — RESTRICTED to rules still in the new pipeline ────────
// Comparing all V3 trades vs all pipeline trades would conflate scope reduction
// with strategy change. We want "of the trades still in scope, does the new
// pipeline match or beat V3?"

const tradableV3Outcomes = [...v3OpenOutcomes.values()].filter(o => !INTENTIONAL_REMOVALS.has(o.rule_id));
const v3Tally = tallyOutcomes(tradableV3Outcomes);
const v3Outcomes = v3Tally.t;
const v3Pnl = v3Tally.pnl;
const v3Wr = (v3Outcomes.WIN + v3Outcomes.LOSS) > 0
  ? v3Outcomes.WIN / (v3Outcomes.WIN + v3Outcomes.LOSS) * 100
  : 0;
const newW = v3Outcomes.WIN  - unexp.t.WIN;
const newL = v3Outcomes.LOSS - unexp.t.LOSS;
const newWr = (newW + newL) > 0 ? newW / (newW + newL) * 100 : 0;
const newPnl = v3Pnl - unexp.pnl;

// ── Report ──────────────────────────────────────────────────────────────────

console.log(`\n────────────────────────────────────────────────────────────────`);
console.log(`  DIFF REPORT — new pipeline vs V3 cascade (pre-refactor)`);
console.log(`────────────────────────────────────────────────────────────────\n`);

console.log(`  Decisions compared : ${v3BySignalId.size}`);
console.log(`  Actions match      : ${nMatch}`);
console.log(`  Different action   : ${v3BySignalId.size - nMatch}\n`);

console.log(`  LOST OPENs (V3 OPENed, pipeline would SKIP): ${lostOpens.length} total`);
console.log(`    ── INTENTIONAL removals (${[...INTENTIONAL_REMOVALS].join(', ')}) ──`);
console.log(`       count: ${lostIntentional.length}  W:${intent.t.WIN} L:${intent.t.LOSS} N:${intent.t.NEUTRAL}  ` +
            `PnL: ${intent.pnl >= 0 ? '+' : ''}${intent.pnl.toFixed(1)} pts`);
console.log(`       (these are expected — the new pipeline deliberately stopped trading these rules)`);
console.log(`    ── UNEXPECTED (rules still in pipeline scope) ──`);
console.log(`       count: ${lostUnexpected.length}  W:${unexp.t.WIN} L:${unexp.t.LOSS} N:${unexp.t.NEUTRAL}  ` +
            `PnL: ${unexp.pnl >= 0 ? '+' : ''}${unexp.pnl.toFixed(1)} pts`);
console.log(`       (these are the ones that fail acceptance — must be 0 winners)\n`);

console.log(`  GAINED OPENs (pipeline would OPEN, V3 did not): ${gainedOpens.length}`);
if (gainedOpens.length > 0 && gainedOpens.length <= 10) {
  for (const g of gainedOpens) {
    console.log(`     id=${g.signal_id} ${g.symbol} ${g.rule_id} ${g.direction}`);
  }
}
console.log(`  Note: gained OPENs have no historical outcome (V3 didn't open the trade).\n`);

console.log(`  SKIP REASON DIFFERENT (informational): ${skipReasonDifferent.length}\n`);

console.log(`────────────────────────────────────────────────────────────────`);
console.log(`  PERFORMANCE COMPARISON (restricted to rules still in pipeline)`);
console.log(`────────────────────────────────────────────────────────────────`);
console.log(`  Excludes intentional removals: ${[...INTENTIONAL_REMOVALS].join(', ')}`);
console.log(`  V3 baseline  : ${v3Outcomes.WIN}W ${v3Outcomes.LOSS}L  WR=${v3Wr.toFixed(1)}%  PnL=${v3Pnl >= 0 ? '+' : ''}${v3Pnl.toFixed(1)} pts`);
console.log(`  Pipeline new : ${newW}W ${newL}L  WR=${newWr.toFixed(1)}%  PnL=${newPnl >= 0 ? '+' : ''}${newPnl.toFixed(1)} pts`);
console.log(`  Δ            : WR ${(newWr - v3Wr) >= 0 ? '+' : ''}${(newWr - v3Wr).toFixed(2)}pp   PnL ${(newPnl - v3Pnl) >= 0 ? '+' : ''}${(newPnl - v3Pnl).toFixed(1)} pts\n`);

// ── Acceptance check (over rules still in scope) ────────────────────────────

console.log(`────────────────────────────────────────────────────────────────`);
console.log(`  ACCEPTANCE (rules still in pipeline scope)`);
console.log(`────────────────────────────────────────────────────────────────`);
const okLostWinners = unexp.t.WIN === 0;
const okWr          = newWr >= v3Wr - 1e-6;
const okPnl         = newPnl >= v3Pnl - 1e-6;
const passed        = okLostWinners && okWr && okPnl;
console.log(`  zero UNEXPECTED lost winners: ${okLostWinners ? 'PASS' : `FAIL (${unexp.t.WIN} winners would be skipped)`}`);
console.log(`  net WR  ≥ baseline          : ${okWr  ? 'PASS' : `FAIL (${(newWr - v3Wr).toFixed(2)}pp drop)`}`);
console.log(`  net PnL ≥ baseline          : ${okPnl ? 'PASS' : `FAIL (${(newPnl - v3Pnl).toFixed(1)} pt drop)`}`);
console.log(`\n  ${passed ? 'OVERALL: PASS — cleared for cutover' : 'OVERALL: FAIL — do NOT cut over'}\n`);

// ── Detail: list UNEXPECTED lost winners if any (the ones that matter) ───────

if (unexp.t.WIN > 0) {
  console.log(`────────────────────────────────────────────────────────────────`);
  console.log(`  UNEXPECTED LOST WINNERS — investigate these:`);
  console.log(`────────────────────────────────────────────────────────────────`);
  const winners = lostUnexpected.filter(o => o.outcome === 'WIN');
  for (const w of winners) {
    const pipeRow = pipelineBySignalId.get(w.signal_id);
    console.log(`  id=${w.signal_id}  ${new Date(w.open_ts).toISOString().slice(0,19)}  ` +
                `${w.symbol} ${w.rule_id} ${w.direction}  pnl=+${w.pnl_pts!.toFixed(0)}pts  ` +
                `→ pipeline would: ${pipeRow?.action} (${pipeRow?.reason})`);
  }
}

process.exit(passed ? 0 : 1);
