// Strategy E — Absorption Scalp (OBSERVE ONLY)
//
// Two variants running simultaneously:
//
// E-5m: 5-min Bull Bar Absorption (plots on 5m chart)
//   Bull bar (close > open) + delta NEGATIVE < -100
//   Sellers absorbed by buyers in uptrend
//   comp_pos 0.40-0.60, macro trend >15pts
//   Entry: bar close | Stop: -10pts | Target: +20pts
//   Backtest: 53% win rate, EV +6.5pts (n=17)
//
// E-15m: 15-min Bear Bar Absorption (plots on 15m chart)
//   Bear bar (close < open) + delta POSITIVE > +300
//   Buyers absorbed the selling in uptrend — counterintuitive but powerful
//   comp_pos 0.50-0.70, macro trend >30pts, dir_eff >0.35, vol_ratio <=3x
//   Entry: bar close | Stop: -20pts | Target: +40pts
//   Backtest: 50% win rate, EV +15pts, avg winner 114pts (n=8)
//
// *** OBSERVE ONLY — needs 50+ signals across varied market conditions ***

import { db } from '../db.js';
import { logger } from '../logger.js';
import type { Symbol, ConfluenceSignal } from '@trading/contracts';

const MIN_5  = 5  * 60 * 1000;
const MIN_15 = 15 * 60 * 1000;
const MACRO_N = 20;

const COOLDOWN_5M_MS  = 15 * 60 * 1000;
const COOLDOWN_15M_MS = 30 * 60 * 1000;

interface OHLCBar {
  ts: number;
  open: number; high: number; low: number; close: number;
  vol: number; delta: number;
}

const _last5m  = new Map<Symbol, number>();
const _last15m = new Map<Symbol, number>();

function buildBars(symbol: Symbol, intervalMs: number, sinceMs: number): OHLCBar[] {
  const rawBars = db.query<{ payload: string }>(`
    SELECT payload FROM events
    WHERE source = 'bookmap'
      AND type = 'bar'
      AND symbol = ?
      AND ts >= ?
    ORDER BY ts ASC
  `, [symbol, sinceMs]);

  const buckets = new Map<number, OHLCBar>();
  for (const row of rawBars) {
    try {
      const b = JSON.parse(row.payload) as OHLCBar;
      const bucket = Math.floor(b.ts / intervalMs) * intervalMs;
      if (!buckets.has(bucket)) {
        buckets.set(bucket, {
          ts: bucket, open: b.open, high: b.high,
          low: b.low, close: b.close,
          vol: b.vol ?? 0, delta: b.delta ?? 0,
        });
      } else {
        const agg = buckets.get(bucket)!;
        agg.high   = Math.max(agg.high, b.high);
        agg.low    = Math.min(agg.low,  b.low);
        agg.close  = b.close;
        agg.vol   += b.vol ?? 0;
        agg.delta += b.delta ?? 0;
      }
    } catch { /* skip malformed */ }
  }
  return Array.from(buckets.values()).sort((a, b) => a.ts - b.ts);
}

function getMacro(bars: OHLCBar[], n: number) {
  const macro = bars.slice(-(n + 1), -1);
  if (macro.length < n) return null;
  const macroHigh  = Math.max(...macro.map(b => b.high));
  const macroLow   = Math.min(...macro.map(b => b.low));
  const macroRange = macroHigh - macroLow;
  const macroMove  = macro[macro.length - 1].close - macro[0].close;
  const avgVol     = macro.reduce((s, b) => s + b.vol, 0) / macro.length;
  return { macroHigh, macroLow, macroRange, macroMove, avgVol };
}

