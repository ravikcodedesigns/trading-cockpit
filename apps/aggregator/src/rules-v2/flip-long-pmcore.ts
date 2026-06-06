// Strategy: FLIP-long-PMCore — FLIP-long signals strictly filtered to 10:30-13:30 ET
// + strong prior-bars-bearish requirement.
//
// Built 2026-06-03 after empirical filter search on 41 historical FLIP-long signals
// (60-day window from qualified_signals + walk-forward in ticks.db at TP=60/SL=40):
//
//   Base FLIP-long at TP=60/SL=40:           19W / 12L / 10 BE-scratch → 61.3% WR
//   FILTERED 10:30-13:30 ET only:            17W /  8L /  9 BE-scratch → 68.0% WR
//   FILTERED 10:30-13:30 & deltaLast3<=-300: 16W /  7L /  8 BE-scratch → 69.6% WR
//
// The time-of-day window is the strongest single filter (FLIP-long signals fire often
// at the 09:30 open but the OPENING-VOL period 09:30-10:30 has lower follow-through;
// late session 13:30+ has the EXPL "dead zone" effect). The deltaLast3<=-300
// requirement tightens to setups with VERY strong prior bearish exhaustion.
//
// This rule is a SHADOW LAYER over FLIP-long — it does NOT detect signals on its own.
// It listens for clean-impulse FLIP-long signals and re-emits them with a different
// ruleId IF they meet the PMCore filter. Original FLIP-long signals continue firing
// unmodified.
//
// Status: SHADOW MODE until 5+ days of live validation. Quality gate forces 'silenced'.

import type { ConfluenceSignal, Symbol } from '@trading/contracts';
import { logger } from '../logger.js';

// ── PMCore filter params ───────────────────────────────────────────────────
const PMCORE_TOD_START_MIN = 10*60 + 30;  // 10:30 ET
const PMCORE_TOD_END_MIN   = 13*60 + 30;  // 13:30 ET
const PMCORE_DELTALAST3_MAX = -300;       // strong prior-3-bar bearish

function isInPMCoreWindow(tsMs: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const min = parseInt(get('hour'), 10)*60 + parseInt(get('minute'), 10);
  return min >= PMCORE_TOD_START_MIN && min < PMCORE_TOD_END_MIN;
}

/**
 * Check whether an emitted FLIP-long signal qualifies for the PMCore filter.
 * Called from state.applySignal AFTER FLIP-long has fired. Returns true if the
 * signal passes the additional confluence; emit a paired signal with ruleId
 * 'flip-long-pmcore' in that case.
 */
export function qualifiesForPMCore(signal: ConfluenceSignal): boolean {
  if (signal.ruleId !== 'clean-impulse') return false;
  if (signal.direction !== 'long') return false;
  if ((signal as any).pattern !== 'FLIP') return false;
  if (!isInPMCoreWindow(signal.ts)) return false;
  const deltaLast3 = (signal as any).deltaLast3 ?? 0;
  if (deltaLast3 > PMCORE_DELTALAST3_MAX) return false;
  return true;
}

/**
 * Build a PMCore signal derived from the original FLIP-long signal.
 * Preserves entry/stopLevel from the source.
 */
export function buildPMCoreSignal(source: ConfluenceSignal): ConfluenceSignal {
  const out: ConfluenceSignal = {
    ...source,
    ruleId: 'flip-long-pmcore',
    score: (source.score ?? 90),
    rationale:
      `FLIP-long-PMCore: parent FLIP-long fired at ${new Date(source.ts).toISOString().substring(11,19)} UTC | ` +
      `PMCore window 10:30-13:30 ET ✓ | deltaLast3 ≤ -300 ✓ | ` +
      `TP=60 SL=40 (R:R 1.5). Backtest 69.6% WR on n=23 closed (16W/7L/8 BE-scratch) over 60-day FLIP history.`,
    strategyVersion: 'PMCORE' as any,
    ruleVersion: 'pmcore-v1',
  };
  logger.info({ ts: source.ts, deltaLast3: (source as any).deltaLast3 }, 'flip-long-pmcore: derived signal');
  return out;
}
