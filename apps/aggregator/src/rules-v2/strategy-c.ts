// Strategy C — RS Level Watcher
//
// Philosophy: price arriving at an institutional RS level is the SETUP.
// Absorption confirming at that level within a time window is the TRIGGER.
// This inverts Strategy B which scans for absorption everywhere.
//
// Flow:
//   1. Poll current price every 500ms
//   2. When price enters within 5pts of any active RS level → open watch window
//   3. During watch window (60s): look for absorption confirmation
//   4. If absorption fires → emit signal with level context + scoring
//   5. Track time-to-move at 5/10/20/30/40/60 min checkpoints
//
// Session-aware level availability:
//   Overnight (6 PM → 9:30 AM): ON HP, ON MHP, QQQ Close only
//   RTH (9:31+): Full level set — BZB, BrZT, HP, MHP, DD Bands, HG, QQQ Open/Close
//
// Scoring:
//   Level quality:    BZB/BrZT=20, MHP/HP/DD=15, HG/QQQ=10, other=8
//   Absorption vol:   >150 contracts=+8, >100=+5, >60=+2
//   Concentration:    >90%=+5, >80%=+2
//   Second touch:     level held already today=+10
//   GM aligned:       +5
//   Counter-GM:       -10

import { getRecentTrades } from './tick-client.js';
import { logger } from '../logger.js';
import { db } from '../db.js';
import { getContext } from '../rs-context.js';
import type { DailyLevels, Symbol, ConfluenceSignal } from '@trading/contracts';

// ─── Types ───────────────────────────────────────────────────────────────────

type Session = 'rth' | 'overnight' | 'closed';

interface RSLevel {
  label: string;
  price: number;
  bonus: number;       // base score from level type
  isEST: boolean;      // Every Single Time 90% setup
  validInSession: 'both' | 'overnight_only' | 'rth_only';
}

interface WatchWindow {
  level: RSLevel;
  openedAt: number;    // ms timestamp when price touched level
  touchPrice: number;  // exact price at first touch
  direction: 'long' | 'short' | null;  // null = undecided, set on touch
  touchCount: number;  // how many times this level was touched today
  lastTouchMs: number;
}

interface CSignalResult {
  signal: ConfluenceSignal;
  levelLabel: string;
  levelPrice: number;
  touchPrice: number;
  openedAt: number;
  absorbedAt: number;
  timeToConfirmMs: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PROXIMITY_PTS = 5;
const WATCH_WINDOW_MS = 60_000;       // 60s window after level touch
const COOLDOWN_MS = 120_000;          // 2 min cooldown per level per direction
const MIN_ABSORPTION_CONTRACTS = 60;  // same as Strategy B
const RTH_START_MIN = 571;            // 9:31 AM ET in minutes

// ─── Session classifier ───────────────────────────────────────────────────────

function classifySession(tsMs: number): Session {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  const min = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday);
  if (isWeekday && min >= RTH_START_MIN && min < 960) return 'rth';
  if (isWeekday) {
    if (min < RTH_START_MIN) return 'overnight';
    if (weekday !== 'Fri' && min >= 1080) return 'overnight';
    return 'closed';
  }
  if (weekday === 'Sun' && min >= 1080) return 'overnight';
  return 'closed';
}

function getMinutesET(tsMs: number): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
}

// ─── Level extraction ─────────────────────────────────────────────────────────

