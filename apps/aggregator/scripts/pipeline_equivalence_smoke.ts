// Smoke test — PR #1 of the signal pipeline refactor.
//
// Asserts byte-equivalence between the new signal-pipeline.ts module and the
// pre-refactor live path (quality.ts:classifySignalQuality + the V3 cascade
// in state.ts:applySignalV3). Must report ZERO mismatches before PR #2 (live
// writes) goes in.
//
// Run:  pnpm --filter @trading/aggregator exec tsx scripts/pipeline_equivalence_smoke.ts

import { db } from '../src/db.js';
import { classifySignalQuality } from '../src/quality.js';
import {
  evaluateTechnical,
  evaluateActionability,
  type ActionabilityAction,
  type ActionabilityContext,
} from '../src/signal-pipeline.js';
import { config } from '../src/config.js';
import type { ConfluenceSignal } from '@trading/contracts';

// ── Test 1: evaluateTechnical ≡ classifySignalQuality ──────────────────────
//
// We do NOT pass a QualityContext — pre-refactor the live path computes ctx
// (recentExpls, lastFlip, regime fields) per-signal at fire time, but in this
// PR we only assert the wrapper itself is transparent. Identical {} context →
// identical decisions on both sides.

const recent = db.recentSignals(2000);
console.log(`\n=== Test 1: evaluateTechnical equivalence over ${recent.length} signals ===`);

let techMismatch = 0;
const techMismatches: string[] = [];
for (const sig of recent) {
  const old = classifySignalQuality(sig);
  const fresh = evaluateTechnical(sig);
  const oldQualified = old.tier === 'gold';
  if (oldQualified !== fresh.qualified || old.reason !== fresh.reason) {
    techMismatch++;
    if (techMismatches.length < 5) {
      techMismatches.push(
        `  ts=${sig.ts} rule=${sig.ruleId} dir=${sig.direction} ` +
        `OLD={tier:${old.tier}, reason:"${old.reason}"} ` +
        `NEW={qualified:${fresh.qualified}, reason:"${fresh.reason}"}`
      );
    }
  }
}
console.log(`  result: ${techMismatch} / ${recent.length} mismatches`);
if (techMismatches.length > 0) {
  console.log(`  first ${techMismatches.length}:`);
  for (const m of techMismatches) console.log(m);
}

// ── Test 2: evaluateActionability cascade order — synthetic ────────────────
//
// Replays each gate-skip path from state.ts:applySignalV3 with crafted inputs
// and asserts the wrapper returns the exact action + reason the original code
// would have. This is gate-by-gate; doesn't require trade-manager state.

interface Case {
  name: string;
  signal: Partial<ConfluenceSignal> & { pattern?: string };
  isQualified: boolean;
  qualifiedReason: string;
  ctx: ActionabilityContext;
  expect: { action: ActionabilityAction; reason: string };
}

const longFloor  = config.pipeline.cvdLongFloor;
const shortFloor = config.pipeline.cvdShortFloor;

