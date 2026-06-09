// ─────────────────────────────────────────────────────────────────────────────
// Signal Pipeline — three-stage refactor in progress.
//
// Target model:
//   raw signal → evaluateTechnical → qualified_signals
//              → evaluateActionability → tradable_signals → trader
//
// This module is PR #1 of the refactor. It introduces the two evaluator
// functions as THIN WRAPPERS around existing logic. Behaviour is byte-identical
// to the pre-refactor live path (state.ts:applySignal + state.ts:applySignalV3).
//
// Phase 1 (this PR): module exists; no callers; tests pin equivalence.
// Phase 2:           state.ts swaps to call these wrappers + live-writes to
//                    qualified_signals and tradable_signals.
// Phase 3+:          remove rs_hard_filtered, fold offline pre-gates in,
//                    rename V3 → tradable everywhere, drop dropFlipShorts, etc.
//
// The wrappers DELIBERATELY duplicate logic from quality.ts (technical) and
// state.ts:applySignalV3 (actionability). Once Phase 2 lands, state.ts deletes
// its own copy and calls these as the single source of truth. Until then,
// both implementations must stay byte-equivalent — the smoke test in
// scripts/pipeline_equivalence_smoke.ts enforces that.
// ─────────────────────────────────────────────────────────────────────────────

import type { ConfluenceSignal } from '@trading/contracts';
import { config } from './config.js';
import { classifySignalQuality } from './quality.js';
import type { QualityContext } from './quality.js';

// ── Stage 2: technical evaluation (= qualified_signals membership) ──────────

export interface EvaluateTechnicalResult {
  qualified: boolean;   // true → signal lands in qualified_signals
  reason: string;       // human-readable; matches classifySignalQuality.reason exactly
}

/**
 * Evaluate the technical-quality stage. Returns whether the signal qualifies
 * (= gold tier) under the current rule logic.
 *
 * This wraps classifySignalQuality() in quality.ts. Behaviour is identical —
 * the wrapper exists so state.ts can call a single stage-named function rather
 * than peeking inside quality.ts.
 */
export function evaluateTechnical(
  signal: ConfluenceSignal,
  ctx: QualityContext = {},
): EvaluateTechnicalResult {
  const decision = classifySignalQuality(signal, ctx);
  return { qualified: decision.tier === 'gold', reason: decision.reason };
}

// ── Stage 3: actionability evaluation (= tradable_signals membership) ──────

/**
 * Action labels match the existing V3Decision['action'] enum for byte-identical
 * equivalence in PR #1. In Phase 4 these will be normalised to a smaller set
 * (OPEN / SKIP / SHADOW) once V3 naming is retired.
 */
export type ActionabilityAction =
  | 'OPEN'
  | 'SKIP_NOT_V3_RULE'
  | 'SKIP_SILENCED'
  | 'SKIP_FORCE_SHADOW'
  | 'SKIP_FLIP_SHORT'
  | 'SKIP_CVD'
  | 'SKIP_COOLDOWN';

export interface EvaluateActionabilityResult {
  action: ActionabilityAction;
  reason: string;
}

export interface ActionabilityContext {
  /** Current session CVD for this symbol (from cvdSession.get(symbol)). */
  cvdSession: number;
  /** True if symbol already has an open V3 trade (tradeManager.getOpen(symbol) != null). */
  hasOpenTrade: boolean;
}

/**
 * Is this signal a V3 entry-rule candidate? Mirrors state.ts:isV3EntryRule().
 * Kept private to the pipeline module so the caller doesn't need to import
 * from state.ts.
 */
function isTradableRule(signal: ConfluenceSignal): boolean {
  if (signal.ruleId === 'expl') return true;
  if (signal.ruleId === 'clean-impulse' && (signal as { pattern?: string }).pattern === 'FLIP') return true;
  // wall-broken-fade REMOVED from pipeline 2026-06-08 per user — was producing
  // a flood of noise OPENs (13,933 out of 14,075 historical) that drowned out
  // the real FLIP/CONT signal. To be re-evaluated as a standalone strategy
  // (see WBF-only backtest). Live V3 path still includes WBF until cutover.
  // if (signal.ruleId === 'wall-broken-fade') return true;
  if (signal.ruleId === 'compression-realwall') return true;
  if (signal.ruleId === 'cont-reentry') return true;
  if (signal.ruleId === 'es-flip') return true;
  return false;
}

/** Mirror of state.ts:v3PatternFor — only FLIP has a meaningful pattern today. */
function patternFor(signal: ConfluenceSignal): string | null {
  if (signal.ruleId === 'clean-impulse' && (signal as { pattern?: string }).pattern === 'FLIP') return 'FLIP';
  return null;
}

/**
 * Evaluate the actionability stage. Decides whether (and how) a qualified
 * signal would be traded under the V3 cascade. Pure function — no DB writes,
 * no broker calls, no event emission. Caller is responsible for side-effects.
 *
 * Behaviour mirrors state.ts:applySignalV3's gate cascade exactly (lines
 * 388-412 at the time of PR #1). The smoke test asserts equivalence.
 */
export function evaluateActionability(
  signal: ConfluenceSignal,
  isQualified: boolean,
  qualifiedReason: string,
  ctx: ActionabilityContext,
): EvaluateActionabilityResult {
  const direction = signal.direction as 'long' | 'short';
  const pattern = patternFor(signal);
  const isV3Rule = isTradableRule(signal);

  if (!isV3Rule) {
    return { action: 'SKIP_NOT_V3_RULE', reason: `not a V3 entry rule (${signal.ruleId})` };
  }
  if (!isQualified) {
    return { action: 'SKIP_SILENCED', reason: `silenced: ${qualifiedReason}` };
  }
  if (config.v3.forceShadowRules.includes(signal.ruleId)) {
    return {
      action: 'SKIP_FORCE_SHADOW',
      reason: `force-shadow rule (${signal.ruleId}) — observed but not traded`,
    };
  }
  if (config.v3.dropFlipShorts
      && signal.ruleId === 'clean-impulse'
      && pattern === 'FLIP'
      && direction === 'short') {
    return { action: 'SKIP_FLIP_SHORT', reason: 'V3 drops qualified FLIP shorts' };
  }
  if (direction === 'long' && ctx.cvdSession <= config.v3.cvdLongFloor) {
    return {
      action: 'SKIP_CVD',
      reason: `cvdSession=${ctx.cvdSession} <= longFloor=${config.v3.cvdLongFloor}`,
    };
  }
  if (direction === 'short' && ctx.cvdSession >= config.v3.cvdShortFloor) {
    return {
      action: 'SKIP_CVD',
      reason: `cvdSession=${ctx.cvdSession} >= shortFloor=${config.v3.cvdShortFloor}`,
    };
  }
  if (ctx.hasOpenTrade) {
    return { action: 'SKIP_COOLDOWN', reason: 'V3 cooldown: a trade is already open' };
  }
  return { action: 'OPEN', reason: qualifiedReason };
}
