// cooldown-shadow.ts
//
// Parallel "would-have-fired" simulator for qualified signals that the
// pipeline skipped via cooldown (action='SKIP_COOLDOWN' in tradable_signals).
//
// Motivation (2026-06-10): backtest showed that across the QUALIFIED 148
// signals (NQ FLIP+CONT), the cooldown-skipped subset (41 signals) carries
// roughly +$27.7/trade if they had been traded with FIXED 80 TP + per-rule SL.
// Net add over the 25-session window: +$1,137 / +$45/day. Before changing
// live behavior, shadow-log them and re-evaluate after collecting forward data.
//
// Strategy params per signal (mirroring the live pipeline's choices):
//   clean-impulse  long :  TP=80,  SL=55
//   clean-impulse  short:  TP=80,  SL=105
//   cont-reentry   long :  TP=80,  SL=70
//   cont-reentry   short:  TP=80,  SL=70
//
// Walks each shadow from open_ts to TP / SL / 15:54 ET (whichever first).
// Records open/close into shadow_trades with source='cooldown-skipped'.
//
// Pure observational — does not touch the live pipeline, the broker, or
// the SSE/WS bus. Wrapped in try/catch by callers so any failure here can
// only emit a warn log; live trading continues unaffected.

import { db } from './db.js';
import { logger as parentLogger } from './logger.js';

const logger = parentLogger.child({ mod: 'cooldown-shadow' });

// Symbols included in cooldown shadow tracking. Only NQ for v1; ES has no
// FLIP+CONT validated backtest yet.
const SHADOW_SYMBOLS = new Set(['NQ']);

const TOUCH_TOLERANCE = 0;      // unused; cooldown shadow opens at exact entry
const SHADOW_TP_PT = 80;

function rulesSl(ruleId: string, direction: 'long' | 'short'): number {
  if (ruleId === 'clean-impulse') return direction === 'long' ? 55 : 105;
  if (ruleId === 'cont-reentry')  return 70;
  // Unknown rule — shouldn't fire under current pipeline rules, but be defensive.
  throw new Error(`cooldown-shadow: no SL for rule '${ruleId}'`);
}

// ── ET helpers ──────────────────────────────────────────────────────────────
function etDateOf(tsMs: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(tsMs));
}
function etOffsetHours(etDate: string): number {
  const [y, m, d] = etDate.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y!, m! - 1, d!, 12, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(utcNoon);
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  return hour - 12;
}
function etTimeToMs(etDate: string, hh: number, mm: number): number {
  const offset = etOffsetHours(etDate);
  const [y, mo, d] = etDate.split('-').map(Number);
  return Date.UTC(y!, mo! - 1, d!, hh - offset, mm);
}
function bucketFor(tsMs: number): 'OPEN' | 'MID' | 'CLOSE' {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(tsMs));
  const hh = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  const mm = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  const minutes = hh * 60 + mm;
  if (minutes < 10 * 60 + 30) return 'OPEN';
  if (minutes < 14 * 60 + 30) return 'MID';
  return 'CLOSE';
}

// ── Internal position state ─────────────────────────────────────────────────
interface ShadowPosition {
  tradeId: number;
  signalId: number;
  ruleId: string;
  direction: 'long' | 'short';
  entry: number;
  openTs: number;
  tpPrice: number;
  slPrice: number;
  rthCloseMs: number;
}

class CooldownShadow {
  // Keyed by symbol → list of open positions for that symbol. List form (not
  // map) because multiple cooldown-skipped signals can be open simultaneously
  // — that's the whole point of shadowing them.
  private openBySymbol = new Map<string, ShadowPosition[]>();

