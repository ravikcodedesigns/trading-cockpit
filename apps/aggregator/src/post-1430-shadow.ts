// post-1430-shadow.ts
//
// Shadow tracking for NQ clean-impulse FLIP SHORT signals that fire AFTER
// 14:30 ET. The pipeline marks them action='OPEN' (qualified + tradable)
// but the trader's risk-guard universal-stop blocks them downstream. This
// module opens a virtual position at the signal's entry and walks TP=80 /
// SL=105 until TP / SL / 15:54 ET, recording the outcome to shadow_trades
// with source='post-1430-flip-short'.
//
// Per Ravi's request 2026-06-10: shadow-test for ~2 weeks. If the cohort
// stays positive after more data lands, carve out a rule-aware exception
// to the 14:30 universal stop in risk-guard.
//
// Motivation: historical analysis on 30 qualified NQ FLIP shorts shows
// 73.3% WR / +$58.6 per trade overall. The 2 historical post-14:30
// samples were both winners (+$160 TP hit on 2026-06-05; +$79 RTH-close
// on today's 2026-06-10 signal — the one Ravi noticed). n=2 is too small
// to claim a real edge yet, but the pattern is worth observing forward.
//
// Pure observational — never touches live order flow. Wrapped in try/catch
// by callers so any failure here can only emit a warn log; live trading
// continues unaffected.

import { db } from './db.js';
import { logger as parentLogger } from './logger.js';

const logger = parentLogger.child({ mod: 'post-1430-shadow' });

const SYMBOL_FILTER = 'NQ';
const RULE_FILTER = 'clean-impulse';
const PATTERN_FILTER = 'FLIP';
const DIRECTION_FILTER = 'short';
const POST_1430_MIN = 14 * 60 + 30; // 14:30 ET in minutes-of-day
const RTH_CLOSE_HH = 15, RTH_CLOSE_MM = 54;

// Per-rule SL applied to FLIP shorts (matches signal-pipeline / live config):
//   clean-impulse short → TP=80, SL=105
const TP_PT = 80;
const SL_PT = 105;

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
function etMinuteOfDay(tsMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(tsMs));
  const hh = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  const mm = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  return hh * 60 + mm;
}

// ── Position state ──────────────────────────────────────────────────────────
interface ShadowPosition {
  tradeId: number;
  signalId: number;
  entry: number;
  openTs: number;
  tpPrice: number;
  slPrice: number;
  rthCloseMs: number;
}

class Post1430Shadow {
  // All shadows are NQ short, but keyed by symbol for future flexibility.
  private openBySymbol = new Map<string, ShadowPosition[]>();

  /**
   * Called from state.decideTradableSignals when a signal has action='OPEN'
   * AND qualified=true. We filter HERE (not in the caller) so the gate is
   * encapsulated in one place: NQ clean-impulse FLIP short fired ≥ 14:30 ET.
   *
   * Caller wraps in try/catch — this method MUST NOT crash the live path.
   */
  recordSignalIfApplicable(args: {
    symbol: string;
    signalId: number;
    ruleId: string;
    direction: 'long' | 'short';
    entry: number;
    ts: number;
    pattern: string | null;
  }): void {
    if (args.symbol !== SYMBOL_FILTER) return;
    if (args.ruleId !== RULE_FILTER) return;
    if (args.pattern !== PATTERN_FILTER) return;
    if (args.direction !== DIRECTION_FILTER) return;
    if (!Number.isFinite(args.entry)) return;
    if (etMinuteOfDay(args.ts) < POST_1430_MIN) return;

    const etDate = etDateOf(args.ts);
    const rthCloseMs = etTimeToMs(etDate, RTH_CLOSE_HH, RTH_CLOSE_MM);
    if (args.ts >= rthCloseMs) return;  // signal arrived ≥ 15:54 — no walk window

    const tpPrice = args.entry - TP_PT;  // short: TP below entry
    const slPrice = args.entry + SL_PT;  // short: SL above entry

    let tradeId: number;
    try {
      tradeId = db.shadow.open({
        source: 'post-1430-flip-short' as 'cooldown-skipped',  // schema accepts any string
        symbol: args.symbol,
        trading_day: etDate,
        level_label: `post-1430:${args.symbol}-FLIP-short`,
        level_price: args.entry,
        classification: 'COOLDOWN',
        bucket: 'CLOSE',  // always in the 14:30-15:54 window
        open_ts: args.ts,
        open_price: args.entry,
        direction: 'short',
        approach_dir: 'N/A',
        tp_pt: TP_PT,
        sl_pt: SL_PT,
        tp_price: tpPrice,
        sl_price: slPrice,
        signal_id: args.signalId,
        rule_id: args.ruleId,
      });
    } catch (err) {
      logger.warn({ err: String(err), signalId: args.signalId }, 'post-1430 shadow open insert failed');
      return;
    }

    const pos: ShadowPosition = {
      tradeId, signalId: args.signalId,
      entry: args.entry, openTs: args.ts, tpPrice, slPrice, rthCloseMs,
    };
    const list = this.openBySymbol.get(args.symbol) ?? [];
    list.push(pos);
    this.openBySymbol.set(args.symbol, list);

    logger.info({
      tradeId, signalId: args.signalId,
      entry: args.entry, tp: tpPrice, sl: slPrice,
      etMin: etMinuteOfDay(args.ts),
    }, 'post-1430 shadow open');
  }

  /** Called per tick by tick-router. Walks open positions to TP/SL/15:54. */
  onTick(symbol: string, ts: number, price: number): void {
    if (symbol !== SYMBOL_FILTER) return;
    const list = this.openBySymbol.get(symbol);
    if (!list || list.length === 0) return;
    const stillOpen: ShadowPosition[] = [];
    for (const pos of list) {
      // 15:54 force close (EOD)
      if (ts >= pos.rthCloseMs) {
        this.closePosition(pos, price, 'EOD', ts);
        continue;
      }
      // SL hit first (short: price ≥ SL above entry)
      if (price >= pos.slPrice) {
        this.closePosition(pos, pos.slPrice, 'SL', ts);
        continue;
      }
      // TP hit (short: price ≤ TP below entry)
      if (price <= pos.tpPrice) {
        this.closePosition(pos, pos.tpPrice, 'TP', ts);
        continue;
      }
      stillOpen.push(pos);
    }
    this.openBySymbol.set(symbol, stillOpen);
  }

  private closePosition(
    pos: ShadowPosition, closePrice: number, reason: 'TP' | 'SL' | 'EOD', ts: number,
  ): void {
    const pnlPts = pos.entry - closePrice;  // always short
    const pnlUsd = pnlPts * 2;               // MNQ $2/pt
    try {
      db.shadow.close({
        id: pos.tradeId, close_ts: ts, close_price: closePrice, close_reason: reason,
        pnl_pts: pnlPts, pnl_usd: pnlUsd, duration_ms: ts - pos.openTs,
      });
    } catch (err) {
      logger.warn({ err: String(err), tradeId: pos.tradeId }, 'post-1430 shadow close update failed');
    }
    logger.info({
      tradeId: pos.tradeId, signalId: pos.signalId, reason,
      pnlPts: pnlPts.toFixed(2), pnlUsd: pnlUsd.toFixed(2),
    }, 'post-1430 shadow close');
  }
}

export const post1430Shadow = new Post1430Shadow();
