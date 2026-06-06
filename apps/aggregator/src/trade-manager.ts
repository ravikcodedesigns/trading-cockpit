// TradeManager — V3 trade lifecycle.
//
// Responsibilities:
//   - Open a trade when state.ts decides a signal should fire (after V3 filters).
//   - Track TP/SL from per-rule config; check on every tick.
//   - Close a trade on TP hit, SL hit, opposite-direction signal, or RTH bell.
//   - Persist open-trade state to the open_trades table so a restart is recoverable.
//   - Emit 'trade-close' events for state.ts to forward to the bus / Discord.
//
// Asymmetric exit rule (from V3 backtest research):
//   - LONG trade: closes only on a QUALIFIED opposite-direction signal.
//   - SHORT trade: closes on ANY opposite-direction signal (qualified or silenced).
// state.ts is responsible for honoring this when it calls shouldExitOnSignal().
//
// This module is pure trade-bookkeeping. It does NOT:
//   - call classifySignalQuality()
//   - decide whether a signal opens or skips (state.ts orchestrates that)
//   - read CVD (that's state.ts's gate-check responsibility)
//   - touch broadcast paths (state.ts forwards close events)
//
// When config.v3.activeMode is 'off' or the symbol is not in config.v3.symbols,
// TradeManager methods are still safe to call but state.ts simply never calls them.

import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { logger } from './logger.js';
import { db, type V3OpenTrade } from './db.js';

export type Direction = 'long' | 'short';
export type CloseReason = 'TP_HIT' | 'SL_HIT' | 'OPP_SIG_EXIT' | 'CLOSE_AT_BELL';

export interface OpenedTrade {
  symbol: string;
  signalId: number;
  ruleId: string;
  pattern: string | null;
  direction: Direction;
  entry: number;
  tpPts: number;
  slPts: number;
  openTs: number;
}

export interface CloseEvent {
  trade: OpenedTrade;
  exitPx: number;
  exitTs: number;
  reason: CloseReason;
  /** Realized PnL in points, signed by direction. */
  pnlPts: number;
  /** Signal id of the closer if reason='OPP_SIG_EXIT', else null. */
  closingSignalId: number | null;
}

/**
 * Resolve the configured TP and SL points for a given V3 rule + direction.
 * Returns null if the rule is not in V3's perRule config (i.e. not a V3 entry rule).
 */
export function resolvePerRulePoints(
  ruleId: string,
  pattern: string | null,
  direction: Direction,
): { tp: number; sl: number } | null {
  const key = pattern ? `${ruleId}-${pattern}` : ruleId;
  const cfg = (config.v3.perRule as Record<string, { tp: number | { long: number; short: number }; sl: number | { long: number; short: number } }>)[key];
  if (!cfg) return null;
  const tp = typeof cfg.tp === 'number' ? cfg.tp : cfg.tp[direction];
  const sl = typeof cfg.sl === 'number' ? cfg.sl : cfg.sl[direction];
  return { tp, sl };
}

class TradeManager {
  private open = new Map<string, OpenedTrade>();
  private bus = new EventEmitter();

  constructor() {
    this.bus.setMaxListeners(20);
  }

  /**
   * Load any persisted open trades from DB on startup. Call once during boot.
   * Persisted rows that are older than today's RTH open are force-closed at
   * load time (their RTH session has long since ended).
   */
  hydrate(): void {
    const rows = db.v3.getAllOpenTrades();
    const now = Date.now();
    const todayRthOpen = rthOpenMsFor(now);
    let kept = 0, forceClosed = 0;
    for (const r of rows) {
      if (r.openTs < todayRthOpen) {
        // Stale: belonged to a prior RTH session. Drop it.
        db.v3.deleteOpenTrade(r.symbol);
        forceClosed++;
        logger.warn({ symbol: r.symbol, openTs: r.openTs }, 'TradeManager.hydrate: dropped stale open trade');
        continue;
      }
      this.open.set(r.symbol, this.rowToTrade(r));
      kept++;
    }
    logger.info({ kept, forceClosed }, 'TradeManager.hydrate complete');
  }

  /** Read the currently open trade for a symbol, or null. */
  getOpen(symbol: string): OpenedTrade | null {
    return this.open.get(symbol) ?? null;
  }

  /**
   * Open a new trade. Caller (state.ts) is responsible for having already
   * verified that no trade is currently open for this symbol and that the
   * signal passed all V3 entry gates.
   *
   * Returns the OpenedTrade. Throws if a trade is already open for the symbol.
   */
  openTrade(args: {
    symbol: string;
    signalId: number;
    ruleId: string;
    pattern: string | null;
    direction: Direction;
    entry: number;
    openTs: number;
  }): OpenedTrade {
    if (this.open.has(args.symbol)) {
      throw new Error(`TradeManager.openTrade: ${args.symbol} already has an open trade`);
    }
    const pts = resolvePerRulePoints(args.ruleId, args.pattern, args.direction);
    if (!pts) {
      throw new Error(`TradeManager.openTrade: no TP/SL config for ${args.ruleId}${args.pattern ? '/' + args.pattern : ''}`);
    }
    const trade: OpenedTrade = {
      symbol: args.symbol,
      signalId: args.signalId,
      ruleId: args.ruleId,
      pattern: args.pattern,
      direction: args.direction,
      entry: args.entry,
      tpPts: pts.tp,
      slPts: pts.sl,
      openTs: args.openTs,
    };
    this.open.set(trade.symbol, trade);
    db.v3.upsertOpenTrade({
      symbol: trade.symbol, signalId: trade.signalId, ruleId: trade.ruleId,
      pattern: trade.pattern, direction: trade.direction, entry: trade.entry,
      tpPts: trade.tpPts, slPts: trade.slPts, openTs: trade.openTs,
    });
    logger.info({ trade }, 'TradeManager: opened');
    return trade;
  }

