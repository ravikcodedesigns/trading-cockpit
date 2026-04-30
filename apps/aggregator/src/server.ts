import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { logger } from './logger.js';
import { state } from './state.js';
import { ingest } from './ingest.js';
import { db } from './db.js';
import type { CockpitMessage, SourceName } from '@trading/contracts';

const VALID_SOURCES: SourceName[] = ['bookmap', 'flashalpha', 'tradovate'];

export async function startServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket, {
    options: {
      maxPayload: 1024 * 64,
      // Heartbeat handled per-connection below
    },
  });

  // CORS for the cockpit (Vite dev server on port 5173 calling aggregator
  // on port 8787 = cross-origin). Without this, browsers silently drop
  // fetch responses even when the server returns 200. Permissive policy
  // is fine here because the aggregator only binds to 127.0.0.1; nothing
  // outside the local machine can reach it.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      reply.code(204).send();
    }
  });

  app.get('/health', async () => ({
    ok: true,
    uptimeSec: Math.floor(process.uptime()),
    eventsLogged: db.eventCount(),
    connections: state.connectionStatus(),
  }));

  // Returns deduplicated bar history for a symbol. Used by the cockpit
  // chart on initial mount to populate historical bars before live WS
  // updates start streaming. Without this, a browser refresh wipes the
  // chart and bars only repopulate from current minute onward.
  app.get('/history/bars', async (req) => {
    const q = req.query as { symbol?: string; minutes?: string };
    const symbol = q.symbol ?? 'NQ';
    const minutes = Math.max(1, Math.min(720, parseInt(q.minutes ?? '60', 10) || 60));
    const sinceMs = Date.now() - minutes * 60 * 1000;
    const bars = db.recentBars(symbol, sinceMs);
    return { symbol, minutes, count: bars.length, bars };
  });

  // --- Source ingest endpoint ---
  // Expects: ws://host/ws/sources?source=bookmap
  app.register(async (scope) => {
    scope.get('/ws/sources', { websocket: true }, (socket, req) => {
      const sourceParam = (req.query as { source?: string }).source;
      if (!sourceParam || !VALID_SOURCES.includes(sourceParam as SourceName)) {
        logger.warn({ sourceParam }, 'rejected source connection');
        socket.close(1008, 'invalid source');
        return;
      }
      const source = sourceParam as SourceName;
      logger.info({ source }, 'source connected');
      state.setConnection(source, 'connected');

      // App-level liveness: the source is expected to send {"type":"heartbeat"}
      // every 5s. If we haven't received any message at all for 30s, we
      // declare the connection dead. This replaces the previous WS-protocol
      // ping/pong which Python's websocket-client doesn't auto-pong, causing
      // false-positive terminations every 30-60s.
      let lastSeen = Date.now();
      const liveness = setInterval(() => {
        if (Date.now() - lastSeen > 30_000) {
          logger.warn({ source, idleMs: Date.now() - lastSeen }, 'source idle timeout, terminating');
          try { socket.terminate(); } catch { /* socket closing */ }
        }
      }, 10_000);

      socket.on('message', (raw: Buffer) => {
        lastSeen = Date.now();
        try {
          const msg = JSON.parse(raw.toString());
          ingest(source, msg);
        } catch (err) {
          logger.warn({ err, source }, 'bad source payload');
        }
      });

      socket.on('close', () => {
        clearInterval(liveness);
        logger.info({ source }, 'source disconnected');
        state.setConnection(source, 'disconnected');
      });

      socket.on('error', (err: Error) => {
        logger.warn({ err, source }, 'source socket error');
      });
    });
  });

  // --- Cockpit subscriber endpoint ---
  // Pushes initial snapshot, then live event/connection updates.
  app.register(async (scope) => {
    scope.get('/ws/cockpit', { websocket: true }, (socket) => {
      logger.info('cockpit connected');

      const send = (msg: CockpitMessage) => {
        try { socket.send(JSON.stringify(msg)); } catch { /* socket closing */ }
      };

      // Initial snapshot
      send({ type: 'snapshot', state: state.snapshot() });

      const unsubEvent = state.onEvent((event) => {
        send({ type: 'event', event });
      });
      const unsubConn = state.onConnection(({ source, status }) => {
        send({ type: 'connection', source, status });
      });

      socket.on('close', () => {
        unsubEvent();
        unsubConn();
        logger.info('cockpit disconnected');
      });
      socket.on('error', (err: Error) => {
        logger.warn({ err }, 'cockpit socket error');
      });
    });
  });

  await app.listen({ port: config.port, host: '127.0.0.1' });
  logger.info({ port: config.port }, 'server listening');
  return app;
}
