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
export type Resilience = number; // actual float from RS platform (e.g. -11.3, +55.7). Sign is all that matters for direction.

/** One row of the platform's Irrational/Unusual Rules panel, read passively by rs-feed.
 *  state: red=active break, yellow=caution (broke + returned), green=none. dir=break direction. */
export interface IrrationalRule {
  section: string;                            // 'Irrational Rules:' | 'Unusual Rules:'
  name: string;                               // '/ENQ DD-Band Break' | 'QQQ MHP Break' | 'UVXY Bull Zone Bottom' …
  state: 'red' | 'yellow' | 'green' | null;
  dir: 'up' | 'down' | null;
}

/** The four resilience readings — same shape per symbol, also at top-level for back-compat. */
export interface ResilienceSet {
  mhpResilience: Resilience;        // orange — MHP resilience. tiebreaker at MHP. >0 = 90% bounce, <0 = ~73%
  hpResilience: Resilience;         // cyan   — HP/weekly resilience. tiebreaker at HP.
  redistResilience: Resilience;     // white  — half-gap/redistribution resilience. only valid inside redist zone.
  resilience: Resilience;           // kept for backward compat — mirrors redistResilience
}

/** Per-symbol context: resilience set + RS reads (LM code, monthly-map bias) + computed GM. */
export interface SymbolContext extends ResilienceSet {
  lmCode?: string;                  // per-symbol Liquidity-Map code (NQ=BLD, ES=MRLD, …)
  mmBullish?: boolean;              // Monthly-Map (1D) bias — true=price not in bear zone
  gm?: GreaterMarket;              // COMPUTED greater-market for this symbol (see compute())
  // Dynamic/overnight HP/MHP estimate (window.DYN_HP), ETF scale (QQQ for NQ, SPY for ES).
  // Converted to futures scale downstream in deriveMarketState (ratio = futures/ETF).
  dynHpEtf?: number;
  dynMhpEtf?: number;
  dynCloseEtf?: number;             // ETF close reference for the ETF→futures conversion
}

