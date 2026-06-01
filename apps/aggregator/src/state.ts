import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { db, type V3Decision } from './db.js';
import { discord } from './discord.js';
import { logger } from './logger.js';
import { classifySignalQuality } from './quality.js';
import type { QualityContext } from './quality.js';
import { cvdSession } from './cvd-session.js';
import { tradeManager, type CloseEvent } from './trade-manager.js';
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

// ── V3 helpers ────────────────────────────────────────────────────────────
//
// These are no-ops when config.v3.activeMode === 'off'.

/**
 * Is this signal a V3 entry-rule candidate (would be eligible to open or
 * close a V3 trade)? Independent of qualification — used by the exit-check
 * path which considers even silenced signals.
 */
function isV3EntryRule(signal: ConfluenceSignal): boolean {
  if (signal.ruleId === 'absorption') return true;
  if (signal.ruleId === 'expl')       return true;
  if (signal.ruleId === 'clean-impulse' && (signal as any).pattern === 'FLIP') return true;
  return false;
}

/**
 * Pattern field for V3 entries that need one (currently only FLIP).
 */
function v3PatternFor(signal: ConfluenceSignal): string | null {
  if (signal.ruleId === 'clean-impulse' && (signal as any).pattern === 'FLIP') return 'FLIP';
  return null;
}

/**
 * Resolve a usable entry price for a signal at V3 open time.
 *
 * - absorption / FLIP: payload has 'entry' (always populated by rule engine).
 * - expl: no entry field — fall back to the most recent tick price for the
 *   symbol at-or-before the signal ts (matches backtest behavior).
 * - Returns null if no price can be resolved (signal is then SKIPPED).
 */
function resolveEntryForOpen(signal: ConfluenceSignal): number | null {
  const entry = (signal as any).entry as number | undefined;
  if (entry && entry > 0) return entry;
  // EXPL fallback: latest tick at/before signal ts
  if (signal.ruleId === 'expl') {
    return latestTickPriceAtOrBefore(signal.symbol, signal.ts);
  }
  return null;
}

/**
 * Look up the last trade tick at-or-before tsMs in ticks.db.
 * Used by V3 for EXPL entry fallback and for OPP_SIG_EXIT close-price.
 * Returns null if no tick is available (e.g. data outage).
 */
let _ticksDb: import('better-sqlite3').Database | null = null;
function getTicksDb(): import('better-sqlite3').Database | null {
  if (_ticksDb) return _ticksDb;
  try {
    const Database = require('better-sqlite3');
    const path = require('node:path');
    const ticksPath = path.join(path.dirname(config.dbPath), 'ticks.db');
    _ticksDb = new Database(ticksPath, { readonly: true });
    return _ticksDb;
  } catch (err) {
    logger.warn({ err: String(err) }, 'V3: ticks.db unavailable for price lookup');
    return null;
  }
}
function latestTickPriceAtOrBefore(symbol: string, tsMs: number): number | null {
  const x = getTicksDb();
  if (!x) return null;
  const row = x.prepare(
    `SELECT price FROM trades WHERE symbol=? AND ts<=? ORDER BY ts DESC LIMIT 1`
  ).get(symbol, tsMs) as { price: number } | undefined;
  return row?.price ?? null;
}

