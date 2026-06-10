// shadow-trader.ts
//
// Parallel "would-have-fired" trade simulator for the 6 structural-level
// touch setups validated in backtest (2026-06-10):
//
//   WkH    BREAKOUT   prior 5-day high (excludes today)
//   PDH    BREAKOUT   prior-day high
//   onVAL  FADE       overnight value-area low
//   PML    BREAKOUT   pre-market low (06:00–09:30 ET)
//   Bull L BREAKOUT   bull-zone lower edge (RS framework)
//   Bear H BREAKOUT   bear-zone upper edge (RS framework)
//
// Strategy params (uniform): TP=50pt, SL=20pt, touch=±1pt, approach=5min lookback.
// Walks the live tick stream during RTH (09:30–15:54 ET). At most one shadow
// trade per (day × level). Force-closes any open shadow at 15:54 ET. Writes
// every open/close to the shadow_trades table.
//
// This module is PURELY OBSERVATIONAL — it does not place broker orders,
// touch the V3 pipeline, or affect the trader daemon in any way.

import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { logger as parentLogger } from './logger.js';
import { config } from './config.js';

const logger = parentLogger.child({ mod: 'shadow' });

// ── Strategy config (frozen 2026-06-10) ─────────────────────────────────────
interface LevelSpec { label: string; classification: 'FADE' | 'BREAKOUT'; }
const SHADOW_LEVELS: LevelSpec[] = [
  { label: 'WkH',    classification: 'BREAKOUT' },
  { label: 'PDH',    classification: 'BREAKOUT' },
  { label: 'onVAL',  classification: 'FADE' },
  { label: 'PML',    classification: 'BREAKOUT' },
  { label: 'Bull L', classification: 'BREAKOUT' },
  { label: 'Bear H', classification: 'BREAKOUT' },
];

const TP_PT = 50;
const SL_PT = 20;
const TOUCH_TOLERANCE = 1.0;
const PRE_MS = 5 * 60_000;
const MIN_APPROACH_PT = 0.5;     // require ≥0.5pt of movement to call an approach direction
const MIN_APPROACH_MS = 60_000;  // need ≥1min of tick history before opening
const SHADOW_SYMBOLS = new Set(['NQ']);

