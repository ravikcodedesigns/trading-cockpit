import { startServer } from './server.js';
import { startLevelsWatcher } from './sources/levels.js';
import { startFlashAlphaPoller } from './sources/flashalpha.js';
import { startVXPoller } from './sources/vx-poller.js';
import { startRulesEngine } from './rules/index.js';
import { startStrategyB, stopStrategyB } from './rules-v2/index.js';
// import { startStrategyC, stopStrategyC } from './rules-v2/strategy-c-index.js';
import { startStrategyD, stopStrategyD } from './rules-v2/strategy-d-index.js';
import { startStrategyE, stopStrategyE } from './rules-v2/strategy-e-index.js';
import { startStrategyH, stopStrategyH } from './rules-v2/strategy-h-index.js';
import { startStrategyEXPL, stopStrategyEXPL } from './rules-v2/strategy-expl-index.js';
import { startStrategyI, stopStrategyI } from './rules-v2/strategy-i-index.js';
import { startStrategyJ, stopStrategyJ } from './rules-v2/strategy-j-index.js';
import { startStrategyCONT, stopStrategyCONT } from './rules-v2/strategy-cont-index.js';
import { startExplShortObserver, stopExplShortObserver } from './observers/expl-short-observer.js';
import { getRecentTrades } from './rules-v2/tick-client.js';
import { state } from './state.js';
import { logger } from './logger.js';
import { discord } from './discord.js';
import { db } from './db.js';
import { config } from './config.js';
import { loadContext, watchContext } from './rs-context.js';
import { loadCalendar, getTodayEvents } from './economic-calendar.js';
import { fireOvernightBriefing } from './morning-brief.js';
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

function scheduleMorningBriefing(): void {
  // Fire at 8:15 AM ET every weekday — 15 min before 8:30 news releases
  const msUntil815ET = (): number => {
    const now = new Date();
    const nyStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
    const ny = new Date(nyStr);
    const target = new Date(nyStr);
    target.setHours(8, 15, 0, 0);
    let ms = target.getTime() - ny.getTime();
    if (ms < 0) ms += 24 * 60 * 60 * 1000; // already past 8:15 — fire tomorrow
    return ms + (now.getTime() - ny.getTime()); // adjust for timezone offset
  };

  const fire = () => {
    const day = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
    if (['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(day)) {
      discord.morningBriefing();
    }
    // Reschedule for next day
    setTimeout(fire, 24 * 60 * 60 * 1000);
  };

  setTimeout(fire, msUntil815ET());
  logger.info({ msUntilFire: msUntil815ET() }, 'morning briefing scheduled at 8:15 ET');
}

function scheduleOvernightBriefing(): void {
  // Fire at 9:00 AM ET every weekday.
  // By 9:00 AM all 8:30 news reactions are visible in tick data, giving a
  // clean pre-open read 30 minutes before the 9:30 AM RTH open.
  const nyHour = (): number =>
    parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(Date.now()));

  const nyWeekday = (): string =>
    new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });

  const isWeekday = () => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(nyWeekday());

  const msUntil9amET = (): number => {
    const now = new Date();
    const nyStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
    const ny = new Date(nyStr);
    const target = new Date(nyStr);
    target.setHours(9, 0, 0, 0);
    let ms = target.getTime() - ny.getTime();
    if (ms < 0) ms += 24 * 60 * 60 * 1000;
    return ms + (now.getTime() - ny.getTime());
  };

  const fire = () => {
    if (isWeekday()) { void fireOvernightBriefing('NQ'); void fireOvernightBriefing('ES'); }
    setTimeout(fire, 24 * 60 * 60 * 1000);
  };

  // If already past 9:00 AM and before 4:00 PM ET on a weekday, fire immediately
  // (covers the case where aggregator restarts mid-morning)
  const h = nyHour();
  if (isWeekday() && h >= 9 && h < 16) {
    logger.info('boot after 9:00 ET — firing overnight briefing now');
    void fireOvernightBriefing('NQ');
    void fireOvernightBriefing('ES');
  }

  setTimeout(fire, msUntil9amET());
  logger.info({ msUntilFire: msUntil9amET() }, 'overnight briefing scheduled at 9:00 ET');
}

async function main() {
  logger.info({ activeStrategy: config.activeStrategy }, 'booting aggregator');

  // Load economic calendar
  loadCalendar();
  const todayEvents = getTodayEvents();
  if (todayEvents.length > 0) {
    logger.warn({ events: todayEvents.map(e => e.short).join('+') }, 'HIGH IMPACT NEWS DAY');
  }

  // 8:15 AM ET: econ calendar warning (before 8:30 news)
  scheduleMorningBriefing();
  // 9:00 AM ET: overnight analysis (news reaction already visible, 30 min before open)
  scheduleOvernightBriefing();

  // Load RS morning context (set via: pnpm context:set)
  const rsCtx = loadContext();
  watchContext(); // pick up CLI writes without restarting aggregator
  logger.info({
    greaterMarket: rsCtx.greaterMarket,
    ddRatio: rsCtx.ddRatio,
    vxAboveBBB: rsCtx.vxAboveBBB,
    isRational: rsCtx.isRational,
  }, 'RS context active');

  startLevelsWatcher();
  startFlashAlphaPoller();
  startVXPoller();

  if (config.activeStrategy === 'A' || config.activeStrategy === 'BOTH') {
    startRulesEngine(getLevels, getFlashAlpha);
    logger.info('strategy-A started (bar-based: sweep + divergence)');
  }

  if (config.activeStrategy === 'B' || config.activeStrategy === 'BOTH' || config.activeStrategy === 'ALL') {
    startStrategyB(getLevels);
    logger.info('strategy-B started (tick-based: absorption)');
  }

//   if (config.activeStrategy === 'C' || config.activeStrategy === 'ALL') {
//     // Start price refresh loop before Strategy C
//     setInterval(refreshPrices, 1000);
//     await refreshPrices();
//     startStrategyC(getLevels, getPrice);
//     logger.info('strategy-C started (RS level watcher)');
//   }

  if (config.activeStrategy === 'D' || config.activeStrategy === 'ALL') {
    startStrategyD();
    logger.info('strategy-D started (15-min compression → 5-min entry)');
  }

  if (config.activeStrategy === 'E' || config.activeStrategy === 'ALL') {
    startStrategyE();
    logger.info('strategy-E started (5-min absorption scalp — observe only)');
  }

  if (config.activeStrategy === 'H' || config.activeStrategy === 'ALL') {
    startStrategyH();
    logger.info('strategy-H started (CLEAN impulse: FLIP + CONT, both directions)');
    startStrategyEXPL();
    logger.info('strategy-EXPL started (pre-explosive move detector)');
    startStrategyI();
    logger.info('strategy-I started (passive-seller: short the pop)');
    startStrategyJ();
    logger.info('strategy-J started (TRAP: tick-level seller/buyer trap detector)');
    startStrategyCONT();
    logger.info('strategy-CONT started (trend continuation re-entry)');
  }

  // Passive observers (data collection, no signals emitted)
  startExplShortObserver();

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
      if (config.activeStrategy === 'H' || config.activeStrategy === 'ALL') {
        stopStrategyH();
        stopStrategyEXPL();
        stopStrategyI();
        stopStrategyJ();
        stopStrategyCONT();
      }
      stopExplShortObserver();
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
