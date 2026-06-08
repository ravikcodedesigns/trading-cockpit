// All event types flowing through the aggregator.
// Sources emit events conforming to these shapes.
// The cockpit consumes these via the cockpit WebSocket.

export type SourceName = 'bookmap' | 'bookmap-es' | 'flashalpha' | 'levels' | 'tradovate' | 'rules' | 'rules-v2';
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

// Liquidity Map code — determined at RTH open from open price vs HP/MHP placement.
//   Prefix: B = open in Bull Zone, Br = open in Bear Zone
//   L/S:    open > HP (Long side) / open < HP (Short side)
//   D/U:    MHP > HP (Down orientation) / HP > MHP (Up orientation)
// LP/IP edge cases (open between zones) must be set manually.
export type LmCode = 'BLD' | 'BLU' | 'BSD' | 'BSU' | 'BrLD' | 'BrLU' | 'BrSD' | 'BrSU';

// RS score conviction tier.
export type RSTier = 'PRIME' | 'HIGH' | 'MODERATE' | 'WEAK' | 'PASS';

export interface AdditionalLevel {
  price: number;
  label: string;                       // short label shown in axis (<=12 chars renders best)
  color?: string;                      // hex e.g. '#5a9bff'; defaults applied client-side
  style?: 'solid' | 'dashed' | 'dotted' | 'large-dashed' | 'sparse-dotted';  // defaults to 'dashed'
  width?: 1 | 2 | 3 | 4;               // defaults to 1; 2 = bold
}

// Secondary zone clusters beyond the primary bullZone/bearZone pair.
// Each entry is one Liquidity Pocket: brzt is the Bear Zone Top (EST long),
// bzb is the Bull Zone Bottom (EST long target / IP bounce level).
// Ordered top-to-bottom (highest brzt first).
export interface ExtraZone {
  bzb: number;   // Bull Zone Bottom — EST long level
  brzt: number;  // Bear Zone Top — EST long level (LP trade fires here)
}

export interface DailyLevels extends BaseEvent {
  source: 'levels';
  type: 'daily';
  symbol: Symbol;
  // The trading day these levels are active for, formatted as YYYY-MM-DD
  // in NY time. Trading day = 09:30 ET on Day N -> 09:30 ET on Day N+1.
  // Friday's trading day extends across the weekend gap to Monday 09:30.
  tradingDay: string;
  // RS structural levels — optional for instruments not yet on the RocketScooter framework
  // (e.g., ES Step 1 expansion 2026-06-04: only ON HP / ON MHP populated via additionalLevels).
  // NQ entries always have all four; chart skips rendering when absent.
  bullZone?: ZoneRange;   // primary Bull Zone; low = BZB (EST level), high = zone top (same as low if out of range)
  bearZone?: ZoneRange;   // primary Bear Zone; high = BrZT (EST level), low = zone bottom (same as high if out of range)
  ddBands?: { upper: number; lower: number };
  hedgePressure?: number; // HP — Weekly Hedge Pressure (cyan line)
  mhp?: number;          // MHP — Monthly Hedge Pressure (orange line); required for LM code auto-computation
  additionalLevels?: AdditionalLevel[];  // RS reference lines (QQQ Open/Close, HG, ON HP, etc.)
  extraZones?: ExtraZone[];              // secondary zone clusters, ordered top-to-bottom
  openPrice?: number;                    // RTH 09:30 open price — required for LM code auto-computation
  lmCode?: LmCode;                       // Liquidity Map code — auto-derived if openPrice + mhp are set
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
  source: 'rules' | 'rules-v2';
  type: 'confluence';
  symbol: Symbol;
  ruleId: string;
  score: number;          // 0-100 signal quality (tick data, CVD, absorption)
  direction: Direction;
  contextEventIds?: number[];
  rationale: string;
  observeOnly?: boolean;  // v1: always true
  strategyVersion: 'A' | 'B' | 'WBF';  // A=bar-based, B=tick-based, WBF=wall-broken-fade
  ruleVersion?: string;         // e.g. 'sweep-v1', 'absorption-v1'
  // RS scoring — independent dimension from signal score
  rsScore?: number;       // 0-100 RS confluence score
  rsTier?: RSTier;        // PRIME | HIGH | MODERATE | WEAK | PASS
  rsComponents?: { level: number; context: number; confirm: number };
  rsMatchedLevel?: string;   // label of nearest RS level
  rsLabelLine?: string;      // one-line display summary e.g. "BZB · First test · GM bull · BLD"
  // Resilience snapshot at signal time — conviction context for the cockpit
  resContext?: {
    res:       number;  // redistribution resilience (gray/white) — tiebreaker inside Open/HG/Close box
    hpRes:     number;  // HP resilience (blue)  — tiebreaker at HP level
    mhpRes:    number;  // MHP resilience (orange) — tiebreaker at MHP level
    isRational: boolean; // false = irrational rules apply, resilience is not reliable
  };
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
//
// Session-naming convention (LEVELS-side, not signal-side):
//   A "trading session" runs from the prior weekday's 16:00 ET close
//   (or Sun 18:00 ET for Monday's session) to the named day's 16:00 ET close.
//   The session is named by its ENDING date:
//
//     Mon's session: Sun 18:00 → Mon 16:00 ET (≈22h, special weekend reopen)
//     Tue's session: Mon 16:00 → Tue 16:00 ET (24h)
//     Wed's session: Tue 16:00 → Wed 16:00 ET (24h)
//     Thu's session: Wed 16:00 → Thu 16:00 ET (24h)
//     Fri's session: Thu 16:00 → Fri 16:00 ET (24h)
//     Weekend gap:   Fri 16:00 → Sun 18:00 ET (no session; mapped to next Mon)
//
// IMPORTANT: this boundary is for chart level rendering + daily_levels.json
// entries only. The RTH signal-gate convention (09:30 → 16:00 ET) is
// independent and unchanged — see classifySession() in apps/aggregator/src/quality.ts.
//
// Returns YYYY-MM-DD for the trading session that contains the given timestamp.
// Weekend-gap timestamps map to the next upcoming Monday session.
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
  const SESSION_END_MIN = 16 * 60;     // 16:00 ET = session close
  const SUNDAY_REOPEN_MIN = 18 * 60;   // 18:00 ET Sun = futures reopen

  const plusDays = (dateStr: string, days: number): string => {
    const dt = new Date(dateStr + 'T12:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  };

  // Sat → next Mon (weekend gap)
  if (weekday === 'Sat') return plusDays(today, 2);

  // Sun before 18:00 → next Mon (weekend gap continues)
  // Sun after 18:00 → Mon (next day; Monday's session in progress)
  if (weekday === 'Sun') return plusDays(today, 1);

  // Fri before 16:00 → today (Friday session)
  // Fri after 16:00 → next Mon (weekend gap)
  if (weekday === 'Fri') {
    return (minutesOfDay < SESSION_END_MIN) ? today : plusDays(today, 3);
  }

  // Mon/Tue/Wed/Thu before 16:00 → today's session
  // Mon/Tue/Wed/Thu after 16:00 → tomorrow's session
  return (minutesOfDay < SESSION_END_MIN) ? today : plusDays(today, 1);
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

// Re-export the standardized level color/style palette so cockpit + aggregator
// share one source of truth.
export * from './level-styles.js';
