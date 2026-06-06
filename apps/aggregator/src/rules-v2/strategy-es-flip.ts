// Strategy ES-FLIP — ES-specific exhaustion reversal detector
//
// Distinct from strategy-h (NQ-tuned). Thresholds derived from labelled-swing
// analysis on 8 training days (2026-05-12 → 2026-05-21) and validated on 8
// holdout days (2026-05-22 → 2026-06-03). See /tmp/es_flip_derive.ts for the
// derivation pipeline and project memory for full analysis.
//
// LONG FLIP (K=4 of 5 features must pass):
//   minOfDay ≤ 250    (before 13:40 ET — morning bias)
//   range ≥ 3.3 pt
//   delta15 ≤ -1087   (sustained 15-min selling pressure)
//   volume ≥ 2,763
//   netMove15 ≤ -1.8 pt
//
// SHORT FLIP (K=5 of 5 — strict AND; SHORT degrades fast with looser K):
//   range30 ≥ 16.8    (volatile regime required)
//   range ≥ 3.3 pt
//   minOfDay ≤ 265    (before 13:55 ET)
//   volume ≥ 2,512
//   netMove5 ≥ 3.3 pt (recent push up to fade)
//
// SWING-CONFIRMATION GATE: only fires when the candidate bar is the local
// extremum within ±5 bars. Entry executes at confirmation-bar close (5-min lag).
//
// Per validation:
//   LONG K=4: ~7.2 sig/day, 60.7% WR, +2.9 EV/sig at TP=20/SL=20
//   SHORT K=5: ~1.5 sig/day, 50.0% WR, +2.7 EV/sig at TP=20/SL=20
//
// SHADOW mode: V3 logs decisions but does NOT auto-trade (forceShadowRules).

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../logger.js';
import type { Symbol, ConfluenceSignal } from '@trading/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TICKS_DB_PATH = path.resolve(__dirname, '../../../../data/ticks.db');

const MIN_1 = 60_000;
const MACRO_N = 30;
const CONFIRM_WINDOW = 5;       // bars on each side for local-extremum confirmation
const COOLDOWN_MS = 15 * 60 * 1000;
const STALE_MS = 2 * MIN_1;

// ── ES-derived feature thresholds (from training-set strong_p25) ─────────────
interface FeatureRule { feature: string; direction: 'gt' | 'lt'; threshold: number; }

const LONG_RULE: FeatureRule[] = [
  { feature: 'minOfDay',  direction: 'lt', threshold: 250 },     // before 13:40 ET
  { feature: 'range',     direction: 'gt', threshold: 3.3 },
  { feature: 'delta15',   direction: 'lt', threshold: -1087 },
  { feature: 'volume',    direction: 'gt', threshold: 2763 },
  { feature: 'netMove15', direction: 'lt', threshold: -1.8 },
];
const LONG_K = 4;

const SHORT_RULE: FeatureRule[] = [
  { feature: 'range30',   direction: 'gt', threshold: 16.8 },
  { feature: 'range',     direction: 'gt', threshold: 3.3 },
  { feature: 'minOfDay',  direction: 'lt', threshold: 265 },     // before 13:55 ET
  { feature: 'volume',    direction: 'gt', threshold: 2512 },
  { feature: 'netMove5',  direction: 'gt', threshold: 3.3 },
];
const SHORT_K = 5;

// ── Per-symbol cooldown (direction-aware) ────────────────────────────────────
const _lastSignalMs = new Map<string, number>();
const cooldownKey = (sym: Symbol, dir: 'long' | 'short') => `${sym}:${dir}`;
function isCooling(symbol: Symbol, dir: 'long' | 'short', nowMs: number): boolean {
  const last = _lastSignalMs.get(cooldownKey(symbol, dir)) ?? 0;
  return (nowMs - last) < COOLDOWN_MS;
}

interface OHLCBar {
  ts: number; open: number; high: number; low: number; close: number;
  vol: number; delta: number;
}

interface Features {
  body: number; range: number; volume: number; deltaT: number;
  delta3: number; delta5: number; delta15: number;
  netMove3: number; netMove5: number; netMove15: number;
  compPosLow: number; compPosHigh: number; range30: number;
  minOfDay: number;
}

interface DetectedSignal {
  direction: 'long' | 'short';
  score: number;
  passCount: number;
  entry: number;
  stopLevel: number;
  swingBarTs: number;
  confirmBarTs: number;
  features: Features;
}

