// Position-watcher — orphan-bracket safety net.
//
// Tradovate's OCO/OSO brackets link siblings to each other (one fills → other
// cancels), but they do NOT auto-cancel when the underlying position is closed
// by some other path (manual flatten, mobile-app close, risk auto-liquidate,
// even a separate opposite order). The leftover exit orders sit in the book and
// can later fire on a price spike, opening an unintended reverse position.
//
// This watcher subscribes to Tradovate's WebSocket position feed, tracks the
// last known netPos per contractId, and when a contract transitions from
// |netPos|>0 to netPos=0 it cancels any working exit orders for that contract.
//
// Wire it into the trader once after `broker.connectWebSocket()`:
//   const stop = startPositionWatcher(broker);
//   // ... later, to dismantle: stop();
//
// Safe to run continuously. Cancellations are idempotent at Tradovate's end —
// re-cancelling an already-canceled order is a no-op.

import type { TradovateClient } from './broker/tradovate.js';
import { logger } from './logger.js';
import { discord } from './discord.js';
import { posDb } from './db.js';
import { getSymbolForContractId } from './order-manager.js';

interface PosSnapshot {
  netPos: number;
  netPrice: number | null;
  lastTs: number;
}

export function startPositionWatcher(broker: TradovateClient): () => void {
  // contractId → last observed snapshot
  const lastByContract = new Map<number, PosSnapshot>();

  // REST-prime: load current open positions so cold-start has prior snapshots.
  // Without this, when the user flattens a position that existed BEFORE the
  // watcher started, the watcher's `prev` is undefined and the open→flat
  // transition is missed.
  (async () => {
    try {
      const positions = await (broker as any).get('/position/list') as Array<{
        id: number; contractId: number; netPos: number; netPrice: number | null;
      }>;
      let primed = 0;
      for (const p of positions) {
        if (p.netPos !== 0) {
          lastByContract.set(p.contractId, {
            netPos: p.netPos,
            netPrice: p.netPrice,
            lastTs: Date.now(),
          });
          primed++;
        }
      }
      if (primed) {
        logger.info({ primed, contracts: Array.from(lastByContract.keys()) },
          'position-watcher: REST-primed with existing open positions');
      } else {
        logger.info('position-watcher: REST-prime found no open positions');
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'position-watcher: REST-prime failed (will rely on WS only)');
    }
  })();

  // Debounce: when we see netPos=0, give Tradovate a moment to deliver the
  // sibling-cancel from a normal OCO fill before we sweep. Otherwise we'd race
  // and cancel the same order Tradovate is already canceling, which is harmless
  // but noisy.
  const PENDING_SWEEP_DELAY_MS = 1500;
  const pendingSweeps = new Map<number, ReturnType<typeof setTimeout>>();

  async function sweepOrphans(contractId: number, prevSnap: PosSnapshot | undefined) {
    pendingSweeps.delete(contractId);
    try {
      // ── 1. Cancel any orphan working orders (SL/TP still on book) ─────
      const workingOrders = await broker.getWorkingOrdersForContract(contractId);
      if (workingOrders.length > 0) {
        logger.warn(
          { contractId, orderIds: workingOrders.map(o => o.id) },
          `position-watcher: flat with ${workingOrders.length} orphan order(s) — canceling`,
        );
        discord.orphan({
          symbol: `contractId=${contractId}`,
          detail: `${workingOrders.length} orphan order(s) detected — canceling: ${workingOrders.map(o => `${o.id}/${o.action}`).join(', ')}`,
        });
        for (const o of workingOrders) {
          try {
            const res = await broker.cancelOrder(o.id);
            logger.info({ orderId: o.id, action: o.action, contractId, res }, 'position-watcher: cancelled orphan');
          } catch (err: any) {
            logger.error({ err: err.message, orderId: o.id }, 'position-watcher: cancel failed');
          }
        }
      } else {
        logger.debug({ contractId }, 'position-watcher: flat & no working orders');
      }

      // ── 2. Update DB so positions.openPositions() reflects reality ────
      // Without this, max_positions silently blocks new signals because the
      // DB row stays in 'filled_entry' indefinitely after a manual flatten,
      // an externally-fired stop, or any close path that doesn't go through
      // our own monitorBracket() fill listener.
      const symbol = getSymbolForContractId(contractId);
      if (!symbol) {
        logger.warn({ contractId }, 'position-watcher: no symbol mapping — DB row not updated. cache not warmed?');
        return;
      }
      const open = posDb.filledPositionsForSymbol(symbol);
      if (open.length === 0) {
        logger.debug({ contractId, symbol }, 'position-watcher: no open DB rows to close');
        return;
      }
      for (const pos of open) {
        // 2026-06-04 fix: previously used prevSnap.netPrice as exit price,
        // but netPrice is the broker's net-position avg (= entry price for
        // a 1-qty trade), NOT the actual close fill. That made every
        // closed_external row land with PnL = 0 (the row 12 TP_HIT bug).
        // Fix: query the broker for the most recent opposite-action fill.
        const closeAction: 'Buy' | 'Sell' = pos.direction === 'long' ? 'Sell' : 'Buy';
        let exitPx: number | null = null;
        try {
          const f = await broker.getMostRecentFill(contractId, closeAction);
          if (f) exitPx = f.price;
        } catch (err: any) {
          logger.warn({ err: err?.message, posId: pos.id }, 'position-watcher: fill lookup failed; falling back to netPrice');
        }
        // Fallback if fill lookup failed: still useful for max_positions
        // unblock but PnL will be 0. Better than nothing.
        if (exitPx === null) exitPx = prevSnap?.netPrice ?? null;

        const fillPx = pos.fill_price ?? null;
        const pnlPts = fillPx !== null && exitPx !== null
          ? (pos.direction === 'long' ? exitPx - fillPx : fillPx - exitPx)
          : 0;
        // MNQ=$2/pt, MES=$1.25/pt. Match POINT_VALUE in order-manager.
        const pointValue = symbol === 'NQ' ? 2 : 1.25;
        const pnlUsd = pnlPts * pointValue * pos.qty;
        posDb.setClosed(pos.id, 'closed_external', exitPx ?? 0, 'position-watcher detected flat transition', pnlPts, pnlUsd);
        logger.warn(
          { posId: pos.id, symbol, direction: pos.direction, fillPx, exitPx, pnlPts, pnlUsd },
          'position-watcher: marked DB row closed_external',
        );
      }
    } catch (err: any) {
      logger.error({ err: err.message, contractId }, 'position-watcher: sweep failed');
    }
  }

  const unsub = broker.onPositionUpdate((pos) => {
    const prev = lastByContract.get(pos.contractId);
    const nowSnap: PosSnapshot = {
      netPos: pos.netPos,
      netPrice: pos.netPrice,
      lastTs: pos.timestamp ? new Date(pos.timestamp).getTime() : Date.now(),
    };
    lastByContract.set(pos.contractId, nowSnap);

    // Edge: position transitioned from open → flat
    const wasOpen = prev && Math.abs(prev.netPos) > 0;
    const nowFlat = pos.netPos === 0;
    if (wasOpen && nowFlat) {
      logger.info(
        { contractId: pos.contractId, prevNetPos: prev.netPos, prevNetPrice: prev.netPrice },
        'position-watcher: flat transition detected — scheduling orphan sweep',
      );
      // Debounce: replace any existing pending sweep for this contract
      const existing = pendingSweeps.get(pos.contractId);
      if (existing) clearTimeout(existing);
      // Capture prev snapshot for exit-price hint inside the timer closure.
      const prevSnap = prev;
      pendingSweeps.set(
        pos.contractId,
        setTimeout(() => sweepOrphans(pos.contractId, prevSnap), PENDING_SWEEP_DELAY_MS),
      );
    }
  });

  logger.info('position-watcher: started');

  return function stop() {
    unsub();
    for (const t of pendingSweeps.values()) clearTimeout(t);
    pendingSweeps.clear();
    lastByContract.clear();
    logger.info('position-watcher: stopped');
  };
}
