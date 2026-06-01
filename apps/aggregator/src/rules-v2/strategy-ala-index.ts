// Strategy ALA Orchestrator (bar-close aligned)

import { state } from '../state.js';
import { logger } from '../logger.js';
import { runStrategyALA, seedCooldownFromDb } from './strategy-ala.js';
import { withRSScore } from './rs-attach.js';
import type { Symbol } from '@trading/contracts';

const BAR_CLOSE_BUFFER_MS = 150;
const SYMBOLS: Symbol[] = ['NQ'];

let _running = false;
let _timer: ReturnType<typeof setTimeout> | null = null;
let _signalCount = 0;

function msUntilNextBarClose(): number {
  const ms = Date.now() % 60_000;
  return (60_000 - ms) + BAR_CLOSE_BUFFER_MS;
}

async function runOnce(): Promise<void> {
  const nowMs = Date.now();
  for (const symbol of SYMBOLS) {
    try {
      const result = await runStrategyALA(symbol, nowMs);
      if (result) {
        _signalCount++;
        state.applySignal(withRSScore({ ...result, strategyVersion: 'ALA' as any }, symbol, nowMs));
      }
    } catch (err) {
      logger.warn({ err, symbol }, 'strategy-ALA: poll error');
    }
  }
}

function schedule(): void {
  if (!_running) return;
  _timer = setTimeout(async () => {
    await runOnce().catch(err => logger.warn({ err }, 'strategy-ALA tick error'));
    schedule();
  }, msUntilNextBarClose());
}

export function startStrategyALA(): void {
  if (_running) { logger.warn('strategy-ALA already running'); return; }
  seedCooldownFromDb();
  _running = true;
  logger.info({ bufferMs: BAR_CLOSE_BUFFER_MS, symbols: SYMBOLS },
    'strategy-ALA started (bar-close aligned)');
  void runOnce();
  schedule();
}

export function stopStrategyALA(): void {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  logger.info({ signals: _signalCount }, 'strategy-ALA stopped');
}