function buildBars(symbol: Symbol, sinceMs: number): OHLCBar[] {
  const ticksDb = new Database(TICKS_DB_PATH, { readonly: true });
  try {
    const trades = ticksDb.prepare(
      `SELECT ts, price, size, is_bid_aggressor FROM trades WHERE symbol=? AND ts>=? ORDER BY ts ASC`
    ).all(symbol, sinceMs) as Array<{ ts: number; price: number; size: number; is_bid_aggressor: number }>;
    const buckets = new Map<number, { open: number; close: number; high: number; low: number; bidVol: number; askVol: number; }>();
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
        bar.high = Math.max(bar.high, t.price);
        bar.low = Math.min(bar.low, t.price);
        bar.close = t.price;
        if (t.is_bid_aggressor === 1) bar.bidVol += t.size;
        else bar.askVol += t.size;
      }
    }
    return Array.from(buckets.entries()).sort(([a], [b]) => a - b)
      .map(([ts, b]) => ({
        ts, open: b.open, high: b.high, low: b.low, close: b.close,
        vol: b.bidVol + b.askVol, delta: b.bidVol - b.askVol,
      }));
  } finally { ticksDb.close(); }
}

function etMinOfDay(ms: number): number {
  // ET offset: handles EST/EDT
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(new Date(ms));
  const hr = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
  let off = hr - new Date(ms).getUTCHours();
  if (off > 12) off -= 24; if (off < -12) off += 24;
  const et = new Date(ms + off * 3600_000);
  const m = et.getUTCHours() * 60 + et.getUTCMinutes();
  return m - 570;  // minutes since 09:30 ET (RTH open)
}

function isRTH(ms: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(new Date(ms));
  const hr = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
  let off = hr - new Date(ms).getUTCHours();
  if (off > 12) off -= 24; if (off < -12) off += 24;
  const et = new Date(ms + off * 3600_000);
  const dow = et.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const m = et.getUTCHours() * 60 + et.getUTCMinutes();
  return m >= 570 && m < 960;
}

function extractFeatures(bars: OHLCBar[], idx: number): Features | null {
  if (idx < MACRO_N) return null;
  const bar = bars[idx];
  if (!bar) return null;
  const macro = bars.slice(idx - MACRO_N, idx);
  const macroHigh = Math.max(...macro.map(b => b.high));
  const macroLow = Math.min(...macro.map(b => b.low));
  const macroRange = macroHigh - macroLow;

  const last3 = bars.slice(idx - 3, idx);
  const last5 = bars.slice(idx - 5, idx);
  const last15 = bars.slice(idx - 15, idx);

  return {
    body: bar.close - bar.open,
    range: bar.high - bar.low,
    volume: bar.vol,
    deltaT: bar.delta,
    delta3: last3.reduce((s, b) => s + b.delta, 0),
    delta5: last5.reduce((s, b) => s + b.delta, 0),
    delta15: last15.reduce((s, b) => s + b.delta, 0),
    netMove3: last3.length > 0 ? bar.open - last3[0]!.open : 0,
    netMove5: last5.length > 0 ? bar.open - last5[0]!.open : 0,
    netMove15: last15.length > 0 ? bar.open - last15[0]!.open : 0,
    compPosLow: macroRange > 0 ? (bar.low - macroLow) / macroRange : 0.5,
    compPosHigh: macroRange > 0 ? (bar.high - macroLow) / macroRange : 0.5,
    range30: macroRange,
    minOfDay: etMinOfDay(bar.ts),
  };
}

function countPasses(feat: Features, rule: FeatureRule[]): number {
  let n = 0;
  for (const r of rule) {
    const v = (feat as any)[r.feature] as number;
    if (r.direction === 'gt' && v >= r.threshold) n++;
    else if (r.direction === 'lt' && v <= r.threshold) n++;
  }
  return n;
}

function detect(bars: OHLCBar[], idx: number): DetectedSignal | null {
  if (idx < MACRO_N) return null;
  if (idx + CONFIRM_WINDOW >= bars.length) return null;
  const bar = bars[idx];
  const confirmBar = bars[idx + CONFIRM_WINDOW];
  if (!bar || !confirmBar) return null;
  if (!isRTH(bar.ts)) return null;
  const feat = extractFeatures(bars, idx);
  if (!feat) return null;

  const window = bars.slice(idx - CONFIRM_WINDOW, idx + CONFIRM_WINDOW + 1);
  const longPasses = countPasses(feat, LONG_RULE);
  const shortPasses = countPasses(feat, SHORT_RULE);

  if (longPasses >= LONG_K) {
    const minLow = Math.min(...window.map(b => b.low));
    if (bar.low === minLow) {
      const score = 75 + longPasses * 5;
      return {
        direction: 'long', score, passCount: longPasses,
        entry: confirmBar.close, stopLevel: bar.low,
        swingBarTs: bar.ts, confirmBarTs: confirmBar.ts,
        features: feat,
      };
    }
  }

  if (shortPasses >= SHORT_K) {
    const maxHigh = Math.max(...window.map(b => b.high));
    if (bar.high === maxHigh) {
      const score = 75 + shortPasses * 5;
      return {
        direction: 'short', score, passCount: shortPasses,
        entry: confirmBar.close, stopLevel: bar.high,
        swingBarTs: bar.ts, confirmBarTs: confirmBar.ts,
        features: feat,
      };
    }
  }
  return null;
}