/** Compose a V3Decision row from the per-signal evaluation. */
function logV3Decision(d: V3Decision) {
  try { db.v3.logDecision(d); } catch (err) {
    logger.error({ err: String(err) }, 'V3: failed to log decision');
  }
}

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

    // Always subscribe to TradeManager close events. The handler internally
    // checks config.v3.activeMode and short-circuits if 'off'. Subscribing
    // unconditionally means runtime mode changes (tests, ops flips) still
    // see close events without restarting the process.
    tradeManager.onClose((evt) => this.handleTradeClose(evt));

    // One-time hydration at boot — only if V3 is on at startup. Cost: small
    // one-time ticks.db scan. If mode is flipped on later via SIGHUP/restart,
    // hydration happens then. Within a single process lifetime, this is
    // fine: in-memory state stays consistent because applySignalV3 keeps
    // CvdSession in sync from ticks (Task #47) and TradeManager in sync
    // from applySignal calls.
    if (config.v3.activeMode !== 'off') {
      try {
        cvdSession.hydrate(config.v3.symbols);
        tradeManager.hydrate();
        logger.info({ mode: config.v3.activeMode, symbols: config.v3.symbols }, 'V3 initialized');
      } catch (err) {
        logger.error({ err: String(err) }, 'V3 init failed; falling back to off mode');
      }
    }
  }

  /**
   * Handler for TradeManager close events. In live mode, broadcasts to cockpit
   * and Discord. In shadow mode, just logs (close events fire on TP/SL ticks
   * regardless of mode, but we only show the user in live mode).
   */
  private handleTradeClose(evt: CloseEvent) {
    const mode = config.v3.activeMode;
    if (mode === 'off') return;

    // Audit log to v3_decisions regardless of mode.
    logV3Decision({
      ts: evt.exitTs,
      symbol: evt.trade.symbol,
      signalId: evt.closingSignalId,
      ruleId: evt.trade.ruleId,
      pattern: evt.trade.pattern,
      direction: evt.trade.direction,
      qualified: true,                          // open-trade entries were qualified V3 opens
      activeMode: mode === 'live' ? 'live' : 'shadow',
      action: 'CLOSE',
      reason: `${evt.reason} px=${evt.exitPx} pnl=${evt.pnlPts.toFixed(1)}`,
      exitPrice: evt.exitPx,
      exitOutcome: evt.reason === 'TP_HIT' ? 'WIN' : evt.reason === 'SL_HIT' ? 'LOSS' : evt.reason as any,
      pnlPts: evt.pnlPts,
      openTradeId: evt.trade.signalId,
      entry: evt.trade.entry,
    });

    if (mode !== 'live') return;
    // Live mode: forward to cockpit bus and Discord.
    // The cockpit will get a 'trade-close' message; Chart.tsx renders a close marker.
    this.bus.emit('trade-close', evt);
    try { (discord as any).tradeClose?.(evt); } catch { /* discord helper optional */ }
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

    // Compute the quality decision once. Both the legacy and V3 paths need it.
    const recentExpls = db.explInWindow(signal.symbol, signal.ts - EXPL_LOOKBACK_MS, signal.ts);
    const regimeCtx = buildRegimeContext(signal);
    const lastFlip = db.lastFlipInWindow(signal.symbol, signal.ts - FLIP_LOOKBACK_MS, signal.ts);
    const decision = classifySignalQuality(signal, { recentExpls, lastFlip, ...regimeCtx });
    const isGold = decision.tier === 'gold';

    // ── V3 active path. Engages when (a) V3 is on and (b) the symbol is in
    //    config.v3.symbols. Otherwise we fall through to the legacy broadcast.
    const v3Active = config.v3.activeMode !== 'off'
                  && (config.v3.symbols as readonly string[]).includes(signal.symbol);
    if (v3Active) {
      this.applySignalV3(signal, id, isGold, decision.reason);
      return id;
    }

    // ── Legacy path (unchanged from pre-V3). Quality gate for broadcast.
    if (isGold) {
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

  /**
   * V3 broadcast and trade-management pipeline. Called only when V3 is active.
   *
   * Two responsibilities:
   *   1. CHECK FOR EXIT — if a V3 trade is open and this opposite-direction
   *      signal is eligible to close it (per asymmetric rule), close it.
   *      Runs BEFORE the gold-tier broadcast decision so silenced opposite
   *      signals can still close short trades.
   *   2. DECIDE WHETHER TO BROADCAST / OPEN — apply V3 filters:
   *        - must be gold-tier
   *        - must be a V3 entry rule (absorption / FLIP / EXPL)
   *        - drop FLIP shorts
   *        - CVD regime gate
   *        - cooldown (no open trade)
   *
   * Behavior by mode:
   *   - 'shadow': decisions are written to v3_decisions for the daily diff
   *               script. The actual broadcast falls back to the legacy
   *               gold-tier rule so the chart and Discord behave as they do
   *               today. TradeManager state IS updated so that close events
   *               can be observed end-to-end in shadow.
   *   - 'live'  : V3 decisions gate the broadcast. Filtered signals do NOT
   *               reach the chart or Discord. TradeManager state is updated
   *               and close events flow to the bus.
   */
  private applySignalV3(signal: ConfluenceSignal, id: number, isGold: boolean, qualityReason: string): void {
    const mode = config.v3.activeMode as 'shadow' | 'live';   // 'off' was filtered out before
    const direction = signal.direction as 'long' | 'short';
    const symbol = signal.symbol;
    const pattern = v3PatternFor(signal);
    const isV3Rule = isV3EntryRule(signal);
    const cvd = cvdSession.get(symbol);
    const baseDecision: Omit<V3Decision, 'action' | 'reason'> = {
      ts: signal.ts, symbol, signalId: id, ruleId: signal.ruleId, pattern,
      direction, qualified: isGold, activeMode: mode,
      cvdSession: cvd,
      entry: (signal as any).entry ?? undefined,
    };

    // ── Step 1: Check whether this signal should close an open trade.
    const openTrade = tradeManager.getOpen(symbol);
    let didClose = false;
    if (openTrade && isV3Rule && tradeManager.shouldExitOnSignal(symbol, direction, isGold)) {
      const exitPx = resolveEntryForOpen(signal) ?? latestTickPriceAtOrBefore(symbol, signal.ts);
      if (exitPx != null) {
        // closeTrade also emits a 'trade-close' event handled by handleTradeClose.
        tradeManager.closeTrade(symbol, exitPx, signal.ts, 'OPP_SIG_EXIT', id);
        didClose = true;
      } else {
        logger.warn({ symbol, signalId: id }, 'V3: opposite signal arrived but no exit price available; skip close');
      }
    }

    // ── Step 2: Determine whether this signal can OPEN a new trade.
    // Sequence of gates: not-V3-rule → silenced → flip-short → CVD → cooldown → OPEN.
    let action: V3Decision['action'] = 'OPEN';
    let reason = qualityReason;

    if (!isV3Rule) { action = 'SKIP_NOT_V3_RULE'; reason = `not a V3 entry rule (${signal.ruleId})`; }
    else if (!isGold) { action = 'SKIP_SILENCED'; reason = `silenced: ${qualityReason}`; }
    else if (config.v3.dropFlipShorts && signal.ruleId === 'clean-impulse' && pattern === 'FLIP' && direction === 'short') {
      action = 'SKIP_FLIP_SHORT'; reason = 'V3 drops qualified FLIP shorts';
    }
    else if (direction === 'long'  && cvd <= config.v3.cvdLongFloor) {
      action = 'SKIP_CVD'; reason = `cvdSession=${cvd} <= longFloor=${config.v3.cvdLongFloor}`;
    }
    else if (direction === 'short' && cvd >= config.v3.cvdShortFloor) {
      action = 'SKIP_CVD'; reason = `cvdSession=${cvd} >= shortFloor=${config.v3.cvdShortFloor}`;
    }
    else if (tradeManager.getOpen(symbol)) {
      // Either we didn't close above (same-dir signal), or the close completed
      // and we'd be re-opening — but a re-open in this path means the closer
      // was an entry-eligible opposite signal. We already closed the prior
      // trade; only allow opening a new one if the slot is empty after close.
      // Belt-and-suspenders: if still open, skip.
      action = 'SKIP_COOLDOWN'; reason = 'V3 cooldown: a trade is already open';
    }

    // ── Log the entry decision.
    logV3Decision({ ...baseDecision, action, reason });

    // ── Step 3: Apply broadcast + open by mode.
    if (mode === 'live') {
      if (action === 'OPEN') {
        const entry = resolveEntryForOpen(signal);
        if (entry == null) {
          logger.warn({ symbol, signalId: id, rule: signal.ruleId }, 'V3 live: cannot resolve entry price; skip open');
        } else {
          // Open the trade and broadcast normally.
          tradeManager.openTrade({
            symbol, signalId: id,
            ruleId: signal.ruleId, pattern, direction,
            entry, openTs: signal.ts,
          });
          this.bus.emit('signal', signal);
          discord.signal(signal);
          logger.info({ ruleId: signal.ruleId, score: signal.score, reason: qualityReason }, 'V3 live: signal broadcast + trade opened');
        }
      } else {
        logger.debug({ ruleId: signal.ruleId, action, reason }, 'V3 live: signal not broadcast');
      }
    } else {
      // Shadow: broadcast follows the legacy gold-tier path; V3 decisions are
      // recorded but do not alter what the user sees.
      if (isGold) {
        this.bus.emit('signal', signal);
        discord.signal(signal);
        logger.info({ ruleId: signal.ruleId, score: signal.score, v3Action: action }, 'V3 shadow: legacy broadcast (V3 decision logged)');
      }
      // In shadow mode we also keep TradeManager in sync so close events are
      // observable end-to-end — but only OPEN if V3 said OPEN, never override
      // the legacy broadcast.
      if (action === 'OPEN' && !tradeManager.getOpen(symbol)) {
        const entry = resolveEntryForOpen(signal);
        if (entry != null) {
          tradeManager.openTrade({
            symbol, signalId: id,
            ruleId: signal.ruleId, pattern, direction,
            entry, openTs: signal.ts,
          });
        }
      }
    }

    // didClose just suppresses an unused-var warning in some lint configs.
    void didClose;
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
