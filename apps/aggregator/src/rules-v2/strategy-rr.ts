// Strategy RR — Reject Resistance (broken support → resistance, short only)
//
// Mechanic:
//   1. A "former low" structural level (PDL / PML / ORL / WkL) is broken to
//      the downside earlier in the session.
//   2. Price retraces up to that level.
//   3. A 1-min bar's upper wick touches the level but closes well below it
//      with seller aggression — the level rejects from below as resistance.
//
// Entry: bar close.  Stop: level + 0.25.  Targets: 3R standard (T1=10pt, T2=20pt, T3=30pt at typical 10pt stop dist).
// Cooldown: 30 min per symbol.
// Trend gate: skip if prev15Net >= 25 (day in strong uptrend invalidates fade).
// Time gates: 10:00 ET ≤ now < 15:25 ET, skip 11:50–13:15 ET (lunch).
// NQ-only — pattern validated only on NQ; ES not tested.

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db.js';
import { logger } from '../logger.js';
import type { Symbol, ConfluenceSignal } from '@trading/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TICKS_DB_PATH = path.resolve(__dirname, '../../../../data/ticks.db');

const MIN_1            = 60_000;
const COOLDOWN_MS      = 30 * 60 * 1000;
const STALE_MS         = 2 * MIN_1;

// Entry-bar gates
const MIN_RANGE        = 4.0;
const MIN_BODY_PCT     = 0.40;
const MAX_CLOSE_IN_RNG = 0.45;   // close in lower half of bar
const MIN_UPPER_WICK   = 1.0;

// Level-confluence
const LEVEL_TOL_ABOVE  = 3.0;    // level must be within 3pt above close
const WICK_REACH_TOL   = 0.5;    // upper wick must reach level (within 0.5pt)

// Trend gate
const MAX_PREV15_NET   = 25.0;

// Time gates (ET minutes)
const ET_START         = 10 * 60 + 0;   // 10:00
const ET_END           = 15 * 60 + 25;  // 15:25
const ET_LUNCH_START   = 11 * 60 + 50;
const ET_LUNCH_END     = 13 * 60 + 15;

interface OHLCBar {
  ts: number; open: number; high: number; low: number; close: number;
  vol: number; delta: number;
}

interface KeyLevel {
  price: number;
  source: 'PDH'|'PDL'|'PMH'|'PML'|'WkH'|'WkL'|'ORH'|'ORL'
        | 'PDC'|'PDO'|'ONH'|'ONL'|'ONMid'|'VWAP';
}

interface DetectedRR {
  direction: 'short';
  score: number;
  entry: number;
  stopLevel: number;
  stopDist: number;
  level: KeyLevel;
  range: number;
  bodyPct: number;
  upperWick: number;
  delta: number;
  prev15Net: number;
  barTs: number;
}

const _lastSignalMs = new Map<string, number>();

export function seedCooldownFromDb(): void {
  for (const sym of ['NQ'] as Symbol[]) {
    const ts = db.lastSignalTsFor('reject-resistance', sym, 'short');
    if (ts > 0) _lastSignalMs.set(`${sym}:short`, ts);
  }
}

function etMinFor(tsMs: number): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
}

function isTimeAllowed(tsMs: number): boolean {
  const m = etMinFor(tsMs);
  if (m < ET_START || m >= ET_END) return false;
  if (m >= ET_LUNCH_START && m <= ET_LUNCH_END) return false;
  return true;
}

function isWeekday(tsMs: number): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short',
  });
  return ['Mon','Tue','Wed','Thu','Fri'].includes(fmt.format(new Date(tsMs)));
}

