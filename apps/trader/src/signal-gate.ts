import WebSocket from 'ws';
import { config } from './config.js';
import { logger } from './logger.js';
import type { CockpitMessage, ConfluenceSignal } from '@trading/contracts';

type SignalHandler = (signal: ConfluenceSignal) => void;

export function startSignalGate(onSignal: SignalHandler): void {
  const seen = new Set<number>(); // dedup by signal ts
  let reconnectDelay = 2_000;

  function connect() {
    logger.info({ url: config.aggregatorWs }, 'connecting to aggregator');
    const ws = new WebSocket(config.aggregatorWs);

    ws.on('open', () => {
      reconnectDelay = 2_000;
      logger.info('signal gate connected');
    });

    ws.on('message', (raw: Buffer) => {
      let msg: CockpitMessage;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // On snapshot: pre-seed recently seen signals (so restarts don't re-fire stale signals)
      if (msg.type === 'snapshot') {
        for (const sig of msg.state.recentSignals) {
          seen.add(sig.ts);
        }
        logger.info({ count: msg.state.recentSignals.length }, 'signal gate: snapshot seeded');
        return;
      }

      if (msg.type !== 'signal') return;

      const signal = msg.signal;

      // Dedup
      if (seen.has(signal.ts)) return;
      seen.add(signal.ts);

      const ruleId = (signal as any).ruleId ?? (signal as any).rule_id ?? '';

      // Only act on enabled rules
      if (!config.enabledRules.includes(ruleId)) return;

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