  /**
   * Called from state.decideTradableSignals when action='SKIP_COOLDOWN'.
   * Records a shadow open into shadow_trades and starts walking it.
   *
   * Caller must wrap in try/catch — this method throws on bad rule_id and
   * the live pipeline must never crash because of it.
   */
  recordSkippedSignal(args: {
    symbol: string;
    signalId: number;
    ruleId: string;
    direction: 'long' | 'short';
    entry: number;
    ts: number;
  }): void {
    if (!SHADOW_SYMBOLS.has(args.symbol)) return;
    if (!Number.isFinite(args.entry)) return;

    const sl = rulesSl(args.ruleId, args.direction);
    const tpPrice = args.direction === 'long' ? args.entry + SHADOW_TP_PT : args.entry - SHADOW_TP_PT;
    const slPrice = args.direction === 'long' ? args.entry - sl              : args.entry + sl;
    const etDate = etDateOf(args.ts);
    const rthCloseMs = etTimeToMs(etDate, 15, 54);
    const bucket = bucketFor(args.ts);

    // Persist the open row first; bail out if the DB write fails.
    let tradeId: number;
    try {
      tradeId = db.shadow.open({
        source: 'cooldown-skipped',
        symbol: args.symbol,
        trading_day: etDate,
        level_label: `cooldown:${args.ruleId}`,   // semantic placeholder
        level_price: args.entry,                  // mirror entry — no level anchor
        classification: 'COOLDOWN',
        bucket,
        open_ts: args.ts,
        open_price: args.entry,
        direction: args.direction,
        approach_dir: 'N/A',
        tp_pt: SHADOW_TP_PT,
        sl_pt: sl,
        tp_price: tpPrice,
        sl_price: slPrice,
        signal_id: args.signalId,
        rule_id: args.ruleId,
      });
    } catch (err) {
      logger.warn({ err: String(err), signalId: args.signalId }, 'cooldown-shadow open insert failed');
      return;
    }

    const pos: ShadowPosition = {
      tradeId,
      signalId: args.signalId,
      ruleId: args.ruleId,
      direction: args.direction,
      entry: args.entry,
      openTs: args.ts,
      tpPrice, slPrice,
      rthCloseMs,
    };
    const list = this.openBySymbol.get(args.symbol) ?? [];
    list.push(pos);
    this.openBySymbol.set(args.symbol, list);

    logger.info({
      tradeId, signalId: args.signalId, ruleId: args.ruleId,
      direction: args.direction, entry: args.entry, tp: tpPrice, sl: slPrice, bucket,
    }, 'cooldown-shadow open');
  }

  /**
   * Called per tick by tick-router. Walks all open cooldown-shadow positions
   * for the symbol, closes any that hit TP / SL / 15:54.
   */
  onTick(symbol: string, ts: number, price: number): void {
    if (!SHADOW_SYMBOLS.has(symbol)) return;
    const list = this.openBySymbol.get(symbol);
    if (!list || list.length === 0) return;
    const stillOpen: ShadowPosition[] = [];
    for (const pos of list) {
      // 15:54 force close (EOD).
      if (ts >= pos.rthCloseMs) {
        this.closePosition(pos, price, 'EOD', ts);
        continue;
      }
      // TP / SL check.
      const exit = this.checkExitHit(pos, price);
      if (exit) {
        this.closePosition(pos, exit.price, exit.reason, ts);
        continue;
      }
      stillOpen.push(pos);
    }
    this.openBySymbol.set(symbol, stillOpen);
  }

  private checkExitHit(pos: ShadowPosition, price: number): { price: number; reason: 'TP' | 'SL' } | null {
    if (pos.direction === 'long') {
      if (price >= pos.tpPrice) return { price: pos.tpPrice, reason: 'TP' };
      if (price <= pos.slPrice) return { price: pos.slPrice, reason: 'SL' };
    } else {
      if (price <= pos.tpPrice) return { price: pos.tpPrice, reason: 'TP' };
      if (price >= pos.slPrice) return { price: pos.slPrice, reason: 'SL' };
    }
    return null;
  }

  private closePosition(
    pos: ShadowPosition, closePrice: number, reason: 'TP' | 'SL' | 'EOD', ts: number,
  ): void {
    const pnlPts = pos.direction === 'long' ? closePrice - pos.entry : pos.entry - closePrice;
    const pnlUsd = pnlPts * 2;  // MNQ $2/pt
    try {
      db.shadow.close({
        id: pos.tradeId, close_ts: ts, close_price: closePrice, close_reason: reason,
        pnl_pts: pnlPts, pnl_usd: pnlUsd, duration_ms: ts - pos.openTs,
      });
    } catch (err) {
      logger.warn({ err: String(err), tradeId: pos.tradeId }, 'cooldown-shadow close update failed');
    }
    logger.info({
      tradeId: pos.tradeId, signalId: pos.signalId, reason,
      pnlPts: pnlPts.toFixed(2), pnlUsd: pnlUsd.toFixed(2),
    }, 'cooldown-shadow close');
  }
}

export const cooldownShadow = new CooldownShadow();
// Silence touch_tolerance lint — kept for future approach-based variants
void TOUCH_TOLERANCE;