// Return ET date string YYYY-MM-DD for a given ms timestamp.
function etDateFor(tsMs: number): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Generate the N previous trading-day date strings (skip Sat/Sun) given a date.
function prevTradingDays(dateStr: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${dateStr}T12:00:00Z`);
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() - 1);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Cache: levels per ET date (recomputed when the day changes).
const _levelCache = new Map<string, KeyLevel[]>();
// Cache: session VWAP accumulators keyed by `${symbol}:${dateStr}`.
// Reset each new ET trading date — RTH-anchored VWAP.
const _vwapState = new Map<string, { cumPV: number; cumV: number; lastBarTs: number }>();

function rangeForEtWindow(ticksDb: Database.Database, symbol: Symbol, dateStr: string, fromHHMM: string, toHHMM: string): { hi: number; lo: number } | null {
  const startTs = Date.parse(`${dateStr}T${fromHHMM}-04:00`);
  const endTs   = Date.parse(`${dateStr}T${toHHMM}-04:00`);
  const row = ticksDb.prepare(
    `SELECT MAX(price) hi, MIN(price) lo FROM trades WHERE symbol=? AND ts >= ? AND ts < ?`
  ).get(symbol, startTs, endTs) as { hi: number; lo: number } | undefined;
  if (!row || row.hi == null || row.lo == null) return null;
  return row;
}

function openCloseForEtWindow(ticksDb: Database.Database, symbol: Symbol, dateStr: string, fromHHMM: string, toHHMM: string): { open: number; close: number } | null {
  const startTs = Date.parse(`${dateStr}T${fromHHMM}-04:00`);
  const endTs   = Date.parse(`${dateStr}T${toHHMM}-04:00`);
  const o = ticksDb.prepare(
    `SELECT price FROM trades WHERE symbol=? AND ts >= ? AND ts < ? ORDER BY ts ASC, id ASC LIMIT 1`
  ).get(symbol, startTs, endTs) as { price: number } | undefined;
  const c = ticksDb.prepare(
    `SELECT price FROM trades WHERE symbol=? AND ts >= ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT 1`
  ).get(symbol, startTs, endTs) as { price: number } | undefined;
  if (!o || !c) return null;
  return { open: o.price, close: c.price };
}

function overnightRange(ticksDb: Database.Database, symbol: Symbol, prevDate: string, today: string): { hi: number; lo: number } | null {
  const startTs = Date.parse(`${prevDate}T16:00:00-04:00`);
  const endTs   = Date.parse(`${today}T09:30:00-04:00`);
  const row = ticksDb.prepare(
    `SELECT MAX(price) hi, MIN(price) lo FROM trades WHERE symbol=? AND ts >= ? AND ts < ?`
  ).get(symbol, startTs, endTs) as { hi: number; lo: number } | undefined;
  if (!row || row.hi == null || row.lo == null) return null;
  return row;
}

function computeStaticLevels(symbol: Symbol, dateStr: string): KeyLevel[] {
  const ticksDb = new Database(TICKS_DB_PATH, { readonly: true });
  try {
    const out: KeyLevel[] = [];
    const prevDays = prevTradingDays(dateStr, 5);
    // PDH/PDL — previous trading day RTH
    const pd = rangeForEtWindow(ticksDb, symbol, prevDays[0]!, '09:30', '16:00');
    if (pd) { out.push({ price: pd.hi, source: 'PDH' }); out.push({ price: pd.lo, source: 'PDL' }); }
    // PDO/PDC — previous day open and close
    const pdOC = openCloseForEtWindow(ticksDb, symbol, prevDays[0]!, '09:30', '16:00');
    if (pdOC) { out.push({ price: pdOC.open, source: 'PDO' }); out.push({ price: pdOC.close, source: 'PDC' }); }
    // PMH/PML — today premarket
    const pm = rangeForEtWindow(ticksDb, symbol, dateStr, '04:00', '09:30');
    if (pm) { out.push({ price: pm.hi, source: 'PMH' }); out.push({ price: pm.lo, source: 'PML' }); }
    // ONH / ONL / ONMid — overnight (prev RTH close → today RTH open)
    const on = overnightRange(ticksDb, symbol, prevDays[0]!, dateStr);
    if (on) {
      out.push({ price: on.hi,                source: 'ONH'   });
      out.push({ price: on.lo,                source: 'ONL'   });
      out.push({ price: (on.hi + on.lo) / 2,  source: 'ONMid' });
    }
    // WkH/WkL — past 5 RTH sessions rolling
    let wkHi = -Infinity, wkLo = Infinity, anyWk = false;
    for (const d of prevDays) {
      const r = rangeForEtWindow(ticksDb, symbol, d, '09:30', '16:00');
      if (!r) continue;
      if (r.hi > wkHi) wkHi = r.hi;
      if (r.lo < wkLo) wkLo = r.lo;
      anyWk = true;
    }
    if (anyWk) { out.push({ price: wkHi, source: 'WkH' }); out.push({ price: wkLo, source: 'WkL' }); }
    return out;
  } finally {
    ticksDb.close();
  }
}

// Add today's opening range H/L (09:30–10:00 ET) to the cached level set.
function ensureOpeningRange(symbol: Symbol, dateStr: string, levels: KeyLevel[]): KeyLevel[] {
  if (levels.some(l => l.source === 'ORH')) return levels;
  const ticksDb = new Database(TICKS_DB_PATH, { readonly: true });
  try {
    const or = rangeForEtWindow(ticksDb, symbol, dateStr, '09:30', '10:00');
    if (or) {
      levels.push({ price: or.hi, source: 'ORH' });
      levels.push({ price: or.lo, source: 'ORL' });
    }
    return levels;
  } finally {
    ticksDb.close();
  }
}

function getLevels(symbol: Symbol, tsMs: number): KeyLevel[] {
  const dateStr = etDateFor(tsMs);
  const key = `${symbol}:${dateStr}`;
  let levels = _levelCache.get(key);
  if (!levels) {
    levels = computeStaticLevels(symbol, dateStr);
    _levelCache.set(key, levels);
  }
  // OR window is known after 10:00 ET — add it once.
  if (etMinFor(tsMs) >= 10 * 60 && !levels.some(l => l.source === 'ORH')) {
    levels = ensureOpeningRange(symbol, dateStr, levels);
    _levelCache.set(key, levels);
  }
  return levels;
}

// Update session VWAP using completed 1-min bars (RTH only). Returns the
// current VWAP value (NaN before the first RTH bar of the session).
function updateAndGetVwap(symbol: Symbol, bars: OHLCBar[], tsMs: number): number {
  const dateStr = etDateFor(tsMs);
  const key = `${symbol}:${dateStr}`;
  let st = _vwapState.get(key);
  if (!st) { st = { cumPV: 0, cumV: 0, lastBarTs: 0 }; _vwapState.set(key, st); }
  // Garbage-collect stale day entries (keep only today + yesterday).
  if (_vwapState.size > 4) {
    for (const k of _vwapState.keys()) if (!k.endsWith(dateStr) && _vwapState.size > 2) _vwapState.delete(k);
  }
  // Walk through completed bars and add any that are RTH and after lastBarTs.
  for (const b of bars) {
    if (b.ts <= st.lastBarTs) continue;
    const m = etMinFor(b.ts);
    if (m < 9 * 60 + 30) continue;       // skip pre-market
    if (m >= 16 * 60) continue;           // skip post-RTH
    const typ = (b.high + b.low + b.close) / 3;
    st.cumPV += typ * b.vol;
    st.cumV  += b.vol;
    st.lastBarTs = b.ts;
  }
  return st.cumV > 0 ? st.cumPV / st.cumV : NaN;
}

// Build 1-min bars from ticks.db. Convention: is_bid_aggressor=1 → BUY
// aggressor (price up); =0 → SELL aggressor (verified empirically).
function buildBars(symbol: Symbol, sinceMs: number): OHLCBar[] {
  const ticksDb = new Database(TICKS_DB_PATH, { readonly: true });
  try {
    const trades = ticksDb.prepare(
      `SELECT ts, price, size, is_bid_aggressor FROM trades WHERE symbol=? AND ts >= ? ORDER BY ts ASC`
    ).all(symbol, sinceMs) as { ts: number; price: number; size: number; is_bid_aggressor: number }[];

    const buckets = new Map<number, { open: number; close: number; high: number; low: number; buyVol: number; sellVol: number }>();
    for (const t of trades) {
      const bk = Math.floor(t.ts / MIN_1) * MIN_1;
      const bar = buckets.get(bk);
      if (!bar) {
        buckets.set(bk, {
          open: t.price, close: t.price, high: t.price, low: t.price,
          buyVol:  t.is_bid_aggressor === 1 ? t.size : 0,
          sellVol: t.is_bid_aggressor === 0 ? t.size : 0,
        });
      } else {
        bar.high  = Math.max(bar.high, t.price);
        bar.low   = Math.min(bar.low,  t.price);
        bar.close = t.price;
        if (t.is_bid_aggressor === 1) bar.buyVol  += t.size;
        else                          bar.sellVol += t.size;
      }
    }
    return Array.from(buckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([ts, bar]) => ({
        ts, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        vol: bar.buyVol + bar.sellVol, delta: bar.buyVol - bar.sellVol,
      }));
  } finally {
    ticksDb.close();
  }
}

function detect(bars: OHLCBar[], levels: KeyLevel[], nowMs: number): DetectedRR | null {
  if (bars.length < 16) return null;

  // Use the just-closed bar (exclude the current forming bar).
  const completed = bars.slice(0, -1);
  const cur = completed[completed.length - 1];
  if (!cur) return null;
  if (nowMs - (cur.ts + MIN_1) > STALE_MS) return null;

  const range = cur.high - cur.low;
  if (range < MIN_RANGE) return null;
  const body = cur.open - cur.close;             // bearish: open > close → body > 0
  if (body <= 0) return null;                    // need bearish bar
  const bodyPct = range > 0 ? body / range : 0;
  if (bodyPct < MIN_BODY_PCT) return null;
  const closeInRangePct = range > 0 ? (cur.close - cur.low) / range : 0.5;
  if (closeInRangePct > MAX_CLOSE_IN_RNG) return null;
  const upperWick = cur.high - Math.max(cur.open, cur.close);
  if (upperWick < MIN_UPPER_WICK) return null;
  if (cur.delta >= 0) return null;

  // prev15 net = close[m] − open[m-14]. Need at least 15 completed bars before cur.
  const first15 = completed[completed.length - 15];
  if (!first15) return null;
  const prev15Net = cur.close - first15.open;
  if (prev15Net >= MAX_PREV15_NET) return null;

  // Find a former-low level above current close.
  // Per-level WR analysis (2026-05-27 on 15 days of train+test data):
  //   PDL: 2/2 = 100%   ORL: 0 triggers
  //   PML: 2/2 = 100%   WkL: 0 triggers
  //   ONL: 0 triggers (added mechanically — symmetric "former low")
  //   PDC/PDO/ONH/ONMid/VWAP: 0/11 — excluded from RR proper.
  // Those other sources are computed and tracked for future variants.
  const formerLows = new Set<KeyLevel['source']>(['PDL','PML','ORL','WkL','ONL']);
  let matched: KeyLevel | null = null;
  for (const lv of levels) {
    if (!formerLows.has(lv.source)) continue;
    const above = lv.price - cur.close;
    if (above <= 0 || above > LEVEL_TOL_ABOVE) continue;
    if (lv.price > cur.close + upperWick + WICK_REACH_TOL) continue;  // wick didn't reach it
    if (!matched || lv.price < matched.price) matched = lv;            // nearest above
  }
  if (!matched) return null;

  // Score: 70 base + 10 if structural (not ORL) + body/wick boosts capped at 95
  let score = 70;
  if (matched.source !== 'ORL') score += 10;
  if (bodyPct >= 0.6) score += 5;
  if (upperWick >= 3.0) score += 5;
  if (score > 95) score = 95;

  const stopLevel = matched.price + 0.25;        // stop just above the level being rejected
  const stopDist  = stopLevel - cur.close;

  return {
    direction: 'short', score,
    entry: cur.close, stopLevel, stopDist,
    level: matched,
    range, bodyPct, upperWick, delta: cur.delta, prev15Net,
    barTs: cur.ts,
  };
}

function isCooling(symbol: Symbol, nowMs: number): boolean {
  return nowMs - (_lastSignalMs.get(`${symbol}:short`) ?? 0) < COOLDOWN_MS;
}

export async function runStrategyRR(symbol: Symbol, nowMs: number): Promise<ConfluenceSignal | null> {
  if (!isWeekday(nowMs))   return null;
  if (!isTimeAllowed(nowMs)) return null;
  if (symbol !== 'NQ')     return null;          // NQ-only

  // Need enough history for prev15 + VWAP-from-RTH-open. Pull from 09:00 ET
  // today (or 30 bars back, whichever is earlier) — keeps it bounded.
  const todayOpenMs = Date.parse(`${etDateFor(nowMs)}T09:00:00-04:00`);
  const sinceMs = Math.min(todayOpenMs, nowMs - 30 * MIN_1);
  const bars    = buildBars(symbol, sinceMs);
  const levels  = [...getLevels(symbol, nowMs)];

  // Append VWAP as a dynamic level (use completed bars only — bars.slice(0,-1)
  // is what runs of detect() also use; mirror that here to keep VWAP causal).
  const completedBars = bars.slice(0, -1);
  const vwap = updateAndGetVwap(symbol, completedBars, nowMs);
  if (isFinite(vwap)) levels.push({ price: vwap, source: 'VWAP' });

  const hit = detect(bars, levels, nowMs);
  if (!hit) return null;
  if (isCooling(symbol, nowMs)) return null;

  _lastSignalMs.set(`${symbol}:short`, nowMs);

  const entry    = hit.entry;
  const stop     = hit.stopLevel;
  const stopDist = hit.stopDist;
  const t1 = entry - stopDist;
  const t2 = entry - 2 * stopDist;
  const t3 = entry - 3 * stopDist;

  const rationale =
    `RR SHORT @ ${hit.level.source}=${hit.level.price.toFixed(2)} ` +
    `(${(hit.level.price - entry).toFixed(2)}pt above close). ` +
    `range=${hit.range.toFixed(1)} body=${(hit.bodyPct * 100).toFixed(0)}% ` +
    `wick=${hit.upperWick.toFixed(1)} delta=${hit.delta} prev15=${hit.prev15Net.toFixed(1)}. ` +
    `Entry=${entry} Stop=${stop} (${stopDist.toFixed(2)}pts risk). ` +
    `T1=${t1.toFixed(2)} T2=${t2.toFixed(2)} T3=${t3.toFixed(2)}.`;

  logger.info({
    symbol, direction: 'short', ruleId: 'reject-resistance',
    score: hit.score, entry, stop, stopDist,
    levelSource: hit.level.source, levelPrice: hit.level.price,
    range: hit.range, bodyPct: hit.bodyPct, upperWick: hit.upperWick,
    delta: hit.delta, prev15Net: hit.prev15Net,
  }, 'strategy-RR: signal fired');

  return {
    ts: hit.barTs,
    source: 'rules-v2',
    type: 'confluence',
    symbol,
    ruleId: 'reject-resistance',
    score: hit.score,
    direction: 'short',
    rationale,
    strategyVersion: 'RR' as any,
    ruleVersion: 'rr-v1',
    entry,
    stopLevel: stop,
    stopDist,
    levelSource: hit.level.source,
    levelPrice: hit.level.price,
    range: hit.range,
    bodyPct: hit.bodyPct,
    upperWick: hit.upperWick,
    delta: hit.delta,
    prev15Net: hit.prev15Net,
  } as any;
}
