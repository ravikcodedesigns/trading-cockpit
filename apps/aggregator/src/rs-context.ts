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
// rs-mm writes the Monthly-Map bias to its OWN file (disjoint from rs-feed's rs-context.json → no write
// race). The aggregator is the sole merger: it overlays mmBullish from here onto the base context.
const MM_PATH = path.resolve(__dirname, '../../../data/rs-context-mm.json');

// Tolerant JSON read — returns null on a missing OR mid-write (torn) file so the caller keeps last-good.
function readJsonSafe(p: string): any | null {
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { /* partial/torn — keep last-good */ }
  return null;
}

// Atomic write (temp + rename) so a concurrent reader (rs-feed / the merge poll) never sees a partial file.
function writeAtomic(p: string, str: string): void {
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, str);
  fs.renameSync(tmp, p);
}

// Overlay per-symbol + global mmBullish from rs-context-mm.json onto a base context. No-op if the file
// is absent (backward-compatible: until rs-mm writes it, the context behaves exactly as before).
function mergeMm(base: any): any {
  const mm = readJsonSafe(MM_PATH);
  if (!mm || !mm.bySymbol) return base;
  const bySymbol = { ...(base.bySymbol || {}) };
  for (const sym of Object.keys(mm.bySymbol)) {
    if (mm.bySymbol[sym]?.mmBullish != null) bySymbol[sym] = { ...(bySymbol[sym] || {}), mmBullish: mm.bySymbol[sym].mmBullish };
  }
  return { ...base, bySymbol };   // per-symbol mmBullish is what compute() reads (sc.mmBullish) — no global field
}

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
  // Freshness — computed by getContext() on each read (NOT stored). For upstream staleness gates:
  // if the feed is dead/frozen these say so, so a strategy can sit out before emitting a signal.
  contextAgeSec?: number;           // seconds since setAt (Infinity if never set)
  contextStale?: boolean;           // true = older than CONTEXT_STALE_SEC (rs-feed not writing)
  // Metadata
  setAt: string;                    // ISO timestamp of the LAST write (rs-feed OR vx-poller/extension)
  feedSetAt?: string;               // ISO timestamp of rs-feed's OWN last write — the true feed-liveness signal
                                    // (setAt can be bumped by vx-poller while rs-feed is dead; feedSetAt can't)
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
    const raw = readJsonSafe(CONTEXT_PATH);
    if (raw) {
      _context = compute(mergeMm(raw));   // base (rs-feed + vx) ⊕ mmBullish (rs-mm) → canonical context
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
  writeAtomic(CONTEXT_PATH, JSON.stringify(_context, null, 2));
  return _context;
}

/**
 * Returns the RS context. If `symbol` is provided and bySymbol[symbol] exists,
 * the per-symbol resilience values are overlaid on top of the flat fields.
 * Otherwise (no symbol, or symbol not in bySymbol), the flat-field defaults are
 * returned — matching pre-bySymbol behavior, so existing callers don't break.
 */
const CONTEXT_STALE_SEC = 30;   // rs-feed writes every 5s → context older than this = feed dead/frozen

export function getContext(symbol?: string): RSContext {
  // Freshness stamped on every read (time-dependent, so computed, never stored). Use feedSetAt (rs-feed's
  // own write) not setAt — so a vx-poller write can't mask a dead rs-feed. Falls back to setAt if absent.
  const freshTs = _context.feedSetAt ?? _context.setAt;
  const contextAgeSec = freshTs ? Math.round((Date.now() - Date.parse(freshTs)) / 1000) : Number.POSITIVE_INFINITY;
  const contextStale = contextAgeSec > CONTEXT_STALE_SEC;
  const overlay = symbol ? _context.bySymbol?.[symbol] : undefined;
  const base: RSContext = overlay ? {
    ..._context,
    mhpResilience:    overlay.mhpResilience,
    hpResilience:     overlay.hpResilience,
    redistResilience: overlay.redistResilience,
    resilience:       overlay.resilience,
    // Per-symbol RS reads + computed greater-market (fall back to global if absent).
    lmCode:           overlay.lmCode ?? _context.lmCode,
    greaterMarket:    overlay.gm ?? _context.greaterMarket,
  } : _context;
  return { ...base, contextAgeSec, contextStale };
}

// Watch the context file for external changes (CLI writes) and reload.
// Debounced via mtime so rapid saves don't trigger multiple reloads.
let _lastMtime = 0, _lastMmMtime = 0;
export function watchContext(): void {
  const reload = () => {
    try {
      const ctxM = fs.existsSync(CONTEXT_PATH) ? fs.statSync(CONTEXT_PATH).mtimeMs : 0;
      const mmM = fs.existsSync(MM_PATH) ? fs.statSync(MM_PATH).mtimeMs : 0;
      if (ctxM === _lastMtime && mmM === _lastMmMtime) return;   // neither file changed
      _lastMtime = ctxM; _lastMmMtime = mmM;
      loadContext();   // re-reads rs-context.json + overlays rs-context-mm.json
      logger.info({ greaterMarket: _context.greaterMarket, vx: _context.vx, mhpResilience: _context.mhpResilience, nqMmBullish: _context.bySymbol?.NQ?.mmBullish }, 'RS context reloaded (merged)');
    } catch { /* ignore */ }
  };

  // Watch both files (instant trigger). If a file doesn't exist yet (e.g. rs-context-mm.json before
  // rs-mm's first write), the watch setup throws → the 2s poll picks it up once it appears.
  for (const p of [CONTEXT_PATH, MM_PATH]) {
    try { fs.watch(p, { persistent: false }, () => setTimeout(reload, 50)); } catch { /* not present yet */ }
  }

  // Poll every 2s as the reliable fallback (fs.watch misses/dupes events; atomic-rename writes; a
  // missed event self-heals within one interval). This poll — not fs.watch — is the live-path safety net.
  setInterval(reload, 2_000);
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
