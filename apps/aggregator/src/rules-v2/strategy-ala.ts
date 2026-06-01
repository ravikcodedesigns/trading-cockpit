// Strategy ALA — three LONG-bias detectors at institutional support levels.
//
//   ALA_BOUNCE       (ruleId='ala-bounce'):
//       Clean test of a hedge level (MHP / HP / ON_MHP / ON_HP) from above
//       — low touched the level, didn't break below significantly, close
//       above. Mechanic: support held.
//
//   ALA_RECLAIM      (ruleId='ala-reclaim'):
//       Failed breakdown of a hedge level (MHP / HP / ON_MHP / ON_HP) — low
//       went meaningfully BELOW the level, close ABOVE. Mechanic: sellers
//       trapped, level reclaimed.
//
//   ALA_ZONE_RECLAIM (ruleId='ala-zone-reclaim'):
//       Same reclaim mechanic at BZB (Bull Zone Bottom) or BrZT (Bear Zone
//       Top) levels, with two additional gates:
//         - closeInRange ≥ 0.90 (close in top 10% of bar range — clean reclaim
//           with buyer follow-through)
//         - cvdSession ≥ 4000   (buyer-dominant session — see below)
//
// ALL three gated by `cvdSession ≥ 4000` — research showed CVD is the day-
// regime discriminator that turns ~28% WR into ~71% WR for level-reclaim
// LONGS. CVD is the cumulative session delta from RTH open (09:30 ET) through
// the signal bar, computed from completed 1-min bars.
//
// SHORT scenarios (clean breakdowns, failed breakouts) intentionally NOT fired
// — when resilience is positive (expected for hedge-pressure / zone levels),
// price is supposed to bounce/reclaim, not break.
//
// Time gates: post-09:35 ET, skip 11:50-13:15 (lunch), skip 15:25+ (close).
// Cooldown: 15 min per (symbol, level, scenario).  NQ only.

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { db } from '../db.js';
import { logger } from '../logger.js';
import type { Symbol, ConfluenceSignal } from '@trading/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TICKS_DB_PATH = path.resolve(__dirname, '../../../../data/ticks.db');
const LEVELS_JSON   = path.resolve(__dirname, '../../../../daily_levels.json');

const MIN_1       = 60_000;
const COOLDOWN_MS = 15 * 60_000;
const STALE_MS    = 2 * MIN_1;

// BOUNCE thresholds (MHP / HP / ON_MHP / ON_HP)
const BOUNCE_LOW_BELOW_TOL = 0.5;
const BOUNCE_LOW_ABOVE_TOL = 1.5;
const BOUNCE_RANGE_MIN     = 4;
const BOUNCE_VOL_MIN       = 1500;

// RECLAIM thresholds (MHP / HP / ON_MHP / ON_HP)
const RECLAIM_BREACH_MIN = 1.0;
const RECLAIM_RANGE_MIN  = 6;
const RECLAIM_VOL_MIN    = 2000;

// ZONE_RECLAIM thresholds (BZB / BrZT only)
const ZONE_BREACH_MIN     = 1.0;
const ZONE_RANGE_MIN      = 6;
const ZONE_VOL_MIN        = 2000;
const ZONE_CLOSE_IN_MIN   = 0.90;       // close must be in top 10% of bar range

// Day-regime gate — applies to all three scenarios.
const CVD_SESSION_MIN     = 4000;

// Target / stop
const TARGET_PTS  = 40;
const STOP_BUFFER = 1.0;

type LevelName = 'MHP' | 'HP' | 'ON_MHP' | 'ON_HP' | 'BZB' | 'BrZT';
type Scenario  = 'BOUNCE' | 'RECLAIM' | 'ZONE_RECLAIM';
interface KeyLevel { source: LevelName; price: number }
interface OHLCBar  { ts: number; open: number; high: number; low: number; close: number; vol: number; delta: number }
interface DetectedALA {
  scenario: Scenario;
  level: KeyLevel;
  bar: OHLCBar;
  range: number;
  bodyPct: number;
  closeInRange: number;
  breach: number;
  cvdSession: number;
  barTs: number;
}

const _lastSignalMs = new Map<string, number>();
const _levelCache   = new Map<string, KeyLevel[]>();

export function seedCooldownFromDb(): void {
  for (const sym of ['NQ'] as Symbol[]) {
    for (const r of ['ala-bounce', 'ala-reclaim', 'ala-zone-reclaim']) {
      const ts = db.lastSignalTsFor(r, sym, 'long');
      if (ts > 0) _lastSignalMs.set(`${sym}:${r}`, ts);
    }
  }
}

function etMin(tsMs: number): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
}
function isWeekday(tsMs: number): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  return ['Mon','Tue','Wed','Thu','Fri'].includes(fmt.format(new Date(tsMs)));
}
function etDateFor(tsMs: number): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function isTimeAllowed(tsMs: number): boolean {
  const m = etMin(tsMs);
  if (m < 9 * 60 + 35) return false;
  if (m >= 11 * 60 + 50 && m <= 13 * 60 + 15) return false;
  if (m >= 15 * 60 + 25) return false;
  return true;
}

