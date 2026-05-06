// Large Print Detection Rule (Strategy B, rule version: large-print-v1)
//
// Detects single trades of unusually large size. Institutions typically
// break orders into small pieces (iceberg / algo slicing) to minimize
// market impact. When they don't, it signals one of two things:
//   1. Urgency - they need to fill NOW and accept market impact
//   2. Conviction - strong directional bias, willing to show their hand
//
// Either case is meaningful. A 100-contract single print is not random noise.
//
// Signal direction: same as the aggressor side of the large print.
//   Large buy print (lifting ask) = LONG signal
//   Large sell print (hitting bid) = SHORT signal
//
// Additional context check: if a large print happens WITHIN an existing
// absorption event (price not moving), it may be the passive order finally
// giving up. This is noted in the rationale but handled via confluence later.

import { getRecentTrades } from './tick-client.js';
import { logger } from '../logger.js';
import { recordConfluenceSignal } from './confluence-tracker.js';
import type { ConfluenceSignal, Symbol } from '@trading/contracts';

// --- Session classifier ---

type Session = 'rth' | 'overnight' | 'closed';

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
  if (isWeekday && min >= 570 && min < 960) return 'rth';
  if (isWeekday) {
    if (min < 570) return 'overnight';
    if (weekday !== 'Fri' && min >= 1080) return 'overnight';
    return 'closed';
  }
  if (weekday === 'Sun' && min >= 1080) return 'overnight';
  return 'closed';
}

// --- Thresholds ---
//
// minSinglePrintSize: minimum contracts for a single trade to qualify.
// lookbackMs: how far back to look for the large print.
// contextWindowMs: window to check for directional follow-through context.
// minContextAggressionPct: follow-through aggression in same direction.
// cooldownMs: minimum time between signals.
//
// RTH thresholds are higher because larger trades are more common in liquid sessions.
// A 50-contract print during RTH is less remarkable than during overnight.

interface LargePrintThresholds {
  minSinglePrintSize: number;
  lookbackMs: number;
  contextWindowMs: number;
  minContextAggressionPct: number;
  cooldownMs: number;
}

const THRESHOLDS: Record<Session, LargePrintThresholds> = {
  rth: {
    minSinglePrintSize: 80,
    lookbackMs: 2_000,
    contextWindowMs: 10_000,
    minContextAggressionPct: 0.55,
    cooldownMs: 30_000,
  },
  overnight: {
    minSinglePrintSize: 30,
    lookbackMs: 2_000,
    contextWindowMs: 10_000,
    minContextAggressionPct: 0.55,
    cooldownMs: 45_000,
  },
  closed: {
    minSinglePrintSize: 99999,
    lookbackMs: 0,
    contextWindowMs: 0,
    minContextAggressionPct: 1,
    cooldownMs: 999_000,
  },
};

// --- Cooldown ---

const _lastSignalMs = new Map<string, number>();

function isCoolingDown(symbol: string, direction: string, nowMs: number, cooldownMs: number): boolean {
  return nowMs - (_lastSignalMs.get(`${symbol}:${direction}`) ?? 0) < cooldownMs;
}

function recordSignal(symbol: string, direction: string, nowMs: number): void {
  _lastSignalMs.set(`${symbol}:${direction}`, nowMs);
}

// Track already-signaled prints to avoid signaling the same print twice
// across polling cycles. Key: ts+symbol+size.
const _signaledPrints = new Set<string>();

function printKey(ts: number, symbol: string, size: number): string {
  return `${ts}:${symbol}:${size}`;
}

// --- Scoring ---
//
// Base 50. Bonuses:
//   Size ratio above threshold (+10 per 1.5x, max +30)
//   Directional context confirmed (+10 if follow-through aggression >= 70%)
//   Very large print (>= 3x threshold) (+10)

function scoreLargePrint(
  printSize: number,
  minSize: number,
  contextAggressionPct: number
): number {
  let score = 50;
  const ratio = printSize / minSize;
  if (ratio >= 3.0) score += 30;
  else if (ratio >= 2.0) score += 20;
  else if (ratio >= 1.5) score += 10;
  if (contextAggressionPct >= 0.70) score += 10;
  return Math.min(100, score);
}

