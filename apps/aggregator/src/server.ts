import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { logger } from './logger.js';
import { state } from './state.js';
import { ingest } from './ingest.js';
import { db } from './db.js';
import { getTodayEvents, getUpcomingEvents } from './economic-calendar.js';
import { getTradesInRange } from './rules-v2/tick-client.js';
import { saveContext, getContext } from './rs-context.js';
import { scoreRSLevels } from './rules-v2/rs-level-scorer.js';
import { discord } from './discord.js';
import type { CockpitMessage, SourceName, TickTrade } from '@trading/contracts';
import { tradingDayFor } from '@trading/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TICKS_DB_PATH = path.join(path.dirname(config.dbPath), 'ticks.db');

// Open ticks.db read-only for post-entry historical analysis.
// Wrapped so a missing file at startup doesn't crash the server.
let _ticksDb: Database.Database | null = null;
try { _ticksDb = new Database(TICKS_DB_PATH, { readonly: true }); } catch { /* ticks.db not yet present */ }

// ── RTH helper ────────────────────────────────────────────────────────────────
function isRTH(tsMs: number): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const wd  = parts.find(p => p.type === 'weekday')?.value ?? '';
  const h   = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0');
  const m   = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0');
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(wd) && (h * 60 + m) >= 570 && (h * 60 + m) < 960;
}

// ── Order-flow analysis ───────────────────────────────────────────────────────
// Pure function: given raw trades for a post-entry window, compute delta /
// volume-split / stacked-levels and classify into GO/WAIT/WARN (30s) or
// HIT/MOVE/SLOW/FAIL (2m) for a given direction.

interface TickPoint { ts: number; price: number; size: number; isBidAggressor: boolean; }

interface OrderFlowResult {
  label: string; color: string; checkpoint: '30s' | '2m';
  cumulativeDelta: number;
  volAboveEntry: number; volAtEntry: number; volBelowEntry: number;
  maxFavorable: number; maxAdverse: number;
  stackedDirectionalLevels: number;
  deltaFirstHalf: number; deltaSecondHalf: number;
  totalVolume: number; tradeCount: number;
}

