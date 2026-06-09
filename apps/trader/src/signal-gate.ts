import WebSocket from 'ws';
import { config } from './config.js';
import { logger } from './logger.js';
import type { CockpitMessage, ConfluenceSignal } from '@trading/contracts';

type SignalHandler = (signal: ConfluenceSignal) => void;
// V3 trade-close event broadcast over the cockpit WS. Shape mirrors
// aggregator's CloseEvent (see apps/aggregator/src/trade-manager.ts).
export interface TradeCloseEvent {
  trade: {
    symbol: string;
    signalId: number;
    ruleId: string;
    pattern: string | null;
    direction: 'long' | 'short';
    entry: number;
    openTs: number;
  };
  exitPx: number;
  exitTs: number;
  reason: 'TP_HIT' | 'SL_HIT' | 'OPP_SIG_EXIT' | 'CLOSE_AT_BELL';
  closingSignalId: number | null;
  pnlPts: number;
}
type TradeCloseHandler = (evt: TradeCloseEvent) => void;

// Lightweight gate state exposed for diagnostics (used by the halt-file watcher
// in index.ts to confirm trader health on resume). Updated by ws open/close events.
export const signalGateState = { connected: false };

export function startSignalGate(onSignal: SignalHandler, onTradeClose?: TradeCloseHandler): void {
  // Dedup key: ts|symbol|ruleId|direction. NOT ts alone.
  // 2026-06-08: ts-only dedup caused us to miss the 10:01 NQ clean-impulse
  // FLIP long because an ES `trap` signal fired at the exact same second and
  // consumed the dedup slot before the enabled-rules check could be reached.
  const seen = new Set<string>();
  const keyOf = (s: { ts: number; symbol: string; ruleId?: string; rule_id?: string; direction: string }) =>
    `${s.ts}|${s.symbol}|${s.ruleId ?? s.rule_id ?? ''}|${s.direction}`;
  let reconnectDelay = 2_000;

  function connect() {
    logger.info({ url: config.aggregatorWs }, 'connecting to aggregator');
    const ws = new WebSocket(config.aggregatorWs);

    ws.on('open', () => {
      reconnectDelay = 2_000;
      signalGateState.connected = true;
      logger.info('signal gate connected');
    });

    ws.on('message', (raw: Buffer) => {
      let msg: CockpitMessage;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // On snapshot: pre-seed recently seen signals (so restarts don't re-fire stale signals)
      if (msg.type === 'snapshot') {
        for (const sig of msg.state.recentSignals) {
          seen.add(keyOf(sig as unknown as Parameters<typeof keyOf>[0]));
        }
        logger.info({ count: msg.state.recentSignals.length }, 'signal gate: snapshot seeded');
        return;
      }

      // V3 trade-close event — opposing-signal exit, bell-close, etc.
      if ((msg as any).type === 'trade-close') {
        const evt = (msg as any).evt as TradeCloseEvent;
        logger.info(
          { symbol: evt.trade.symbol, direction: evt.trade.direction, reason: evt.reason, exitPx: evt.exitPx, pnlPts: evt.pnlPts },
          'signal gate: V3 trade-close received'
        );
        if (onTradeClose) onTradeClose(evt);
        return;
      }

      if (msg.type !== 'signal') return;

      const signal = msg.signal;
      const ruleId = (signal as any).ruleId ?? (signal as any).rule_id ?? '';

      // Only act on enabled rules — checked BEFORE dedup so a dropped rule
      // can't consume the dedup slot for an enabled rule at the same ts.
      if (!config.enabledRules.includes(ruleId)) return;

      // Dedup (composite key — see top-of-function comment)
      const key = keyOf({ ts: signal.ts, symbol: signal.symbol, ruleId, direction: signal.direction });
      if (seen.has(key)) return;
      seen.add(key);

      // For clean-impulse: only FLIP pattern (not CONT)
      if (ruleId === 'clean-impulse' && (signal as any).pattern !== 'FLIP') return;

      // Only gold-tier (aggregator already filters, but be explicit)
      // Signals from /ws/cockpit are always gold — silenced ones never reach here.

      // Age gate: ignore signals older than 3 minutes (stale on restart)
      if (Date.now() - signal.ts > 3 * 60_000) {
        logger.debug({ ts: signal.ts, ruleId }, 'stale signal ignored');
        return;
      }

      logger.info(
        { ts: signal.ts, ruleId, direction: signal.direction, symbol: signal.symbol, score: signal.score },
        'signal gate: new signal'
      );
      onSignal(signal);
    });

    ws.on('close', () => {
      signalGateState.connected = false;
      logger.warn({ reconnectDelay }, 'signal gate disconnected — reconnecting');
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    });

    ws.on('error', (err) => {
      logger.warn({ err }, 'signal gate WS error');
    });

    // Keep-alive ping every 20s (matches cockpit's pattern)
    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 20_000);

    ws.on('close', () => clearInterval(ping));
  }

  connect();
}
