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
import { flipLongFcVeto, contShortRetraceVeto, cvdLongFloorOffTag } from '@trading/contracts';
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
 * Action labels — written into tradable_signals.action and also reused as the
 * SignalResult['action'] enum for the signal_results audit log.
 */
export type ActionabilityAction =
  | 'OPEN'
  | 'SKIP_NOT_V3_RULE'
  | 'SKIP_SILENCED'
  | 'SKIP_FORCE_SHADOW'
  | 'SKIP_FLIP_SHORT'
  | 'SKIP_FLIP_LONG_DELTA15'
  | 'SKIP_TRAP_VETO'
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
  /**
   * Timestamp (ms) of the most recent SAME-direction trap for this symbol at or
   * before the signal (0 / undefined = none). Only populated by the caller for
   * FLIP-long candidates; used by the trap veto. See config.pipeline.flipTrapVeto.
   */
  lastSameDirTrapMs?: number;
  /**
   * DANGER-FLAG at decision time (registered DANGER-FLAG-CONFIRM 2026-07-08):
   * true = violent-tape state (3-bar range + 11-bar volume over the frozen
   * thresholds in @trading/contracts). Shadow-only — tags the OPEN reason for
   * cohort tracking; NEVER gates. undefined = not computable.
   */
  dangerFlag?: boolean;
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
  if (config.pipeline.forceShadowRules.includes(signal.ruleId)) {
    return {
      action: 'SKIP_FORCE_SHADOW',
      reason: `force-shadow rule (${signal.ruleId}) — observed but not traded`,
    };
  }
  if (config.pipeline.dropFlipShorts
      && signal.ruleId === 'clean-impulse'
      && pattern === 'FLIP'
      && direction === 'short') {
    return { action: 'SKIP_FLIP_SHORT', reason: 'V3 drops qualified FLIP shorts' };
  }
  // ── FLIP-long delta15_ratio gate ──────────────────────────────────────
  // Require the prior 15 bars to show meaningful net selling pressure
  // (delta15 / vol15 ≤ threshold). Backed by permutation-validated edge
  // on Net$ (p=0.007 sweep-corrected). In shadow mode we annotate the
  // reason field but DO NOT block — letting the trade flow through so we
  // can compare actual vs would-have-skipped over a real out-of-sample
  // week before flipping the env flag.
  let flipLongDelta15ShadowNote = '';
  if (signal.ruleId === 'clean-impulse' && pattern === 'FLIP' && direction === 'long') {
    const sig = signal as unknown as { delta15?: number; vol15?: number };
    if (typeof sig.delta15 === 'number' && typeof sig.vol15 === 'number' && sig.vol15 > 0) {
      const ratio = sig.delta15 / sig.vol15;
      const thresh = config.pipeline.flipLongDelta15Gate.threshold;
      const wouldBlock = ratio > thresh; // not exhausted enough
      if (wouldBlock) {
        const blockReason = `delta15_ratio=${ratio.toFixed(4)} > gate=${thresh}`;
        if (config.pipeline.flipLongDelta15Gate.enabled) {
          return { action: 'SKIP_FLIP_LONG_DELTA15', reason: blockReason };
        }
        // Shadow mode: pass through, note in reason for later analysis.
        // Query: SELECT … FROM tradable_signals WHERE reason LIKE '[D15-SHADOW%';
        flipLongDelta15ShadowNote = `[D15-SHADOW: would-block ${blockReason}] `;
      }
    }
  }
  // ── FLIP-long trap veto (2026-06-18) ───────────────────────────────────
  // Skip a FLIP long if a SAME-direction (long) trap fired within the veto
  // window before this signal. The flip is then a late echo of a reversal the
  // faster trap already captured (or the level is chopping). LONGS ONLY —
  // validated on the NQ tradable book (flip-long 53%→60% WR, June OOS 42%→47%,
  // permutation pnl p=0.030). Subtractive-only. See config.pipeline.flipTrapVeto.
  if (signal.ruleId === 'clean-impulse' && pattern === 'FLIP' && direction === 'long'
      && config.pipeline.flipTrapVeto.enabled
      && typeof ctx.lastSameDirTrapMs === 'number' && ctx.lastSameDirTrapMs > 0) {
    const ageMs = signal.ts - ctx.lastSameDirTrapMs;
    if (ageMs >= 0 && ageMs <= config.pipeline.flipTrapVeto.windowMs) {
      return {
        action: 'SKIP_TRAP_VETO',
        reason: `same-dir trap ${Math.round(ageMs / 60_000)}m before flip-long `
          + `(veto window ${config.pipeline.flipTrapVeto.windowMs / 60_000}m)`,
      };
    }
  }
  if (direction === 'long' && ctx.cvdSession <= config.pipeline.cvdLongFloor) {
    return {
      action: 'SKIP_CVD',
      reason: `cvdSession=${ctx.cvdSession} <= longFloor=${config.pipeline.cvdLongFloor}`,
    };
  }
  if (direction === 'short' && ctx.cvdSession >= config.pipeline.cvdShortFloor) {
    return {
      action: 'SKIP_CVD',
      reason: `cvdSession=${ctx.cvdSession} >= shortFloor=${config.pipeline.cvdShortFloor}`,
    };
  }
  if (ctx.hasOpenTrade) {
    return { action: 'SKIP_COOLDOWN', reason: 'V3 cooldown: a trade is already open' };
  }
  // ── FLIP-long F_C shadow veto (2026-07-08) ─────────────────────────────
  // Tag the OPEN tradable book KEPT vs VETO under the frozen F_C filter
  // (deltaT>1200 OR delta15>-1000). SHADOW-ONLY — does NOT block; accrues a
  // forward OOS record on the rows that actually opened. Backtest: recent-era
  // veto cohort 5W/20L, KEEP lifts 43%→61% WR (perm p=0.002), survives regime
  // conditioning (within-day paired KEEP 67% vs VETO 21%). NOT validated OOS
  // (n=16). See BACKLOG #2. Query: `WHERE reason LIKE '[FC-VETO:%'` (or FC-KEPT).
  let flipLongFcNote = '';
  if (signal.ruleId === 'clean-impulse' && pattern === 'FLIP' && direction === 'long') {
    const fc = flipLongFcVeto(signal as unknown as { deltaT?: number; delta15?: number });
    flipLongFcNote = fc.veto ? `[FC-VETO: ${fc.reason}] ` : '[FC-KEPT] ';
  }

  // ── CONT-short shallow-retrace shadow tag (2026-07-08) ─────────────────
  // Tag cont-reentry SHORT OPEN rows KEPT vs VETO under the frozen retrace lever
  // (retracePct>0.35 = deep = coin flip). SHADOW-ONLY. Short only. Backtest: shallow
  // 8W/1L (89%) vs deep 10W/10L (50%). See BACKLOG §2b. Query: `reason LIKE '[CSR-%'`.
  let contShortCsrNote = '';
  if (signal.ruleId === 'cont-reentry' && direction === 'short') {
    const csr = contShortRetraceVeto(signal as unknown as { retracePct?: number });
    contShortCsrNote = csr.veto ? `[CSR-VETO: ${csr.reason}] ` : '[CSR-KEPT] ';
  }

  // ── CVD-LONGFLOOR-OFF forward tag (2026-07-08) ──────────────────────────
  // The long-side CVD floor was DISABLED (see config.ts; registered
  // CVD-LONGFLOOR-OFF). Long OPENs that the OLD floor (cvdSession ≤ -1000)
  // would have vetoed get tagged so the cohort is queryable
  // (`reason LIKE '[CVD-LFO%'`) and chart-visible for forward tracking.
  let cvdLfoNote = '';
  if (direction === 'long') {
    const lfo = cvdLongFloorOffTag({ direction, cvdSession: ctx.cvdSession });
    if (lfo.tagged) cvdLfoNote = `[CVD-LFO: ${lfo.reason}] `;
  }

  // ── DANGER-FLAG cohort tag (2026-07-08, registered DANGER-FLAG-CONFIRM) ──
  // Both directions, FLIP + CONT. Shadow-only; the pre-committed action if the
  // registration confirms is a SIZING overlay, never a gate.
  let dflagNote = '';
  if (ctx.dangerFlag !== undefined && (signal.ruleId === 'clean-impulse' || signal.ruleId === 'cont-reentry')) {
    dflagNote = ctx.dangerFlag ? '[DFLAG-UP] ' : '[DFLAG-DOWN] ';
  }

  // Prepend shadow notes (if any) so reviewer can later filter for
  // would-have-blocked rows: `WHERE reason LIKE '[D15-SHADOW:%'` / `'[FC-%'` / `'[CSR-%'` / `'[CVD-LFO%'` / `'[DFLAG-%'`.
  return { action: 'OPEN', reason: dflagNote + cvdLfoNote + flipLongFcNote + contShortCsrNote + flipLongDelta15ShadowNote + qualifiedReason };
}
