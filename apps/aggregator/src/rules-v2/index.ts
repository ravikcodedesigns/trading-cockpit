// Strategy B Rules Engine
//
// Runs tick-based rules on a polling loop. Unlike Strategy A (which is
// event-driven via Bookmap addon messages), Strategy B pulls data from
// the tick-store on a fixed interval and runs pattern detection.
//
// Architecture:
//   - Polls every POLL_MS (500ms default, configurable)
//   - Runs each rule for each subscribed symbol
//   - Emits signals via state.applySignal() — same path as Strategy A
//   - All signals tagged strategy_version='B' for outcome comparison
//
// Adding a new rule:
//   1. Create it in rules-v2/<rule-name>.ts
//   2. Import and add to RULES array below
//   3. Update quality.ts if it needs a different gold-tier threshold

import { state } from '../state.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { detectAbsorption } from './absorption.js';
import { detectTapeSpeed } from './tape-speed.js';
import { detectLargePrint } from './large-print.js';
import { detectWallBrokenFade } from './wall-broken-fade.js';
import { detectCompressionRealwall } from './compression-realwall.js';
import type { Symbol } from '@trading/contracts';

const POLL_MS = config.tickStore.pollMs;

// Symbols to evaluate
const SYMBOLS: Symbol[] = ['NQ', 'ES'];

// Rule registry. Each rule is independently enabled/disabled.
// Add new rules here — no other changes needed.
type RuleFn = (symbol: Symbol, nowMs: number) => Promise<{ signal: Parameters<typeof state.applySignal>[0] } | null>;

const RULES: Array<{ id: string; fn: RuleFn; enabled: boolean }> = [
  {
    id: 'absorption',
    fn: detectAbsorption,
    enabled: true,
  },
  {
    id: 'tape-speed',
    fn: detectTapeSpeed,
    enabled: true,
  },
  {
    id: 'large-print',
    fn: detectLargePrint,
    enabled: true,
  },
  {
    // Strategy WBF — passive wall fade. Shadow-only until calibrated.
    // Quality gate in quality.ts forces silenced tier; signals still hit signals table.
    id: 'wall-broken-fade',
    fn: detectWallBrokenFade,
    enabled: true,
  },
  {
    // Compression + Real-Bid-Wall + Capitulation (LONG only, MNQ).
    // R:R 1:4 strict (TP=24/SL=6). SHADOW pending multi-day MBO validation;
    // single-day MBO produced 0 qualifying confluence on the test day.
    // Quality gate in quality.ts forces 'silenced' until validated.
    id: 'compression-realwall',
    fn: detectCompressionRealwall,
    enabled: true,
  },
  // Future rules:
  // { id: 'iceberg', fn: detectIceberg, enabled: true },
  // { id: 'footprint-imbalance', fn: detectFootprintImbalance, enabled: true },
  // { id: 'liquidity-vacuum', fn: detectLiquidityVacuum, enabled: true },
];

let _running = false;
let _timer: ReturnType<typeof setTimeout> | null = null;
let _iteration = 0;

async function runOnce(): Promise<void> {
  const nowMs = Date.now();
  _iteration++;

  for (const symbol of SYMBOLS) {
    for (const rule of RULES) {
      if (!rule.enabled) continue;

      try {
        const result = await rule.fn(symbol, nowMs);
        if (result) {
          // Attach strategy metadata before applying
          const signal = {
            ...result.signal,
            strategyVersion: 'B' as const,
          };
          state.applySignal(signal);
        }
      } catch (err) {
        logger.warn({ err, rule: rule.id, symbol }, 'strategy-B rule crashed');
      }
    }
  }

  // Periodic health log every 5 minutes
  if (_iteration % (300_000 / POLL_MS) === 0) {
    logger.info({ iteration: _iteration, symbols: SYMBOLS, rules: RULES.filter(r => r.enabled).map(r => r.id) },
      'strategy-B heartbeat');
  }
}

function schedule(): void {
  if (!_running) return;
  _timer = setTimeout(async () => {
    await runOnce().catch(err => logger.warn({ err }, 'strategy-B poll error'));
    schedule();
  }, POLL_MS);
}

export function startStrategyB(): void {
  if (_running) {
    logger.warn('strategy-B already running');
    return;
  }
  _running = true;
  logger.info({ pollMs: POLL_MS, symbols: SYMBOLS, rules: RULES.filter(r => r.enabled).map(r => r.id) },
    'strategy-B started');
  schedule();
}

export function stopStrategyB(): void {
  _running = false;
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  logger.info('strategy-B stopped');
}

export function setRuleEnabled(ruleId: string, enabled: boolean): void {
  const rule = RULES.find(r => r.id === ruleId);
  if (!rule) {
    logger.warn({ ruleId }, 'unknown rule');
    return;
  }
  rule.enabled = enabled;
  logger.info({ ruleId, enabled }, 'strategy-B rule toggled');
}

export function getRuleStatus(): Array<{ id: string; enabled: boolean }> {
  return RULES.map(r => ({ id: r.id, enabled: r.enabled }));
}
