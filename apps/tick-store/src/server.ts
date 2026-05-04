import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { tickDb } from './db.js';
import { logger } from './logger.js';
import type { TickBatch, TickEvent } from '@trading/contracts';

const PORT = parseInt(process.env.TICK_STORE_PORT ?? '8788', 10);
const HOST = process.env.TICK_STORE_HOST ?? '127.0.0.1';

export async function startServer(): Promise<void> {
  const app = Fastify({ logger: false });
  await app.register(websocket);

  // Liveness/health
  app.get('/health', async () => ({
    ok: true,
    trades: tickDb.tradeCount(),
    depth: tickDb.depthCount(),
    uptimeSec: Math.floor(process.uptime()),
  }));

  // Range query: trades
  app.get('/trades', async (req) => {
    const q = req.query as { symbol?: string; from?: string; to?: string };
    const symbol = q.symbol ?? 'NQ';
    const from = parseInt(q.from ?? '0', 10);
    const to = parseInt(q.to ?? `${Date.now()}`, 10);
    const trades = tickDb.getTrades(symbol, from, to);
    return { symbol, from, to, count: trades.length, trades };
  });

  // Range query: depth
  app.get('/depth', async (req) => {
    const q = req.query as { symbol?: string; from?: string; to?: string };
    const symbol = q.symbol ?? 'NQ';
    const from = parseInt(q.from ?? '0', 10);
    const to = parseInt(q.to ?? `${Date.now()}`, 10);
    const events = tickDb.getDepth(symbol, from, to);
    return { symbol, from, to, count: events.length, events };
  });

  // Ingest endpoint: addon connects here and streams tick batches.
  // Failure isolation: if this connection drops or this process crashes,
  // the aggregator's signal pipeline is unaffected. Bookmap addon will
  // auto-reconnect via existing WSSender retry logic.
  await app.register(async (scope) => {
    scope.get('/ws/ticks', { websocket: true }, (socket) => {
      logger.info('addon connected to tick stream');
      let batchCount = 0;
      let totalTrades = 0;
      let totalDepth = 0;

      socket.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString()) as TickBatch | { type: 'heartbeat' };

          // Heartbeats keep liveness alive but don't carry data
          if (msg.type === 'heartbeat') return;

          if (msg.type !== 'batch' || !Array.isArray(msg.events)) {
            logger.warn({ type: (msg as { type?: string }).type }, 'unexpected payload type');
            return;
          }

          // Filter to known event types defensively
          const events = msg.events.filter(
            (e: TickEvent) => e.type === 'trade' || e.type === 'depth',
          );
          if (events.length === 0) return;

          const result = tickDb.writeBatch(events);
          batchCount++;
          totalTrades += result.trades;
          totalDepth += result.depth;

          // Periodic stats log so we can watch ingest rate without spamming
          if (batchCount % 100 === 0) {
            logger.info(
              { batches: batchCount, trades: totalTrades, depth: totalDepth },
              'ingest stats',
            );
          }
        } catch (err) {
          logger.warn({ err }, 'malformed batch from addon');
        }
      });

      socket.on('close', () => {
        logger.info(
          { batches: batchCount, trades: totalTrades, depth: totalDepth },
          'addon tick stream disconnected',
        );
      });

      socket.on('error', (err: Error) => {
        logger.warn({ err }, 'addon tick stream error');
      });
    });
  });

  await app.listen({ port: PORT, host: HOST });
  logger.info({ port: PORT, host: HOST }, 'tick-store listening');
}