function analyzeOrderFlow(
  trades: TickPoint[],
  entryPrice: number,
  direction: 'long' | 'short',
  checkpoint: '30s' | '2m',
): OrderFlowResult {
  const TICK = 0.25;
  const isShort = direction === 'short';
  const empty = (): OrderFlowResult => ({
    label: checkpoint === '30s' ? 'WAIT' : 'SLOW', color: '#6b7280', checkpoint,
    cumulativeDelta: 0, volAboveEntry: 0, volAtEntry: 0, volBelowEntry: 0,
    maxFavorable: 0, maxAdverse: 0, stackedDirectionalLevels: 0,
    deltaFirstHalf: 0, deltaSecondHalf: 0, totalVolume: 0, tradeCount: 0,
  });
  if (!trades.length) return empty();

  const midTs = trades[0]!.ts + (trades[trades.length - 1]!.ts - trades[0]!.ts) / 2;
  let cumulativeDelta = 0, deltaFirstHalf = 0, deltaSecondHalf = 0;
  let volAboveEntry = 0, volAtEntry = 0, volBelowEntry = 0;
  let maxFavorable = 0, maxAdverse = 0, totalVolume = 0;
  const byLevel = new Map<number, { buyVol: number; sellVol: number }>();

  for (const t of trades) {
    const buyAgg  = t.isBidAggressor ? 0 : t.size;
    const sellAgg = t.isBidAggressor ? t.size : 0;
    const td = buyAgg - sellAgg;

    cumulativeDelta += td;
    if (t.ts <= midTs) deltaFirstHalf += td; else deltaSecondHalf += td;
    totalVolume += t.size;

    if      (t.price > entryPrice + TICK / 2) volAboveEntry += t.size;
    else if (t.price < entryPrice - TICK / 2) volBelowEntry += t.size;
    else                                       volAtEntry    += t.size;

    const fav = isShort ? entryPrice - t.price : t.price - entryPrice;
    const adv = isShort ? t.price - entryPrice : entryPrice - t.price;
    if (fav > maxFavorable) maxFavorable = fav;
    if (adv > maxAdverse)   maxAdverse   = adv;

    const level = Math.round(t.price / TICK) * TICK;
    const l = byLevel.get(level) ?? { buyVol: 0, sellVol: 0 };
    l.buyVol += buyAgg; l.sellVol += sellAgg;
    byLevel.set(level, l);
  }

  // Count consecutive ticks in the favorable direction where the directional
  // aggression dominates — this is "stacked sell/buy levels".
  let stackedDirectionalLevels = 0;
  let scanPrice = isShort
    ? Math.round((entryPrice - TICK) / TICK) * TICK
    : Math.round((entryPrice + TICK) / TICK) * TICK;
  for (let i = 0; i < 30; i++) {
    const l = byLevel.get(scanPrice);
    if (!l) break;
    const dominant = isShort ? l.sellVol > l.buyVol : l.buyVol > l.sellVol;
    if (!dominant) break;
    stackedDirectionalLevels++;
    scanPrice = isShort ? scanPrice - TICK : scanPrice + TICK;
  }

  // ── Classification ───────────────────────────────────────────────────────
  let label: string; let color: string;

  if (checkpoint === '30s') {
    // For absorption signals: positive delta at 30s is often "last wave of buyers
    // still being absorbed" — not a failure indicator. Focus on price action only.
    if (maxFavorable >= 20) {
      // T1 hit within 30s — immediate strong move
      label = 'GO'; color = '#10b981';
    } else if (maxAdverse >= 12) {
      // Hard break above absorption level — approaching stop territory
      label = 'WARN'; color = '#ef4444';
    } else if (maxFavorable >= 5 && maxAdverse < 6) {
      // Price already moving toward target with minimal bounce — clean start
      label = 'GO'; color = '#10b981';
    } else if (maxAdverse >= 7 && maxFavorable < 3) {
      // Price exclusively moving against with no favorable response
      label = 'WARN'; color = '#ef4444';
    } else {
      // Normal oscillation — absorption still processing, wait for 2m check
      label = 'WAIT'; color = '#6b7280';
    }
  } else {
    // 2m checkpoint — has the absorption result played out?
    const volFavoring = isShort ? volBelowEntry > volAboveEntry : volAboveEntry > volBelowEntry;

    if (maxFavorable >= 20) {
      label = 'HIT'; color = '#10b981';
    } else if (maxAdverse >= 15) {
      // Significant adverse — approaching or through stop
      label = 'FAIL'; color = '#ef4444';
    } else if (maxFavorable >= 8 && volFavoring && maxAdverse < 10) {
      // Moving in right direction, volume on right side, not threatened
      label = 'MOVE'; color = '#3b82f6';
    } else {
      // Not enough follow-through yet, or mixed signals
      label = 'SLOW'; color = '#f59e0b';
    }
  }

  return {
    label, color, checkpoint,
    cumulativeDelta, volAboveEntry, volAtEntry, volBelowEntry,
    maxFavorable, maxAdverse, stackedDirectionalLevels,
    deltaFirstHalf, deltaSecondHalf, totalVolume, tradeCount: trades.length,
  };
}

const VALID_SOURCES: SourceName[] = ['bookmap', 'bookmap-es', 'flashalpha', 'tradovate'];

// Path to the cockpit's production build (apps/cockpit/dist/).
// Exists after `pnpm --filter @trading/cockpit build`.
const COCKPIT_DIST = path.resolve(__dirname, '../../cockpit/dist');

