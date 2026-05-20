import { EventEmitter } from 'node:events';
import { db } from './db.js';
import { discord } from './discord.js';
import { logger } from './logger.js';
import { classifySignalQuality } from './quality.js';
import type { QualityContext } from './quality.js';
import type {
  AggregatorEvent,
  ConfluenceSignal,
  ConnectionStatus,
  CockpitSnapshot,
  DailyLevels,
  FlashAlphaSnapshot,
  SourceName,
  Symbol,
} from '@trading/contracts';

const EXPL_LOOKBACK_MS = 60 * 60_000; // 60-min window for EXPL conflict detection
const FLIP_LOOKBACK_MS = 60 * 60_000; // 60-min window for absorption FLIP-context filter

interface Bar {
  ts: number; open: number; high: number; low: number; close: number;
  buyVolume?: number; sellVolume?: number;
}

// Returns the 09:30 ET timestamp (ms) for the RTH session that contains signalTs.
// Handles EDT (-04:00) and EST (-05:00) automatically.
function getRthOpenTs(signalTs: number): number {
  const datePart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(signalTs));
  // datePart = "MM/DD/YYYY"
  const [mm, dd, yyyy] = datePart.split('/');
  // Determine UTC offset: probe whether New York is EDT (-4) or EST (-5)
  const probeHour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', hour12: false,
    }).format(new Date(signalTs)),
    10
  );
  const utcHour = new Date(signalTs).getUTCHours();
  const offsetH = ((utcHour - probeHour) + 24) % 24;
  const offset = offsetH === 4 ? '-04:00' : '-05:00';
  return Date.parse(`${yyyy}-${mm}-${dd}T09:30:00${offset}`);
}

// Build regime context from session bars. Only meaningful for LONG signals.
// Returns empty object for SHORT (regime detection not yet calibrated for shorts).
function buildRegimeContext(signal: { symbol: string; direction: string; ts: number }): Partial<QualityContext> {
  if (signal.direction !== 'long') return {};
  const rthOpen = getRthOpenTs(signal.ts);
  const rawBars = db.recentBars(signal.symbol, rthOpen) as Bar[];
  if (rawBars.length === 0) return {};

  // Only bars up to (and including) the signal's own bar
  const bars = rawBars.filter(b => b.ts <= signal.ts);
  if (bars.length === 0) return {};

  const sessionOpen  = bars[0]!.open;
  const sessionHigh  = Math.max(...bars.map(b => b.high));
  const sessionLow   = Math.min(...bars.map(b => b.low));
  const currentPrice = bars.at(-1)!.close;

  // 30-min rolling CVD windows (each bar = 1 min)
  const now = signal.ts;
  const cvdLast30m = bars
    .filter(b => b.ts >= now - 30 * 60_000 && b.ts <= now)
    .reduce((s, b) => s + (b.buyVolume ?? 0) - (b.sellVolume ?? 0), 0);
  const cvdPrev30m = bars
    .filter(b => b.ts >= now - 60 * 60_000 && b.ts < now - 30 * 60_000)
    .reduce((s, b) => s + (b.buyVolume ?? 0) - (b.sellVolume ?? 0), 0);

  // Count same-direction EXPLs that fired earlier today whose bid zone was later broken.
  // "Broken" = current price is more than 15 pts below the EXPL's entry bar close.
  const todayExpls = db.explInWindow(signal.symbol, rthOpen, signal.ts)
    .filter(e => e.direction === signal.direction && (signal.ts - e.ts) > 30 * 60_000);

  const failedSameDirExpls = todayExpls.filter(expl => {
    // Find the bar closest to the EXPL signal time as an entry price proxy
    const nearest = bars.reduce(
      (best, b) => Math.abs(b.ts - expl.ts) < Math.abs(best.ts - expl.ts) ? b : best,
      bars[0]!
    );
    return currentPrice < nearest.close - 15;
  }).length;

  return { cvdLast30m, cvdPrev30m, sessionHigh, sessionLow, sessionOpen, currentPrice, failedSameDirExpls };
}

const RECENT_EVENT_BUFFER = 200;
const startTime = Date.now();

class State {
  private bus = new EventEmitter();
  private connections = new Map<SourceName, ConnectionStatus>();
  // levels keyed by tradingDay date string -> symbol -> DailyLevels.
  // Multiple trading days held concurrently so the cockpit can render past
  // days' levels on past bars.
  private levelsByDay: Map<string, Partial<Record<Symbol, DailyLevels>>> = new Map();
  private flashAlpha: Partial<Record<Symbol, FlashAlphaSnapshot>> = {};
  private recentEvents: AggregatorEvent[] = [];

  constructor() {
    this.bus.setMaxListeners(50);
  }

  // --- Connection tracking ---

  setConnection(source: SourceName, status: ConnectionStatus) {
    const prev = this.connections.get(source);
    this.connections.set(source, status);
    if (prev !== status) {
      logger.info({ source, status }, 'connection state changed');
      this.bus.emit('connection', { source, status });
      if (status === 'connected') discord.sourceConnected(source);
      else if (status === 'disconnected' && prev === 'connected') {
        discord.sourceDisconnected(source);
      }
    }
  }

  connectionStatus(): Partial<Record<SourceName, ConnectionStatus>> {
    return Object.fromEntries(this.connections) as Partial<Record<SourceName, ConnectionStatus>>;
  }

  // --- Event ingest ---

