import 'dotenv/config';
import { config } from './config.js';
import { logger } from './logger.js';
import { posDb } from './db.js';
import { checkCanTrade } from './risk-guard.js';
import { TradovateClient } from './broker/tradovate.js';
import { handleSignal } from './order-manager.js';
import { startSignalGate } from './signal-gate.js';
import type { ConfluenceSignal } from '@trading/contracts';

async function main() {
  logger.info({ mode: config.mode, rules: config.enabledRules }, '═══ trader starting ═══');

  // ── Broker setup ───────────────────────────────────────────────────────────
  const broker = new TradovateClient();
  await broker.authenticate();
  await broker.loadAccount();
  await broker.connectWebSocket();
  logger.info({ account: broker.account }, 'broker ready');

  // ── Resume any open positions from a previous run ─────────────────────────
  const open = posDb.openPositions();
  if (open.length > 0) {
    logger.warn({ count: open.length }, 'found open positions from previous run — watchdog will monitor them');
    // Don't auto-close: the broker bracket is still live. Watchdog in order-manager
    // handles them if/when a new signal arrives and re-attaches listeners.
    // For now, log them and wait.
    for (const p of open) {
      logger.warn({ id: p.id, symbol: p.symbol, status: p.status, fill: p.fill_price }, 'open position');
    }
  }

  // ── Signal gate ────────────────────────────────────────────────────────────
  startSignalGate(async (signal: ConfluenceSignal) => {
    const block = checkCanTrade(signal.ts);
    if (block) {
      logger.info({ block, ruleId: (signal as any).ruleId, direction: signal.direction }, 'trade blocked');
      return;
    }

    logger.info(
      { ruleId: (signal as any).ruleId, direction: signal.direction, symbol: signal.symbol },
      '▶ executing trade'
    );

    // Fire-and-forget — handleSignal manages its own error handling
    handleSignal(broker, signal).catch((err) => {
      logger.error({ err }, 'handleSignal threw unexpectedly');
    });
  });

  logger.info('trader ready — listening for signals');

  // ── Startup summary ────────────────────────────────────────────────────────
  const todayPnl = posDb.todayPnl();
  logger.info(
    {
      mode:          config.mode,
      account:       broker.account.name,
      enabledRules:  config.enabledRules,
      qty:           config.qty,
      maxDailyLoss:  config.risk.maxDailyLoss,
      todayPnl,
    },
    'trader configuration'
  );
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal startup error');
  process.exit(1);
});
