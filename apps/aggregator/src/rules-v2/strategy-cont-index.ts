// Strategy CONT Orchestrator
// Bar-close aligned: wakes 100ms after every minute boundary.
// Detects trend continuation re-entry setups on NQ.

import { state } from '../state.js';
import { logger } from '../logger.js';
import { runStrategyCONT, seedCooldownFromDb } from './strategy-cont.js';
import { withRSScore } from './rs-attach.js';
import type { Symbol } from '@trading/contracts';

const BAR_CLOSE_BUFFER_MS = 100;
const SYMBOLS: Symbol[] = ['NQ'];

let _running     = false;
let _timer: ReturnType<typeof setTimeout> | null = null;
let _signalCount = 0;

function msUntilNextBarClose(): number {
  const msIntoMinute = Date.now() % 60_000;
  return (60_000 - msIntoMinute) + BAR_CLOSE_BUFFER_MS;
}

async function runOnce(): Promise<void> {
  const nowMs = Date.now();

  for (const symbol of SYMBOLS) {
    try {
      const result = await runStrategyCONT(symbol, nowMs);
      if (result) {
        _signalCount++;
        state.applySignal(withRSScore({ ...result, strategyVersion: 'CONT' as any }, symbol, nowMs));
      }
    } catch (err) {
      logger.warn({ err, symbol }, 'strategy-CONT: poll error');
    }
  }
}

function schedule(): void {
  if (!_running) return;
  _timer = setTimeout(async () => {
    await runOnce().catch(err => logger.warn({ err }, 'strategy-CONT tick error'));
    schedule();
  }, msUntilNextBarClose());
}

export function startStrategyCONT(): void {
  if (_running) { logger.warn('strategy-CONT already running'); return; }
  seedCooldownFromDb();
  _running = true;
  logger.info({ bufferMs: BAR_CLOSE_BUFFER_MS, symbols: SYMBOLS }, 'strategy-CONT started');
  void runOnce();
  schedule();
}

export function stopStrategyCONT(): void {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  logger.info({ signals: _signalCount }, 'strategy-CONT stopped');
}
