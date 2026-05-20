// Strategy CONT — Trend Continuation Re-Entry
//
// Fires when a confirmed FLIP/EXPL/absorption signal established a trend
// direction within the last 90 min, price extended ≥ 40pts in that direction,
// then pulled back 20–55% of that run while delta is re-aligning.
//
// This catches the "second leg" of trending days that the initial FLIP/EXPL
// fires miss — the continuation moves that run 80–400pts on strong trend days.
//
// Detection per bar close:
//   1. Find most recent gold trigger (H/EXPL/B≥80) for same symbol+direction
//      within last 90 min.
//   2. Build 1-min bars from that trigger's ts → now.
//   3. Compute max favorable extension (peak gain from trigger entry).
//   4. Require extension ≥ MIN_EXTENSION pts (trend confirmed).
//   5. Compute retrace % = (peak_gain − current_gain) / peak_gain.
//   6. Require retrace in [RETRACE_MIN, RETRACE_MAX] (partial pullback, not collapse).
//   7. Require delta re-alignment: cumulative 15-min delta ≥ DELTA_REALIGN in direction.
//   8. Require current bar delta ≥ DELTA_BAR_MIN in direction (buyers/sellers returning now).
//
// Scoring:
//   Base 70. +10 if delta realignment is strong (|delta15|>1500). +10 if retrace
//   is in the ideal shallow zone (20–35%). +10 if parent signal was H or EXPL.
//
// Cooldown: 30 min per symbol+direction.
// RTH only.

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db.js';
import { logger } from '../logger.js';
import type { Symbol, ConfluenceSignal } from '@trading/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TICKS_DB_PATH = path.resolve(__dirname, '../../../../data/ticks.db');

const MIN_1          = 60_000;
const COOLDOWN_MS    = 30 * MIN_1;
const PARENT_WINDOW  = 90 * MIN_1;   // look back 90 min for parent signal
const STALE_MS       =  2 * MIN_1;   // bar must have closed within last 2 min

const MIN_EXTENSION   = 60;    // parent trend must have run ≥ 60pts (calibrated: <60pt extensions all fail)
const RETRACE_MIN     = 0.25;  // minimum pullback (25%) — calibrated: 20-24% retraces all fail (too shallow = still trending, entry chases)
const RETRACE_MAX     = 0.48;  // maximum pullback (48%) — calibrated: 50%+ retraces all fail (busted structure)
const DELTA_REALIGN   = 600;   // |delta15| in direction of move
const DELTA_BAR_MIN   = 100;   // current bar delta in direction (buyers/sellers active NOW)
const OPEN_GATE_MIN   = 600;   // no CONT before 10:00 ET — opening range instability (3/3 fail rate)

interface OHLCBar {
  ts: number;
  open: number; high: number; low: number; close: number;
  vol: number; delta: number;
}

function buildBars(sinceMs: number): OHLCBar[] {
  const ticksDb = new Database(TICKS_DB_PATH, { readonly: true });
  try {
    const trades = ticksDb.prepare(`
      SELECT ts, price, size, is_bid_aggressor
      FROM trades
      WHERE symbol = 'NQ' AND ts >= ?
      ORDER BY ts ASC
    `).all(sinceMs) as { ts: number; price: number; size: number; is_bid_aggressor: number }[];

    const buckets = new Map<number, {
      open: number; close: number; high: number; low: number;
      bidVol: number; askVol: number;
    }>();

    for (const t of trades) {
      const bucket = Math.floor(t.ts / MIN_1) * MIN_1;
      const bar = buckets.get(bucket);
      if (!bar) {
        buckets.set(bucket, {
          open: t.price, close: t.price, high: t.price, low: t.price,
          bidVol: t.is_bid_aggressor === 1 ? t.size : 0,
          askVol: t.is_bid_aggressor === 0 ? t.size : 0,
        });
      } else {
        bar.high  = Math.max(bar.high, t.price);
        bar.low   = Math.min(bar.low,  t.price);
        bar.close = t.price;
        if (t.is_bid_aggressor === 1) bar.bidVol += t.size;
        else                          bar.askVol += t.size;
      }
    }

    return Array.from(buckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([ts, bar]) => ({
        ts,
        open:  bar.open,
        high:  bar.high,
        low:   bar.low,
        close: bar.close,
        vol:   bar.bidVol + bar.askVol,
        delta: bar.askVol - bar.bidVol,  // positive = net buying (ask-lifted minus bid-hit)
      }));
  } finally {
    ticksDb.close();
  }
}