  /**
   * Asymmetric exit rule predicate: given an incoming signal that is
   * opposite-direction to the currently open trade, decide whether it
   * is eligible to close that trade.
   *
   *   open LONG  → closer must be qualified (per config.v3.requireQualifiedExitsLongs)
   *   open SHORT → if closeShortsOnlyOnFlipLong=true: closer MUST be a qualified
   *                clean-impulse FLIP-long. Otherwise: legacy requireQualifiedExitsShorts.
   *
   * Returns false if no open trade or directions don't oppose.
   */
  shouldExitOnSignal(
    symbol: string,
    incomingDirection: Direction,
    incomingIsQualified: boolean,
    incomingRuleId?: string,
    incomingPattern?: string | null,
  ): boolean {
    const t = this.open.get(symbol);
    if (!t) return false;
    if (t.direction === incomingDirection) return false;
    if (t.direction === 'long' && config.v3.requireQualifiedExitsLongs && !incomingIsQualified) {
      return false;
    }
    if (t.direction === 'short') {
      if (config.v3.closeShortsOnlyOnFlipLong) {
        // Strict: only a qualified FLIP-LONG (clean-impulse + FLIP pattern) can close a short.
        if (!incomingIsQualified) return false;
        if (incomingRuleId !== 'clean-impulse') return false;
        if (incomingPattern !== 'FLIP') return false;
      } else if (config.v3.requireQualifiedExitsShorts && !incomingIsQualified) {
        return false;
      }
    }
    return true;
  }

  /**
   * Close the open trade by reason. Emits a 'trade-close' event and removes
   * the row from open_trades. Returns the close event for the caller's use,
   * or null if there was no open trade.
   */
  closeTrade(
    symbol: string,
    exitPx: number,
    exitTs: number,
    reason: CloseReason,
    closingSignalId: number | null = null,
  ): CloseEvent | null {
    const t = this.open.get(symbol);
    if (!t) return null;
    const pnlPts = t.direction === 'long' ? exitPx - t.entry : t.entry - exitPx;
    const evt: CloseEvent = { trade: t, exitPx, exitTs, reason, pnlPts, closingSignalId };
    this.open.delete(symbol);
    db.v3.deleteOpenTrade(symbol);
    logger.info({ symbol, exitPx, exitTs, reason, pnlPts }, 'TradeManager: closed');
    this.bus.emit('trade-close', evt);
    return evt;
  }

  /**
   * Tick handler. Called for every NQ trade tick when V3 is active.
   * Closes the open trade if the tick crosses TP or SL.
   *
   * Note: this checks SL FIRST. If a single tick somehow satisfies both
   * (impossible since tpPts and slPts are on opposite sides of entry, but
   * defensive), the adverse outcome takes precedence — the worse outcome
   * for the trader. This matches the backtest's `if (adv >= sl) before
   * if (fav >= tp)` ordering.
   */
  onTick(symbol: string, tickTs: number, tickPx: number): CloseEvent | null {
    const t = this.open.get(symbol);
    if (!t) return null;
    const fav = t.direction === 'long' ? tickPx - t.entry : t.entry - tickPx;
    const adv = -fav;
    if (adv >= t.slPts) {
      const slPx = t.direction === 'long' ? t.entry - t.slPts : t.entry + t.slPts;
      return this.closeTrade(symbol, slPx, tickTs, 'SL_HIT', null);
    }
    if (fav >= t.tpPts) {
      const tpPx = t.direction === 'long' ? t.entry + t.tpPts : t.entry - t.tpPts;
      return this.closeTrade(symbol, tpPx, tickTs, 'TP_HIT', null);
    }
    return null;
  }

  /**
   * Force-close any open trade for this symbol at the provided RTH close price.
   * Called by the RTH close timer (15:54 ET) for each tracked symbol.
   */
  onRthClose(symbol: string, closePx: number, closeTs: number): CloseEvent | null {
    return this.closeTrade(symbol, closePx, closeTs, 'CLOSE_AT_BELL', null);
  }

  /** For tests / diagnostics. */
  snapshot(): OpenedTrade[] {
    return [...this.open.values()];
  }

  /** Subscribe to close events. Returns an unsubscribe function. */
  onClose(fn: (e: CloseEvent) => void): () => void {
    this.bus.on('trade-close', fn);
    return () => { this.bus.off('trade-close', fn); };
  }

  private rowToTrade(r: V3OpenTrade): OpenedTrade {
    return {
      symbol: r.symbol, signalId: r.signalId, ruleId: r.ruleId,
      pattern: r.pattern, direction: r.direction, entry: r.entry,
      tpPts: r.tpPts, slPts: r.slPts, openTs: r.openTs,
    };
  }
}

// Return today's RTH-open UTC ms (09:30 ET / 13:30 UTC assuming EDT).
function rthOpenMsFor(tsMs: number): number {
  const d = new Date(tsMs - 4 * 60 * 60_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 13, 30, 0, 0);
}

// Module-level singleton. Importers reuse the same instance.
export const tradeManager = new TradeManager();
