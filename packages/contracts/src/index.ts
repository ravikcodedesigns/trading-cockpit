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

export interface DeltaDivergenceEvent extends BaseEvent {
  source: 'bookmap';
  type: 'delta_divergence';
  symbol: Symbol;
  direction: 'bullish' | 'bearish';
  currentPrice: number;
  currentDelta: number;
  priorPrice: number;
  priorDelta: number;
  deltaDiff: number;
  magnitude: number;
  windowSec: number;
}

export type BookmapEvent = HeartbeatEvent | AbsorptionEvent | IcebergEvent | BarEvent | SweepEvent | DeltaDivergenceEvent;

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

export interface AdditionalLevel {
  price: number;
  label: string;                       // short label shown in axis (<=12 chars renders best)
  color?: string;                      // hex e.g. '#5a9bff'; defaults applied client-side
  style?: 'solid' | 'dashed' | 'dotted' | 'large-dashed' | 'sparse-dotted';  // defaults to 'dashed'
  width?: 1 | 2 | 3 | 4;               // defaults to 1; 2 = bold
}

export interface DailyLevels extends BaseEvent {
  source: 'levels';
  type: 'daily';
  symbol: Symbol;
  // The trading day these levels are active for, formatted as YYYY-MM-DD
  // in NY time. Trading day = 09:30 ET on Day N -> 09:30 ET on Day N+1.
  // Friday's trading day extends across the weekend gap to Monday 09:30.
  tradingDay: string;
  bullZone: ZoneRange;
  bearZone: ZoneRange;
  ddBands: { upper: number; lower: number };
  hedgePressure: number;
  additionalLevels?: AdditionalLevel[];  // RS reference lines (QQQ Open/Close, HG, MHP, etc.)
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
    // Date-keyed map: trading-day "YYYY-MM-DD" -> symbol -> DailyLevels.
    // Multiple days held concurrently so cockpit can render historical bars
    // with the levels that were active on that day.
    levelsByDay: Record<string, Partial<Record<Symbol, DailyLevels>>>;
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

// --- Trading day helper ---
// Trading day boundary is 09:30 ET on Day N -> 09:30 ET on Day N+1.
// Friday's trading day extends through the weekend (Sat closed, Sun 18:00
// reopen still belongs to Friday until Monday 09:30 RTH open).
//
// Returns YYYY-MM-DD for the trading day that contains the given timestamp.
// Returns null if the timestamp is before any 09:30 boundary on a weekday.
export function tradingDayFor(tsMs: number): string {
  const d = new Date(tsMs);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string): string => parts.find(p => p.type === t)?.value ?? '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const weekday = get('weekday');
  const hour = parseInt(get('hour'), 10);
  const minute = parseInt(get('minute'), 10);
  const minutesOfDay = hour * 60 + minute;

  const today = `${year}-${month}-${day}`;
  const RTH_OPEN = 9 * 60 + 30; // 09:30 ET in minutes

  // Helper to subtract days from a YYYY-MM-DD string.
  const minusDays = (dateStr: string, days: number): string => {
    const dt = new Date(dateStr + 'T12:00:00Z'); // noon UTC to avoid TZ edge cases
    dt.setUTCDate(dt.getUTCDate() - days);
    return dt.toISOString().slice(0, 10);
  };

  // Determine prior trading day based on current weekday.
  // After 09:30 ET on a weekday: today's trading day = today.
  // Before 09:30 ET on a weekday: today's trading day = previous weekday.
  // Saturday/Sunday/before-Sunday-18:00: trading day = previous Friday.

  if (weekday === 'Sat') {
    // Always Friday's trading day
    return minusDays(today, 1);
  }
  if (weekday === 'Sun') {
    // Always Friday's trading day (regardless of time, since Sun 18:00 reopen
    // is still part of Friday's day until Mon 09:30)
    return minusDays(today, 2);
  }
  if (weekday === 'Mon') {
    if (minutesOfDay < RTH_OPEN) {
      // Pre-market Monday = still Friday's trading day
      return minusDays(today, 3);
    }
    return today;
  }
  // Tue-Fri
  if (minutesOfDay < RTH_OPEN) {
    // Pre-market = previous weekday's trading day
    return minusDays(today, 1);
  }
  return today;
}

// --- Tick stream types (Phase 1: tick-store) ---

export interface TickTrade {
  type: 'trade';
  ts: number;          // milliseconds since epoch
  symbol: Symbol;
  price: number;
  size: number;
  isBidAggressor: boolean;  // true = seller hit bid (sell aggression); false = buyer lifted ask (buy aggression)
}

export interface TickDepth {
  type: 'depth';
  ts: number;
  symbol: Symbol;
  side: 'bid' | 'ask';
  price: number;
  size: number;        // 0 means level removed/cancelled
  isReplace: boolean;  // true if this replaces existing size at this price (vs add/remove)
}

export type TickEvent = TickTrade | TickDepth;

// Batched payload sent from addon to tick-store
export interface TickBatch {
  type: 'batch';
  ts: number;          // batch creation timestamp (server-side ordering)
  events: TickEvent[];
}