function isRTH(tsMs: number): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  const min = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday) &&
    min >= 570 && min < 960;
}

const _lastSignalMs    = new Map<string, number>();
// One CONT per parent signal — tracks the parent's ts so we don't fire again on same parent.
// Calibration: first re-entry wins; subsequent fires on same parent all fail.
const _lastParentTs    = new Map<string, number>();

function etMinute(tsMs: number): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  return parseInt(parts.find(p => p.type === 'hour')!.value, 10) * 60 +
         parseInt(parts.find(p => p.type === 'minute')!.value, 10);
}

export function seedCooldownFromDb(): void {
  const ts = db.lastSignalTsFor('cont-reentry', 'NQ', 'long');
  if (ts > 0) _lastSignalMs.set('NQ:long', ts);
  const ts2 = db.lastSignalTsFor('cont-reentry', 'NQ', 'short');
  if (ts2 > 0) _lastSignalMs.set('NQ:short', ts2);
}

function isCooling(symbol: Symbol, direction: string, nowMs: number): boolean {
  return nowMs - (_lastSignalMs.get(`${symbol}:${direction}`) ?? 0) < COOLDOWN_MS;
}

function isSameParentUsed(symbol: Symbol, direction: string, parentTs: number): boolean {
  return _lastParentTs.get(`${symbol}:${direction}`) === parentTs;
}

interface ContHit {
  direction: 'long' | 'short';
  score: number;
  entry: number;
  parentEntry: number;
  parentTs: number;
  extensionPts: number;
  retracePct: number;
  delta15: number;
  deltaBar: number;
  barTs: number;
}

function detect(
  symbol: Symbol,
  nowMs: number,
): ContHit | null {
  // Opening gate: no CONT before 10:00 ET — opening range creates false re-entry setups.
  if (etMinute(nowMs) < OPEN_GATE_MIN) return null;

  for (const direction of ['long', 'short'] as const) {
    const parent = db.recentGoldTriggerFor(symbol, direction, PARENT_WINDOW, nowMs);
    if (!parent) continue;

    // One CONT per parent signal — calibration: first re-entry wins; subsequent fires fail.
    if (isSameParentUsed(symbol, direction, parent.ts)) continue;

    // Fetch bars from just before parent signal → now
    const bars = buildBars(parent.ts - MIN_1);
    const completed = bars.slice(0, -1);  // exclude forming bar
    if (completed.length < 5) continue;

    const cur = completed[completed.length - 1];
    if (!cur) continue;

    // Staleness guard: bar must have closed within last 2 min
    if (nowMs - (cur.ts + MIN_1) > STALE_MS) continue;

    // Only use bars AFTER the parent signal (bars at or after parent.ts)
    const postParent = completed.filter(b => b.ts >= Math.floor(parent.ts / MIN_1) * MIN_1);
    if (postParent.length < 3) continue;

    const isLong = direction === 'long';

    // Max favorable extension from parent entry
    const peakGain = isLong
      ? Math.max(...postParent.map(b => b.high)) - parent.entry
      : parent.entry - Math.min(...postParent.map(b => b.low));

    if (peakGain < MIN_EXTENSION) continue;

    // Current gain from parent entry
    const currentGain = isLong
      ? cur.close - parent.entry
      : parent.entry - cur.close;

    if (currentGain <= 0) continue;  // already below parent entry = busted

    // Retrace percentage
    const retracePct = (peakGain - currentGain) / peakGain;
    if (retracePct < RETRACE_MIN || retracePct > RETRACE_MAX) continue;

    // Delta windows (last 15 bars)
    const last15 = completed.slice(-15);
    const delta15 = last15.reduce((s, b) => s + b.delta, 0);
    const deltaBar = cur.delta;

    // Delta must re-align in direction of the trend
    const deltaOk = isLong
      ? delta15 >= DELTA_REALIGN && deltaBar >= DELTA_BAR_MIN
      : delta15 <= -DELTA_REALIGN && deltaBar <= -DELTA_BAR_MIN;

    if (!deltaOk) continue;

    // Score
    let score = 70;
    const absDelta15 = Math.abs(delta15);
    if (absDelta15 > 1500) score += 10;
    else if (absDelta15 > 1000) score += 5;
    if (retracePct >= RETRACE_MIN && retracePct <= 0.35) score += 10;  // ideal shallow zone
    // Bonus if parent was H or EXPL (higher-conviction setup)
    const parentIsHighConv = db.recentGoldTriggerFor(symbol, direction, PARENT_WINDOW, nowMs) !== null;
    if (parentIsHighConv) score += 5;
    score = Math.min(100, score);

    return {
      direction,
      score,
      entry: cur.close,
      parentEntry: parent.entry,
      parentTs: parent.ts,
      extensionPts: peakGain,
      retracePct,
      delta15,
      deltaBar,
      barTs: cur.ts,
    };
  }

  return null;
}

