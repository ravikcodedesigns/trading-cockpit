// Strategy EXPL Orchestrator
// Bar-close aligned: wakes 100ms after every minute boundary.
// EXPL evaluates 60 minutes of historical closed bars — running once per bar
// close is sufficient and avoids redundant reads between closes.
// Both LONG and SHORT directions; per-direction DB-backed cooldown.

import { state } from '../state.js';
import { logger } from '../logger.js';
import { db } from '../db.js';
import { evaluateEXPL, evaluateEXPLShort } from '../strategy-expl.js';
import type { Symbol } from '@trading/contracts';

const BAR_CLOSE_BUFFER_MS = 100;
const COOLDOWN_MS = 15 * 60 * 1000;   // 15 min — persisted via DB across restarts
const SYMBOLS: Symbol[] = ['NQ'];

let _running     = false;
let _timer: ReturnType<typeof setTimeout> | null = null;
let _signalCount = 0;

async function runOnce(): Promise<void> {
  const nowMs = Date.now();

  for (const symbol of SYMBOLS) {
    // ── LONG ──────────────────────────────────────────────────────────────────
    try {
      const lastLong = db.lastSignalTsFor('expl', symbol, 'long');
      if (nowMs - lastLong >= COOLDOWN_MS) {
        const result = evaluateEXPL(nowMs, symbol);
        if (result) {
          _signalCount++;

          const rationale =
            `EXPL-LONG [RTH]: ${result.score}/5 confluences — ` +
            result.conditions.join(' | ');

          const signal = {
            ts:              result.timestamp,
            source:          'rules-v2' as const,
            type:            'confluence' as const,
            symbol,
            ruleId:          'expl',
            rule_id:         'expl',
            score:           result.score,
            direction:       'long' as const,
            rationale,
            strategyVersion: 'EXPL' as any,
            ruleVersion:     'expl-v1',
            observeOnly:     true,
            profile:         result.profile,
            rangeLow:        result.rangeLow,
            rangeHigh:       result.rangeHigh,
            rangePct:        result.rangePct,
            compressionAvg:  result.compressionRange,
            stackedBidZones: result.stackedBidZones,
            largeLotPrice:   result.largeLotPrice,
            largeLotSize:    result.largeLotSize,
            shakeout:        result.shakeoutDetected,
            conditions:      result.conditions,
          };

          state.applySignal(signal as any);

          logger.info({
            symbol, score: result.score, profile: result.profile,
            rangePct: result.rangePct, zones: result.stackedBidZones,
          }, 'strategy-EXPL: LONG signal fired');
        }
      }
    } catch (err) {
      logger.warn({ err, symbol }, 'strategy-EXPL LONG: poll error');
    }

    // ── SHORT ─────────────────────────────────────────────────────────────────
    try {
      const lastShort = db.lastSignalTsFor('expl', symbol, 'short');
      if (nowMs - lastShort >= COOLDOWN_MS) {
        const result = evaluateEXPLShort(nowMs, symbol);
        if (result) {
          _signalCount++;

          const rationale =
            `EXPL-SHORT [RTH]: ${result.score}/5 confluences — ` +
            result.conditions.join(' | ');

          const signal = {
            ts:              result.timestamp,
            source:          'rules-v2' as const,
            type:            'confluence' as const,
            symbol,
            ruleId:          'expl',
            rule_id:         'expl',
            score:           result.score,
            direction:       'short' as const,
            rationale,
            strategyVersion: 'EXPL' as any,
            ruleVersion:     'expl-v1',
            observeOnly:     true,
            profile:         result.profile,
            rangeLow:        result.rangeLow,
            rangeHigh:       result.rangeHigh,
            rangePct:        result.rangePct,
            compressionAvg:  result.compressionRange,
            stackedAskZones: result.stackedBidZones,  // stored in stackedBidZones field
            largeLotPrice:   result.largeLotPrice,
            largeLotSize:    result.largeLotSize,
            reverseShakeout: result.shakeoutDetected,
            conditions:      result.conditions,
          };

          state.applySignal(signal as any);

          logger.info({
            symbol, score: result.score, profile: result.profile,
            rangePct: result.rangePct, zones: result.stackedBidZones,
          }, 'strategy-EXPL: SHORT signal fired');
        }
      }
    } catch (err) {
      logger.warn({ err, symbol }, 'strategy-EXPL SHORT: poll error');
    }
  }
}

/** ms until the next minute boundary + 100ms buffer */
function msUntilNextBarClose(): number {
  const msIntoMinute = Date.now() % 60_000;
  return (60_000 - msIntoMinute) + BAR_CLOSE_BUFFER_MS;
}

function schedule(): void {
  if (!_running) return;
  _timer = setTimeout(async () => {
    await runOnce().catch(err => logger.warn({ err }, 'strategy-EXPL tick error'));
    schedule();
  }, msUntilNextBarClose());
}

export function startStrategyEXPL(): void {
  if (_running) { logger.warn('strategy-EXPL already running'); return; }
  _running = true;
  logger.info({ bufferMs: BAR_CLOSE_BUFFER_MS, symbols: SYMBOLS }, 'strategy-EXPL started');
  void runOnce();
  schedule();
}

export function stopStrategyEXPL(): void {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  logger.info({ signals: _signalCount }, 'strategy-EXPL stopped');
}
