import { config, signalParams } from './config.js';
import { posDb } from './db.js';
import { createHaltFile } from './risk-guard.js';
import { logger } from './logger.js';
import type { TradovateClient } from './broker/tradovate.js';
import type { ConfluenceSignal } from '@trading/contracts';

// Point value per contract ($)
const POINT_VALUE: Record<string, number> = {
  MNQ: 2,
  MES: 1.25,
  NQ:  20,
  ES:  12.5,
};

// Contract name cache: root → current front-month name (e.g. "MNQ" → "MNQM6")
const contractCache = new Map<string, string>();

async function resolveContract(broker: TradovateClient, root: string): Promise<string> {
  if (!contractCache.has(root)) {
    const c = await broker.findContract(root);
    contractCache.set(root, c.name);
    logger.info({ root, contract: c.name }, 'contract resolved');
  }
  return contractCache.get(root)!;
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function handleSignal(broker: TradovateClient, signal: ConfluenceSignal): Promise<void> {
  const { ruleId, direction, symbol, ts: signalTs } = signal as any;

  const params = signalParams(ruleId, direction);
  if (!params) {
    logger.warn({ ruleId, direction }, 'no SL/TP params for signal — skipping');
    return;
  }

  const contractRoot = config.contracts[symbol as 'NQ' | 'ES'];
  if (!contractRoot) {
    logger.warn({ symbol }, 'no contract configured for symbol');
    return;
  }

  const pointValue = POINT_VALUE[contractRoot] ?? 2;
  const posId = posDb.createPosition({
    signal_ts: signalTs,
    symbol,
    rule_id: ruleId,
    direction,
    qty: config.qty,
    sl_pts: params.sl,
    tp_pts: params.tp,
  });

  logger.info({ posId, ruleId, direction, symbol, sl: params.sl, tp: params.tp }, 'position created');

  try {
    // ── 1. Resolve contract ────────────────────────────────────────────────
    const contractName = await resolveContract(broker, contractRoot);

    // ── 2. Place market entry ──────────────────────────────────────────────
    const entryAction = direction === 'long' ? 'Buy' : 'Sell';
    const entryOrderId = await broker.placeMarketOrder({ contractName, action: entryAction, qty: config.qty });
    posDb.setEntryOrder(posId, String(entryOrderId));
    logger.info({ posId, entryOrderId }, 'entry order placed, waiting for fill');

    // ── 3. Wait for fill ───────────────────────────────────────────────────
    const fillPrice = await broker.waitForFill(entryOrderId, 30_000);
    logger.info({ posId, fillPrice, entryOrderId }, 'entry filled');

    // ── 4. Calculate SL/TP prices from actual fill ─────────────────────────
    const slPrice = direction === 'long'
      ? parseFloat((fillPrice - params.sl).toFixed(2))
      : parseFloat((fillPrice + params.sl).toFixed(2));

    const tpPrice = direction === 'long'
      ? parseFloat((fillPrice + params.tp).toFixed(2))
      : parseFloat((fillPrice - params.tp).toFixed(2));

    // ── 5. Place SL (stop) ─────────────────────────────────────────────────
    const closeAction = direction === 'long' ? 'Sell' : 'Buy';
    const slOrderId = await broker.placeStopOrder({
      contractName, action: closeAction, qty: config.qty, stopPrice: slPrice,
    });

    // ── 6. Place TP (limit) ────────────────────────────────────────────────
    const tpOrderId = await broker.placeLimitOrder({
      contractName, action: closeAction, qty: config.qty, limitPrice: tpPrice,
    });

    posDb.setFill(posId, fillPrice, slPrice, tpPrice, String(slOrderId), String(tpOrderId));
    logger.info({ posId, fillPrice, slPrice, tpPrice, slOrderId, tpOrderId }, 'bracket live');

    // ── 7. Monitor for close ───────────────────────────────────────────────
    monitorBracket(broker, posId, entryOrderId, slOrderId, tpOrderId, fillPrice, contractName, closeAction, pointValue, params);
  } catch (err: any) {
    logger.error({ posId, err: err?.message }, 'order flow failed');
    posDb.setStatus(posId, 'error');

    // If we have an open position with no protection — create halt file
    const pos = posDb.getById(posId);
    if (pos?.status === 'filled_entry') {
      logger.error({ posId }, 'UNPROTECTED POSITION — halting trader');
      createHaltFile(`unprotected position id=${posId} symbol=${symbol}`);
    }
  }
}

function monitorBracket(
  broker: TradovateClient,
  posId: number,
  entryOrderId: number,
  slOrderId: number,
  tpOrderId: number,
  fillPrice: number,
  contractName: string,
  closeAction: 'Buy' | 'Sell',
  pointValue: number,
  params: { sl: number; tp: number },
) {
  const pos = posDb.getById(posId);
  if (!pos) return;

  const unsub = broker.onOrderUpdate(async (orderId, status) => {
    if (status !== 'Filled') return;
    if (orderId !== slOrderId && orderId !== tpOrderId) return;

    const isSL = orderId === slOrderId;
    const otherOrderId = isSL ? tpOrderId : slOrderId;

    // Cancel the other leg
    try { await broker.cancelOrder(otherOrderId); } catch { /* already gone */ }
    unsub();

    // Get actual exit price
    let exitPrice = isSL ? pos.sl_price! : pos.tp_price!;
    try {
      const s = await broker.getOrderStatus(orderId);
      if (s?.avgPx) exitPrice = s.avgPx;
    } catch { /* use stored price */ }

    const pnlPts = isSL ? -params.sl : params.tp;
    const pnlUsd = pnlPts * pointValue * config.qty;
    const status_ = isSL ? 'closed_sl' : 'closed_tp';
    const reason  = isSL ? 'SL hit' : 'TP hit';

    posDb.setClosed(posId, status_, exitPrice, reason, pnlPts, pnlUsd);
    logger.info({ posId, reason, exitPrice, pnlPts, pnlUsd }, 'position closed');
  });

  // Watchdog: every 5s verify both SL and TP orders are still live
  const watchdog = setInterval(async () => {
    const current = posDb.getById(posId);
    if (!current || current.status !== 'filled_entry') {
      clearInterval(watchdog);
      return;
    }

    try {
      const [slStatus, tpStatus] = await Promise.all([
        broker.getOrderStatus(slOrderId),
        broker.getOrderStatus(tpOrderId),
      ]);

      if (slStatus?.status === 'Filled') {
        clearInterval(watchdog);
        return;
      }
      if (tpStatus?.status === 'Filled') {
        clearInterval(watchdog);
        return;
      }

      // If either leg is missing (cancelled/rejected), replace it
      if (!slStatus || slStatus.status === 'Cancelled' || slStatus.status === 'Rejected') {
        logger.error({ posId, slOrderId }, 'SL order gone — replacing');
        const newSl = await broker.placeStopOrder({
          contractName, action: closeAction, qty: config.qty, stopPrice: pos.sl_price!,
        });
        posDb.setFill(posId, fillPrice, pos.sl_price!, pos.tp_price!, String(newSl), String(tpOrderId));
        logger.warn({ posId, newSl }, 'SL order replaced');
      }

      if (!tpStatus || tpStatus.status === 'Cancelled' || tpStatus.status === 'Rejected') {
        logger.error({ posId, tpOrderId }, 'TP order gone — replacing');
        const newTp = await broker.placeLimitOrder({
          contractName, action: closeAction, qty: config.qty, limitPrice: pos.tp_price!,
        });
        posDb.setFill(posId, fillPrice, pos.sl_price!, pos.tp_price!, String(slOrderId), String(newTp));
        logger.warn({ posId, newTp }, 'TP order replaced');
      }
    } catch (err) {
      logger.warn({ posId, err }, 'watchdog check failed');
    }
  }, 5_000);
}