export async function runStrategyCONT(
  symbol: Symbol,
  nowMs: number,
): Promise<ConfluenceSignal | null> {
  if (!isRTH(nowMs)) return null;

  const hit = detect(symbol, nowMs);
  if (!hit) return null;

  if (isCooling(symbol, hit.direction, nowMs)) return null;

  _lastSignalMs.set(`${symbol}:${hit.direction}`, nowMs);
  _lastParentTs.set(`${symbol}:${hit.direction}`, hit.parentTs);

  const isLong = hit.direction === 'long';
  const stopDist = 25;  // fixed stop distance for re-entry
  const stop = isLong ? hit.entry - stopDist : hit.entry + stopDist;

  const parentAgoMin = Math.round((nowMs - hit.parentTs) / MIN_1);
  const fmt = (n: number) => (n > 0 ? '+' : '') + n.toFixed(0);

  const rationale =
    `CONT ${hit.direction.toUpperCase()}: ${hit.extensionPts.toFixed(1)}pt extension from ${hit.parentEntry} ` +
    `retraced ${(hit.retracePct * 100).toFixed(0)}% — delta15=${fmt(hit.delta15)} bar=${fmt(hit.deltaBar)} ` +
    `parent ${parentAgoMin}m ago. Entry=${hit.entry} Stop=${stop}.`;

  logger.info({
    symbol, direction: hit.direction,
    score: hit.score, entry: hit.entry, stop,
    parentEntry: hit.parentEntry, parentAgoMin,
    extensionPts: hit.extensionPts,
    retracePct: hit.retracePct.toFixed(2),
    delta15: hit.delta15, deltaBar: hit.deltaBar,
  }, 'strategy-CONT: signal fired');

  return {
    ts: hit.barTs,
    source: 'rules-v2',
    type: 'confluence',
    symbol,
    ruleId: 'cont-reentry',
    score: hit.score,
    direction: hit.direction,
    rationale,
    strategyVersion: 'CONT' as any,
    ruleVersion: 'cont-v1',
    entry: hit.entry,
    stopLevel: stop,
    stopDist,
    parentEntry: hit.parentEntry,
    parentTs: hit.parentTs,
    extensionPts: hit.extensionPts,
    retracePct: hit.retracePct,
    delta15: hit.delta15,
    deltaBar: hit.deltaBar,
  } as any;
}
