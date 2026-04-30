// All event types flowing through the aggregator.
// Sources emit events conforming to these shapes.
// The cockpit consumes these via the cockpit WebSocket.

export type SourceName = 'bookmap' | 'flashalpha' | 'levels' | 'tradovate' | 'rules';
export type Symbol = 'NQ' | 'ES';
export type Side = 'bid' | 'ask';
export type Direction = 'long' | 'short';

export interface BaseEvent {
  ts: number;
  source: SourceName;
  type: string;
  symbol?: Symbol;
}

// --- Bookmap addon events ---

export interface HeartbeatEvent extends BaseEvent {
  source: 'bookmap';
  type: 'heartbeat';
}

export interface AbsorptionEvent extends BaseEvent {
  source: 'bookmap';
  type: 'absorption';
  symbol: Symbol;
  side: Side;
  price: number;
  size: number;          // total absorbed contracts
  durationMs: number;    // how long the level held while being hit
}

export interface IcebergEvent extends BaseEvent {
  source: 'bookmap';
  type: 'iceberg';
  symbol: Symbol;
  side: Side;
  price: number;
  estimatedTotalSize: number;
}

export interface BarEvent extends BaseEvent {
  source: 'bookmap';
  type: 'bar';
  symbol: Symbol;
  interval: '1s' | '1m';
  partial?: boolean;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
}

export interface SweepEvent extends BaseEvent {
  source: 'bookmap';
  type: 'sweep';
  symbol: Symbol;
  direction: Direction;
  levels: number;
  volume: number;
  durationMs: number;
  startPrice: number;
  endPrice: number;
}

export type BookmapEvent = HeartbeatEvent | AbsorptionEvent | IcebergEvent | BarEvent | SweepEvent;

// --- FlashAlpha (polled snapshots) ---

export type GammaRegime = 'positive' | 'negative' | 'neutral';

export interface FlashAlphaSnapshot extends BaseEvent {
  source: 'flashalpha';
  type: 'snapshot';
  symbol: Symbol;
  gexTotal: number;
  zeroGamma: number;
  dealerFlip: number;
  gammaRegime: GammaRegime;
  callWalls: number[];
  putWalls: number[];
}

// --- Daily levels (RocketScooter, manual JSON) ---

export interface ZoneRange { low: number; high: number; }

export interface DailyLevels extends BaseEvent {
  source: 'levels';
  type: 'daily';
  symbol: Symbol;
  bullZone: ZoneRange;
  bearZone: ZoneRange;
  ddBands: { upper: number; lower: number };
  hedgePressure: number;
  notes?: string;
}

// --- Tradovate (live price for cockpit chart) ---

export interface PriceTick extends BaseEvent {
  source: 'tradovate';
  type: 'tick';
  symbol: Symbol;
  price: number;
  size: number;
  side?: Side;
}

// --- Confluence signals (output of rules engine) ---

export interface ConfluenceSignal extends BaseEvent {
  source: 'rules';
  type: 'confluence';
  symbol: Symbol;
  ruleId: string;
  score: number;          // 0-100
  direction: Direction;
  contextEventIds: number[];
  rationale: string;
  observeOnly: boolean;   // v1: always true
}

// --- Union of everything that flows through the aggregator ---

export type AggregatorEvent =
  | BookmapEvent
  | FlashAlphaSnapshot
  | DailyLevels
  | PriceTick
  | ConfluenceSignal;

// --- Cockpit messages (server → cockpit over /ws/cockpit) ---

export type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';

export interface CockpitSnapshot {
  type: 'snapshot';
  state: {
    ts: number;
    connections: Partial<Record<SourceName, ConnectionStatus>>;
    levels: Partial<Record<Symbol, DailyLevels>>;
    flashAlpha: Partial<Record<Symbol, FlashAlphaSnapshot>>;
    recentEvents: AggregatorEvent[];
    recentSignals: ConfluenceSignal[];
    eventsLogged: number;
    uptimeSec: number;
  };
}

export interface CockpitEventPush {
  type: 'event';
  event: AggregatorEvent;
}

export interface CockpitSignalPush {
  type: 'signal';
  signal: ConfluenceSignal;
}

export interface CockpitConnectionPush {
  type: 'connection';
  source: SourceName;
  status: ConnectionStatus;
}

export type CockpitMessage = CockpitSnapshot | CockpitEventPush | CockpitSignalPush | CockpitConnectionPush;