function extractLevels(levels: DailyLevels, session: Session): RSLevel[] {
  const result: RSLevel[] = [];

  if (session === 'rth') {
    // Full level set available after 09:31
    result.push({ label: 'Bull Zone Bottom', price: levels.bullZone.low,  bonus: 20, isEST: true,  validInSession: 'rth_only' });
    result.push({ label: 'Bear Zone Top',    price: levels.bearZone.high, bonus: 20, isEST: true,  validInSession: 'rth_only' });
    result.push({ label: 'Upper DD Band',    price: levels.ddBands.upper, bonus: 15, isEST: false, validInSession: 'rth_only' });
    result.push({ label: 'Lower DD Band',    price: levels.ddBands.lower, bonus: 15, isEST: false, validInSession: 'rth_only' });
    result.push({ label: 'HP',               price: levels.hedgePressure, bonus: 15, isEST: false, validInSession: 'rth_only' });

    for (const al of levels.additionalLevels ?? []) {
      const lbl = al.label.toLowerCase();
      // Skip overnight-only levels during RTH
      if (lbl.startsWith('on ')) continue;
      let bonus = 8;
      if (lbl.includes('mhp') || lbl.includes('monthly hedge')) bonus = 15;
      else if (lbl.includes('hp') || lbl.includes('hedge')) bonus = 15;
      else if (lbl.includes('hg') || lbl.includes('half gap')) bonus = 10;
      else if (lbl.includes('qqq')) bonus = 10;
      result.push({ label: al.label, price: al.price, bonus, isEST: false, validInSession: 'rth_only' });
    }
  } else {
    // Overnight: only ON HP, ON MHP, QQQ Close
    for (const al of levels.additionalLevels ?? []) {
      const lbl = al.label.toLowerCase();
      if (lbl.startsWith('on hp') || lbl.startsWith('on mhp') || lbl.includes('overnight mhp') || lbl.includes('overnight hp')) {
        const bonus = lbl.includes('mhp') ? 15 : 15;
        result.push({ label: al.label, price: al.price, bonus, isEST: false, validInSession: 'overnight_only' });
      }
      if (lbl.includes('qqq close')) {
        result.push({ label: al.label, price: al.price, bonus: 10, isEST: false, validInSession: 'both' });
      }
    }
  }

  return result;
}

// ─── Absorption detector (simplified — runs only within a watch window) ───────

