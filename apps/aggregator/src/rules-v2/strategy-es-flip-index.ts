// Strategy ES-FLIP orchestrator — bar-close aligned, ES symbol only.
// Wakes 100ms after every minute boundary; evaluates the bar that was
// CONFIRM_WINDOW (5) min ago — by now we have the forward bars needed
// for swing-extremum confirmation.

import { state } from '../state.js';
import { logger } from '../logger.js';
import { runStrategyEsFlip } from './strategy-es-flip.js';
import { withRSScore } from './rs-attach.js';
import type { Symbol } from '@trading/contracts';

const BAR_CLOSE_BUFFER_MS = 100;
const SYMBOLS: Symbol[] = ['ES'];   // ES-only

let _running = false;
let _timer: ReturnType<typeof setTimeout> | null = null;
let _iter = 0;
let _signals = 0;

function msUntilNextBarClose(): number {
  const msIntoMinute = Date.now() % 60_000;
  return (60_000 - msIntoMinute) + BAR_CLOSE_BUFFER_MS;
}

async function runOnce(): Promise<void> {
  const nowMs = Date.now();
  _iter++;
  for (const symbol of SYMBOLS) {
    try {
      const result = await runStrategyEsFlip(symbol, nowMs);
      if (result) {
        _signals++;
        state.applySignal(withRSScore({ ...result, strategyVersion: 'ES-FLIP' as any }, symbol, nowMs));
      }
    } catch (err) {
      logger.warn({ err, symbol }, 'strategy-ES-FLIP: poll error');
    }
  }
}

function schedule(): void {
  if (!_running) return;
  _timer = setTimeout(async () => {
    await runOnce().catch(err => logger.warn({ err }, 'strategy-ES-FLIP tick error'));
    schedule();
  }, msUntilNextBarClose());
}

export function startStrategyEsFlip(): void {
  if (_running) { logger.warn('strategy-ES-FLIP already running'); return; }
  _running = true;
  logger.info({ bufferMs: BAR_CLOSE_BUFFER_MS, symbols: SYMBOLS },
    'strategy-ES-FLIP started (SHADOW — bar-close aligned, 100ms buffer)');
  void runOnce();
  schedule();
}

export function stopStrategyEsFlip(): void {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  logger.info({ signals: _signals }, 'strategy-ES-FLIP stopped');
}
