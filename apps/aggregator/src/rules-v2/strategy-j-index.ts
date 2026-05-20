// Strategy J Orchestrator — 500ms polling
// Runs the absorbed spike detector at tick resolution,
// firing the moment tick-level absorption is confirmed.

import { state } from '../state.js';
import { logger } from '../logger.js';
import { runStrategyJ, seedJCooldownFromDb } from './strategy-j.js';
import { withRSScore } from './rs-attach.js';
import type { Symbol } from '@trading/contracts';

const POLL_MS = 500;
const SYMBOLS: Symbol[] = ['NQ', 'ES'];

let _running     = false;
let _timer: ReturnType<typeof setTimeout> | null = null;
let _iteration   = 0;
let _signalCount = 0;

async function runOnce(): Promise<void> {
  const nowMs = Date.now();
  _iteration++;

  for (const symbol of SYMBOLS) {
    try {
      const result = await runStrategyJ(symbol, nowMs);
      if (result) {
        _signalCount++;
        state.applySignal(withRSScore({ ...result, strategyVersion: 'J' as any }, symbol, nowMs));
      }
    } catch (err) {
      logger.warn({ err, symbol }, 'strategy-J: poll error');
    }
  }

  if (_iteration % (300_000 / POLL_MS) === 0) {
    logger.info({ iteration: _iteration, signals: _signalCount }, 'strategy-J heartbeat');
  }
}

function schedule(): void {
  if (!_running) return;
  _timer = setTimeout(async () => {
    await runOnce().catch(err => logger.warn({ err }, 'strategy-J tick error'));
    schedule();
  }, POLL_MS);
}

export function startStrategyJ(): void {
  if (_running) { logger.warn('strategy-J already running'); return; }
  seedJCooldownFromDb();
  _running = true;
  logger.info({ pollMs: POLL_MS, symbols: SYMBOLS }, 'strategy-J started (500ms TRAP detector)');
  void runOnce();
  schedule();
}

export function stopStrategyJ(): void {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  logger.info({ signals: _signalCount }, 'strategy-J stopped');
}
