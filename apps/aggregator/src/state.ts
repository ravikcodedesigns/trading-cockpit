import { EventEmitter } from 'node:events';
import { db } from './db.js';
import { discord } from './discord.js';
import { logger } from './logger.js';
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
  private levels: Partial<Record<Symbol, DailyLevels>> = {};
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
      this.levels[event.symbol] = event;
    } else if (event.source === 'flashalpha' && event.type === 'snapshot') {
      this.flashAlpha[event.symbol] = event;
    }

    this.bus.emit('event', event);
    return id;
  }

  applySignal(signal: ConfluenceSignal): number {
    const id = db.logSignal(signal);
    this.bus.emit('signal', signal);
    discord.signal(signal);
    return id;
  }

  // --- Snapshot for cockpit on connect ---

  snapshot(): CockpitSnapshot['state'] {
    return {
      ts: Date.now(),
      connections: this.connectionStatus(),
      levels: this.levels,
      flashAlpha: this.flashAlpha,
      recentEvents: db.recentEvents(50).reverse(),
      recentSignals: db.recentSignals(50),
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