// --- Main detection function ---

export async function detectLargePrint(
  symbol: Symbol,
  nowMs: number
): Promise<{ signal: ConfluenceSignal } | null> {
  const session = classifySession(nowMs);
  if (session === 'closed') return null;

  const t = THRESHOLDS[session];

  // Fetch recent trades covering lookback + context windows
  const allTrades = await getRecentTrades(symbol, Math.max(t.lookbackMs, t.contextWindowMs));
  if (allTrades.length === 0) return null;

  // Find the most recent large print within the lookback window
  const lookbackCutoff = nowMs - t.lookbackMs;
  const recentTrades = allTrades.filter(tr => tr.ts >= lookbackCutoff);

  // Find largest single print in recent window
  let largePrint: typeof allTrades[0] | null = null;
  for (const trade of recentTrades) {
    if (trade.size >= t.minSinglePrintSize) {
      if (!largePrint || trade.size > largePrint.size) {
        largePrint = trade;
      }
    }
  }

  if (!largePrint) return null;

  // Dedup: don't signal the same print twice
  const key = printKey(largePrint.ts, symbol, largePrint.size);
  if (_signaledPrints.has(key)) return null;

  // Determine direction from the large print's aggressor side
  // isBidAggressor = true means seller crossed the bid = SELL aggression = SHORT signal
  const direction: 'long' | 'short' = largePrint.isBidAggressor ? 'short' : 'long';

  if (isCoolingDown(symbol, direction, nowMs, t.cooldownMs)) return null;

  // Context check: what was the aggression like in the surrounding window?
  const contextCutoff = nowMs - t.contextWindowMs;
  const contextTrades = allTrades.filter(tr => tr.ts >= contextCutoff);

  const contextBuyVol = contextTrades.filter(tr => !tr.isBidAggressor).reduce((s, tr) => s + tr.size, 0);
  const contextSellVol = contextTrades.filter(tr => tr.isBidAggressor).reduce((s, tr) => s + tr.size, 0);
  const contextTotalVol = contextBuyVol + contextSellVol;
  const contextDominantVol = direction === 'long' ? contextBuyVol : contextSellVol;
  const contextAggressionPct = contextTotalVol > 0 ? contextDominantVol / contextTotalVol : 0;

  // Context should at least slightly confirm direction
  if (contextAggressionPct < t.minContextAggressionPct) return null;

  const score = scoreLargePrint(largePrint.size, t.minSinglePrintSize, contextAggressionPct);

  const aggrDesc = largePrint.isBidAggressor ? 'sell' : 'buy';
  const rationale = `LARGE PRINT [${session.toUpperCase()}]: single ${largePrint.size}-contract ` +
    `${aggrDesc} aggression at ${largePrint.price}. ` +
    `${(largePrint.size / t.minSinglePrintSize).toFixed(1)}x threshold. ` +
    `Context window: ${Math.round(contextAggressionPct * 100)}% same-direction aggression.`;

  // Mark this print as signaled
  _signaledPrints.add(key);
  // Evict old keys after 10 minutes to prevent memory leak
  if (_signaledPrints.size > 1000) {
    const oldest = [..._signaledPrints].slice(0, 500);
    oldest.forEach(k => _signaledPrints.delete(k));
  }

  recordSignal(symbol, direction, nowMs);

  // Write to confluence tracker so absorption can detect confirmation
  recordConfluenceSignal(symbol, 'large-print', direction, score, nowMs);

  logger.info({
    symbol, session,
    printSize: largePrint.size, minSize: t.minSinglePrintSize,
    price: largePrint.price, direction,
    contextAggressionPct: Math.round(contextAggressionPct * 100),
    score,
  }, 'large print detected');

  return {
    signal: {
      ts: nowMs,
      source: 'rules-v2',
      type: 'confluence',
      symbol,
      ruleId: 'large-print',
      score,
      direction,
      rationale,
      strategyVersion: 'B',
      ruleVersion: 'large-print-v1',
    },
  };
}