async function detectAbsorptionAtLevel(
  symbol: Symbol,
  levelPrice: number,
  direction: 'long' | 'short',
  nowMs: number
): Promise<{ contracts: number; concentration: number; durationMs: number } | null> {
  const windowMs = 5000;
  const trades = await getRecentTrades(symbol, nowMs - windowMs);
  if (!trades.length) return null;

  // Filter trades within PROXIMITY of the level price
  const nearby = trades.filter(t => Math.abs(t.price - levelPrice) <= PROXIMITY_PTS);
  if (!nearby.length) return null;

  const total = nearby.reduce((s, t) => s + t.size, 0);
  if (total < MIN_ABSORPTION_CONTRACTS) return null;

  // For LONG signal: look for sell aggression being absorbed (sellers absorbed = buy side holds)
  // For SHORT signal: look for buy aggression being absorbed (buyers absorbed = sell side holds)
  const targetSide = direction === 'long' ? 'sell' : 'buy';
  const targetVol = nearby.filter(t => t.side === targetSide).reduce((s, t) => s + t.size, 0);
  const concentration = targetVol / total;

  if (concentration < 0.65) return null;

  const durationMs = nearby[nearby.length - 1].ts - nearby[0].ts;

  return { contracts: total, concentration, durationMs };
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

function scoreSignal(
  level: RSLevel,
  contracts: number,
  concentration: number,
  direction: 'long' | 'short',
  touchCount: number
): number {
  let score = level.bonus; // level quality base

  // Absorption volume bonus
  if (contracts >= 150) score += 8;
  else if (contracts >= 100) score += 5;
  else score += 2;

  // Concentration bonus
  if (concentration >= 0.90) score += 5;
  else if (concentration >= 0.80) score += 2;

  // Second touch bonus (level held already today → higher conviction)
  if (touchCount >= 2) score += 10;

  // Greater market alignment
  const ctx = getContext();
  if (ctx.greaterMarket !== 'neutral') {
    const aligned = (ctx.greaterMarket === 'bull' && direction === 'long') ||
                    (ctx.greaterMarket === 'bear' && direction === 'short');
    if (aligned) score += 5;
    else score -= 10;
  }

  return Math.min(100, Math.max(0, score));
}

// ─── State: open watch windows and today's touch history ─────────────────────

// key = `${symbol}:${levelLabel}`
const _openWindows: Map<string, WatchWindow> = new Map();
const _lastSignalMs: Map<string, number> = new Map();  // cooldown per level+direction
const _touchHistory: Map<string, number> = new Map();  // touch count per level per day
const _lastDay: Map<Symbol, string> = new Map();       // detect day rollover

function dayKey(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

function resetIfNewDay(symbol: Symbol, tsMs: number): void {
  const today = dayKey(tsMs);
  if (_lastDay.get(symbol) !== today) {
    _lastDay.set(symbol, today);
    // Clear touch history for this symbol
    for (const key of _touchHistory.keys()) {
      if (key.startsWith(`${symbol}:`)) _touchHistory.delete(key);
    }
    for (const key of _openWindows.keys()) {
      if (key.startsWith(`${symbol}:`)) _openWindows.delete(key);
    }
  }
}

function getTouchCount(symbol: Symbol, levelLabel: string): number {
  return _touchHistory.get(`${symbol}:${levelLabel}`) ?? 0;
}

function recordTouch(symbol: Symbol, levelLabel: string): void {
  const key = `${symbol}:${levelLabel}`;
  _touchHistory.set(key, (_touchHistory.get(key) ?? 0) + 1);
}

function isCoolingDown(symbol: Symbol, levelLabel: string, direction: string, nowMs: number): boolean {
  const key = `${symbol}:${levelLabel}:${direction}`;
  return nowMs - (_lastSignalMs.get(key) ?? 0) < COOLDOWN_MS;
}

function recordSignal(symbol: Symbol, levelLabel: string, direction: string, nowMs: number): void {
  _lastSignalMs.set(`${symbol}:${levelLabel}:${direction}`, nowMs);
}

// ─── Main poll function ───────────────────────────────────────────────────────

export async function runStrategyC(
  symbol: Symbol,
  nowMs: number,
  levels: DailyLevels | undefined,
  getCurrentPrice: () => number | undefined
): Promise<CSignalResult | null> {
  if (!levels) return null;

  const session = classifySession(nowMs);
  if (session === 'closed') return null;

  resetIfNewDay(symbol, nowMs);

  const currentPrice = getCurrentPrice();
  if (!currentPrice) return null;

  const activeLevels = extractLevels(levels, session);
  if (!activeLevels.length) return null;

  // ── Step 1: Check for new level touches ──────────────────────────────────

  for (const level of activeLevels) {
    const dist = Math.abs(currentPrice - level.price);
    if (dist > PROXIMITY_PTS) continue;

    const winKey = `${symbol}:${level.label}`;

    // Open a new watch window if none exists
    if (!_openWindows.has(winKey)) {
      recordTouch(symbol, level.label);
      const touchCount = getTouchCount(symbol, level.label);

      // Determine direction: price approaching from above = short setup, from below = long setup
      // We store both and decide at absorption confirmation time
      _openWindows.set(winKey, {
        level,
        openedAt: nowMs,
        touchPrice: currentPrice,
        direction: null,  // determined at confirmation
        touchCount,
        lastTouchMs: nowMs,
      });

      logger.info({
        symbol, level: level.label, price: currentPrice,
        levelPrice: level.price, dist: dist.toFixed(2), touchCount, session,
      }, 'strategy-C: level touched, opening watch window');
    } else {
      // Update last touch time (price is still at level)
      const win = _openWindows.get(winKey)!;
      win.lastTouchMs = nowMs;
    }
  }

  // ── Step 2: Check open watch windows for absorption confirmation ──────────

  for (const [winKey, win] of _openWindows.entries()) {
    if (!winKey.startsWith(`${symbol}:`)) continue;

    // Expire old windows
    if (nowMs - win.openedAt > WATCH_WINDOW_MS) {
      _openWindows.delete(winKey);
      logger.debug({ symbol, level: win.level.label }, 'strategy-C: watch window expired');
      continue;
    }

    // Try both directions — whichever absorption confirms first wins
    for (const direction of ['long', 'short'] as const) {
      if (isCoolingDown(symbol, win.level.label, direction, nowMs)) continue;

      // Direction logic:
      // LONG at level: price bouncing UP from level (level acts as support)
      // SHORT at level: price bouncing DOWN from level (level acts as resistance)
      // We check both and let the absorption pattern decide

      const abs = await detectAbsorptionAtLevel(symbol, win.level.price, direction, nowMs);
      if (!abs) continue;

      // Confirm direction makes sense for level type
      const lbl = win.level.label.toLowerCase();
      const isSupportLevel = lbl.includes('bull zone') || lbl.includes('lower dd') ||
                             lbl.includes('on hp') || lbl.includes('on mhp') ||
                             (lbl.includes('hp') && !lbl.includes('upper'));
      const isResistanceLevel = lbl.includes('bear zone') || lbl.includes('upper dd');

      if (isSupportLevel && direction === 'short') continue;
      if (isResistanceLevel && direction === 'long') continue;
      // Mixed levels (QQQ, HG, MHP) allow both directions

      const score = scoreSignal(win.level, abs.contracts, abs.concentration, direction, win.touchCount);

      // Minimum score threshold: 50 (lower than B since level quality is already baked in)
      if (score < 50) continue;

      recordSignal(symbol, win.level.label, direction, nowMs);
      _openWindows.delete(winKey);

      const ctx = getContext();
      const gmAligned = ctx.greaterMarket === 'neutral' ? true :
        (ctx.greaterMarket === 'bull' && direction === 'long') ||
        (ctx.greaterMarket === 'bear' && direction === 'short');

      const timeToConfirmMs = nowMs - win.openedAt;

      const rationale =
        `STRATEGY-C [${session.toUpperCase()}]: Price touched ${win.level.label} (${win.level.price}) ` +
        `at ${win.touchPrice}. Absorption confirmed: ${abs.contracts} contracts, ` +
        `${Math.round(abs.concentration * 100)}% concentration in ${abs.durationMs}ms. ` +
        `Touch #${win.touchCount}. Confirmed in ${(timeToConfirmMs / 1000).toFixed(1)}s. ` +
        `GM: ${ctx.greaterMarket}${gmAligned ? ' (aligned)' : ' (counter)'}. ` +
        `Level: ${win.level.isEST ? 'EST 90%' : 'RS pivot'}.`;

      logger.info({
        symbol, level: win.level.label, levelPrice: win.level.price,
        direction, score, contracts: abs.contracts,
        concentration: Math.round(abs.concentration * 100),
        touchCount: win.touchCount, timeToConfirmMs, session,
      }, 'strategy-C: SIGNAL');

      const signal: ConfluenceSignal = {
        ts: nowMs,
        source: 'rules-v2',
        type: 'confluence',
        symbol,
        ruleId: 'rs-level-absorption',
        score,
        direction,
        rationale,
        strategyVersion: 'C' as any,
        ruleVersion: 'rs-level-watcher-v1',
        // Extra fields for outcome tracking
        rsLevel: win.level.label,
        rsLevelPrice: win.level.price,
        touchPrice: win.touchPrice,
        touchCount: win.touchCount,
        timeToConfirmMs,
        levelBonus: win.level.bonus,
        isEST: win.level.isEST,
        openedAt: win.openedAt,
      } as any;

      return {
        signal,
        levelLabel: win.level.label,
        levelPrice: win.level.price,
        touchPrice: win.touchPrice,
        openedAt: win.openedAt,
        absorbedAt: nowMs,
        timeToConfirmMs,
      };
    }
  }

  return null;
}
