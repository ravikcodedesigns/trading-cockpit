// Strategy D Orchestrator
// Polls every 60 seconds (aligned to 1-min bar boundaries)
// for 15-min compression breakouts confirmed by 5-min entries.

import { state } from '../state.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { runStrategyD, getStrategyDWatchStatus } from './strategy-d.js';
import type { Symbol } from '@trading/contracts';

const POLL_MS = 60_000; // poll every minute
const SYMBOLS: Symbol[] = ['NQ', 'ES'];

let _running = false;
let _timer: ReturnType<typeof setTimeout> | null = null;
let _iteration = 0;
let _signalCount = 0;

async function runOnce(): Promise<void> {
  const nowMs = Date.now();
  _iteration++;

  for (const symbol of SYMBOLS) {
    try {
      const result = await runStrategyD(symbol, nowMs);
      if (result) {
        _signalCount++;
        state.applySignal({ ...result, strategyVersion: 'D' as any });
      }
    } catch (err) {
      logger.warn({ err, symbol }, 'strategy-D: poll error');
    }
  }

  // Log watch status every 5 minutes
  if (_iteration % 5 === 0) {
    for (const symbol of SYMBOLS) {
      const watch = getStrategyDWatchStatus(symbol);
      if (watch) {
        logger.info({
          symbol, direction: watch.direction,
          compHigh: watch.compHigh, compLow: watch.compLow,
          watchingFor: '5-min entry',
        }, 'strategy-D: active watch window');
      }
    }
  }
}

function schedule(): void {
  if (!_running) return;
  _timer = setTimeout(async () => {
    await runOnce().catch(err => logger.warn({ err }, 'strategy-D tick error'));
    schedule();
  }, POLL_MS);
}

export function startStrategyD(): void {
  if (_running) { logger.warn('strategy-D already running'); return; }
  _running = true;
  logger.info({ pollMs: POLL_MS, symbols: SYMBOLS },
    'strategy-D started (15-min compression → 5-min entry)');
  schedule();
}

export function stopStrategyD(): void {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  logger.info({ signals: _signalCount }, 'strategy-D stopped');
}
