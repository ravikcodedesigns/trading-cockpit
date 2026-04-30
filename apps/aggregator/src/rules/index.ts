import { state } from '../state.js';
import { logger } from '../logger.js';
import type {
  AbsorptionEvent,
  AggregatorEvent,
  ConfluenceSignal,
  DailyLevels,
  FlashAlphaSnapshot,
  SweepEvent,
  Symbol,
} from '@trading/contracts';

// Rule registry. Each rule subscribes to events and may emit signals.
// All v1 rules are observe-only — they log and ping Discord, no trade trigger.

const DEDUP_WINDOW_MS = 60_000;

interface RuleContext {
  recentSignalKeys: Map<string, number>;
}

function inZone(price: number, zone: { low: number; high: number }, padding = 0): boolean {
  return price >= zone.low - padding && price <= zone.high + padding;
}

// --- Rule: absorption inside a zone with non-negative gamma ---

function ruleAbsorptionAtZone(
  event: AbsorptionEvent,
  ctx: RuleContext,
  getLevels: (s: Symbol) => DailyLevels | undefined,
  getFlashAlpha: (s: Symbol) => FlashAlphaSnapshot | undefined
): ConfluenceSignal | null {
  const levels = getLevels(event.symbol);
  if (!levels) return null;

  const fa = getFlashAlpha(event.symbol);
  // Don't gate on FA if we don't have it yet — observe and note its absence

  // Are we near a meaningful zone?
  const padPct = 0.0005; // 0.05% padding around zone boundary
  const padding = event.price * padPct;
  const inBull = inZone(event.price, levels.bullZone, padding);
  const inBear = inZone(event.price, levels.bearZone, padding);

  if (!inBull && !inBear) return null;

  // Direction depends on which zone + which side absorbed
  // - bid absorption in bull zone = buyers defending = bullish
  // - ask absorption in bear zone = sellers defending = bearish
  let direction: 'long' | 'short' | null = null;
  let zoneName = '';
  if (inBull && event.side === 'bid') { direction = 'long'; zoneName = 'bull zone'; }
  else if (inBear && event.side === 'ask') { direction = 'short'; zoneName = 'bear zone'; }
  if (!direction) return null;

  // Score: base 50, +20 if size is meaningful, +20 if duration sustained, +10 if FA gamma aligns
  let score = 50;
  if (event.size > 200) score += 20;
  if (event.durationMs > 3000) score += 20;
  if (fa) {
    const aligned =
      (direction === 'long' && fa.gammaRegime !== 'negative') ||
      (direction === 'short' && fa.gammaRegime !== 'positive');
    if (aligned) score += 10;
  }
  score = Math.min(100, score);

  // Dedup: same rule + symbol + direction + nearby price within 60s
  const dedupKey = `absorptionZone:${event.symbol}:${direction}:${Math.round(event.price)}`;
  const last = ctx.recentSignalKeys.get(dedupKey);
  if (last && Date.now() - last < DEDUP_WINDOW_MS) return null;
  ctx.recentSignalKeys.set(dedupKey, Date.now());

  const rationale =
    `${event.side} absorption ${event.size} contracts at ${event.price} ` +
    `in ${zoneName} (${event.durationMs}ms hold). ` +
    `GEX regime: ${fa?.gammaRegime ?? 'unknown'}.`;

  return {
    ts: event.ts,
    source: 'rules',
    type: 'confluence',
    symbol: event.symbol,
    ruleId: 'absorption-at-zone',
    score,
    direction,
    contextEventIds: [],
    rationale,
    observeOnly: true,
  };
}

// --- Rule: sweep with optional zone confluence ---
//
// You asked to surface ALL sweeps (not pre-filtered by zone). So we always
// emit a signal for any sweep that arrives. Zone proximity becomes a SCORE
// adjustment rather than a gate.

