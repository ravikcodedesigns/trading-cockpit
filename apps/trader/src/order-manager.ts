import { config, signalParams } from './config.js';
import { posDb } from './db.js';
import { createHaltFile } from './risk-guard.js';
import { logger } from './logger.js';
import { discord } from './discord.js';
import type { TradovateClient } from './broker/tradovate.js';
import type { ConfluenceSignal } from '@trading/contracts';
import type { TradeCloseEvent } from './signal-gate.js';

// Point value per contract ($)
const POINT_VALUE: Record<string, number> = {
  MNQ: 2,
  MES: 1.25,
  NQ:  20,
  ES:  12.5,
};

// Contract name cache: root → current front-month name (e.g. "MNQ" → "MNQM6")
const contractCache = new Map<string, string>();

// Reverse lookup so position-watcher can map a broker-side contractId back to
// the cockpit symbol (NQ/ES). Without this, the watcher can't tell which
// positions.db row to mark closed when the broker reports a flat transition.
const contractIdToSymbol = new Map<number, 'NQ' | 'ES'>();

// Exposed so position-watcher can resolve contractId → cockpit symbol.
export function getSymbolForContractId(contractId: number): 'NQ' | 'ES' | null {
  return contractIdToSymbol.get(contractId) ?? null;
}

async function resolveContract(broker: TradovateClient, root: string): Promise<string> {
  if (!contractCache.has(root)) {
    const c = await broker.findContract(root);
    contractCache.set(root, c.name);
    // Reverse map: MNQ contract id → 'NQ' (cockpit symbol)
    const symbol: 'NQ' | 'ES' = root === config.contracts.ES ? 'ES' : 'NQ';
    contractIdToSymbol.set(c.id, symbol);
    logger.info({ root, contract: c.name, contractId: c.id, symbol }, 'contract resolved');
  }
  return contractCache.get(root)!;
}

