import { EventEmitter } from 'node:events';
import { db } from './db.js';
import { discord } from './discord.js';
import { logger } from './logger.js';
import { classifySignalQuality } from './quality.js';
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
    const decision = classifySignalQuality(signal);
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
    const allRecent = db.recentSignals(500);
    const goldOnly = allRecent
      .filter(s => classifySignalQuality(s).tier === 'gold')
      .slice(0, 50);

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

  onConnection(fn: (m: { source: SourceName; status: ConnectionStatus }) => void): () => void {
    this.bus.on('connection', fn);
    return () => { this.bus.off('connection', fn); };
  }
}

export const state = new State();