// ── E-5m: Bull bar + negative delta ──────────────────────────────────────────
async function check5m(symbol: Symbol, nowMs: number): Promise<ConfluenceSignal | null> {
  if (nowMs - (_last5m.get(symbol) ?? 0) < COOLDOWN_5M_MS) return null;

  const bars = buildBars(symbol, MIN_5, nowMs - (MACRO_N + 3) * MIN_5);
  if (bars.length < MACRO_N + 2) return null;

  const completed = bars.slice(0, -1);
  const cur = completed[completed.length - 1];
  const m = getMacro(completed, MACRO_N);
  if (!m) return null;

  // Condition 1: Bull bar
  const body = cur.close - cur.open;
  if (body < 5.0) return null;

  // Condition 2: Delta negative (sellers absorbed)
  if (cur.delta >= -100) return null;

  // Condition 3: comp_pos 0.40-0.60
  const compPos = m.macroRange > 0 ? (cur.low - m.macroLow) / m.macroRange : 0.5;
  if (compPos < 0.40 || compPos > 0.60) return null;

  // Condition 4: Macro trend UP
  if (m.macroMove < 15.0) return null;

  // Stale bar check
  if (nowMs - cur.ts > MIN_5 * 2) return null;

  _last5m.set(symbol, nowMs);

  const entry = cur.close;
  const rationale =
    `ABSORPTION-SCALP-5m: Bull bar absorbed selling. ` +
    `Body=${body.toFixed(1)}pts, delta=${cur.delta} (sellers absorbed). ` +
    `comp_pos=${compPos.toFixed(2)}, macro=+${m.macroMove.toFixed(1)}pts. ` +
    `Entry=${entry} Stop=${entry-10} (-10pts) Target=${entry+20} (+20pts). ` +
    `[OBSERVE ONLY]`;

  logger.info({ symbol, entry, body, delta: cur.delta, compPos, macroMove: m.macroMove },
    'strategy-E 5m: SIGNAL');

  return {
    ts: cur.ts + MIN_5,
    source: 'rules-v2', type: 'confluence', symbol,
    ruleId: 'absorption-scalp',
    score: 100, direction: 'long',
    rationale,
    strategyVersion: 'E' as any,
    ruleVersion: 'absorption-scalp-5m',
    entry, stopLevel: entry - 10, target: entry + 20,
    compPos, observeOnly: true,
  } as any;
}

// ── E-15m: Bear bar + positive delta ─────────────────────────────────────────
async function check15m(symbol: Symbol, nowMs: number): Promise<ConfluenceSignal | null> {
  if (nowMs - (_last15m.get(symbol) ?? 0) < COOLDOWN_15M_MS) return null;

  const bars = buildBars(symbol, MIN_15, nowMs - (MACRO_N + 3) * MIN_15);
  if (bars.length < MACRO_N + 2) return null;

  const completed = bars.slice(0, -1);
  const cur = completed[completed.length - 1];
  const m = getMacro(completed, MACRO_N);
  if (!m) return null;

  // Condition 1: Bear bar
  const body = cur.open - cur.close;  // positive when bear
  if (body < 10.0) return null;

  // Condition 2: Delta positive > +300 (buyers absorbed selling)
  if (cur.delta <= 300) return null;

  // Condition 3: comp_pos 0.50-0.70
  const compPos = m.macroRange > 0 ? (cur.low - m.macroLow) / m.macroRange : 0.5;
  if (compPos < 0.50 || compPos > 0.70) return null;

  // Condition 4: Macro trend UP > 30pts
  if (m.macroMove < 30.0) return null;

  // Condition 5: Dir efficiency >= 0.35
  const dirEff = m.macroRange > 0 ? Math.abs(m.macroMove) / m.macroRange : 0;
  if (dirEff < 0.35) return null;

  // Condition 6: Vol ratio <= 3x (no news bars)
  const volRatio = m.avgVol > 0 ? cur.vol / m.avgVol : 1;
  if (volRatio > 3.0) return null;

  // Stale bar check
  if (nowMs - cur.ts > MIN_15 * 2) return null;

  _last15m.set(symbol, nowMs);

  const entry = cur.close;
  const rationale =
    `ABSORPTION-SCALP-15m: Bear bar absorbed by buyers. ` +
    `Body=${body.toFixed(1)}pts, delta=+${cur.delta} (buyers absorbed selling). ` +
    `comp_pos=${compPos.toFixed(2)}, dir_eff=${dirEff.toFixed(2)}, ` +
    `macro=+${m.macroMove.toFixed(1)}pts, vol=${volRatio.toFixed(1)}x. ` +
    `Entry=${entry} Stop=${entry-20} (-20pts) Target=${entry+40} (+40pts). ` +
    `[OBSERVE ONLY]`;

  logger.info({ symbol, entry, body, delta: cur.delta, compPos, dirEff,
    macroMove: m.macroMove, volRatio },
    'strategy-E 15m: SIGNAL');

  return {
    ts: cur.ts + MIN_15,
    source: 'rules-v2', type: 'confluence', symbol,
    ruleId: 'absorption-scalp-15m',
    score: 100, direction: 'long',
    rationale,
    strategyVersion: 'E' as any,
    ruleVersion: 'absorption-scalp-15m',
    entry, stopLevel: entry - 20, target: entry + 40,
    compPos, dirEff, observeOnly: true,
  } as any;
}

// ── Public API ────────────────────────────────────────────────────────────────
export async function runStrategyE(
  symbol: Symbol,
  nowMs: number
): Promise<ConfluenceSignal[]> {
  const results: ConfluenceSignal[] = [];

  const sig5m  = await check5m(symbol, nowMs);
  if (sig5m)  results.push(sig5m);

  const sig15m = await check15m(symbol, nowMs);
  if (sig15m) results.push(sig15m);

  return results;
}
