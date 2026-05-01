import { startServer } from './server.js';
import { startLevelsWatcher } from './sources/levels.js';
import { startFlashAlphaPoller } from './sources/flashalpha.js';
import { startRulesEngine } from './rules/index.js';
import { state } from './state.js';
import { logger } from './logger.js';
import { discord } from './discord.js';
import { db } from './db.js';
import type { Symbol, DailyLevels, FlashAlphaSnapshot } from '@trading/contracts';
import { tradingDayFor } from '@trading/contracts';

// Accessors for rules engine to read current materialized state
const snapshot = () => state.snapshot();
const getLevels = (s: Symbol): DailyLevels | undefined => {
  // Look up the trading day for "now" and return that day's levels for the
  // symbol. After the per-day levels refactor, state holds a date-keyed
  // map instead of a single levels object.
  const today = tradingDayFor(Date.now());
  return state.levelsForDay(today)?.[s];
};
const getFlashAlpha = (s: Symbol): FlashAlphaSnapshot | undefined => snapshot().flashAlpha[s];

async function main() {
  logger.info('booting aggregator');

  // Start sources first so they can begin populating state immediately
  startLevelsWatcher();
  startFlashAlphaPoller();
  startRulesEngine(getLevels, getFlashAlpha);

  // Then the server (sources and cockpit can connect)
  const app = await startServer();

  discord.systemUp();
  logger.info('aggregator ready');

  // --- Graceful shutdown ---
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      db.close();
    } catch (err) {
      logger.error({ err }, 'shutdown error');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Crash reporting
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException');
    discord.systemError('Uncaught exception', err.stack ?? err.message);
    setTimeout(() => process.exit(1), 1000);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandledRejection');
    discord.systemError('Unhandled rejection', String(reason));
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal boot error');
  process.exit(1);
});
