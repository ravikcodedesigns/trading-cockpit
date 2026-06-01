/**
 * entry_filter_test.ts — supervised filter test for clean 30/10 entries.
 *
 * Workflow:
 *   For each RTH minute m on each date:
 *     features(m)  ← computed from past data only (causal)
 *     label(m)     ← does a clean 30/10 LONG (or SHORT) move start at m+1 open?
 *                    (MFE ≥ 30 AND MAE ≤ 10 in next HORIZON_MS)
 *
 *   For each candidate filter rule, compute:
 *     triggers     = number of minutes where rule fires (LONG or SHORT)
 *     wins         = number of those that were true clean entries
 *     precision    = wins / triggers
 *
 *   We want HIGH precision (≥80%) even if recall is modest.
 *
 * Conventions:
 *   trades.is_bid_aggressor = 1 → BUY aggressor (price up)
 *   trades.is_bid_aggressor = 0 → SELL aggressor (price down)
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const HORIZON_MS = 10 * 60 * 1000;
const MFE_PTS    = Number(process.env.MFE_PTS ?? 40);
const MAE_PTS    = Number(process.env.MAE_PTS ?? 10);
const MIN_ET_MIN = Number(process.env.MIN_ET_MIN ?? 600);   // skip 9:30-10:00

const TRAIN_DATES = ['2026-05-05','2026-05-06','2026-05-08','2026-05-11','2026-05-12',
                     '2026-05-13','2026-05-14','2026-05-15','2026-05-18','2026-05-19'];
const TEST_DATES  = ['2026-05-20','2026-05-21','2026-05-22','2026-05-26','2026-05-27'];

const RTH_START_MIN = 9 * 60 + 35;
const RTH_END_MIN   = 15 * 60 + 55;

type Trade = { ts: number; price: number; size: number; isBidAgg: 0 | 1 };
type Bar = {
  minStartTs: number;
  open: number; high: number; low: number; close: number;
  vol: number; delta: number;
};

function etMinutesOfDay(tsMs: number): number {
  const d = new Date(tsMs - 4 * 60 * 60 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function loadTrades(db: Database.Database, date: string): Trade[] {
  const startTs = Date.parse(`${date}T08:00:00-04:00`);
  const endTs   = Date.parse(`${date}T16:30:00-04:00`);
  return db.prepare(
    `SELECT ts, price, size, is_bid_aggressor AS isBidAgg
     FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?
     ORDER BY ts ASC, id ASC`
  ).all(startTs, endTs) as Trade[];
}

function buildBars(trades: Trade[]): Bar[] {
  const bars: Bar[] = [];
  let cur: Bar | null = null;
  for (const t of trades) {
    const minStart = Math.floor(t.ts / 60000) * 60000;
    if (!cur || cur.minStartTs !== minStart) {
      if (cur) bars.push(cur);
      cur = { minStartTs: minStart, open: t.price, high: t.price, low: t.price, close: t.price, vol: 0, delta: 0 };
    }
    if (t.price > cur.high) cur.high = t.price;
    if (t.price < cur.low)  cur.low  = t.price;
    cur.close = t.price;
    cur.vol += t.size;
    cur.delta += (t.isBidAgg === 1 ? t.size : -t.size);
  }
  if (cur) bars.push(cur);
  return bars;
}

// ─── Features computed from past bars only (no lookahead) ────────────────────

type Feat = {
  // The current bar (just closed)
  range: number;
  body: number;
  bodyPct: number;
  delta: number;
  vol: number;
  bullish: boolean;
  // Wick analysis
  upperWick: number;    // high − max(open, close)
  lowerWick: number;    // min(open, close) − low
  closeInRangePct: number;  // (close − low) / range
  // Prior bars
  prev5Net: number;       // close[m] − open[m-4]
  prev5Delta: number;
  prev5Range: number;
  prev5ImpulseCount: number;
  // 15-min context
  prev15Net: number;      // last 15 bars net
  // Session context
  rthHi: number;
  rthLo: number;
  rthMid: number;
  // Distance current close is from session extremes
  distFromHi: number;
  distFromLo: number;
  // Did THIS bar's high touch/exceed session high (or low for short)?
  testedHi: boolean;
  testedLo: boolean;
  // Trailing 1-min volatility
  prev3MaxBar: number;
  // ET minute-of-day
  mod: number;
  // Day's range so far
  sessionRange: number;
};

function feat(bars: Bar[], bi: number, rthHi: number, rthLo: number): Feat | null {
  if (bi < 14) return null;
  const b = bars[bi];
  const range = b.high - b.low;
  const body = b.close - b.open;
  const bodyPct = range > 0 ? Math.abs(body) / range : 0;
  const upperWick = b.high - Math.max(b.open, b.close);
  const lowerWick = Math.min(b.open, b.close) - b.low;
  const closeInRangePct = range > 0 ? (b.close - b.low) / range : 0.5;
  const first5 = bars[bi - 4];
  const first15 = bars[bi - 14];
  let prev5Hi = -Infinity, prev5Lo = Infinity, prev5Delta = 0;
  let impulseCount = 0;
  let prev3MaxBar = 0;
  for (let k = bi - 4; k <= bi; k++) {
    const x = bars[k];
    if (x.high > prev5Hi) prev5Hi = x.high;
    if (x.low  < prev5Lo) prev5Lo = x.low;
    prev5Delta += x.delta;
    const r = x.high - x.low;
    const bod = Math.abs(x.close - x.open);
    if (r >= 5 && r > 0 && bod / r >= 0.5) impulseCount++;
    if (k >= bi - 2) prev3MaxBar = Math.max(prev3MaxBar, r);
  }
  return {
    range, body, bodyPct, delta: b.delta, vol: b.vol, bullish: body > 0,
    upperWick, lowerWick, closeInRangePct,
    prev5Net: b.close - first5.open,
    prev15Net: b.close - first15.open,
    prev5Delta, prev5Range: prev5Hi - prev5Lo, prev5ImpulseCount: impulseCount,
    rthHi, rthLo, rthMid: (rthHi + rthLo) / 2,
    distFromHi: rthHi - b.close,
    distFromLo: b.close - rthLo,
    testedHi: b.high >= rthHi - 0.25,
    testedLo: b.low  <= rthLo + 0.25,
    prev3MaxBar,
    mod: etMinutesOfDay(b.minStartTs),
    sessionRange: rthHi - rthLo,
  };
}

// ─── Label: clean 30/10 entry in next 10 min ─────────────────────────────────

function labelEntry(trades: Trade[], entryTs: number, entryPrice: number, dir: 'long' | 'short'): boolean {
  const endTs = entryTs + HORIZON_MS;
  // Binary search for first tick ts >= entryTs
  let lo = 0, hi = trades.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (trades[mid].ts < entryTs) lo = mid + 1;
    else hi = mid;
  }
  let mfe = 0, mae = 0;
  for (let i = lo; i < trades.length && trades[i].ts <= endTs; i++) {
    const px = trades[i].price;
    if (dir === 'long') {
      const g = px - entryPrice, d = entryPrice - px;
      if (g > mfe) mfe = g;
      if (d > mae) mae = d;
      if (mae > MAE_PTS) return false;  // already exceeded MAE → not clean
      if (mfe >= MFE_PTS) return true;  // hit target before MAE
    } else {
      const g = entryPrice - px, d = px - entryPrice;
      if (g > mfe) mfe = g;
      if (d > mae) mae = d;
      if (mae > MAE_PTS) return false;
      if (mfe >= MFE_PTS) return true;
    }
  }
  return false;
}

// ─── Candidate filter rules ──────────────────────────────────────────────────

type FilterFn = (f: Feat) => 'long' | 'short' | null;

const FILTERS: Record<string, FilterFn> = {
  // ─── New patterns based on observed clean-move structure ───
  // L1: Pullback long in an uptrending day
  //   - Day is uptrending: prev15 net > +10
  //   - prev5 was a small pullback: prev5 net between -8 and -1
  //   - Current bar reverses: bullish AND delta > 0
  //   - In upper half of session range
  'L1_pullbackLong': (f) => {
    if (f.prev15Net < 10) return null;
    if (f.prev5Net < -10 || f.prev5Net > -1) return null;
    if (!f.bullish || f.delta <= 0) return null;
    if (f.rthMid !== 0 && f.distFromHi > f.sessionRange / 2) return null;
    return 'long';
  },
  // S1: Pullback short in a downtrending day
  'S1_pullbackShort': (f) => {
    if (f.prev15Net > -10) return null;
    if (f.prev5Net > 10 || f.prev5Net < 1) return null;
    if (f.bullish || f.delta >= 0) return null;
    if (f.distFromLo > f.sessionRange / 2) return null;
    return 'short';
  },
  // S2: Failed test of session high — wick rejection + close in lower half
  'S2_failedHighTest': (f) => {
    if (!f.testedHi) return null;
    if (f.range < 4) return null;
    if (f.closeInRangePct > 0.40) return null;     // close in lower 40% of bar
    if (f.upperWick < 2) return null;
    return 'short';
  },
  // L2: Failed test of session low — wick rejection + close in upper half
  'L2_failedLowTest': (f) => {
    if (!f.testedLo) return null;
    if (f.range < 4) return null;
    if (f.closeInRangePct < 0.60) return null;     // close in upper 40% of bar
    if (f.lowerWick < 2) return null;
    return 'long';
  },
  // X1: Exhaustion short after big up push, at/near session high
  'X1_exhaustionShort': (f) => {
    if (f.prev5Net < 15) return null;
    if (f.prev5Delta < 1500) return null;
    if (f.distFromHi > 5) return null;
    if (f.closeInRangePct > 0.5) return null;       // bar can't close near top
    return 'short';
  },
  // X2: Exhaustion long after big down push, at/near session low
  'X2_exhaustionLong': (f) => {
    if (f.prev5Net > -15) return null;
    if (f.prev5Delta > -1500) return null;
    if (f.distFromLo > 5) return null;
    if (f.closeInRangePct < 0.5) return null;
    return 'long';
  },
  // CONT: Continuation after consolidation — tight prev5 range + breakout bar
  // STACK_L: classic pullback-to-trend LONG setup with multiple confirmations
  //   - Time 10:30-12:00 or 13:30-14:30 ET (best mean-reversion windows)
  //   - prev15Net > +15 (clear uptrend established)
  //   - prev5Net negative (pullback happened)
  //   - Current bar bullish reversal (body > 0, close in upper 2/3 of range)
  //   - Strong positive delta confirming buyers stepping in
  //   - In upper half of session range
  'STACK_pullbackLong': (f) => {
    const goodTime = (f.mod >= 630 && f.mod <= 720) || (f.mod >= 810 && f.mod <= 870);
    if (!goodTime) return null;
    if (f.prev15Net < 15) return null;
    if (f.prev5Net > -2) return null;
    if (!f.bullish || f.closeInRangePct < 0.60) return null;
    const dPct = f.vol > 0 ? Math.abs(f.delta) / f.vol : 0;
    if (f.delta <= 0 || dPct < 0.10) return null;
    if (f.distFromHi > f.sessionRange * 0.5) return null;
    return 'long';
  },
  // STACK_S: classic pullback-to-trend SHORT setup with multiple confirmations
  'STACK_pullbackShort': (f) => {
    const goodTime = (f.mod >= 630 && f.mod <= 720) || (f.mod >= 810 && f.mod <= 870);
    if (!goodTime) return null;
    if (f.prev15Net > -15) return null;
    if (f.prev5Net < 2) return null;
    if (f.bullish || f.closeInRangePct > 0.40) return null;
    const dPct = f.vol > 0 ? Math.abs(f.delta) / f.vol : 0;
    if (f.delta >= 0 || dPct < 0.10) return null;
    if (f.distFromLo > f.sessionRange * 0.5) return null;
    return 'short';
  },
  // STACK2_L: rejection of session low + uptrend day (failed breakdown)
  'STACK2_failedBreakdown': (f) => {
    if (f.prev15Net < 0) return null;          // day is uptrending or flat-up
    if (f.distFromLo > 3) return null;          // tested near session low
    if (!f.testedLo) return null;
    if (f.range < 4) return null;
    if (f.closeInRangePct < 0.60) return null;  // close in upper part = rejection
    if (f.lowerWick < 1.5) return null;          // visible wick down
    if (f.delta <= 0) return null;
    return 'long';
  },
  // STACK2_S: rejection of session high + downtrend day (failed breakout)
  'STACK2_failedBreakout': (f) => {
    if (f.prev15Net > 0) return null;
    if (f.distFromHi > 3) return null;
    if (!f.testedHi) return null;
    if (f.range < 4) return null;
    if (f.closeInRangePct > 0.40) return null;
    if (f.upperWick < 1.5) return null;
    if (f.delta >= 0) return null;
    return 'short';
  },
  // Tightened H variants
  'H2_strict': (f) => {
    if (f.range < 6 || f.bodyPct < 0.65) return null;
    const dPct = f.vol > 0 ? Math.abs(f.delta) / f.vol : 0;
    if (dPct < 0.18) return null;
    if (f.bullish  && f.delta > 0 && f.distFromHi <= 1 && f.prev15Net >= 5)  return 'long';
    if (!f.bullish && f.delta < 0 && f.distFromLo <= 1 && f.prev15Net <= -5) return 'short';
    return null;
  },
  'H3_veryStrict': (f) => {
    if (f.range < 7 || f.bodyPct < 0.70) return null;
    const dPct = f.vol > 0 ? Math.abs(f.delta) / f.vol : 0;
    if (dPct < 0.20) return null;
    if (f.bullish  && f.delta > 0 && f.distFromHi <= 0.5 && f.prev15Net >= 10) return 'long';
    if (!f.bullish && f.delta < 0 && f.distFromLo <= 0.5 && f.prev15Net <= -10) return 'short';
    return null;
  },
  // Breakout w/ tight prev range (compression-expansion)
  'H4_compression': (f) => {
    if (f.range < 5 || f.bodyPct < 0.60) return null;
    if (f.prev5Range > 12) return null;          // recent compression
    const dPct = f.vol > 0 ? Math.abs(f.delta) / f.vol : 0;
    if (dPct < 0.15) return null;
    if (f.bullish  && f.delta > 0 && f.distFromHi <= 1)  return 'long';
    if (!f.bullish && f.delta < 0 && f.distFromLo <= 1) return 'short';
    return null;
  },
  // H + volume above 5-bar avg
  // CMPX: compression-expansion breakout
  //   - prev5Range tight (≤ 8pts)
  //   - current bar breaks out: range 5-12pt, body ≥ 60%
  //   - in trend direction (prev15 net agrees)
  //   - not lunch/end-of-day
  // WICK_S: aggressive short on visible top wick at session high
  'WICK_S_topReject': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (!f.testedHi) return null;
    if (f.upperWick < 2) return null;
    if (f.closeInRangePct > 0.40) return null;
    if (f.range < 4) return null;
    if (f.delta >= 0) return null;
    return 'short';
  },
  // WICK_L: mirror long
  'WICK_L_botReject': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (!f.testedLo) return null;
    if (f.lowerWick < 2) return null;
    if (f.closeInRangePct < 0.60) return null;
    if (f.range < 4) return null;
    if (f.delta <= 0) return null;
    return 'long';
  },
  // EXT2: extreme + body + delta with prev3MaxBar in normal range (no climax)
  'EXT2_filtered': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 6 || f.bodyPct < 0.65) return null;
    if (f.range > 15) return null;                     // skip climax bars
    if (f.prev3MaxBar > 18) return null;               // skip recent volatility extremes
    const dPct = f.vol > 0 ? Math.abs(f.delta) / f.vol : 0;
    if (dPct < 0.15) return null;
    if (f.bullish  && f.delta > 0 && f.distFromHi <= 1 && f.prev15Net >= 5)  return 'long';
    if (!f.bullish && f.delta < 0 && f.distFromLo <= 1 && f.prev15Net <= -5) return 'short';
    return null;
  },
  'CMPX_breakout': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.prev5Range > 8) return null;
    if (f.range < 5 || f.range > 12 || f.bodyPct < 0.60) return null;
    const dPct = f.vol > 0 ? Math.abs(f.delta) / f.vol : 0;
    if (dPct < 0.12) return null;
    if (f.bullish && f.delta > 0 && f.prev15Net >= 0)  return 'long';
    if (!f.bullish && f.delta < 0 && f.prev15Net <= 0) return 'short';
    return null;
  },
  // H8: H2 + size cap (avoid climactic bars) + lunch exclusion
  'H8_capRange': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 6 || f.range > 14 || f.bodyPct < 0.65) return null;
    const dPct = f.vol > 0 ? Math.abs(f.delta) / f.vol : 0;
    if (dPct < 0.18) return null;
    if (f.bullish  && f.delta > 0 && f.distFromHi <= 1 && f.prev15Net >= 5)  return 'long';
    if (!f.bullish && f.delta < 0 && f.distFromLo <= 1 && f.prev15Net <= -5) return 'short';
    return null;
  },
  // H2 + skip lunch (11:50-13:15 ET) + skip last 30 min (15:25+ ET)
  'H6_noLunch': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;   // skip lunch
    if (f.mod >= 15*60+25) return null;                          // skip last 30
    if (f.range < 6 || f.bodyPct < 0.65) return null;
    const dPct = f.vol > 0 ? Math.abs(f.delta) / f.vol : 0;
    if (dPct < 0.18) return null;
    if (f.bullish  && f.delta > 0 && f.distFromHi <= 1 && f.prev15Net >= 5)  return 'long';
    if (!f.bullish && f.delta < 0 && f.distFromLo <= 1 && f.prev15Net <= -5) return 'short';
    return null;
  },
  // Even stricter: H6 + body 70 + delta 22
  'H7_tight': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 6 || f.bodyPct < 0.70) return null;
    const dPct = f.vol > 0 ? Math.abs(f.delta) / f.vol : 0;
    if (dPct < 0.22) return null;
    if (f.bullish  && f.delta > 0 && f.distFromHi <= 1 && f.prev15Net >= 8)  return 'long';
    if (!f.bullish && f.delta < 0 && f.distFromLo <= 1 && f.prev15Net <= -8) return 'short';
    return null;
  },
  'H5_volBoost': (f) => {
    if (f.range < 5 || f.bodyPct < 0.60) return null;
    const dPct = f.vol > 0 ? Math.abs(f.delta) / f.vol : 0;
    if (dPct < 0.15) return null;
    if (f.vol < 3000) return null;                // require real volume
    if (f.bullish  && f.delta > 0 && f.distFromHi <= 1)  return 'long';
    if (!f.bullish && f.delta < 0 && f.distFromLo <= 1) return 'short';
    return null;
  },
  'CONT_breakout': (f) => {
    if (f.prev5Range > 8) return null;     // tight prior range
    if (f.range < 5 || f.bodyPct < 0.6) return null;
    const dPct = f.vol > 0 ? Math.abs(f.delta) / f.vol : 0;
    if (dPct < 0.12) return null;
    if (f.bullish && f.delta > 0 && f.prev15Net > 5)  return 'long';
    if (!f.bullish && f.delta < 0 && f.prev15Net < -5) return 'short';
    return null;
  },
  // F. B + body ≥ 70%
  'F_extremeBody70': (f) => {
    if (f.range < 5 || f.bodyPct < 0.70) return null;
    if (f.bullish  && f.distFromHi <= 1) return 'long';
    if (!f.bullish && f.distFromLo <= 1) return 'short';
    return null;
  },
  // G. B + bar extends ≥ 2pt beyond prior extreme (real sweep, not nick)
  'G_sweepExtreme': (f) => {
    if (f.range < 5 || f.bodyPct < 0.60) return null;
    if (f.bullish  && f.distFromHi <= 0.25 && f.range >= 4) return 'long';   // current close is the new high; range gives the breakout
    if (!f.bullish && f.distFromLo <= 0.25 && f.range >= 4) return 'short';
    return null;
  },
  // H. B + delta dominance >= 15% one-sided
  'H_extremeDelta15': (f) => {
    if (f.range < 5 || f.bodyPct < 0.60) return null;
    const dPct = f.vol > 0 ? Math.abs(f.delta) / f.vol : 0;
    if (dPct < 0.15) return null;
    if (f.bullish  && f.delta > 0 && f.distFromHi <= 1) return 'long';
    if (!f.bullish && f.delta < 0 && f.distFromLo <= 1) return 'short';
    return null;
  },
  // I. B + prev5 net same direction (trend continuation new high/low)
  'I_extremeTrend': (f) => {
    if (f.range < 5 || f.bodyPct < 0.60) return null;
    if (f.bullish  && f.distFromHi <= 1 && f.prev5Net >= 3)  return 'long';
    if (!f.bullish && f.distFromLo <= 1 && f.prev5Net <= -3) return 'short';
    return null;
  },
  // J. B + morning only (10:00-11:30 ET)
  'J_extremeMorning': (f) => {
    if (f.range < 5 || f.bodyPct < 0.60) return null;
    if (f.mod < 600 || f.mod > 690) return null;   // 10:00-11:30 ET
    if (f.bullish  && f.distFromHi <= 1) return 'long';
    if (!f.bullish && f.distFromLo <= 1) return 'short';
    return null;
  },
  // K. Combined: extreme + body 65% + prev5 trend + delta align
  'K_combined': (f) => {
    if (f.range < 5 || f.bodyPct < 0.65) return null;
    const dPct = f.vol > 0 ? Math.abs(f.delta) / f.vol : 0;
    if (dPct < 0.12) return null;
    if (f.bullish  && f.delta > 0 && f.distFromHi <= 1 && f.prev5Net >= 3)  return 'long';
    if (!f.bullish && f.delta < 0 && f.distFromLo <= 1 && f.prev5Net <= -3) return 'short';
    return null;
  },
  // A. Trend + impulse bar — enter in trend direction at close of impulse bar.
  'A_trendImpulse': (f) => {
    const isImpulse = f.range >= 5 && f.bodyPct >= 0.5;
    if (!isImpulse) return null;
    if (f.bullish && f.prev5Net >= 5)  return 'long';
    if (!f.bullish && f.prev5Net <= -5) return 'short';
    return null;
  },
  // B. New session extreme bar with strong body
  'B_newExtreme': (f) => {
    const isImpulse = f.range >= 5 && f.bodyPct >= 0.6;
    if (!isImpulse) return null;
    if (f.bullish && f.distFromHi <= 1)  return 'long';   // new RTH high
    if (!f.bullish && f.distFromLo <= 1) return 'short';  // new RTH low
    return null;
  },
  // C. Impulse + delta alignment + at session extreme
  'C_extremeWithDelta': (f) => {
    const isImpulse = f.range >= 6 && f.bodyPct >= 0.55;
    if (!isImpulse) return null;
    const deltaPct = f.vol > 0 ? Math.abs(f.delta) / f.vol : 0;
    if (deltaPct < 0.10) return null;
    if (f.bullish  && f.delta > 0 && f.distFromHi <= 2)  return 'long';
    if (!f.bullish && f.delta < 0 && f.distFromLo <= 2)  return 'short';
    return null;
  },
  // D. Continuation: 3+ impulse bars in last 5, then another impulse
  'D_continuation': (f) => {
    if (f.prev5ImpulseCount < 3) return null;
    if (f.range < 4 || f.bodyPct < 0.5) return null;
    if (f.bullish && f.prev5Net > 0 && f.prev5Delta > 0)  return 'long';
    if (!f.bullish && f.prev5Net < 0 && f.prev5Delta < 0) return 'short';
    return null;
  },
  // E. Strong directional bar at session extreme + heavy delta dominance
  'E_extremeStrong': (f) => {
    if (f.range < 8 || f.bodyPct < 0.65) return null;
    const deltaPct = f.vol > 0 ? Math.abs(f.delta) / f.vol : 0;
    if (deltaPct < 0.15) return null;
    if (f.bullish  && f.delta > 0 && f.distFromHi <= 3)  return 'long';
    if (!f.bullish && f.delta < 0 && f.distFromLo <= 3)  return 'short';
    return null;
  },
};

// ─── Main eval ──────────────────────────────────────────────────────────────

type Stats = { triggers: number; wins: number; longs: number; longWins: number; shorts: number; shortWins: number };

async function main() {
  const arg = process.argv[2];
  let dates = TRAIN_DATES;
  let mode = 'train';
  if (arg === 'test') { dates = TEST_DATES; mode = 'test'; }

  console.log(`Entry filter test — mode=${mode}`);
  const db = new Database(TICKS_DB, { readonly: true });
  db.pragma('journal_mode = WAL');

  const totals: Record<string, Stats> = {};
  for (const name of Object.keys(FILTERS)) totals[name] = { triggers:0, wins:0, longs:0, longWins:0, shorts:0, shortWins:0 };
  let totalMinutes = 0;
  let cleanLong = 0, cleanShort = 0;

  for (const date of dates) {
    const trades = loadTrades(db, date);
    const bars   = buildBars(trades);
    let rthHi = -Infinity, rthLo = Infinity;

    const RTH_OPEN_MIN = 9 * 60 + 30;
    for (let bi = 0; bi < bars.length - 1; bi++) {
      const b = bars[bi];
      const mod = etMinutesOfDay(b.minStartTs);
      if (mod < RTH_OPEN_MIN || mod > RTH_END_MIN) continue;
      if (b.high > rthHi) rthHi = b.high;
      if (b.low  < rthLo) rthLo = b.low;
      if (mod < MIN_ET_MIN) continue;

      const f = feat(bars, bi, rthHi, rthLo);
      if (!f) continue;
      totalMinutes++;

      const entryTs = b.minStartTs + 60_000;
      const entryPx = b.close;
      const isCleanLong  = labelEntry(trades, entryTs, entryPx, 'long');
      const isCleanShort = labelEntry(trades, entryTs, entryPx, 'short');
      if (isCleanLong)  cleanLong++;
      if (isCleanShort) cleanShort++;

      for (const [name, fn] of Object.entries(FILTERS)) {
        const dir = fn(f);
        if (!dir) continue;
        const s = totals[name];
        s.triggers++;
        const won = dir === 'long' ? isCleanLong : isCleanShort;
        if (dir === 'long') {
          s.longs++;
          if (won) { s.longWins++; s.wins++; }
        } else {
          s.shorts++;
          if (won) { s.shortWins++; s.wins++; }
        }
        // Per-trigger detail dump for focused filters
        const DUMP_FILTERS = new Set(['H2_strict','H5_volBoost','STACK_pullbackShort','L2_failedLowTest']);
        if (DUMP_FILTERS.has(name)) {
          console.log(`  [${name}] ${date} ${String(Math.floor(f.mod/60)).padStart(2,'0')}:${String(f.mod%60).padStart(2,'0')} ${dir} entry=${b.close.toFixed(2)}  range=${f.range.toFixed(1)} body=${(f.bodyPct*100).toFixed(0)} d/v=${(f.vol > 0 ? Math.abs(f.delta)/f.vol*100 : 0).toFixed(1)} delta=${f.delta} vol=${f.vol}  dFromHi=${f.distFromHi.toFixed(1)} dFromLo=${f.distFromLo.toFixed(1)} prev5=${f.prev5Net.toFixed(1)} prev15=${f.prev15Net.toFixed(1)}  ${won?'WIN':'lose'}`);
        }
      }
    }
  }
  db.close();

  console.log(`\nBaseline: ${totalMinutes} RTH minutes  cleanLong=${cleanLong}  cleanShort=${cleanShort}`);
  console.log(`Baseline P(cleanLong)  = ${(cleanLong /Math.max(totalMinutes,1)*100).toFixed(1)}%`);
  console.log(`Baseline P(cleanShort) = ${(cleanShort/Math.max(totalMinutes,1)*100).toFixed(1)}%`);
  console.log('\nFilter performance:');
  console.log('name                      trigs  wins  P%    | longs lWins lP%   | shorts sWins sP%');
  for (const [name, s] of Object.entries(totals)) {
    const p = s.triggers ? (s.wins / s.triggers) * 100 : 0;
    const lp = s.longs ? (s.longWins / s.longs) * 100 : 0;
    const sp = s.shorts ? (s.shortWins / s.shorts) * 100 : 0;
    console.log(
      `${name.padEnd(24)}  ${String(s.triggers).padStart(5)}  ${String(s.wins).padStart(4)}  ${p.toFixed(1).padStart(5)}% | ` +
      `${String(s.longs).padStart(5)} ${String(s.longWins).padStart(5)} ${lp.toFixed(1).padStart(5)}% | ` +
      `${String(s.shorts).padStart(5)} ${String(s.shortWins).padStart(5)} ${sp.toFixed(1).padStart(5)}%`
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); });
