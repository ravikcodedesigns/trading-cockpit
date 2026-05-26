// Attaches RS score fields to a signal before it is applied to state.
// Called from every strategy index file — one line wraps the signal.

import type { ConfluenceSignal, Symbol } from '@trading/contracts';
import { tradingDayFor } from '@trading/contracts';
import { state } from '../state.js';
import { db } from '../db.js';
import { scoreRSLevels } from './rs-level-scorer.js';
import { getContext } from '../rs-context.js';

// Look back 60 minutes for break-and-return detection.
const BR_LOOKBACK_MS = 60 * 60_000;

export function withRSScore(
  signal: ConfluenceSignal,
  symbol: Symbol,
  nowMs: number,
): ConfluenceSignal {
  const today  = tradingDayFor(nowMs);
  const levels = state.levelsForDay(today)?.[symbol];
  const entry  = (signal as any).entry as number | undefined;

  // No entry price means we can't locate the signal on the RS map — skip scoring
  if (!entry) return signal;

  // Pull last 60 min of bars so the scorer can detect break-and-return setups.
  const recentBars = (db.recentBars(symbol, nowMs - BR_LOOKBACK_MS) as { high: number; low: number }[]);

  const rs  = scoreRSLevels(entry, signal.direction, levels, entry, recentBars);
  const ctx = getContext();

  // _rsResult and _rsContext are internal fields used by db.logSignal to populate
  // the RS analysis columns — they are not part of the public ConfluenceSignal contract.
  return {
    ...signal,
    rsScore:        rs.score,
    rsTier:         rs.tier,
    rsComponents:   rs.components,
    rsMatchedLevel: rs.matchedLevel?.label,
    rsLabelLine:    rs.labelLine,
    resContext: {
      res:        ctx.redistResilience,
      hpRes:      ctx.hpResilience,
      mhpRes:     ctx.mhpResilience,
      isRational: ctx.isRational,
    },
    // Internal fields for DB persistence (stripped before sending to cockpit/Discord)
    _rsResult:  rs,
    _rsContext: ctx,
  } as ConfluenceSignal;
}
