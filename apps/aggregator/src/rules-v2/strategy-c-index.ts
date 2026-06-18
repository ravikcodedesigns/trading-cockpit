// Strategy C Orchestrator
//
// Runs the RS level watcher on a polling loop.
// Requires getLevels and getCurrentPrice injected at startup.
//
// Add to .env or config: ACTIVE_STRATEGY=C or ACTIVE_STRATEGY=ALL

import { state } from '../state.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { runStrategyC } from './strategy-c.js';
import { tickOutcomes, initOutcomeTable, trackSignalC, getPendingCount } from './strategy-c-outcomes.js';
import { tradingDayFor } from '@trading/contracts';
import type { Symbol, DailyLevels } from '@trading/contracts';

const POLL_MS = config.tickStore.pollMs;
const SYMBOLS: Symbol[] = ['NQ', 'ES'];

type GetLevelsFn = (s: Symbol) => DailyLevels | undefined;
type GetPriceFn = (s: Symbol) => number | undefined;

let _running = false;
let _timer: ReturnType<typeof setTimeout> | null = null;
let _getLevels: GetLevelsFn = () => undefined;
let _getPrice: GetPriceFn = () => undefined;
let _iteration = 0;
let _signalCount = 0;

async function runOnce(): Promise<void> {
  const nowMs = Date.now();
  _iteration++;

  for (const symbol of SYMBOLS) {
    const levels = _getLevels(symbol);

    try {
      const result = await runStrategyC(symbol, nowMs, levels, () => _getPrice(symbol));

      if (result) {
        _signalCount++;
        const signal = result.signal;

        // Insert into DB via state (same path as A and B)
        state.applySignal({ ...signal, strategyVersion: 'C' as any });

        // Get the DB ID of the inserted signal for outcome tracking
        // (state.applySignal returns the inserted ID via the DB layer)
        // We track by timestamp as proxy since we don't surface signal IDs
        trackSignalC(
          Date.now(),  // proxy ID — replace with real DB ID if surfaced
          symbol,
          signal.direction,
          (signal as any).touchPrice ?? (signal as any).rsLevelPrice,
          signal.ts,
          (signal as any).rsLevel ?? 'unknown',
          (signal as any).rsLevelPrice ?? 0,
          (signal as any).touchCount ?? 1,
          (signal as any).timeToConfirmMs ?? 0
        );
      }
    } catch (err) {
      logger.warn({ err, symbol }, 'strategy-C: poll error');
    }
  }

  // Tick outcome tracking every poll cycle
  await tickOutcomes(nowMs).catch(err =>
    logger.warn({ err }, 'strategy-C: outcome tick error')
  );

  // Heartbeat every 5 minutes
  if (_iteration % (300_000 / POLL_MS) === 0) {
    logger.info({
      iteration: _iteration, symbols: SYMBOLS,
      signals: _signalCount, pendingOutcomes: getPendingCount(),
    }, 'strategy-C heartbeat');
  }
}

function schedule(): void {
  if (!_running) return;
  _timer = setTimeout(async () => {
    await runOnce().catch(err => logger.warn({ err }, 'strategy-C poll error'));
    schedule();
  }, POLL_MS);
}

export function startStrategyC(getLevels: GetLevelsFn, getPrice: GetPriceFn): void {
  if (_running) { logger.warn('strategy-C already running'); return; }
  _getLevels = getLevels;
  _getPrice = getPrice;
  initOutcomeTable();
  _running = true;
  logger.info({ pollMs: POLL_MS, symbols: SYMBOLS }, 'strategy-C started (RS level watcher)');
  schedule();
}

export function stopStrategyC(): void {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  logger.info({ signals: _signalCount }, 'strategy-C stopped');
}
