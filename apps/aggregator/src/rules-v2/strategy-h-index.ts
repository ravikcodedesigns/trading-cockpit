// Strategy H Orchestrator
// Bar-close aligned: wakes 100ms after every minute boundary so the completed
// bar is evaluated the instant it closes, not on a fixed polling interval.
// Detects two patterns on 1-minute RTH bars:
//   FLIP: exhaustion reversal at comp_pos extremes
//   CONT: momentum continuation in the middle of the range

import { state } from '../state.js';
import { logger } from '../logger.js';
import { runStrategyH, seedCooldownFromDb } from './strategy-h.js';
import { withRSScore } from './rs-attach.js';
import type { Symbol } from '@trading/contracts';

const BAR_CLOSE_BUFFER_MS = 100;  // 100ms after :00 — enough for last ticks to flush to DB
// strategy-h is NQ-tuned. ES uses strategy-es-flip with ES-derived thresholds.
const SYMBOLS: Symbol[] = ['NQ'];

let _running     = false;
let _timer: ReturnType<typeof setTimeout> | null = null;
let _iteration   = 0;
let _signalCount = 0;

/** ms until the next minute boundary + 100ms buffer */
function msUntilNextBarClose(): number {
  const msIntoMinute = Date.now() % 60_000;
  return (60_000 - msIntoMinute) + BAR_CLOSE_BUFFER_MS;
}

async function runOnce(): Promise<void> {
  const nowMs = Date.now();
  _iteration++;

  for (const symbol of SYMBOLS) {
    try {
      const result = await runStrategyH(symbol, nowMs);
      if (result) {
        _signalCount++;
        state.applySignal(withRSScore({ ...result, strategyVersion: 'H' as any }, symbol, nowMs));
      }
    } catch (err) {
      logger.warn({ err, symbol }, 'strategy-H: poll error');
    }
  }
}

function schedule(): void {
  if (!_running) return;
  _timer = setTimeout(async () => {
    await runOnce().catch(err => logger.warn({ err }, 'strategy-H tick error'));
    schedule();
  }, msUntilNextBarClose());
}

export function startStrategyH(): void {
  if (_running) { logger.warn('strategy-H already running'); return; }
  seedCooldownFromDb();  // restore per-symbol/direction cooldowns across restarts
  _running = true;
  logger.info({ bufferMs: BAR_CLOSE_BUFFER_MS, symbols: SYMBOLS },
    'strategy-H started (bar-close aligned, 100ms buffer)');
  void runOnce();  // evaluate immediately on start for any signal on current bar
  schedule();
}

export function stopStrategyH(): void {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  logger.info({ signals: _signalCount }, 'strategy-H stopped');
}
