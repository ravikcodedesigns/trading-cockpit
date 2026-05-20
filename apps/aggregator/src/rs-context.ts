// RS Market Context Store
//
// Holds the morning context values set via:
//   pnpm --filter aggregator context:set --dd-ratio 0.73 --vx 18.5 --bbb 20.2 --vvix 88 --greater-market bull
//
// Persisted to a JSON file so it survives aggregator restarts.
// Rules read from this store to apply RS-based filters and bonuses.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTEXT_PATH = path.resolve(__dirname, '../../../data/rs-context.json');

export type GreaterMarket = 'bull' | 'bear' | 'neutral';
export type Resilience = 1 | 0 | -1; // 1=bullish, 0=neutral, -1=bearish

export interface RSContext {
  // Greater market (3 indicators: DD ratio + SPY vs MHP + Monthly Maps)
  greaterMarket: GreaterMarket;    // 'bull' | 'bear' | 'neutral'
  ddRatio: number;                  // 0-1, >0.5 = bullish
  // Three resilience readings — each is a tiebreaker at its respective level
  mhpResilience: Resilience;        // orange — MHP resilience. tiebreaker at MHP. >0 = 90% bounce, <0 = ~73%
  hpResilience: Resilience;         // blue   — HP/weekly resilience. tiebreaker at HP.
  redistResilience: Resilience;     // white  — half-gap/redistribution resilience. only valid inside redist zone.
  resilience: Resilience;           // kept for backward compat — mirrors redistResilience
  // Volatility environment
  vx: number;                       // /VX futures price
  bbb: number;                      // contango/backwardation midpoint (monthly, set Tuesday before VIX OPEX)
  vvix: number;                     // volatility of VIX
  // Derived fields (computed on load)
  vxAboveBBB: boolean;              // true = volatile, pivots can overshoot — spread entries
  vvixElevated: boolean;            // true = VIX sensitive to events (>100)
  vvixGolden: boolean;              // true = golden environment (<90), news shrugs off
  isRational: boolean;              // false = irrational rules apply
  // Metadata
  setAt: string;                    // ISO timestamp when context was last set
  tradingDay: string;               // YYYY-MM-DD
}

const DEFAULT_CONTEXT: RSContext = {
  greaterMarket: 'neutral',
  ddRatio: 0.5,
  mhpResilience: 0,
  hpResilience: 0,
  redistResilience: 0,
  resilience: 0,
  vx: 20,
  bbb: 20,
  vvix: 95,
  vxAboveBBB: false,
  vvixElevated: false,
  vvixGolden: true,
  isRational: true,
  setAt: new Date().toISOString(),
  tradingDay: new Date().toISOString().slice(0, 10),
};

function compute(raw: Omit<RSContext, 'vxAboveBBB' | 'vvixElevated' | 'vvixGolden' | 'isRational'>): RSContext {
  const vxAboveBBB = raw.vx > raw.bbb;
  const vvixElevated = raw.vvix > 100;
  const vvixGolden = raw.vvix < 90;
  // Rational = VX below BBB AND VVIX not elevated
  const isRational = !vxAboveBBB && !vvixElevated;
  return { ...raw, vxAboveBBB, vvixElevated, vvixGolden, isRational };
}

let _context: RSContext = DEFAULT_CONTEXT;

export function loadContext(): RSContext {
  try {
    if (fs.existsSync(CONTEXT_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONTEXT_PATH, 'utf-8'));
      _context = compute(raw);
      logger.info({
        greaterMarket: _context.greaterMarket,
        ddRatio: _context.ddRatio,
        vx: _context.vx,
        bbb: _context.bbb,
        vvix: _context.vvix,
        vxAboveBBB: _context.vxAboveBBB,
        isRational: _context.isRational,
        setAt: _context.setAt,
      }, 'RS context loaded');
    } else {
      logger.warn('No RS context file found, using defaults. Run: pnpm context:set');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load RS context, using defaults');
  }
  return _context;
}

export function saveContext(updates: Partial<Omit<RSContext, 'vxAboveBBB' | 'vvixElevated' | 'vvixGolden' | 'isRational'>>): RSContext {
  const raw = { ..._context, ...updates, setAt: new Date().toISOString() };
  _context = compute(raw);
  fs.mkdirSync(path.dirname(CONTEXT_PATH), { recursive: true });
  fs.writeFileSync(CONTEXT_PATH, JSON.stringify(_context, null, 2));
  return _context;
}

export function getContext(): RSContext {
  return _context;
}

// Watch the context file for external changes (CLI writes) and reload.
// Debounced via mtime so rapid saves don't trigger multiple reloads.
let _lastMtime = 0;
export function watchContext(): void {
  const reload = () => {
    try {
      if (!fs.existsSync(CONTEXT_PATH)) return;
      const mtime = fs.statSync(CONTEXT_PATH).mtimeMs;
      if (mtime === _lastMtime) return;
      _lastMtime = mtime;
      loadContext();
      logger.info({ greaterMarket: _context.greaterMarket, vx: _context.vx, mhpResilience: _context.mhpResilience }, 'RS context reloaded from file');
    } catch { /* ignore */ }
  };

  try {
    fs.watch(CONTEXT_PATH, { persistent: false }, () => setTimeout(reload, 50));
  } catch { /* file may not exist yet at watch time */ }

  // Poll every 5s as fallback (atomic-rename editors, cross-process writes)
  setInterval(reload, 5_000);
}

// Update a specific resilience in real-time without full context reset.
// field: 'mhp' | 'hp' | 'redist'
export function setResilience(field: 'mhp' | 'hp' | 'redist', value: Resilience): void {
  const key = field === 'mhp' ? 'mhpResilience'
            : field === 'hp'  ? 'hpResilience'
            :                   'redistResilience';
  const updates: Partial<RSContext> = { [key]: value };
  // Keep backward-compat resilience field mirroring redistResilience
  if (field === 'redist') updates.resilience = value;
  _context = { ..._context, ...updates };
  saveContext(updates);
  logger.info({ field, value }, 'RS resilience updated');
}
