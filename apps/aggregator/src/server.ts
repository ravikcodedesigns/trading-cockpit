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
    const q = req.query as { symbol?: string; minutes?: string; interval?: string };
    const symbol = q.symbol ?? 'NQ';
    const minutes = Math.max(1, Math.min(43200, parseInt(q.minutes ?? '10080', 10) || 10080));
    const intervalMin = parseInt(q.interval ?? '1', 10) || 1; // 1, 5, or 15
    const sinceMs = Date.now() - minutes * 60 * 1000;

    if (intervalMin === 1) {
      // Standard 1-min bars from existing logic
      const bars = db.recentBars(symbol, sinceMs);
      return { symbol, minutes, interval: 1, count: bars.length, bars };
    }

    // Aggregate 1-min bars into 5-min or 15-min bars
    const intervalMs = intervalMin * 60 * 1000;
    const rawBars = db.query<{ payload: string }>(`
      SELECT payload FROM events
      WHERE source = 'bookmap'
        AND type = 'bar'
        AND symbol = ?
        AND ts >= ?
      ORDER BY ts ASC
    `, [symbol, sinceMs]);

    const buckets = new Map<number, {
      ts: number; open: number; high: number; low: number; close: number;
      volume: number; buyVolume: number; sellVolume: number;
    }>();

    for (const row of rawBars) {
      try {
        const b = JSON.parse(row.payload) as any;
        const bucket = Math.floor(b.ts / intervalMs) * intervalMs;
        if (!buckets.has(bucket)) {
          buckets.set(bucket, {
            ts: bucket, open: b.open, high: b.high,
            low: b.low, close: b.close,
            volume: b.volume ?? 0,
            buyVolume: b.buyVolume ?? 0,
            sellVolume: b.sellVolume ?? 0,
          });
        } else {
          const agg = buckets.get(bucket)!;
          agg.high  = Math.max(agg.high, b.high);
          agg.low   = Math.min(agg.low,  b.low);
          agg.close = b.close;
          agg.volume    += b.volume ?? 0;
          agg.buyVolume  += b.buyVolume ?? 0;
          agg.sellVolume += b.sellVolume ?? 0;
        }
      } catch { /* skip malformed */ }
    }

    const bars = Array.from(buckets.values())
      .sort((a, b) => a.ts - b.ts);

    return { symbol, minutes, interval: intervalMin, count: bars.length, bars };
  });

  // Returns historical post-entry classification markers for ++ short signals.
  // Used by the cockpit chart on load to backfill FAST/MID/SLOW/FAIL markers
  // without waiting for live signals to fire.
  app.get('/history/post-entry-markers', async (req) => {
    const q = req.query as { symbol?: string };
    const symbol = q.symbol ?? 'NQ';

    // Query all ++ short absorption signals with matured outcomes
    const rows = db.query<{
      id: number; ts: number; score: number; rationale: string;
      conviction: string; mv5: number; adv5: number;
      mv15: number; adv15: number; mv60: number;
    }>(`
      SELECT
        s.id,
        s.ts,
        s.score,
        json_extract(s.payload, '$.rationale') AS rationale,
        json_extract(s.payload, '$.conviction') AS conviction,
        som.w5_max_gain      AS mv5,
        som.w5_max_drawdown  AS adv5,
        som.w15_max_gain     AS mv15,
        som.w15_max_drawdown AS adv15,
        som.w60_max_gain     AS mv60
      FROM signals s
      LEFT JOIN signal_outcomes_matured som ON som.signal_id = s.id
      WHERE s.symbol = ?
        AND s.rule_id = 'absorption'
        AND s.direction = 'short'
        AND json_extract(s.payload, '$.conviction') = '++'
        AND s.score BETWEEN 65 AND 79
      ORDER BY s.ts
    `, [symbol]);

    if (!rows.length) return { markers: [] };

    const markers = [];

    for (const row of rows) {
      // Extract entry price from rationale
      const priceMatch = row.rationale?.match(/absorbed at ([0-9.]+)/);
      if (!priceMatch) continue;

      const mv5  = row.mv5  ?? 0;
      const adv5 = row.adv5 ?? 0;
      const mv60 = row.mv60 ?? 0;
      const mv15 = row.mv15 ?? 0;

      // 90s checkpoint: approximate using w5 data
      // We use w5 as a proxy — if moved fast in 5min it was likely fast in 90s
      let label90s: string;
      let color90s: string;

      if (mv5 >= 10 && adv5 < 5) {
        label90s = 'MID'; color90s = '#3b82f6';
      } else if (mv5 >= 10 && adv5 >= 5) {
        label90s = 'FAST?'; color90s = '#f59e0b';
      } else if (adv5 > mv5 && adv5 > 5) {
        label90s = 'HOLD'; color90s = '#a855f7';
      } else {
        label90s = 'SLOW?'; color90s = '#6366f1';
      }

      // 5min checkpoint classification
      let label5m: string;
      let color5m: string;

      if (mv5 >= 20) {
        // Fast enough to hit 20 in 5min
        if (mv5 >= 30) {
          label5m = 'FAST ✓'; color5m = '#10b981';
        } else {
          label5m = 'MID ✓'; color5m = '#3b82f6';
        }
      } else if (mv5 < 20 && adv5 > 15) {
        label5m = 'FAIL ✗'; color5m = '#ef4444';
      } else if (mv60 >= 40) {
        // Slow grinder — didn't hit 20 in 5min but eventually got there
        label5m = 'SLOW ~'; color5m = '#f59e0b';
      } else {
        label5m = 'WAIT'; color5m = '#6b7280';
      }

      // Time buckets: snap to minute bars
      const ts90s = Math.floor((row.ts + 30_000)  / 60_000) * 60;
      const ts5m  = Math.floor((row.ts + 120_000) / 60_000) * 60;

      markers.push({
        id: `${row.ts}-90s`,
        symbol,
        time: ts90s,
        label: label90s,
        color: color90s,
        checkpoint: '90s',
        signalTs: row.ts,
      });

      markers.push({
        id: `${row.ts}-5m`,
        symbol,
        time: ts5m,
        label: label5m,
        color: color5m,
        checkpoint: '5m',
        signalTs: row.ts,
      });
    }

    return { symbol, count: markers.length, markers };
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

      const send = (msg: object) => {
        try { socket.send(JSON.stringify(msg)); } catch { /* socket closing */ }
      };

      // Initial snapshot
      send({ type: 'snapshot', state: state.snapshot() });

      const unsubEvent = state.onEvent((event) => {
        send({ type: 'event', event });
      });
      // Live signals: separate broadcast path for confluence signals.
      // Without this subscription, signals only appear in the cockpit after
      // a page refresh (loaded from snapshot) — they never push live.
      const unsubSignal = state.onSignal((signal) => {
        send({ type: 'signal', signal });
      });
      const unsubConn = state.onConnection(({ source, status }) => {
        send({ type: 'connection', source, status });
      });

      // App-level ping/pong for cockpit liveness. Browser may not fire
      // onclose when the WS dies silently (throttled tab, Wi-Fi flicker);
      // pong responses give the cockpit a positive liveness signal.
      socket.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type?: string };
          if (msg.type === 'ping') {
            send({ type: 'pong' });
          }
        } catch {
          // ignore malformed
        }
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