// Pre-warm both MNQ and MES contract caches at startup. Called from index.ts
// so the position-watcher can map contractId→symbol even when a flat
// transition fires before any signal has been processed (e.g. trader
// restart with stale open position).
export async function warmContractCache(broker: TradovateClient): Promise<void> {
  await Promise.all([
    resolveContract(broker, config.contracts.NQ),
    resolveContract(broker, config.contracts.ES),
  ]);
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

  // Track entry-fill state locally so the catch block can detect an
  // unprotected position even if we never got to setFill.
  let entryFilled = false;
  let entryFillPrice: number | null = null;

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
    entryFilled = true;
    entryFillPrice = fillPrice;
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

    // Discord OPEN notification
    discord.open({
      ruleId, direction, symbol: contractRoot,
      entry: fillPrice, tp: tpPrice, sl: slPrice,
      pointValue, qty: config.qty,
    });

    // ── 7. Monitor for close ───────────────────────────────────────────────
    monitorBracket(broker, posId, entryOrderId, slOrderId, tpOrderId, fillPrice, contractName, closeAction, pointValue, params, ruleId, direction, contractRoot);
  } catch (err: any) {
    logger.error({ posId, entryFilled, entryFillPrice, err: err?.message }, 'order flow failed');
    discord.reject({ ruleId, direction, symbol: contractRoot, reason: err?.message ?? String(err) });

    // If we got the entry fill but never attached the bracket — position is
    // naked. Record the fill price (so position-watcher can compute PnL when
    // the broker reports flat) and halt the trader.
    if (entryFilled && entryFillPrice !== null) {
      posDb.setErrorWithFill(posId, entryFillPrice);
      logger.error({ posId, entryFillPrice }, 'UNPROTECTED POSITION — halting trader');
      createHaltFile(`unprotected position id=${posId} symbol=${symbol} fillPrice=${entryFillPrice}`);
      discord.halt(`unprotected position posId=${posId} symbol=${symbol} fill=${entryFillPrice} — FLATTEN MANUALLY then clear /tmp/trader.halt`);
    } else {
      // No fill yet (e.g. placeMarketOrder threw, or waitForFill timed out).
      // Mark plain 'error' so position-watcher ignores it.
      posDb.setStatus(posId, 'error');
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
  ruleId: string,
  direction: 'long' | 'short',
  contractRoot: string,
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

    discord.close({
      reason: isSL ? 'SL_HIT' : 'TP_HIT',
      ruleId, direction, symbol: contractRoot,
      exitPx: exitPrice, pnlPts, pnlUsd,
    });
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

// ── V3 trade-close handler ────────────────────────────────────────────────────
// Triggered when the aggregator's V3 framework decides to close an open trade
// (opposing-signal exit, RTH bell close, etc.).
//
// Order of operations is CRITICAL to avoid double-fill races:
//   1. Cancel SL order (so it doesn't fill while we're flattening)
//   2. Cancel TP order (same)
//   3. Place market order to flatten
//   4. Wait for fill confirmation
//   5. Update local position DB
//   6. (Discord notification fires from the trade-close event downstream)
//
// If a TP or SL has ALREADY filled before we receive the close event, the
// position-watcher will catch the orphan bracket leg and clean it up.
export async function handleV3Close(broker: TradovateClient, evt: TradeCloseEvent): Promise<void> {
  const { symbol, direction } = evt.trade;
  const contractRoot = config.contracts[symbol as 'NQ' | 'ES'];
  if (!contractRoot) {
    logger.warn({ symbol }, 'V3 close: no contract configured for symbol — skipping');
    return;
  }
  const pointValue = POINT_VALUE[contractRoot] ?? 2;

  // Find the open position for this symbol. If none, nothing to do —
  // V3 may have closed something the trader never opened (e.g. stale state).
  const openPos = posDb.openPositions().filter(p => p.symbol === symbol && p.status === 'filled_entry');
  if (openPos.length === 0) {
    logger.info({ symbol, reason: evt.reason }, 'V3 close: no open position for symbol — nothing to flatten');
    return;
  }
  if (openPos.length > 1) {
    logger.warn({ symbol, count: openPos.length }, 'V3 close: multiple open positions for symbol — closing all');
  }

  const contractName = await resolveContract(broker, contractRoot);
  const closeAction: 'Buy' | 'Sell' = direction === 'long' ? 'Sell' : 'Buy';

  for (const pos of openPos) {
    logger.info({ posId: pos.id, symbol, reason: evt.reason, exitPxHint: evt.exitPx }, 'V3 close: starting flatten sequence');

    // 1+2. Cancel SL and TP (race-safe: do these before placing market order)
    if (pos.sl_order_id) {
      try { await broker.cancelOrder(parseInt(pos.sl_order_id, 10)); }
      catch (err) { logger.warn({ posId: pos.id, slOrderId: pos.sl_order_id, err }, 'V3 close: SL cancel failed (already gone?)'); }
    }
    if (pos.tp_order_id) {
      try { await broker.cancelOrder(parseInt(pos.tp_order_id, 10)); }
      catch (err) { logger.warn({ posId: pos.id, tpOrderId: pos.tp_order_id, err }, 'V3 close: TP cancel failed (already gone?)'); }
    }

    // 3. Place market order to flatten
    let exitFill: number | null = null;
    try {
      const closeOrderId = await broker.placeMarketOrder({ contractName, action: closeAction, qty: pos.qty });
      logger.info({ posId: pos.id, closeOrderId }, 'V3 close: market order placed, waiting for fill');

      // 4. Wait for fill confirmation
      exitFill = await broker.waitForFill(closeOrderId, 15_000);
    } catch (err: any) {
      logger.error({ posId: pos.id, err: err?.message }, 'V3 close: market flatten failed — position MAY still be open');
      createHaltFile(`V3 close failed posId=${pos.id} symbol=${symbol} err=${err?.message ?? err}`);
      discord.halt(`V3 close flatten failed posId=${pos.id} symbol=${symbol} err=${err?.message ?? err}`);
      continue;
    }

    // 5. Update local DB
    const exitPx = exitFill ?? evt.exitPx;
    const pnlPts = direction === 'long' ? exitPx - (pos.fill_price ?? 0) : (pos.fill_price ?? 0) - exitPx;
    const pnlUsd = pnlPts * pointValue * pos.qty;
    const status = evt.reason === 'OPP_SIG_EXIT' ? 'closed_opp' :
                   evt.reason === 'CLOSE_AT_BELL' ? 'closed_bell' :
                   evt.reason === 'TP_HIT' ? 'closed_tp' : 'closed_sl';

    posDb.setClosed(pos.id, status, exitPx, evt.reason, pnlPts, pnlUsd);
    logger.info({ posId: pos.id, reason: evt.reason, exitPx, pnlPts, pnlUsd }, 'V3 close: position flattened + recorded');

    discord.close({
      reason: evt.reason,
      ruleId: pos.rule_id, direction, symbol: contractRoot,
      exitPx, pnlPts, pnlUsd,
    });
  }
}