function ruleSweep(
  event: SweepEvent,
  ctx: RuleContext,
  getLevels: (s: Symbol) => DailyLevels | undefined,
  getFlashAlpha: (s: Symbol) => FlashAlphaSnapshot | undefined
): ConfluenceSignal | null {
  const levels = getLevels(event.symbol);
  const fa = getFlashAlpha(event.symbol);

  // Base score reflects raw sweep magnitude.
  let score = 40;
  if (event.volume >= 100) score += 15;
  if (event.volume >= 200) score += 10;
  if (event.levels >= 5) score += 10;
  if (event.durationMs <= 200) score += 5;  // very fast sweep = more aggressive

  // Zone confluence boost (where the sweep ENDED matters)
  let zoneNote = '';
  if (levels) {
    const padPct = 0.0005;
    const padding = event.endPrice * padPct;
    const inBull = inZone(event.endPrice, levels.bullZone, padding);
    const inBear = inZone(event.endPrice, levels.bearZone, padding);
    if (inBull) {
      score += 15;
      zoneNote = event.direction === 'long' ? ' INTO bull zone (breakout candidate)' : ' INTO bull zone (rejection candidate)';
    } else if (inBear) {
      score += 15;
      zoneNote = event.direction === 'short' ? ' INTO bear zone (breakdown candidate)' : ' INTO bear zone (rejection candidate)';
    }
  }

  // Gamma regime alignment (if FA available)
  if (fa) {
    const aligned =
      (event.direction === 'long' && fa.gammaRegime !== 'negative') ||
      (event.direction === 'short' && fa.gammaRegime !== 'positive');
    if (aligned) score += 5;
  }

  score = Math.min(100, score);

  // Dedup: same direction within 60s of last sweep alert
  const dedupKey = `sweep:${event.symbol}:${event.direction}`;
  const last = ctx.recentSignalKeys.get(dedupKey);
  if (last && Date.now() - last < DEDUP_WINDOW_MS) return null;
  ctx.recentSignalKeys.set(dedupKey, Date.now());

  const moveTicks = Math.abs(event.endPrice - event.startPrice);
  const rationale =
    `${event.direction.toUpperCase()} sweep: ${event.volume} contracts across ` +
    `${event.levels} levels in ${event.durationMs}ms ` +
    `(${event.startPrice} -> ${event.endPrice}, ${moveTicks.toFixed(2)} pts).` +
    zoneNote +
    (fa ? ` Regime: ${fa.gammaRegime}.` : '');

  return {
    ts: event.ts,
    source: 'rules',
    type: 'confluence',
    symbol: event.symbol,
    ruleId: 'sweep',
    score,
    direction: event.direction,
    contextEventIds: [],
    rationale,
    observeOnly: true,
  };
}

// --- Engine ---

export function startRulesEngine(
  getLevels: (s: Symbol) => DailyLevels | undefined,
  getFlashAlpha: (s: Symbol) => FlashAlphaSnapshot | undefined
): void {
  const ctx: RuleContext = { recentSignalKeys: new Map() };

  state.onEvent((event: AggregatorEvent) => {
    try {
      if (event.source === 'bookmap' && event.type === 'absorption') {
        const sig = ruleAbsorptionAtZone(event, ctx, getLevels, getFlashAlpha);
        if (sig) {
          logger.info({ ruleId: sig.ruleId, score: sig.score, direction: sig.direction }, 'signal fired');
          state.applySignal(sig);
        }
      }
      if (event.source === 'bookmap' && event.type === 'sweep') {
        const sig = ruleSweep(event, ctx, getLevels, getFlashAlpha);
        if (sig) {
          logger.info({ ruleId: sig.ruleId, score: sig.score, direction: sig.direction, levels: event.levels, volume: event.volume }, 'signal fired');
          state.applySignal(sig);
        }
      }
      // Add more rules here as observation reveals what works.
    } catch (err) {
      logger.error({ err }, 'rule evaluation crashed');
    }
  });

  logger.info('rules engine started');
}
