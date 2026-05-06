// Tape Speed / Urgency Detection Rule (Strategy B, rule version: tape-speed-v1)
//
// Detects sudden spikes in trade frequency indicating institutional urgency.
// When the tape prints significantly faster than its recent baseline,
// institutions are in a hurry to fill. This urgency precedes directional moves.
//
// The signal fires when:
//   1. Recent trade frequency (last 5s) is significantly above baseline (last 60s)
//   2. The fast-tape is directionally biased (one side dominating)
//   3. The spike is sustained (not a single outlier trade)
//
// Signal direction:
//   Urgency with buy aggression  = buyers in a hurry = LONG signal
//   Urgency with sell aggression = sellers in a hurry = SHORT signal
//
// This is complementary to absorption: absorption detects PASSIVE orders
// defending a level. Tape speed detects AGGRESSIVE urgency. Together they
// describe who is winning the battle at a price level.

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
// urgencyRatio: fast-window rate / baseline rate. 3.0 = 3x faster than baseline.
// minFastTrades: minimum trades in fast window (prevents low-volume false positives).
// minAggressionPct: directional bias required (0.60 = 60% one-sided).
// minFastVolume: minimum contracts in fast window.

interface TapeSpeedThresholds {
  fastWindowMs: number;      // recent window (trades per second here vs baseline)
  baselineWindowMs: number;  // longer baseline to compare against
  minUrgencyRatio: number;   // fast_rate / baseline_rate must exceed this
  minFastTrades: number;     // minimum trade count in fast window
  minFastVolume: number;     // minimum volume in fast window
  minAggressionPct: number;  // minimum directional bias
  cooldownMs: number;
}

const THRESHOLDS: Record<Session, TapeSpeedThresholds> = {
  rth: {
    fastWindowMs: 5_000,
    baselineWindowMs: 60_000,
    minUrgencyRatio: 3.5,
    minFastTrades: 20,
    minFastVolume: 100,
    minAggressionPct: 0.65,
    cooldownMs: 30_000,
  },
  overnight: {
    fastWindowMs: 5_000,
    baselineWindowMs: 60_000,
    minUrgencyRatio: 4.0,
    minFastTrades: 8,
    minFastVolume: 30,
    minAggressionPct: 0.65,
    cooldownMs: 45_000,
  },
  closed: {
    fastWindowMs: 0,
    baselineWindowMs: 0,
    minUrgencyRatio: 999,
    minFastTrades: 999,
    minFastVolume: 999,
    minAggressionPct: 1,
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

// --- Scoring ---
//
// Base 50. Bonuses for:
//   Higher urgency ratio (+5 per 0.5x above minimum, max +20)
//   Very one-sided aggression >= 80% (+5)
//   High fast volume relative to threshold (+5 per 1.5x, max +10)

function scoreTapeSpeed(
  urgencyRatio: number,
  minRatio: number,
  aggressionPct: number,
  fastVolume: number,
  minFastVolume: number
): number {
  let score = 50;
  const ratioExcess = urgencyRatio - minRatio;
  score += Math.min(20, Math.floor(ratioExcess / 0.5) * 5);
  if (aggressionPct >= 0.80) score += 5;
  const volRatio = fastVolume / minFastVolume;
  if (volRatio >= 2.0) score += 10;
  else if (volRatio >= 1.5) score += 5;
  return Math.min(100, score);
}

// --- Main detection function ---

export async function detectTapeSpeed(
  symbol: Symbol,
  nowMs: number
): Promise<{ signal: ConfluenceSignal } | null> {
  const session = classifySession(nowMs);
  if (session === 'closed') return null;

  const t = THRESHOLDS[session];

  // Fetch baseline window (longer, for rate comparison)
  const baselineTrades = await getRecentTrades(symbol, t.baselineWindowMs);
  if (baselineTrades.length < t.minFastTrades * 2) return null;

  // Split into fast window (most recent) and baseline
  const cutoffMs = nowMs - t.fastWindowMs;
  const fastTrades = baselineTrades.filter(tr => tr.ts >= cutoffMs);
  const slowTrades = baselineTrades.filter(tr => tr.ts < cutoffMs);

  if (fastTrades.length < t.minFastTrades) return null;
  if (slowTrades.length === 0) return null;

  // Compute rates (trades per second)
  const fastRatePerSec = fastTrades.length / (t.fastWindowMs / 1000);
  const slowWindowSec = (t.baselineWindowMs - t.fastWindowMs) / 1000;
  const baselineRatePerSec = slowTrades.length / slowWindowSec;

  if (baselineRatePerSec === 0) return null;

  const urgencyRatio = fastRatePerSec / baselineRatePerSec;
  if (urgencyRatio < t.minUrgencyRatio) return null;

  // Check fast window volume and aggression
  const fastBuyVol = fastTrades.filter(tr => !tr.isBidAggressor).reduce((s, tr) => s + tr.size, 0);
  const fastSellVol = fastTrades.filter(tr => tr.isBidAggressor).reduce((s, tr) => s + tr.size, 0);
  const fastTotalVol = fastBuyVol + fastSellVol;

  if (fastTotalVol < t.minFastVolume) return null;

  const dominantVol = Math.max(fastBuyVol, fastSellVol);
  const aggressionPct = dominantVol / fastTotalVol;
  if (aggressionPct < t.minAggressionPct) return null;

  const isBuyDominant = fastBuyVol > fastSellVol;
  const direction: 'long' | 'short' = isBuyDominant ? 'long' : 'short';

  if (isCoolingDown(symbol, direction, nowMs, t.cooldownMs)) return null;

  const score = scoreTapeSpeed(urgencyRatio, t.minUrgencyRatio, aggressionPct, fastTotalVol, t.minFastVolume);

  const aggrDesc = isBuyDominant ? 'buy' : 'sell';
  const rationale = `TAPE SPEED [${session.toUpperCase()}]: urgency ratio ${urgencyRatio.toFixed(1)}x ` +
    `(${fastRatePerSec.toFixed(1)} trades/sec vs ${baselineRatePerSec.toFixed(1)} baseline). ` +
    `Fast window: ${fastTrades.length} trades, ${fastTotalVol} contracts, ` +
    `${Math.round(aggressionPct * 100)}% ${aggrDesc} aggression.`;

  recordSignal(symbol, direction, nowMs);

  // Write to confluence tracker so absorption can detect confirmation
  recordConfluenceSignal(symbol, 'tape-speed', direction, score, nowMs);

  logger.info({
    symbol, session, urgencyRatio: urgencyRatio.toFixed(2),
    fastRate: fastRatePerSec.toFixed(1), baselineRate: baselineRatePerSec.toFixed(1),
    fastTrades: fastTrades.length, fastVolume: fastTotalVol,
    aggressionPct: Math.round(aggressionPct * 100), direction, score,
  }, 'tape speed detected');

  return {
    signal: {
      ts: nowMs,
      source: 'rules-v2',
      type: 'confluence',
      symbol,
      ruleId: 'tape-speed',
      score,
      direction,
      rationale,
      strategyVersion: 'B',
      ruleVersion: 'tape-speed-v1',
    },
  };
}
