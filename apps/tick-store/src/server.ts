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
  // ── LIVE PX fan-out (2026-07-21): the cockpit's live candle needs REAL-TIME price. The
  // Bookmap .log path buffers writes (p80 delivery 2s+ in quiet tape); this ingest stream gets
  // every trade the instant the addon relays it. Subscribers get the freshest price per symbol,
  // throttled to ≥80ms between pushes (trailing flush guarantees the final price always lands).
  const liveSubs = new Set<{ sock: { send: (s: string) => void; readyState: number }; symbol: string }>();
  const pxLast: Record<string, number> = {};
  const pxLastTs: Record<string, number> = {};   // newest trade ts seen per symbol (monotone guard)
  const pxPending: Record<string, { ts: number; price: number } | undefined> = {};
  const pxTimer: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
  const PX_MIN_MS = 80;
  const pushPx = (symbol: string): void => {
    const p = pxPending[symbol];
    if (!p) return;
    pxPending[symbol] = undefined;
    pxLast[symbol] = Date.now();
    const msg = JSON.stringify({ type: 'px', symbol, ts: p.ts, price: p.price });
    for (const s of liveSubs) {
      if (s.symbol !== symbol) continue;
      try { if (s.sock.readyState === 1) s.sock.send(msg); } catch { /* dropped */ }
    }
  };
  const queuePx = (symbol: string, ts: number, price: number): void => {
    pxPending[symbol] = { ts, price };
    const since = Date.now() - (pxLast[symbol] ?? 0);
    if (since >= PX_MIN_MS) { pushPx(symbol); return; }
    if (!pxTimer[symbol]) pxTimer[symbol] = setTimeout(() => { pxTimer[symbol] = undefined; pushPx(symbol); }, PX_MIN_MS - since);
  };

  await app.register(async (scope) => {
    scope.get('/ws/live', { websocket: true }, (socket, req) => {
      const symbol = new URL(req.url ?? '', 'http://x').searchParams.get('symbol') ?? 'NQ';
      const sub = { sock: socket as unknown as { send: (s: string) => void; readyState: number }, symbol };
      liveSubs.add(sub);
      logger.info({ symbol, subs: liveSubs.size }, 'live px subscriber connected');
      socket.on('message', () => { /* pings — keepalive only */ });
      socket.on('close', () => liveSubs.delete(sub));
      socket.on('error', () => liveSubs.delete(sub));
    });

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

          // live px fan-out: forward pass, monotone-ts guard — only genuinely NEWER trades queue,
          // so an already-pushed fresher price can never be followed by a stale one
          for (const e of events) {
            if (e.type !== 'trade') continue;
            if (e.ts <= (pxLastTs[e.symbol] ?? 0)) continue;
            pxLastTs[e.symbol] = e.ts;
            queuePx(e.symbol, e.ts, e.price);
          }

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
