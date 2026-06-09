import 'dotenv/config';
import { config } from './config.js';
import { logger } from './logger.js';
import { posDb } from './db.js';
import { checkCanTrade } from './risk-guard.js';
import { TradovateClient } from './broker/tradovate.js';
import { handleSignal, handleV3Close, warmContractCache } from './order-manager.js';
import { startSignalGate } from './signal-gate.js';
import { startPositionWatcher } from './position-watcher.js';
import { notify } from './notify.js';
import type { ConfluenceSignal } from '@trading/contracts';

async function main() {
  logger.info({ mode: config.mode, rules: config.enabledRules }, '═══ trader starting ═══');

  // ── Broker setup ───────────────────────────────────────────────────────────
  const broker = new TradovateClient();
  await broker.authenticate();
  await broker.loadAccount();
  // WS connect with exponential backoff — Tradovate 429s on rapid reconnects.
  // Without this the trader fatal-exits on a single 429 and tsx watch doesn't
  // auto-restart it (waits for a file change). Backoff: 5,10,20,40,60,60,...
  // capped at 60s, max ~20 attempts (~15 min total) before giving up.
  await connectWithBackoff(broker);
  logger.info({ account: broker.account }, 'broker ready');

  // Pre-warm front-month contract caches (MNQ + MES). Lets the
  // position-watcher map contractId→symbol from the very first WS update,
  // even if the trader restarted with a stale open position.
  await warmContractCache(broker);

  // ── Position-watcher (orphan-bracket safety net) ───────────────────────────
  // Cancels any working exit orders when a contract's net position hits 0 by
  // any path (manual flatten, mobile-app close, opposing fill, risk liquidate).
  // Tradovate's OCO/OSO brackets only link siblings to each other — they do
  // NOT auto-cancel when the position is closed externally. This watcher is
  // the safety net for that gap.
  const stopWatcher = startPositionWatcher(broker);
  const shutdown = (sig: string) => {
    logger.warn({ signal: sig }, '═══ trader stopping ═══');
    stopWatcher();
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

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
    const block = checkCanTrade(signal.ts, signal.direction as 'long' | 'short');
    if (block) {
      logger.info({ block, ruleId: (signal as any).ruleId, direction: signal.direction }, 'trade blocked');
      // Notify Discord on data-driven TOD blocks (these matter — user may want to know).
      // RTH/news/halt/maxPositions/duplicate are intentionally silent.
      if (block === 'flip_long_pre_1030' || block === 'after_1430_stop' || block === 'daily_loss_limit') {
        notify.block({
          ruleId: (signal as any).ruleId,
          direction: signal.direction,
          symbol: signal.symbol,
          blockReason: block,
        });
      }
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
  }, async (evt) => {
    // V3 trade-close event handler (opposing-signal exit, bell close, etc.)
    // Cancel pending SL/TP + market-flatten the position.
    logger.info(
      { symbol: evt.trade.symbol, direction: evt.trade.direction, reason: evt.reason, exitPx: evt.exitPx },
      '◀ V3 close — flattening position'
    );
    handleV3Close(broker, evt).catch((err) => {
      logger.error({ err }, 'handleV3Close threw unexpectedly');
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

  notify.startup({
    mode: config.mode,
    rules: config.enabledRules,
    lossLimit: config.risk.maxDailyLoss,
  });
}

async function connectWithBackoff(broker: TradovateClient): Promise<void> {
  const delays = [5_000, 10_000, 20_000, 40_000];
  const maxDelay = 60_000;
  const maxAttempts = 20;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await broker.connectWebSocket();
      return;
    } catch (err: any) {
      const wait = delays[attempt - 1] ?? maxDelay;
      const is429 = String(err?.message ?? '').includes('429');
      logger.warn(
        { attempt, maxAttempts, waitMs: wait, is429, err: err?.message },
        is429
          ? 'Tradovate rate-limited (429) on WS connect — backing off'
          : 'Tradovate WS connect failed — backing off'
      );
      if (attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal startup error');
  process.exit(1);
});