export async function startServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket, {
    options: {
      maxPayload: 1024 * 64,
      // Heartbeat handled per-connection below
    },
  });

  // Serve the built cockpit SPA when the dist folder exists.
  // In dev mode Vite handles this; in production the aggregator is the only server.
  const fs = await import('node:fs');
  if (fs.existsSync(COCKPIT_DIST)) {
    await app.register(fastifyStatic, {
      root: COCKPIT_DIST,
      // Serve index.html for any unknown route so the SPA handles navigation.
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache');
      },
    });
    // SPA catch-all: unknown GET routes serve index.html
    app.setNotFoundHandler(async (_req, reply) => {
      return reply.sendFile('index.html');
    });
    logger.info({ path: COCKPIT_DIST }, 'serving cockpit static files');
  }

  // CORS — needed when Vite dev server (port 5173) calls this server (port 8787).
  // In production both are on the same origin so this is a no-op for the cockpit,
  // but kept to allow external tooling (CLI, scripts) to call the API.
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

  // VX/VVIX live update — called by the Claude Code cron bridge every minute.
  // Body: { vx: number, vvix: number }
  app.post('/context/vx', async (req, reply) => {
    const body = req.body as { vx?: unknown; vvix?: unknown };
    const vx   = typeof body.vx   === 'number' ? body.vx   : NaN;
    const vvix = typeof body.vvix === 'number' ? body.vvix : NaN;
    if (isNaN(vx) || isNaN(vvix)) {
      return reply.code(400).send({ error: 'vx and vvix must be numbers' });
    }
    const ctx = saveContext({ vx, vvix });
    logger.info({ vx, vvix, vxAboveBBB: ctx.vxAboveBBB, vvixGolden: ctx.vvixGolden }, 'VX/VVIX updated via bridge');
    return { ok: true, vx: ctx.vx, vvix: ctx.vvix, vxAboveBBB: ctx.vxAboveBBB, vvixGolden: ctx.vvixGolden };
  });

  app.get('/context/rs', async () => getContext());

  // Test signal — fires a scored signal through the full RS pipeline and
  // pushes it live to the cockpit. Bypasses quality gate.
  // Accepts optional ruleId + pattern so we can drive the trader end-to-end
  // (e.g. ruleId='clean-impulse', pattern='FLIP' to trigger an auto-trade).
  app.post('/test/signal', async (req, reply) => {
    const body = req.body as { symbol?: unknown; price?: unknown; direction?: unknown; discord?: unknown; ruleId?: unknown; pattern?: unknown; observeOnly?: unknown };
    const symbol  = body.symbol === 'ES' ? 'ES' : 'NQ';
    const price   = typeof body.price === 'number' ? body.price : NaN;
    const dir     = body.direction === 'short' ? 'short' : 'long';
    const notify  = body.discord === true;
    const ruleId  = typeof body.ruleId === 'string' && body.ruleId.length > 0 ? body.ruleId : 'test';
    const pattern = typeof body.pattern === 'string' ? body.pattern : null;
    const observeOnly = body.observeOnly !== false; // default true; pass false to let trader act
    if (isNaN(price)) return reply.code(400).send({ error: 'price must be a number' });

    const today  = tradingDayFor(Date.now());
    const levels = state.levelsForDay(today)?.[symbol];
    const recentBars = (db.recentBars(symbol, Date.now() - 60 * 60_000) as { high: number; low: number }[]);
    const rs = scoreRSLevels(price, dir, levels, price, recentBars);

    const signal: import('@trading/contracts').ConfluenceSignal = {
      ts: Date.now(),
      source: 'rules-v2' as const,
      type: 'confluence' as const,
      symbol,
      ruleId,
      strategyVersion: 'B' as const,
      ruleVersion: 'test-v1',
      score: 75,
      direction: dir,
      rationale: `Test signal at ${price} (${dir})`,
      observeOnly,
      ...(pattern ? { pattern } : {}),
      rsScore:        rs.score,
      rsTier:         rs.tier,
      rsComponents:   rs.components,
      rsMatchedLevel: rs.matchedLevel?.label,
      rsLabelLine:    rs.labelLine,
    } as any;

    state.broadcastTestSignal(signal);
    if (notify) discord.signal(signal);
    logger.info({ price, dir, symbol, ruleId, pattern, observeOnly, discord: notify }, 'test signal broadcast');
    return { ok: true, ruleId, pattern, rsScore: rs.score, rsTier: rs.tier, rsLabelLine: rs.labelLine, matchedLevel: rs.matchedLevel };
  });

  app.get('/econ/today', async () => ({
    today: getTodayEvents(),
    upcoming: getUpcomingEvents(7),
  }));

  // ── Kill-switch: control the trader's halt file ─────────────────────────────
  // The trader process reads /tmp/trader.halt on every signal; presence of the
  // file blocks all new trades. POST/DELETE here lets the cockpit toggle it.
  // Same-host assumption (trader + aggregator + cockpit all on this machine).
  const TRADER_HALT_FILE = '/tmp/trader.halt';

  app.get('/trader/halt', async () => ({
    halted: fs.existsSync(TRADER_HALT_FILE),
    reason: fs.existsSync(TRADER_HALT_FILE)
      ? fs.readFileSync(TRADER_HALT_FILE, 'utf8').trim()
      : null,
  }));

  app.post('/trader/halt', async (req, reply) => {
    const body = (req.body ?? {}) as { reason?: string };
    const reason = (body.reason ?? 'cockpit kill-switch').slice(0, 200);
    try {
      fs.writeFileSync(TRADER_HALT_FILE, `${new Date().toISOString()} — ${reason}\n`);
      logger.error({ reason }, 'KILL-SWITCH armed — trader halted');
      return { ok: true, halted: true, reason };
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? 'failed' });
    }
  });

  app.delete('/trader/halt', async (_req, reply) => {
    try {
      if (fs.existsSync(TRADER_HALT_FILE)) fs.unlinkSync(TRADER_HALT_FILE);
      logger.warn('KILL-SWITCH cleared — trader resumed');
      return { ok: true, halted: false };
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? 'failed' });
    }
  });

  // ── Trader state — current position + today's pnl ─────────────────────────
  // Reads positions.db directly (same-host). Used by the cockpit's status bar
  // to show whether the trader currently has an open position. Critical for
  // UX after the 2026-06-04 09:59 incident where a trade fired without the
  // user noticing because the FLIP marker wasn't on the active timeframe.
  const TRADER_DB_PATH = path.join(path.dirname(config.dbPath), 'positions.db');
  let _traderDb: Database.Database | null = null;
  try { _traderDb = new Database(TRADER_DB_PATH, { readonly: true, fileMustExist: true }); }
  catch { logger.warn({ path: TRADER_DB_PATH }, 'trader positions.db not present yet'); }

  app.get('/trader/state', async () => {
    if (!_traderDb) {
      try { _traderDb = new Database(TRADER_DB_PATH, { readonly: true, fileMustExist: true }); }
      catch { return { open: null, todayPnl: 0, recentErrors: 0, halted: fs.existsSync(TRADER_HALT_FILE) }; }
    }
    const open = _traderDb.prepare(`
      SELECT id, signal_ts, symbol, rule_id, direction, qty, fill_price, sl_price, tp_price, status,
             entry_order_id, sl_order_id, tp_order_id
      FROM positions
      WHERE status IN ('pending_entry','filled_entry')
      ORDER BY id DESC LIMIT 1
    `).get() as any;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    const pnl = (_traderDb.prepare(`SELECT realized_usd FROM daily_pnl WHERE trading_day=?`).get(day) as any)?.realized_usd ?? 0;
    const recentErrors = (_traderDb.prepare(`
      SELECT COUNT(*) AS c FROM positions WHERE status='error' AND created_at > ?
    `).get(Date.now() - 60 * 60_000) as any)?.c ?? 0;
    return {
      open: open ?? null,
      todayPnl: pnl,
      recentErrors,
      halted: fs.existsSync(TRADER_HALT_FILE),
    };
  });

  // Returns deduplicated bar history for a symbol. Used by the cockpit
  // chart on initial mount to populate historical bars before live WS
  // updates start streaming. Without this, a browser refresh wipes the
  // chart and bars only repopulate from current minute onward.
  app.get('/history/bars', async (req) => {
    const q = req.query as { symbol?: string; minutes?: string; interval?: string; from?: string; to?: string };
    const symbol = q.symbol ?? 'NQ';
    const intervalMin = parseInt(q.interval ?? '1', 10) || 1; // 1, 5, or 15

    // Two modes: explicit (from, to) range — used by the chart's date-jump
    // calendar to load a specific historical day on demand. Or the legacy
    // (minutes) window relative to now.
    const fromMsArg = q.from ? parseInt(q.from, 10) : NaN;
    const toMsArg   = q.to   ? parseInt(q.to,   10) : NaN;
    const hasRange  = Number.isFinite(fromMsArg) && Number.isFinite(toMsArg) && toMsArg > fromMsArg;

    let sinceMs: number;
    let untilMs: number;
    let minutes: number;
    if (hasRange) {
      sinceMs = fromMsArg;
      untilMs = toMsArg;
      minutes = Math.floor((untilMs - sinceMs) / 60_000);
    } else {
      minutes = Math.max(1, Math.min(43200, parseInt(q.minutes ?? '10080', 10) || 10080));
      sinceMs = Date.now() - minutes * 60 * 1000;
      untilMs = Date.now() + 60_000;  // small future buffer for in-progress bar
    }

    if (intervalMin === 1) {
      const bars = hasRange
        ? db.barsBetween(symbol, sinceMs, untilMs)
        : db.recentBars(symbol, sinceMs);
      return { symbol, minutes, interval: 1, count: bars.length, bars };
    }

    // Aggregate 1-min bars into 5-min or 15-min bars
    const intervalMs = intervalMin * 60 * 1000;
    const rawBars = hasRange
      ? db.query<{ payload: string }>(`
          SELECT payload FROM events
          WHERE source IN ('bookmap', 'bookmap-es')
            AND type = 'bar'
            AND symbol = ?
            AND ts >= ?
            AND ts <  ?
          ORDER BY ts ASC
        `, [symbol, sinceMs, untilMs])
      : db.query<{ payload: string }>(`
          SELECT payload FROM events
          WHERE source IN ('bookmap', 'bookmap-es')
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

  // Live post-entry order-flow analysis.
  // Called by cockpit ws.ts at 30s and 2m after an RTH absorption signal fires.
  // Fetches the tick window from the tick-store and classifies into
  // GO/WAIT/WARN (30s) or HIT/MOVE/SLOW/FAIL (2m).
  app.get('/post-entry/analysis', async (req) => {
    const q = req.query as {
      symbol?: string; from?: string; to?: string;
      entryPrice?: string; direction?: string; checkpoint?: string;
    };
    const symbol     = q.symbol    ?? 'NQ';
    const from       = parseInt(q.from       ?? '0', 10);
    const to         = parseInt(q.to         ?? '0', 10);
    const entryPrice = parseFloat(q.entryPrice ?? '0');
    const direction  = (q.direction  ?? 'short') as 'long' | 'short';
    const checkpoint = (q.checkpoint ?? '30s')   as '30s' | '2m';

    if (!from || !to || !entryPrice) {
      return { label: checkpoint === '30s' ? 'WAIT' : 'SLOW', color: '#6b7280', error: 'missing params' };
    }

    const raw = await getTradesInRange(symbol, from, to);
    const trades: TickPoint[] = raw.map((t: TickTrade) => ({
      ts: t.ts, price: t.price, size: t.size, isBidAggressor: t.isBidAggressor,
    }));
    return analyzeOrderFlow(trades, entryPrice, direction, checkpoint);
  });

  // Historical post-entry markers — tick-based, RTH NQ absorption signals.
  // Replaces the old w5_max_gain proxy with actual order-flow classification
  // using ticks.db directly.
  app.get('/history/post-entry-markers', async (req) => {
    const q = req.query as { symbol?: string };
    const symbol = q.symbol ?? 'NQ';

    if (!_ticksDb) return { markers: [] };

    const rows = db.query<{ ts: number; rationale: string; direction: string; conviction: string }>(`
      SELECT s.ts,
        json_extract(s.payload, '$.rationale')  AS rationale,
        s.direction,
        json_extract(s.payload, '$.conviction') AS conviction
      FROM signals s
      WHERE s.symbol    = ?
        AND s.rule_id   = 'absorption'
        AND json_extract(s.payload, '$.conviction') = '+'
        AND s.score     >= 65
        AND (s.meta IS NULL OR json_extract(s.meta, '$.filtered') IS NOT 1)
      ORDER BY s.ts
    `, [symbol]);

    if (!rows.length) return { markers: [] };

    const markers: object[] = [];

    for (const row of rows) {
      if (!isRTH(row.ts)) continue;

      const m = row.rationale?.match(/absorbed at ([0-9.]+)/);
      if (!m) continue;
      const entryPrice = parseFloat(m[1]!);
      const direction = row.direction as 'long' | 'short';

      // ── 30s window ────────────────────────────────────────────────────────
      const raw30 = _ticksDb.prepare(
        `SELECT ts, price, size, is_bid_aggressor FROM trades WHERE symbol=? AND ts>? AND ts<=? ORDER BY ts ASC`
      ).all(symbol, row.ts, row.ts + 30_000) as { ts:number; price:number; size:number; is_bid_aggressor:number }[];

      const trades30: TickPoint[] = raw30.map(t => ({
        ts: t.ts, price: t.price, size: t.size, isBidAggressor: t.is_bid_aggressor === 1,
      }));
      const a30 = analyzeOrderFlow(trades30, entryPrice, direction, '30s');

      // ── 2m window ─────────────────────────────────────────────────────────
      const raw2m = _ticksDb.prepare(
        `SELECT ts, price, size, is_bid_aggressor FROM trades WHERE symbol=? AND ts>? AND ts<=? ORDER BY ts ASC`
      ).all(symbol, row.ts, row.ts + 120_000) as { ts:number; price:number; size:number; is_bid_aggressor:number }[];

      const trades2m: TickPoint[] = raw2m.map(t => ({
        ts: t.ts, price: t.price, size: t.size, isBidAggressor: t.is_bid_aggressor === 1,
      }));
      const a2m = analyzeOrderFlow(trades2m, entryPrice, direction, '2m');

      const ts30 = Math.floor((row.ts + 30_000)  / 60_000) * 60;
      const ts2m  = Math.floor((row.ts + 120_000) / 60_000) * 60;

      markers.push({ id: `${row.ts}-30s`, symbol, time: ts30, label: a30.label, color: a30.color, checkpoint: '30s', signalTs: row.ts });
      markers.push({ id: `${row.ts}-2m`,  symbol, time: ts2m,  label: a2m.label, color: a2m.color, checkpoint: '2m',  signalTs: row.ts });
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
      // V3 trade-close events: broadcast so the trader app can act on V3
      // opposing-signal exits and the cockpit renders close markers.
      const unsubClose = state.onTradeClose((evt: any) => {
        send({ type: 'trade-close', evt } as any);
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
        unsubClose();
        unsubConn();
        logger.info('cockpit disconnected');
      });
      socket.on('error', (err: Error) => {
        logger.warn({ err }, 'cockpit socket error');
      });
    });
  });

  await app.listen({ port: config.port, host: config.host });
  logger.info({ port: config.port, host: config.host }, 'server listening');
  return app;
}
