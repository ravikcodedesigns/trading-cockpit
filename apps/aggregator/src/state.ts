import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { db } from './db.js';
import { discord } from './discord.js';
import { logger } from './logger.js';
import { classifySignalQuality } from './quality.js';
import type { QualityContext } from './quality.js';
import { evaluateTechnical, evaluateActionability } from './signal-pipeline.js';
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

// ── Pipeline helpers ──────────────────────────────────────────────────────
//
// Used by the pipeline path (decideTradableSignals + close/open methods) for
// looking up entry prices, last ticks, etc.

// isV3EntryRule + v3PatternFor — REMOVED 2026-06-09 in pipeline cutover.
// The pipeline's signal-pipeline.ts:isTradableRule() + patternFor() are the
// authoritative replacements. Anything in state.ts that needs the pattern
// field reads it directly from the signal payload (it's just signal.pattern).

/**
 * Resolve a usable entry price for a signal at pipeline open time.
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

// logV3Decision — REMOVED 2026-06-09 in pipeline cutover. The pipeline writes
// per-signal decisions to tradable_signals (the modern equivalent of
// v3_decisions). Old v3_decisions writes from applySignalV3 are gone with the
// cascade removal.

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

    // Subscribe to TradeManager close events. Close events forward to the
    // cockpit bus + Discord and audit-log to v3_decisions (to be renamed
    // signal_results in a follow-up commit).
    tradeManager.onClose((evt) => this.handleTradeClose(evt));

    // One-time hydration at boot. Cost: small ticks.db scan. Keeps cvdSession
    // + tradeManager consistent across process restarts so the pipeline sees
    // valid CVD state and any persisted open trades on the first signal.
    try {
      cvdSession.hydrate(config.pipeline.symbols);
      tradeManager.hydrate();
      logger.info({ mode: config.pipeline.activeMode, symbols: config.pipeline.symbols }, 'pipeline initialized');
    } catch (err) {
      logger.error({ err: String(err) }, 'pipeline init failed');
    }
  }

  /**
   * Handler for TradeManager close events. Broadcasts to cockpit and Discord.
   * Audit-logs the close as a v3_decisions row for backwards-compatible
   * close-history queries (the table will be renamed in a follow-up commit).
   */
  private handleTradeClose(evt: CloseEvent) {
    // Audit log to v3_decisions (close-history record).
    try {
      db.signalResults.log({
        ts: evt.exitTs,
        symbol: evt.trade.symbol,
        signalId: evt.closingSignalId,
        ruleId: evt.trade.ruleId,
        pattern: evt.trade.pattern,
        direction: evt.trade.direction,
        qualified: true,
        activeMode: 'live',
        action: 'CLOSE',
        reason: `${evt.reason} px=${evt.exitPx} pnl=${evt.pnlPts.toFixed(1)}`,
        exitPrice: evt.exitPx,
        exitOutcome: evt.reason === 'TP_HIT' ? 'WIN' : evt.reason === 'SL_HIT' ? 'LOSS' : evt.reason as any,
        pnlPts: evt.pnlPts,
        openTradeId: evt.trade.signalId,
        entry: evt.trade.entry,
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'failed to audit-log trade close');
    }

    // Forward to cockpit bus + Discord. Chart.tsx renders the close marker.
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
    const qualityCtx: QualityContext = { recentExpls, lastFlip, ...regimeCtx };
    const decision = classifySignalQuality(signal, qualityCtx);
    const isGold = decision.tier === 'gold';

    // ── Pipeline dispatch (post-cutover, 2026-06-09) ─────────────────────────
    // For symbols managed by the pipeline (config.pipeline.symbols → NQ currently),
    // decideTradableSignals owns the close-on-opp + open-trade + broadcast
    // path. For other symbols (ES today), fall through to the legacy gold-tier
    // broadcast — these symbols haven't been promoted into the pipeline scope.
    const pipelineSymbolManaged = (config.pipeline.symbols as readonly string[]).includes(signal.symbol);

    if (pipelineSymbolManaged) {
      this.decideTradableSignals(signal, id, isGold, decision.reason, qualityCtx);
    } else if (isGold) {
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
   * Pipeline decision maker (PR #2 + PR #4).
   *
   * Runs evaluateTechnical + evaluateActionability, writes the decision to
   * tradable_signals, and (when pipeline.activeMode === 'live' and the symbol
   * is in v3.symbols) drives the actual broadcast + tradeManager side effects.
   *
   * Behavior by config.pipeline.activeMode:
   *   - 'shadow': parallel observer only. Writes tradable_signals + logs
   *               divergence vs V3 cascade. NO broadcasts or trade-manager calls.
   *   - 'live':   authoritative path. After writing tradable_signals, applies
   *               close-on-opp + OPEN/broadcast based on the pipeline's action.
   *               V3 cascade still runs (with applySideEffects=false) for log
   *               continuity in v3_decisions.
   *
   * Returns the pipeline's action string ('OPEN', 'SKIP_*', or 'ERROR' on
   * exception) so the caller can log it / compare to V3.
   *
   * Never throws. Errors are caught and logged.
   */
  private decideTradableSignals(
    signal: ConfluenceSignal,
    signalId: number,
    isGold: boolean,
    qualifiedReason: string,
    qualityCtx: QualityContext,
  ): string {
    try {
      // Sanity: technical wrapper MUST match what classifySignalQuality returned.
      // (Pinned by pipeline_equivalence_smoke.ts; double-check at runtime for
      // catching drift.)
      const tech = evaluateTechnical(signal, qualityCtx);
      if (tech.qualified !== isGold) {
        logger.error({
          signalId, ruleId: signal.ruleId,
          live_isGold: isGold, pipeline_qualified: tech.qualified,
        }, '[PIPELINE-DIVERGENCE] evaluateTechnical disagrees with live classifySignalQuality');
      }

      const symbol = signal.symbol;
      const cvd = cvdSession.get(symbol);
      const hasOpenTrade = tradeManager.getOpen(symbol) != null;
      const act = evaluateActionability(signal, tech.qualified, tech.reason,
                                        { cvdSession: cvd, hasOpenTrade });

      // Shadow flag mirrors SKIP_FORCE_SHADOW — a force-shadow rule (es-flip,
      // expl) that would otherwise OPEN is logged but not traded.
      const shadow = act.action === 'SKIP_FORCE_SHADOW';

      // ── Apply actions ────────────────────────────────────────────────────
      // Pipeline is authoritative — drive close-on-opp + OPEN + broadcast from
      // the decision. Sequence per design:
      //   1. close any open trade if this signal is opposing-qualified
      //   2. open new trade + broadcast if action='OPEN'
      //   3. write tradable_signals row LAST — log reflects what actually
      //      happened (trade placed), not what we're about to do.
      this.closeOpenTradeOnOpposingSignal(signal, signalId, tech.qualified);
      if (act.action === 'OPEN') {
        this.openTradeAndBroadcast(signal, signalId, act.reason);
      }

      db.tradable.upsert({
        signal_id:    signalId,
        signal_ts:    signal.ts,
        symbol,
        rule_id:      signal.ruleId,
        pattern:      (signal as { pattern?: string }).pattern ?? null,
        direction:    signal.direction as 'long' | 'short',
        score:        signal.score,
        qualified:    tech.qualified,
        action:       act.action,
        reason:       act.reason,
        shadow,
        cvd_session:  cvd,
        entry:        (signal as { entry?: number }).entry,
        evaluated_at: Date.now(),
      });

      return act.action;
    } catch (err) {
      // Observer failures must never affect live trading. Log and move on.
      logger.warn({ err, signalId, ruleId: signal.ruleId },
                  '[PIPELINE-DECIDE] failed — falling back to V3 cascade for this signal');
      return 'ERROR';
    }
  }

  /**
   * Close the symbol's open trade if THIS incoming signal is a qualified
   * opposing-direction signal whose rule is in `config.pipeline.tradableExitRules`
   * (currently FLIP + CONT). No-op when there's no open trade, when the
   * direction matches, or when the rule isn't an exit-eligible rule.
   *
   * Called by the pipeline-live path before evaluating whether THIS signal
   * itself should open a new trade — exactly the same close-on-opp semantics
   * that V3's Step 1 used to handle. Source-of-truth for the close decision
   * is `tradeManager.shouldExitOnSignal()`.
   */
  private closeOpenTradeOnOpposingSignal(
    signal: ConfluenceSignal,
    signalId: number,
    qualified: boolean,
  ): void {
    const symbol = signal.symbol;
    const direction = signal.direction as 'long' | 'short';
    const pattern = (signal as { pattern?: string }).pattern ?? null;

    const openTrade = tradeManager.getOpen(symbol);
    if (!openTrade) return;
    if (!tradeManager.shouldExitOnSignal(symbol, direction, qualified, signal.ruleId, pattern)) return;

    const exitPx = resolveEntryForOpen(signal) ?? latestTickPriceAtOrBefore(symbol, signal.ts);
    if (exitPx == null) {
      logger.warn({ symbol, signalId }, 'pipeline live: opposite signal arrived but no exit price; skip close');
      return;
    }
    tradeManager.closeTrade(symbol, exitPx, signal.ts, 'OPP_SIG_EXIT', signalId);
  }

  /**
   * Open a new trade in tradeManager AND broadcast the signal to the cockpit
   * (via this.bus.emit 'signal') + Discord webhook. Called only when the
   * pipeline's action for THIS signal was 'OPEN' and pipeline is the live
   * driver. The trader subscribes to bus 'signal' events to place the actual
   * broker order — so this method's openTrade call is the trigger for the
   * full live-trade flow.
   *
   * If the entry price can't be resolved (rare — signal payload missing entry
   * + no recent tick), warn and skip without opening or broadcasting.
   */
  private openTradeAndBroadcast(
    signal: ConfluenceSignal,
    signalId: number,
    reason: string,
  ): void {
    const symbol = signal.symbol;
    const direction = signal.direction as 'long' | 'short';
    const pattern = (signal as { pattern?: string }).pattern ?? null;

    const entry = resolveEntryForOpen(signal);
    if (entry == null) {
      logger.warn({ symbol, signalId, rule: signal.ruleId }, 'pipeline live: cannot resolve entry price; skip open');
      return;
    }
    tradeManager.openTrade({
      symbol, signalId, ruleId: signal.ruleId, pattern, direction,
      entry, openTs: signal.ts,
    });
    this.bus.emit('signal', signal);
    discord.signal(signal);
    logger.info({ ruleId: signal.ruleId, score: signal.score, reason },
                'pipeline live: signal broadcast + trade opened');
  }

  // applySignalV3 — REMOVED 2026-06-09 in pipeline cutover. The pipeline path
  // (decideTradableSignals + closeOpenTradeOnOpposingSignal +
  // openTradeAndBroadcast) is the authoritative replacement. All entry gating,
  // cascade ordering, and broadcast/tradeManager side effects live there.

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
    // Pull from qualified_signals (the persisted "this passed the gate at
    // fire-time" record). Earlier this re-ran classifySignalQuality on every
    // recentSignals(2000) row in-memory, which meant a signal could "go away"
    // on a cockpit reload if the gate logic / context had drifted since it
    // fired. Reading the persisted decision keeps cards stable across
    // cockpit reloads AND aggregator restarts — what the user saw at fire
    // time is what they see again on reload.
    //
    // 30h window covers a full futures session (Sun 18:00 ET → Mon 16:00 ET
    // = 22h) plus generous slack. Cap at 2000 so the snapshot stays small.
    const sinceMs = Date.now() - 30 * 60 * 60 * 1000;
    const goldOnly = db.qualifiedSignalsSince(sinceMs, 2000);

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

  // V3 trade-close events. Emitted when V3 closes a position (TP_HIT, SL_HIT,
  // OPP_SIG_EXIT, CLOSE_AT_BELL). Broadcast to cockpit WS so the trader app
  // can listen for V3-driven exits (e.g. opposing-signal exit on FLIP-LONG
  // closing an open FLIP-SHORT). Live mode only — handleTradeClose gates this.
  onTradeClose(fn: (evt: any) => void): () => void {
    this.bus.on('trade-close', fn);
    return () => { this.bus.off('trade-close', fn); };
  }
}

export const state = new State();