  applyEvent(event: AggregatorEvent): number {
    const id = db.logEvent(event);
    this.recentEvents.push(event);
    if (this.recentEvents.length > RECENT_EVENT_BUFFER) {
      this.recentEvents.shift();
    }

    // Update materialized state for known event types
    if (event.source === 'levels' && event.type === 'daily') {
      const dayMap = this.levelsByDay.get(event.tradingDay) ?? {};
      dayMap[event.symbol] = event;
      this.levelsByDay.set(event.tradingDay, dayMap);
    } else if (event.source === 'flashalpha' && event.type === 'snapshot') {
      this.flashAlpha[event.symbol] = event;
    }

    this.bus.emit('event', event);
    return id;
  }

  applySignal(signal: ConfluenceSignal): number {
    // DB log is unconditional — even silenced signals get persisted so the
    // outcome tracker can keep validating their quality. We need this data
    // to know when (or whether) to revisit the gold-tier thresholds.
    const id = db.logSignal(signal);

    // Quality gate for broadcast paths (Discord + cockpit). Only gold-tier
    // signals reach the human attention layer. See quality.ts for current
    // tier definitions; thresholds are calibrated against outcome data.
    const recentExpls = db.explInWindow(signal.symbol, signal.ts - EXPL_LOOKBACK_MS, signal.ts);
    const regimeCtx = buildRegimeContext(signal);
    const lastFlip = db.lastFlipInWindow(signal.symbol, signal.ts - FLIP_LOOKBACK_MS, signal.ts);
    const decision = classifySignalQuality(signal, { recentExpls, lastFlip, ...regimeCtx });
    if (decision.tier === 'gold') {
      this.bus.emit('signal', signal);
      discord.signal(signal);
      logger.info({ ruleId: signal.ruleId, score: signal.score, reason: decision.reason },
                  'gold-tier signal broadcast');
    } else {
      logger.debug({ ruleId: signal.ruleId, score: signal.score, reason: decision.reason },
                   'silenced signal (DB only)');
    }
    return id;
  }

  // Bulk-replace all levels with a fresh set from the levels file.
  // Wipes the in-memory map and reapplies. Logs each as a 'levels' event so
  // it gets persisted to SQLite and broadcast to the cockpit normally.
  applyAllLevels(daysMap: Record<string, DailyLevels[]>): void {
    this.levelsByDay.clear();
    for (const dayLevels of Object.values(daysMap)) {
      for (const event of dayLevels) {
        this.applyEvent(event);
      }
    }
  }

  // Look up levels for a specific trading day.
  levelsForDay(date: string): Partial<Record<Symbol, DailyLevels>> | undefined {
    return this.levelsByDay.get(date);
  }

  // Return all loaded days for snapshot delivery.
  allLevelsByDay(): Record<string, Partial<Record<Symbol, DailyLevels>>> {
    return Object.fromEntries(this.levelsByDay);
  }

  // --- Snapshot for cockpit on connect ---

  snapshot(): CockpitSnapshot['state'] {
    // For recentSignals, fetch a wider net (500) and filter to gold tier
    // before returning. The cockpit should only see what passes Discord;
    // silenced signals stay in the DB for outcome analysis but aren't
    // shown in the right panel or as chart markers.
    const allRecent = db.recentSignals(2000);
    // Preload context signals once for in-memory per-signal lookups.
    const allExpls = db.query<{ ts: number; direction: string; symbol: string }>(
      `SELECT ts, direction, symbol FROM signals WHERE rule_id = 'expl' ORDER BY ts ASC`
    );
    const allFlips = db.query<{ ts: number; direction: string; symbol: string; entry?: number }>(
      `SELECT ts, direction, symbol, CAST(json_extract(payload, '$.entry') AS REAL) as entry FROM signals
       WHERE strategy_version = 'H' AND json_extract(payload, '$.pattern') = 'FLIP'
       ORDER BY ts ASC`
    );
    const goldOnly = allRecent
      .filter(s => {
        const recentExpls = allExpls.filter(
          e => e.symbol === s.symbol && e.ts >= s.ts - EXPL_LOOKBACK_MS && e.ts < s.ts
        );
        const flipsInWindow = allFlips.filter(
          f => f.symbol === s.symbol && f.ts >= s.ts - FLIP_LOOKBACK_MS && f.ts < s.ts
        );
        const lastFlip = flipsInWindow.length > 0 ? flipsInWindow.at(-1)! : null;
        return classifySignalQuality(s, { recentExpls, lastFlip }).tier === 'gold';
      })
      .slice(0, 2000);

    return {
      ts: Date.now(),
      connections: this.connectionStatus(),
      levelsByDay: this.allLevelsByDay(),
      flashAlpha: this.flashAlpha,
      recentEvents: db.recentEvents(50).reverse(),
      recentSignals: goldOnly,
      eventsLogged: db.eventCount(),
      uptimeSec: Math.floor((Date.now() - startTime) / 1000),
    };
  }

  // --- Subscription helpers ---

  onEvent(fn: (e: AggregatorEvent) => void): () => void {
    this.bus.on('event', fn);
    return () => { this.bus.off('event', fn); };
  }

  onSignal(fn: (s: ConfluenceSignal) => void): () => void {
    this.bus.on('signal', fn);
    return () => { this.bus.off('signal', fn); };
  }

  // Bypass quality gate — for test signals only. Emits directly to cockpit WS.
  broadcastTestSignal(signal: ConfluenceSignal): void {
    this.bus.emit('signal', signal);
  }

  onConnection(fn: (m: { source: SourceName; status: ConnectionStatus }) => void): () => void {
    this.bus.on('connection', fn);
    return () => { this.bus.off('connection', fn); };
  }
}

export const state = new State();
