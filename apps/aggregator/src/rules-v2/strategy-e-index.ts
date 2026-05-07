// Strategy E Orchestrator — 5-min Absorption Scalp
// Polls every minute, checks last completed 5-min bar.
// OBSERVE ONLY until 50+ signals validated.

import { state } from '../state.js';
import { logger } from '../logger.js';
import { runStrategyE } from './strategy-e.js';
import type { Symbol } from '@trading/contracts';

const POLL_MS = 60_000;
const SYMBOLS: Symbol[] = ['NQ', 'ES'];

let _running = false;
let _timer: ReturnType<typeof setTimeout> | null = null;
let _signalCount = 0;

async function tick(): Promise<void> {
  const nowMs = Date.now();
  for (const symbol of SYMBOLS) {
    try {
      const results = await runStrategyE(symbol, nowMs);
      for (const result of results) {
        _signalCount++;
        state.applySignal({ ...result, strategyVersion: 'E' as any });
        logger.info({ symbol, ruleVersion: (result as any).ruleVersion, total: _signalCount },
          'strategy-E signal fired');
      }
    } catch (err) {
      logger.warn({ err, symbol }, 'strategy-E poll error');
    }
  }
}

function schedule(): void {
  if (!_running) return;
  _timer = setTimeout(async () => {
    await tick().catch(err => logger.warn({ err }, 'strategy-E tick error'));
    schedule();
  }, POLL_MS);
}

export function startStrategyE(): void {
  if (_running) return;
  _running = true;
  logger.info({ pollMs: POLL_MS, symbols: SYMBOLS },
    'strategy-E started (5-min absorption scalp — observe only)');
  schedule();
}

export function stopStrategyE(): void {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  logger.info({ signals: _signalCount }, 'strategy-E stopped');
}
