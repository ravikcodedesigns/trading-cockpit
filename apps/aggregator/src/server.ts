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
    options: { maxPayload: 1024 * 64 },
  });

  app.get('/health', async () => ({
    ok: true,
    uptimeSec: Math.floor(process.uptime()),
    eventsLogged: db.eventCount(),
    connections: state.connectionStatus(),
  }));

  // --- Source ingest endpoint ---
  // We deliberately do NOT use WS-protocol ping/pong; sources publish
  // application-level "heartbeat" messages instead.
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

      socket.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          ingest(source, msg);
        } catch (err) {
          logger.warn({ err, source }, 'bad source payload');
        }
      });

      socket.on('close', () => {
        logger.info({ source }, 'source disconnected');
        state.setConnection(source, 'disconnected');
      });

      socket.on('error', (err: Error) => {
        logger.warn({ err, source }, 'source socket error');
      });
    });
  });

  // --- Cockpit subscriber endpoint ---
  // Sends initial snapshot, then live event/signal/connection updates.
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
      const unsubSignal = state.onSignal((signal) => {
        send({ type: 'signal', signal });
      });
      const unsubConn = state.onConnection(({ source, status }) => {
        send({ type: 'connection', source, status });
      });

      socket.on('close', () => {
        unsubEvent();
        unsubSignal();
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