/**
 * Main entry point — invoked at each bar close. Looks at the bar that was
 * CONFIRM_WINDOW (5) minutes ago — by now we have enough forward bars to
 * confirm whether it was a true swing extremum.
 */
export async function runStrategyEsFlip(symbol: Symbol, nowMs: number): Promise<ConfluenceSignal | null> {
  if (symbol !== 'ES') return null;          // ES-only
  if (!isRTH(nowMs)) return null;

  const sinceMs = nowMs - (MACRO_N + CONFIRM_WINDOW + 5) * MIN_1;
  const bars = buildBars(symbol, sinceMs);
  if (bars.length < MACRO_N + CONFIRM_WINDOW + 1) return null;

  // Evaluate the bar that's CONFIRM_WINDOW back from the most recent completed bar.
  // Most recent completed bar = bars[-1]. Candidate = bars[-1 - CONFIRM_WINDOW].
  const candidateIdx = bars.length - 1 - CONFIRM_WINDOW;
  if (candidateIdx < 0) return null;

  const hit = detect(bars, candidateIdx);
  if (!hit) return null;

  // Staleness: confirm-bar must be within last STALE_MS
  if (nowMs - hit.confirmBarTs > STALE_MS) return null;

  // Cooldown
  if (isCooling(symbol, hit.direction, nowMs)) return null;
  _lastSignalMs.set(cooldownKey(symbol, hit.direction), nowMs);

  const isLong = hit.direction === 'long';
  const stopDist = Math.abs(hit.entry - hit.stopLevel);
  const tpPts = 20;  // V3 config TP=20
  const slPts = 20;  // V3 config SL=20
  const targets = isLong
    ? `T1=${hit.entry + tpPts} (+${tpPts}) SL=${hit.entry - slPts} (-${slPts})`
    : `T1=${hit.entry - tpPts} (-${tpPts}) SL=${hit.entry + slPts} (+${slPts})`;
  const fmt = (n: number) => (n > 0 ? '+' : '') + Math.round(n);

  const rationale =
    `ES-FLIP ${hit.direction.toUpperCase()} K=${hit.passCount}/5: ` +
    `range=${hit.features.range.toFixed(1)}pt, delta15=${fmt(hit.features.delta15)}, ` +
    `netMove15=${fmt(hit.features.netMove15)}, vol=${Math.round(hit.features.volume)}, ` +
    `range30=${hit.features.range30.toFixed(0)}pt, minOfDay=${hit.features.minOfDay}. ` +
    `Entry=${hit.entry.toFixed(2)} (5-min lag from swing). Stop=${hit.stopLevel.toFixed(2)} ` +
    `(${stopDist.toFixed(1)}pt structural). ${targets}.`;

  logger.info({
    symbol, direction: hit.direction, passCount: hit.passCount,
    score: hit.score, entry: hit.entry, stop: hit.stopLevel, swingBarTs: hit.swingBarTs,
    confirmBarTs: hit.confirmBarTs,
  }, 'strategy-ES-FLIP: SHADOW signal fired');

  return {
    ts: hit.confirmBarTs,
    source: 'rules-v2',
    type: 'confluence',
    symbol,
    ruleId: 'es-flip',
    score: hit.score,
    direction: hit.direction,
    rationale,
    strategyVersion: 'ES-FLIP' as any,
    ruleVersion: 'es-flip-v1',
    pattern: 'FLIP',
    entry: hit.entry,
    stopLevel: hit.stopLevel,
    stopDist,
    swingBarTs: hit.swingBarTs,
    passCount: hit.passCount,
    delta15: hit.features.delta15,
    delta5: hit.features.delta5,
    range30: hit.features.range30,
    netMove15: hit.features.netMove15,
    netMove5: hit.features.netMove5,
  } as any;
}