function loadLevelsForDate(dateStr: string): KeyLevel[] {
  if (!fs.existsSync(LEVELS_JSON)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(LEVELS_JSON, 'utf-8'));
    const entry = raw?.days?.[dateStr];
    if (!entry) return [];
    const lv = entry.levels?.[0];
    if (!lv) return [];
    const out: KeyLevel[] = [];
    if (typeof lv.mhp === 'number') out.push({ source: 'MHP', price: lv.mhp });
    if (typeof lv.hedgePressure === 'number') out.push({ source: 'HP', price: lv.hedgePressure });
    const add = (lv.additionalLevels ?? []) as { price?: number; label?: string }[];
    for (const a of add) {
      if (typeof a.price !== 'number' || !a.label) continue;
      if (a.label === 'ON MHP') out.push({ source: 'ON_MHP', price: a.price });
      if (a.label === 'ON HP')  out.push({ source: 'ON_HP',  price: a.price });
    }
    // Bull Zone Bottom (BZB) and Bear Zone Top (BrZT) — zone-defining levels
    if (lv.bullZone && typeof lv.bullZone.low  === 'number') out.push({ source: 'BZB',  price: lv.bullZone.low  });
    if (lv.bearZone && typeof lv.bearZone.high === 'number') out.push({ source: 'BrZT', price: lv.bearZone.high });
    return out;
  } catch (e) {
    logger.warn({ err: e, dateStr }, 'strategy-ALA: failed to parse daily_levels.json');
    return [];
  }
}

function getLevels(tsMs: number): KeyLevel[] {
  const dateStr = etDateFor(tsMs);
  let cached = _levelCache.get(dateStr);
  if (!cached) {
    cached = loadLevelsForDate(dateStr);
    _levelCache.set(dateStr, cached);
  }
  return cached;
}

// Build 1-min bars from RTH-open onward (so we can compute session CVD).
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
    return Array.from(buckets.entries()).sort(([a],[b]) => a - b).map(([ts, bar]) => ({
      ts, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
      vol: bar.buyVol + bar.sellVol, delta: bar.buyVol - bar.sellVol,
    }));
  } finally {
    ticksDb.close();
  }
}

// Cumulative session delta — sum delta across all bars at or before barTs that
// fall in the RTH window (09:30 ET ≤ minute < 16:00 ET).
function computeSessionCvd(bars: OHLCBar[], barTs: number): number {
  let cvd = 0;
  for (const b of bars) {
    if (b.ts > barTs) break;
    const m = etMin(b.ts);
    if (m < 9*60+30 || m >= 16*60) continue;
    cvd += b.delta;
  }
  return cvd;
}

// BOUNCE — clean test (low at/near level, no significant break, close above)
function isBounce(bar: OHLCBar, level: number): boolean {
  if (bar.close <= level) return false;
  if (bar.low < level - BOUNCE_LOW_BELOW_TOL) return false;
  if (bar.low > level + BOUNCE_LOW_ABOVE_TOL) return false;
  if ((bar.high - bar.low) < BOUNCE_RANGE_MIN) return false;
  if (bar.vol < BOUNCE_VOL_MIN) return false;
  return true;
}

// RECLAIM — low broke below level, close back above (MHP/HP/ON_MHP/ON_HP)
function isReclaim(bar: OHLCBar, level: number): boolean {
  if (bar.close <= level) return false;
  if (level - bar.low < RECLAIM_BREACH_MIN) return false;
  if ((bar.high - bar.low) < RECLAIM_RANGE_MIN) return false;
  if (bar.vol < RECLAIM_VOL_MIN) return false;
  return true;
}

// ZONE_RECLAIM — reclaim at BZB/BrZT, requires close in top 10% of range
function isZoneReclaim(bar: OHLCBar, level: number): boolean {
  if (bar.close <= level) return false;
  if (level - bar.low < ZONE_BREACH_MIN) return false;
  const range = bar.high - bar.low;
  if (range < ZONE_RANGE_MIN) return false;
  if (bar.vol < ZONE_VOL_MIN) return false;
  const closeIn = range > 0 ? (bar.close - bar.low) / range : 0;
  if (closeIn < ZONE_CLOSE_IN_MIN) return false;
  return true;
}

