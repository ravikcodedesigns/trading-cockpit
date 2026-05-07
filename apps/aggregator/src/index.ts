import { startServer } from './server.js';
import { startLevelsWatcher } from './sources/levels.js';
import { startFlashAlphaPoller } from './sources/flashalpha.js';
import { startRulesEngine } from './rules/index.js';
import { startStrategyB, stopStrategyB } from './rules-v2/index.js';
import { startStrategyC, stopStrategyC } from './rules-v2/strategy-c-index.js';
import { startStrategyD, stopStrategyD } from './rules-v2/strategy-d-index.js';
import { startStrategyE, stopStrategyE } from './rules-v2/strategy-e-index.js';
import { getRecentTrades } from './rules-v2/tick-client.js';
import { state } from './state.js';
import { logger } from './logger.js';
import { discord } from './discord.js';
import { db } from './db.js';
import { config } from './config.js';
import { loadContext } from './rs-context.js';
import type { Symbol, DailyLevels, FlashAlphaSnapshot } from '@trading/contracts';
import { tradingDayFor } from '@trading/contracts';

const snapshot = () => state.snapshot();
const getLevels = (s: Symbol): DailyLevels | undefined => {
  const today = tradingDayFor(Date.now());
  return state.levelsForDay(today)?.[s];
};
const getFlashAlpha = (s: Symbol): FlashAlphaSnapshot | undefined => snapshot().flashAlpha[s];

// Current price: last trade from tick-store (Strategy C needs this)
const _lastPrice: Partial<Record<Symbol, number>> = {};
async function refreshPrices(): Promise<void> {
  for (const sym of ['NQ', 'ES'] as Symbol[]) {
    const trades = await getRecentTrades(sym, 5000).catch(() => []);
    if (trades.length) _lastPrice[sym] = trades[trades.length - 1].price;
  }
}
const getPrice = (s: Symbol): number | undefined => _lastPrice[s];

async function main() {
  logger.info({ activeStrategy: config.activeStrategy }, 'booting aggregator');

  // Load RS morning context (set via: pnpm context:set)
  const rsCtx = loadContext();
  logger.info({
    greaterMarket: rsCtx.greaterMarket,
    ddRatio: rsCtx.ddRatio,
    vxAboveBBB: rsCtx.vxAboveBBB,
    isRational: rsCtx.isRational,
  }, 'RS context active');

  startLevelsWatcher();
  startFlashAlphaPoller();

  if (config.activeStrategy === 'A' || config.activeStrategy === 'BOTH') {
    startRulesEngine(getLevels, getFlashAlpha);
    logger.info('strategy-A started (bar-based: sweep + divergence)');
  }

  if (config.activeStrategy === 'B' || config.activeStrategy === 'BOTH' || config.activeStrategy === 'ALL') {
    startStrategyB(getLevels);
    logger.info('strategy-B started (tick-based: absorption)');
  }

  if (config.activeStrategy === 'C' || config.activeStrategy === 'ALL') {
    // Start price refresh loop before Strategy C
    setInterval(refreshPrices, 1000);
    await refreshPrices();
    startStrategyC(getLevels, getPrice);
    logger.info('strategy-C started (RS level watcher)');
  }

  if (config.activeStrategy === 'D' || config.activeStrategy === 'ALL') {
    startStrategyD();
    logger.info('strategy-D started (15-min compression → 5-min entry)');
  }

  if (config.activeStrategy === 'E' || config.activeStrategy === 'ALL') {
    startStrategyE();
    logger.info('strategy-E started (5-min absorption scalp — observe only)');
  }

  // Then the server (sources and cockpit can connect)
  const app = await startServer();

  discord.systemUp();
  logger.info('aggregator ready');

  // --- Graceful shutdown ---
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    try {
      if (config.activeStrategy === 'B' || config.activeStrategy === 'BOTH') {
        stopStrategyB();
      }
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