export interface RSContext extends ResilienceSet {
  // Greater market (3 indicators: DD ratio + SPY vs MHP + Monthly Maps)
  greaterMarket: GreaterMarket;    // 'bull' | 'bear' | 'neutral'
  ddRatio: number;                  // 0-1, >0.5 = bullish
  lmCode?: string;                  // LM code for the day: BLU / BLD / BSD / BrD etc.
  // Top-level resilience fields (mhpResilience/hpResilience/redistResilience/resilience)
  // are inherited from ResilienceSet and act as the GLOBAL / default values.
  // Per-symbol overrides live in `bySymbol` below — when present, getContext(symbol)
  // overlays them on top of the flat fields. Callers that don't pass a symbol still
  // see the global (= default-symbol) values unchanged.
  bySymbol?: Record<string, SymbolContext>;
  // Irrational/Unusual Rules panel — raw per-row states read passively by rs-feed.
  // The level engine derives the sit-out gate from these (deriveGate in rules-v2).
  irrational?: IrrationalRule[];
  // Greater-market index inputs (ETF price from Yahoo poller; MHP threshold from RS platform header)
  spy?: number;                     // SPY ETF live price (Yahoo) — vs spyMhp for ES greater-market
  qqq?: number;                     // QQQ ETF live price (Yahoo) — vs qqqMhp for NQ greater-market
  spyMhp?: number;                  // SP500 MHP price from platform header (#sp-MHP)
  qqqMhp?: number;                  // NQ100 MHP price from platform header (#nq-MHP)
  spyPrev?: number;                 // SPY prior close (Yahoo) — for the QQQ-vs-SPY RS read
  qqqPrev?: number;                 // QQQ prior close (Yahoo) — for the QQQ-vs-SPY RS read
  qqqSpyRs?: number;                // DERIVED: QQQ %chg − SPY %chg (pct pts). >0 = Nasdaq leading (risk-on)
  // VX (volatility-complex) gamma inflection. Live UVXY vs the platform's VX gamma
  // HP/MHP (both UVXY-scale). Above MHP/HP = vol expanding = risk-off for NQ/ES.
  uvxy?: number;                    // live UVXY price (Yahoo)
  vxGammaHp?: number;               // VX gamma HP (UVXY-scale, from DYN_HP.VX)
  vxGammaMhp?: number;              // VX gamma MHP (UVXY-scale, from DYN_HP.VX)
  vxVolState?: 'pinned' | 'above-mhp' | 'above-hp';  // DERIVED inflection state
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

function compute(raw: Omit<RSContext, 'vxAboveBBB' | 'vvixElevated' | 'vvixGolden' | 'isRational' | 'qqqSpyRs' | 'vxVolState'>): RSContext {
  const vxAboveBBB = raw.vx > raw.bbb;
  const vvixElevated = raw.vvix > 100;
  const vvixGolden = raw.vvix < 90;
  // Rational = VX below BBB AND VVIX not elevated
  const isRational = !vxAboveBBB && !vvixElevated;

  // QQQ-vs-SPY relative strength: intraday % change spread (pct points).
  // >0 = Nasdaq outperforming S&P (tech/risk-on, NQ tailwind); <0 = lagging (defensive).
  let qqqSpyRs: number | undefined;
  if (raw.qqq != null && raw.qqqPrev && raw.spy != null && raw.spyPrev) {
    qqqSpyRs = ((raw.qqq / raw.qqqPrev - 1) - (raw.spy / raw.spyPrev - 1)) * 100;
  }

  // VX vol-inflection: live UVXY vs its gamma HP/MHP. Severity is by LEVEL IMPORTANCE
  // (MHP = monthly = more significant than HP = weekly), not price height — so check
  // MHP first: above-mhp = severe (red), above-hp = milder (amber), pinned = compressed.
  // (For VX, MHP sits below HP, so crossing MHP is the trigger; the amber HP tier only
  // shows on instruments where HP < MHP.)
  let vxVolState: RSContext['vxVolState'];
  if (raw.uvxy != null && raw.vxGammaMhp != null && raw.vxGammaHp != null) {
    vxVolState = raw.uvxy >= raw.vxGammaMhp ? 'above-mhp'
               : raw.uvxy >= raw.vxGammaHp ? 'above-hp'
               : 'pinned';
  }

  // Per-symbol Greater Market (Ravi's rule): bullish if ANY of
  //   (1) DD > 0.5   (2) index-ETF > its MHP   (3) Monthly-Map bullish.
  // Bearish only if all three are false. ETF/MHP pairing is per symbol:
  //   NQ -> QQQ vs qqqMhp (NQ100 MHP) ;  ES -> SPY vs spyMhp (SP500 MHP).
  const ddBull = raw.ddRatio > 0.5;
  let bySymbol = raw.bySymbol;
  if (bySymbol) {
    bySymbol = { ...bySymbol };
    for (const [sym, sc] of Object.entries(bySymbol)) {
      let etfBull = false;
      if (sym === 'NQ' && raw.qqq != null && raw.qqqMhp != null) etfBull = raw.qqq > raw.qqqMhp;
      if (sym === 'ES' && raw.spy != null && raw.spyMhp != null) etfBull = raw.spy > raw.spyMhp;
      const gmBull = ddBull || etfBull || sc.mmBullish === true;
      bySymbol[sym] = { ...sc, gm: gmBull ? 'bull' : 'bear' };
    }
  }

  return { ...raw, bySymbol, vxAboveBBB, vvixElevated, vvixGolden, isRational, qqqSpyRs, vxVolState };
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

export function saveContext(updates: Partial<Omit<RSContext, 'vxAboveBBB' | 'vvixElevated' | 'vvixGolden' | 'isRational' | 'qqqSpyRs' | 'vxVolState'>>): RSContext {
  const raw = { ..._context, ...updates, setAt: new Date().toISOString() };
  _context = compute(raw);
  fs.mkdirSync(path.dirname(CONTEXT_PATH), { recursive: true });
  fs.writeFileSync(CONTEXT_PATH, JSON.stringify(_context, null, 2));
  return _context;
}

/**
 * Returns the RS context. If `symbol` is provided and bySymbol[symbol] exists,
 * the per-symbol resilience values are overlaid on top of the flat fields.
 * Otherwise (no symbol, or symbol not in bySymbol), the flat-field defaults are
 * returned — matching pre-bySymbol behavior, so existing callers don't break.
 */
export function getContext(symbol?: string): RSContext {
  if (!symbol) return _context;
  const overlay = _context.bySymbol?.[symbol];
  if (!overlay) return _context;
  return {
    ..._context,
    mhpResilience:    overlay.mhpResilience,
    hpResilience:     overlay.hpResilience,
    redistResilience: overlay.redistResilience,
    resilience:       overlay.resilience,
    // Per-symbol RS reads + computed greater-market (fall back to global if absent).
    lmCode:           overlay.lmCode ?? _context.lmCode,
    greaterMarket:    overlay.gm ?? _context.greaterMarket,
  };
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
// field: 'mhp' | 'hp' | 'redist', value: actual float from RS platform (e.g. -11.3, +55.7)
export function setResilience(field: 'mhp' | 'hp' | 'redist', value: number): void {
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