const cases: Case[] = [
  {
    name: 'SKIP_NOT_V3_RULE — absorption (not in V3 entry rule set)',
    signal: { ruleId: 'absorption', direction: 'long', ts: 1, symbol: 'NQ', score: 80 },
    isQualified: true, qualifiedReason: 'whatever',
    ctx: { cvdSession: 0, hasOpenTrade: false },
    expect: { action: 'SKIP_NOT_V3_RULE', reason: 'not a V3 entry rule (absorption)' },
  },
  {
    name: 'SKIP_SILENCED — V3 rule but quality gate said silenced',
    signal: { ruleId: 'clean-impulse', pattern: 'FLIP', direction: 'long', ts: 1, symbol: 'NQ', score: 80 },
    isQualified: false, qualifiedReason: 'H: FLIP long buyers-dominant',
    ctx: { cvdSession: 0, hasOpenTrade: false },
    expect: { action: 'SKIP_SILENCED', reason: 'silenced: H: FLIP long buyers-dominant' },
  },
  {
    name: 'SKIP_FORCE_SHADOW — es-flip is in forceShadowRules',
    signal: { ruleId: 'es-flip', direction: 'long', ts: 1, symbol: 'ES', score: 80 },
    isQualified: true, qualifiedReason: 'ES-FLIP shadow',
    ctx: { cvdSession: 0, hasOpenTrade: false },
    expect: {
      action: 'SKIP_FORCE_SHADOW',
      reason: 'force-shadow rule (es-flip) — observed but not traded',
    },
  },
  {
    name: 'SKIP_CVD long — cvdSession below longFloor',
    signal: { ruleId: 'clean-impulse', pattern: 'FLIP', direction: 'long', ts: 1, symbol: 'NQ', score: 80 },
    isQualified: true, qualifiedReason: 'H: clean-impulse FLIP score=80',
    ctx: { cvdSession: longFloor - 1, hasOpenTrade: false },
    expect: {
      action: 'SKIP_CVD',
      reason: `cvdSession=${longFloor - 1} <= longFloor=${longFloor}`,
    },
  },
  {
    name: 'SKIP_CVD short — cvdSession above shortFloor',
    signal: { ruleId: 'clean-impulse', pattern: 'FLIP', direction: 'short', ts: 1, symbol: 'NQ', score: 80 },
    isQualified: true, qualifiedReason: 'H: clean-impulse FLIP score=80',
    ctx: { cvdSession: shortFloor + 1, hasOpenTrade: false },
    expect: {
      action: 'SKIP_CVD',
      reason: `cvdSession=${shortFloor + 1} >= shortFloor=${shortFloor}`,
    },
  },
  {
    name: 'SKIP_COOLDOWN — existing open trade for symbol',
    signal: { ruleId: 'clean-impulse', pattern: 'FLIP', direction: 'long', ts: 1, symbol: 'NQ', score: 80 },
    isQualified: true, qualifiedReason: 'H: clean-impulse FLIP score=80',
    ctx: { cvdSession: 0, hasOpenTrade: true },
    expect: { action: 'SKIP_COOLDOWN', reason: 'V3 cooldown: a trade is already open' },
  },
  {
    name: 'OPEN — all gates pass, FLIP long',
    signal: { ruleId: 'clean-impulse', pattern: 'FLIP', direction: 'long', ts: 1, symbol: 'NQ', score: 95 },
    isQualified: true, qualifiedReason: 'H: clean-impulse FLIP score=95',
    ctx: { cvdSession: 0, hasOpenTrade: false },
    expect: { action: 'OPEN', reason: 'H: clean-impulse FLIP score=95' },
  },
  {
    name: 'OPEN — all gates pass, FLIP short',
    signal: { ruleId: 'clean-impulse', pattern: 'FLIP', direction: 'short', ts: 1, symbol: 'NQ', score: 90 },
    isQualified: true, qualifiedReason: 'H: clean-impulse FLIP score=90',
    ctx: { cvdSession: 0, hasOpenTrade: false },
    expect: { action: 'OPEN', reason: 'H: clean-impulse FLIP score=90' },
  },
  {
    name: 'SKIP_NOT_V3_RULE — wall-broken-fade (removed 2026-06-08)',
    signal: { ruleId: 'wall-broken-fade', direction: 'long', ts: 1, symbol: 'NQ', score: 80 },
    isQualified: true, qualifiedReason: 'WBF visual-monitor mode: score=80',
    ctx: { cvdSession: 0, hasOpenTrade: false },
    expect: { action: 'SKIP_NOT_V3_RULE', reason: 'not a V3 entry rule (wall-broken-fade)' },
  },
  {
    name: 'OPEN — cont-reentry passes (cont is not in current forceShadowRules)',
    signal: { ruleId: 'cont-reentry', direction: 'long', ts: 1, symbol: 'NQ', score: 90 },
    isQualified: true, qualifiedReason: 'CONT shadow',
    ctx: { cvdSession: 0, hasOpenTrade: false },
    // NOTE: cont-reentry was REMOVED from forceShadowRules on 2026-06-07 per
    // HANDOFF §20. If you re-add it, flip this expected action to SKIP_FORCE_SHADOW.
    expect: { action: 'OPEN', reason: 'CONT shadow' },
  },
];

console.log(`\n=== Test 2: evaluateActionability cascade — ${cases.length} synthetic cases ===`);
let actMismatch = 0;
for (const c of cases) {
  const got = evaluateActionability(
    c.signal as ConfluenceSignal,
    c.isQualified,
    c.qualifiedReason,
    c.ctx,
  );
  const ok = got.action === c.expect.action && got.reason === c.expect.reason;
  console.log(`  [${ok ? 'OK' : 'FAIL'}] ${c.name}`);
  if (!ok) {
    actMismatch++;
    console.log(`     expected: action=${c.expect.action} reason="${c.expect.reason}"`);
    console.log(`     got:      action=${got.action} reason="${got.reason}"`);
  }
}
console.log(`  result: ${actMismatch} / ${cases.length} failures`);

// ── Test 3: dropFlipShorts toggle awareness ────────────────────────────────
//
// Currently dropFlipShorts=false in config. Verify the wrapper honours it
// (OPEN), and that flipping it hypothetically would yield SKIP_FLIP_SHORT.
// We don't actually flip the config (no mutation of singleton config object);
// we just sanity-check current behavior.

console.log(`\n=== Test 3: dropFlipShorts honored (current = ${config.pipeline.dropFlipShorts}) ===`);
const flipShort = evaluateActionability(
  { ruleId: 'clean-impulse', pattern: 'FLIP', direction: 'short', ts: 1, symbol: 'NQ', score: 90 } as unknown as ConfluenceSignal,
  true, 'H: clean-impulse FLIP score=90',
  { cvdSession: 0, hasOpenTrade: false },
);
const expectedAction: ActionabilityAction = config.pipeline.dropFlipShorts ? 'SKIP_FLIP_SHORT' : 'OPEN';
const ok3 = flipShort.action === expectedAction;
console.log(`  [${ok3 ? 'OK' : 'FAIL'}] expected ${expectedAction}, got ${flipShort.action}`);

// ── Summary ────────────────────────────────────────────────────────────────

const totalFail = techMismatch + actMismatch + (ok3 ? 0 : 1);
console.log(`\n══════════════════════════════════════════════════`);
console.log(`Total failures: ${totalFail}`);
console.log(`══════════════════════════════════════════════════\n`);
process.exit(totalFail === 0 ? 0 : 1);