function detect(bars: OHLCBar[], levels: KeyLevel[], nowMs: number): DetectedALA | null {
  if (bars.length < 2) return null;
  const completed = bars.slice(0, -1);
  const cur = completed[completed.length - 1];
  if (!cur) return null;
  if (nowMs - (cur.ts + MIN_1) > STALE_MS) return null;

  // CVD must indicate buyer-dominant session.
  const cvdSession = computeSessionCvd(completed, cur.ts);
  if (cvdSession < CVD_SESSION_MIN) return null;

  // Per scenario priority: BOUNCE > RECLAIM > ZONE_RECLAIM (cleanest first).
  // ZONE_RECLAIM only fires at BZB / BrZT.
  for (const lv of levels) {
    if (lv.source === 'BZB' || lv.source === 'BrZT') continue;
    if (isBounce(cur, lv.price)) {
      return buildResult(cur, lv, 'BOUNCE', cvdSession);
    }
  }
  for (const lv of levels) {
    if (lv.source === 'BZB' || lv.source === 'BrZT') continue;
    if (isReclaim(cur, lv.price)) {
      return buildResult(cur, lv, 'RECLAIM', cvdSession);
    }
  }
  for (const lv of levels) {
    if (lv.source !== 'BZB' && lv.source !== 'BrZT') continue;
    if (isZoneReclaim(cur, lv.price)) {
      return buildResult(cur, lv, 'ZONE_RECLAIM', cvdSession);
    }
  }
  return null;
}

function buildResult(cur: OHLCBar, lv: KeyLevel, scenario: Scenario, cvdSession: number): DetectedALA {
  const range = cur.high - cur.low;
  const body  = Math.abs(cur.close - cur.open);
  return {
    scenario, level: lv, bar: cur, range,
    bodyPct: range > 0 ? body / range : 0,
    closeInRange: range > 0 ? (cur.close - cur.low) / range : 0.5,
    breach: Math.max(0, lv.price - cur.low),
    cvdSession,
    barTs: cur.ts,
  };
}

function scenarioToRuleId(s: Scenario): string {
  if (s === 'BOUNCE')       return 'ala-bounce';
  if (s === 'RECLAIM')      return 'ala-reclaim';
  return 'ala-zone-reclaim';
}

function isCooling(symbol: Symbol, ruleId: string, nowMs: number): boolean {
  return nowMs - (_lastSignalMs.get(`${symbol}:${ruleId}`) ?? 0) < COOLDOWN_MS;
}

export async function runStrategyALA(symbol: Symbol, nowMs: number): Promise<ConfluenceSignal | null> {
  if (symbol !== 'NQ') return null;
  if (!isWeekday(nowMs)) return null;
  if (!isTimeAllowed(nowMs)) return null;
  const levels = getLevels(nowMs);
  if (!levels.length) return null;

  // Load bars from today's RTH open onward (so CVD is accurate). Falls back to
  // 5-min lookback if RTH open is in the future (paranoia guard).
  const rthOpenTs = Date.parse(`${etDateFor(nowMs)}T09:30:00-04:00`);
  const sinceMs = Math.min(rthOpenTs, nowMs - 5 * MIN_1);
  const bars = buildBars(symbol, sinceMs);

  const hit = detect(bars, levels, nowMs);
  if (!hit) return null;

  const ruleId = scenarioToRuleId(hit.scenario);
  if (isCooling(symbol, ruleId, nowMs)) return null;
  _lastSignalMs.set(`${symbol}:${ruleId}`, nowMs);

  const entry    = hit.bar.close;
  const stop     = hit.bar.low - STOP_BUFFER;
  const stopDist = entry - stop;
  const target   = entry + TARGET_PTS;

  const rationale =
    `${hit.scenario} at ${hit.level.source}=${hit.level.price.toFixed(2)}. ` +
    `bar=${hit.bar.open.toFixed(2)}/${hit.bar.high.toFixed(2)}/${hit.bar.low.toFixed(2)}/${hit.bar.close.toFixed(2)} ` +
    `range=${hit.range.toFixed(1)} body=${(hit.bodyPct * 100).toFixed(0)}% ` +
    `closeR=${(hit.closeInRange * 100).toFixed(0)}% breach=${hit.breach.toFixed(1)} ` +
    `cvdSession=${hit.cvdSession} delta=${hit.bar.delta} vol=${hit.bar.vol}. ` +
    `LONG entry=${entry} stop=${stop.toFixed(2)} (${stopDist.toFixed(2)}pt risk) target=${target}.`;

  logger.info({
    symbol, direction: 'long', ruleId,
    scenario: hit.scenario,
    levelSource: hit.level.source, levelPrice: hit.level.price,
    entry, stop, target, stopDist,
    range: hit.range, bodyPct: hit.bodyPct, closeInRange: hit.closeInRange,
    breach: hit.breach, delta: hit.bar.delta, vol: hit.bar.vol,
    cvdSession: hit.cvdSession,
  }, `strategy-ALA: ${hit.scenario} signal fired`);

  return {
    ts: hit.barTs,
    source: 'rules-v2',
    type: 'confluence',
    symbol,
    ruleId,
    score: 80,
    direction: 'long',
    rationale,
    strategyVersion: 'ALA' as any,
    ruleVersion: 'ala-v3',
    scenario: hit.scenario,
    entry,
    stopLevel: stop,
    stopDist,
    levelSource: hit.level.source,
    levelPrice: hit.level.price,
    range: hit.range,
    bodyPct: hit.bodyPct,
    closeInRange: hit.closeInRange,
    breach: hit.breach,
    cvdSession: hit.cvdSession,
    delta: hit.bar.delta,
    vol: hit.bar.vol,
  } as any;
}