// ── ET helpers ──────────────────────────────────────────────────────────────
function etDateOf(tsMs: number): string {
  // YYYY-MM-DD in America/New_York
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

// ── Per-symbol state ────────────────────────────────────────────────────────
interface ShadowPosition {
  tradeId: number;
  label: string;
  direction: 'long' | 'short';
  entryPrice: number;
  openTs: number;
  tpPrice: number;
  slPrice: number;
}
interface SymbolState {
  currentEtDate: string | null;
  recentTicks: Array<{ ts: number; price: number }>;  // rolling 5min
  levelsLoadedForDate: string | null;
  levelsPriceByLabel: Map<string, number>;
  openedToday: Set<string>;        // labels already opened (or attempted) today
  openPositions: Map<string, ShadowPosition>;
  rthOpenMs: number;
  rthCloseMs: number;
}

function newState(): SymbolState {
  return {
    currentEtDate: null,
    recentTicks: [],
    levelsLoadedForDate: null,
    levelsPriceByLabel: new Map(),
    openedToday: new Set(),
    openPositions: new Map(),
    rthOpenMs: 0,
    rthCloseMs: 0,
  };
}

// ── Levels loader: reads today's NQ entry from daily_levels.json ────────────
function levelsFilePath(symbol: string): string {
  if (symbol === 'NQ') return config.levelsPath;
  // ES not in scope for shadow strategy v1 (no ES backtest validated yet).
  throw new Error(`No levels file for symbol ${symbol}`);
}
function loadLevelsForDay(symbol: string, etDate: string): Map<string, number> {
  const out = new Map<string, number>();
  const filePath = levelsFilePath(symbol);
  if (!fs.existsSync(filePath)) {
    logger.warn({ symbol, filePath }, 'levels file missing');
    return out;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    logger.warn({ symbol, etDate, err: String(err) }, 'levels file parse failed');
    return out;
  }
  const data = parsed as { days?: Record<string, { levels?: Array<unknown> }> };
  const dayEntry = data.days?.[etDate];
  if (!dayEntry?.levels) {
    logger.warn({ symbol, etDate }, 'no levels entry for date');
    return out;
  }
  const entry = dayEntry.levels.find((l) => (l as { symbol: string }).symbol === symbol) as any;
  if (!entry) {
    logger.warn({ symbol, etDate }, 'no levels for symbol');
    return out;
  }
  const wanted = new Set(SHADOW_LEVELS.map(s => s.label));
  if (Array.isArray(entry.additionalLevels)) {
    for (const al of entry.additionalLevels) {
      if (typeof al?.price === 'number' && wanted.has(al.label)) out.set(al.label, al.price);
    }
  }
  if (wanted.has('Bull L') && entry.bullZone?.low != null) out.set('Bull L', entry.bullZone.low);
  if (wanted.has('Bear H') && entry.bearZone?.high != null) out.set('Bear H', entry.bearZone.high);
  return out;
}

// ── ShadowTrader ────────────────────────────────────────────────────────────
class ShadowTrader {
  private states = new Map<string, SymbolState>();

  /** Called from tick-router on every tick. Fast path — must not throw. */
  onTick(symbol: string, ts: number, price: number): void {
    if (!SHADOW_SYMBOLS.has(symbol)) return;
    let st = this.states.get(symbol);
    if (!st) { st = newState(); this.states.set(symbol, st); }

    const etDate = etDateOf(ts);

    // Day rollover — close any open positions at last known price as EOD,
    // reset day state.
    if (st.currentEtDate !== etDate) {
      if (st.currentEtDate != null && st.openPositions.size > 0) {
        const prevPrice = st.recentTicks[st.recentTicks.length - 1]?.price ?? price;
        const prevTs = st.recentTicks[st.recentTicks.length - 1]?.ts ?? ts;
        this.closeAllAsEod(symbol, st, prevPrice, prevTs);
      }
      st.currentEtDate = etDate;
      st.openedToday.clear();
      st.openPositions.clear();
      st.rthOpenMs = etTimeToMs(etDate, 9, 30);
      st.rthCloseMs = etTimeToMs(etDate, 15, 54);
    }

    // Maintain 5-min rolling tick buffer (for approach direction)
    st.recentTicks.push({ ts, price });
    while (st.recentTicks.length > 0 && st.recentTicks[0]!.ts < ts - PRE_MS) {
      st.recentTicks.shift();
    }

    // Lazy-load today's levels (on first tick of the day in or after RTH).
    // We try to load any time; if the entry isn't in daily_levels.json yet
    // (e.g. pre-09:23 cron), this is a no-op map and we'll retry next tick.
    if (st.levelsLoadedForDate !== etDate) {
      const loaded = loadLevelsForDay(symbol, etDate);
      if (loaded.size > 0) {
        st.levelsPriceByLabel = loaded;
        st.levelsLoadedForDate = etDate;
        const summary: Record<string, number> = {};
        for (const [l, p] of loaded) summary[l] = p;
        logger.info({ symbol, etDate, levels: summary }, 'shadow levels loaded');
      }
    }

    // 1. Check open positions for TP/SL hit. Walk all opens; close any hit.
    for (const [label, pos] of [...st.openPositions]) {
      const exit = this.checkExitHit(pos, price);
      if (exit) this.closePosition(st, label, pos, exit.price, exit.reason, ts);
    }

    // 2. Force-close anything still open at/after 15:54 ET.
    if (ts >= st.rthCloseMs && st.openPositions.size > 0) {
      this.closeAllAsEod(symbol, st, price, ts);
    }

    // 3. Within RTH window, check for new opens.
    if (st.levelsLoadedForDate === etDate && ts >= st.rthOpenMs && ts < st.rthCloseMs) {
      for (const spec of SHADOW_LEVELS) {
        if (st.openedToday.has(spec.label)) continue;
        const levelPrice = st.levelsPriceByLabel.get(spec.label);
        if (levelPrice == null) continue;
        if (Math.abs(price - levelPrice) > TOUCH_TOLERANCE) continue;
        // Touched.
        const approachDir = this.computeApproachDir(st.recentTicks, ts, price);
        if (!approachDir) continue;
        const direction: 'long' | 'short' = spec.classification === 'FADE'
          ? (approachDir === 'up' ? 'short' : 'long')
          : (approachDir === 'up' ? 'long' : 'short');
        this.openPosition(symbol, st, etDate, spec, levelPrice, price, ts, approachDir, direction);
      }
    }
  }

  private computeApproachDir(recent: Array<{ ts: number; price: number }>, ts: number, price: number): 'up' | 'down' | null {
    if (recent.length === 0) return null;
    const oldest = recent[0]!;
    if (ts - oldest.ts < MIN_APPROACH_MS) return null;
    const delta = price - oldest.price;
    if (Math.abs(delta) < MIN_APPROACH_PT) return null;
    return delta > 0 ? 'up' : 'down';
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

  private openPosition(
    symbol: string, st: SymbolState, etDate: string, spec: LevelSpec,
    levelPrice: number, entryPrice: number, ts: number,
    approachDir: 'up' | 'down', direction: 'long' | 'short',
  ): void {
    const tpPrice = direction === 'long' ? entryPrice + TP_PT : entryPrice - TP_PT;
    const slPrice = direction === 'long' ? entryPrice - SL_PT : entryPrice + SL_PT;
    const bucket = bucketFor(ts);
    let tradeId: number;
    try {
      tradeId = db.shadow.open({
        symbol, trading_day: etDate, level_label: spec.label, level_price: levelPrice,
        classification: spec.classification, bucket,
        open_ts: ts, open_price: entryPrice, direction, approach_dir: approachDir,
        tp_pt: TP_PT, sl_pt: SL_PT, tp_price: tpPrice, sl_price: slPrice,
      });
    } catch (err) {
      logger.warn({ err: String(err), symbol, label: spec.label }, 'shadow open insert failed');
      return;
    }
    const pos: ShadowPosition = { tradeId, label: spec.label, direction, entryPrice, openTs: ts, tpPrice, slPrice };
    st.openPositions.set(spec.label, pos);
    st.openedToday.add(spec.label);
    logger.info({
      symbol, label: spec.label, classification: spec.classification, bucket,
      approachDir, direction, entry: entryPrice, tp: tpPrice, sl: slPrice,
    }, 'shadow open');
  }

  private closePosition(
    st: SymbolState, label: string, pos: ShadowPosition,
    closePrice: number, reason: 'TP' | 'SL' | 'EOD', ts: number,
  ): void {
    const pnlPts = pos.direction === 'long' ? closePrice - pos.entryPrice : pos.entryPrice - closePrice;
    const pnlUsd = pnlPts * 2; // MNQ $2/pt
    try {
      db.shadow.close({
        id: pos.tradeId, close_ts: ts, close_price: closePrice, close_reason: reason,
        pnl_pts: pnlPts, pnl_usd: pnlUsd, duration_ms: ts - pos.openTs,
      });
    } catch (err) {
      logger.warn({ err: String(err), id: pos.tradeId }, 'shadow close update failed');
    }
    st.openPositions.delete(label);
    logger.info({ label, reason, pnlPts: pnlPts.toFixed(2), pnlUsd: pnlUsd.toFixed(2) }, 'shadow close');
  }

  private closeAllAsEod(symbol: string, st: SymbolState, lastPrice: number, ts: number): void {
    for (const [label, pos] of [...st.openPositions]) {
      this.closePosition(st, label, pos, lastPrice, 'EOD', ts);
    }
  }
}

export const shadowTrader = new ShadowTrader();
