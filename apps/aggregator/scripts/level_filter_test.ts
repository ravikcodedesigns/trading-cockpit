/**
 * level_filter_test.ts — entry filter test with structural-level confluence
 *
 * Builds a set of structural levels per date (all causally computable at any
 * given moment m, no lookahead), then tests whether requiring confluence with
 * those levels lifts the precision of our best mechanical filter.
 *
 * Levels:
 *   PDH / PDL    — previous RTH day's high / low
 *   PMH / PML    — today's premarket (04:00–09:30 ET) high / low
 *   WkH / WkL    — past 5 RTH sessions' high / low (rolling)
 *   ORH / ORL    — today's opening range (09:30–10:00 ET) high / low
 *   Round25/50   — every 25- and 50-point multiple within ±200pts of current
 *   Swing        — 5-bar fractal swings confirmed at bar k by bar k+5
 *
 * For each candidate trigger minute, compute:
 *   nearestLevelAbove (resistance) — closest level price > current
 *   nearestLevelBelow (support)    — closest level price < current
 *   typeAbove, typeBelow           — source of each
 *   atLevel(target, tol)           — boolean: any level within tol pts of price
 *
 * Then test:
 *   H_extremeDelta15 + "entry within X pts of any key level on direction side"
 *   variants with X = 1, 2, 3, and with subsets of level types
 *
 * Conventions:
 *   is_bid_aggressor=1 → BUY aggressor (verified empirically)
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const HORIZON_MS = 10 * 60 * 1000;
const MFE_PTS    = Number(process.env.MFE_PTS ?? 30);
const MAE_PTS    = Number(process.env.MAE_PTS ?? 10);
const MIN_ET_MIN = Number(process.env.MIN_ET_MIN ?? 600);   // 10:00 ET

const TRAIN_DATES = ['2026-05-05','2026-05-06','2026-05-08','2026-05-11','2026-05-12',
                     '2026-05-13','2026-05-14','2026-05-15','2026-05-18','2026-05-19'];
const TEST_DATES  = ['2026-05-20','2026-05-21','2026-05-22','2026-05-26','2026-05-27'];

const RTH_OPEN_MIN  = 9 * 60 + 30;
const RTH_CLOSE_MIN = 16 * 60;
const RTH_END_MIN   = 15 * 60 + 55;

type Trade = { ts: number; price: number; size: number; isBidAgg: 0|1 };
type Bar = {
  minStartTs: number;
  open: number; high: number; low: number; close: number;
  vol: number; delta: number;
};

type LevelSource =
  | 'PDH'|'PDL'|'PMH'|'PML'|'WkH'|'WkL'|'ORH'|'ORL'
  | 'Round25'|'Round50'
  | 'SwingH'|'SwingL'
  // Newly added batch (2026-05-27):
  | 'PDC'|'PDO'|'ONH'|'ONL'|'ONMid'|'VWAP'
  // Top-3 expansion batch:
  | 'PrevWkL'|'IBL'
  // RTH-anchor level for "failed breakdown of opening price" setups:
  | 'RTHOpen';
type Level = { price: number; source: LevelSource; formedTs?: number };

function etMinutesOfDay(tsMs: number): number {
  const d = new Date(tsMs - 4 * 60 * 60 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function loadTrades(db: Database.Database, date: string, fromHHMM: string, toHHMM: string): Trade[] {
  const startTs = Date.parse(`${date}T${fromHHMM}-04:00`);
  const endTs   = Date.parse(`${date}T${toHHMM}-04:00`);
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

// ─── Level computation ──────────────────────────────────────────────────────

function queryHighLow(db: Database.Database, date: string, fromHHMM: string, toHHMM: string): { hi: number; lo: number } | null {
  const startTs = Date.parse(`${date}T${fromHHMM}-04:00`);
  const endTs   = Date.parse(`${date}T${toHHMM}-04:00`);
  const row = db.prepare(
    `SELECT MAX(price) hi, MIN(price) lo FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?`
  ).get(startTs, endTs) as { hi: number; lo: number } | undefined;
  if (!row || row.hi == null || row.lo == null) return null;
  return row;
}

// First / last trade price in an ET window — used for PDO / PDC.
function queryOpenClose(db: Database.Database, date: string, fromHHMM: string, toHHMM: string): { open: number; close: number } | null {
  const startTs = Date.parse(`${date}T${fromHHMM}-04:00`);
  const endTs   = Date.parse(`${date}T${toHHMM}-04:00`);
  const o = db.prepare(
    `SELECT price FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ? ORDER BY ts ASC, id ASC LIMIT 1`
  ).get(startTs, endTs) as { price: number } | undefined;
  const c = db.prepare(
    `SELECT price FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT 1`
  ).get(startTs, endTs) as { price: number } | undefined;
  if (!o || !c) return null;
  return { open: o.price, close: c.price };
}

// Overnight session = previous RTH close (16:00 ET) → today's RTH open (09:30 ET).
function queryOvernight(db: Database.Database, prevDate: string, today: string): { hi: number; lo: number } | null {
  const startTs = Date.parse(`${prevDate}T16:00:00-04:00`);
  const endTs   = Date.parse(`${today}T09:30:00-04:00`);
  const row = db.prepare(
    `SELECT MAX(price) hi, MIN(price) lo FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?`
  ).get(startTs, endTs) as { hi: number; lo: number } | undefined;
  if (!row || row.hi == null || row.lo == null) return null;
  return row;
}

// Monday of the prior completed calendar week (used for PrevWkL).
function prevWeekMondayFor(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const dow = d.getUTCDay();                     // 0=Sun..6=Sat
  const daysToThisMon = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - daysToThisMon);  // this week's Monday
  d.setUTCDate(d.getUTCDate() - 7);              // previous Monday
  return d.toISOString().slice(0, 10);
}

// Returns Mon..Fri of the prior calendar week as YYYY-MM-DD.
function prevWeekDates(dateStr: string): string[] {
  const mon = new Date(`${prevWeekMondayFor(dateStr)}T12:00:00Z`);
  const out: string[] = [];
  for (let i = 0; i < 5; i++) {
    out.push(mon.toISOString().slice(0, 10));
    mon.setUTCDate(mon.getUTCDate() + 1);
  }
  return out;
}

function prevTradingDays(date: string, n: number): string[] {
  // Crude: step back by calendar days, skip Saturday & Sunday.
  // (Treats US holidays as trading days; acceptable since we'll just get
  //  zero trades on a holiday and ignore an empty result.)
  const out: string[] = [];
  const d = new Date(`${date}T12:00:00Z`);
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() - 1);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Static (date-level) levels — known at session open, don't change intraday.
function computeStaticLevels(db: Database.Database, date: string, refPrice: number): Level[] {
  const out: Level[] = [];
  const [prev1, prev2, prev3, prev4, prev5] = prevTradingDays(date, 5);
  // PDH / PDL — previous trading day RTH
  const pdRange = queryHighLow(db, prev1, '09:30', '16:00');
  if (pdRange) {
    out.push({ price: pdRange.hi, source: 'PDH' });
    out.push({ price: pdRange.lo, source: 'PDL' });
  }
  // PDO / PDC — previous day RTH open and close
  const pdOC = queryOpenClose(db, prev1, '09:30', '16:00');
  if (pdOC) {
    out.push({ price: pdOC.open,  source: 'PDO' });
    out.push({ price: pdOC.close, source: 'PDC' });
  }
  // PMH / PML — today's premarket
  const pmRange = queryHighLow(db, date, '04:00', '09:30');
  if (pmRange) {
    out.push({ price: pmRange.hi, source: 'PMH' });
    out.push({ price: pmRange.lo, source: 'PML' });
  }
  // ONH / ONL / ONMid — overnight session (prev RTH close → today's RTH open)
  const onRange = queryOvernight(db, prev1, date);
  if (onRange) {
    out.push({ price: onRange.hi, source: 'ONH' });
    out.push({ price: onRange.lo, source: 'ONL' });
    out.push({ price: (onRange.hi + onRange.lo) / 2, source: 'ONMid' });
  }
  // Weekly H/L — past 5 RTH sessions (rolling)
  let wkHi = -Infinity, wkLo = Infinity, anyWk = false;
  for (const d of [prev1, prev2, prev3, prev4, prev5]) {
    const r = queryHighLow(db, d, '09:30', '16:00');
    if (!r) continue;
    if (r.hi > wkHi) wkHi = r.hi;
    if (r.lo < wkLo) wkLo = r.lo;
    anyWk = true;
  }
  if (anyWk) {
    out.push({ price: wkHi, source: 'WkH' });
    out.push({ price: wkLo, source: 'WkL' });
  }
  // PrevWkL — prior completed calendar week's low (distinct from rolling WkL)
  let prevWkLo = Infinity, anyPrevWk = false;
  for (const d of prevWeekDates(date)) {
    const r = queryHighLow(db, d, '09:30', '16:00');
    if (!r) continue;
    if (r.lo < prevWkLo) prevWkLo = r.lo;
    anyPrevWk = true;
  }
  if (anyPrevWk) out.push({ price: prevWkLo, source: 'PrevWkL' });
  // RTHOpen — today's first 09:30 ET trade price (static for the rest of the
  // day; available from RTH open onwards).
  const rthOpenStart = Date.parse(`${date}T09:30:00-04:00`);
  const rthOpenEnd   = Date.parse(`${date}T16:00:00-04:00`);
  const rthO = db.prepare(
    `SELECT price FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ? ORDER BY ts ASC, id ASC LIMIT 1`
  ).get(rthOpenStart, rthOpenEnd) as { price: number } | undefined;
  if (rthO) out.push({ price: rthO.price, source: 'RTHOpen' });
  // Round numbers — every 25 and every 50 pts within ±200 of refPrice
  const floor25 = Math.floor(refPrice / 25) * 25;
  for (let k = -8; k <= 8; k++) {
    const px = floor25 + k * 25;
    if (px % 50 === 0) out.push({ price: px, source: 'Round50' });
    else               out.push({ price: px, source: 'Round25' });
  }
  return out;
}

// Opening range (30-min) AND Initial Balance (60-min) — only the windows that
// have already closed relative to `nowTs` are emitted.
//   ORH/ORL — 09:30–10:00 ET (available after 10:00)
//   IBL     — 09:30–10:30 ET (available after 10:30)
function computeIntradayLevels(bars: Bar[], nowTs: number): Level[] {
  const out: Level[] = [];
  let orHi = -Infinity, orLo = Infinity, orAny = false;
  let ibLo = Infinity, ibAny = false;
  for (const b of bars) {
    const mod = etMinutesOfDay(b.minStartTs);
    if (mod >= 9*60+30 && mod < 10*60) {
      if (b.high > orHi) orHi = b.high;
      if (b.low  < orLo) orLo = b.low;
      orAny = true;
    }
    if (mod >= 9*60+30 && mod < 10*60+30) {
      if (b.low < ibLo) ibLo = b.low;
      ibAny = true;
    }
  }
  if (orAny && etMinutesOfDay(nowTs) >= 10*60) {
    out.push({ price: orHi, source: 'ORH' });
    out.push({ price: orLo, source: 'ORL' });
  }
  if (ibAny && etMinutesOfDay(nowTs) >= 10*60 + 30) {
    out.push({ price: ibLo, source: 'IBL' });
  }
  return out;
}

// Dynamic swings — 5-bar fractals. A swing at index k is confirmed at index k+5.
// At time m (= index mi), we know all swings with k+5 ≤ mi.
function activeSwings(bars: Bar[], asOfBi: number): Level[] {
  const out: Level[] = [];
  for (let k = 5; k <= asOfBi - 5; k++) {
    const b = bars[k];
    let isSwingHi = true, isSwingLo = true;
    for (let j = k - 5; j <= k + 5; j++) {
      if (j === k) continue;
      if (bars[j].high >= b.high) isSwingHi = false;
      if (bars[j].low  <= b.low)  isSwingLo = false;
    }
    if (isSwingHi) out.push({ price: b.high, source: 'SwingH', formedTs: bars[k + 5].minStartTs });
    if (isSwingLo) out.push({ price: b.low,  source: 'SwingL', formedTs: bars[k + 5].minStartTs });
  }
  return out;
}

// ─── Features ───────────────────────────────────────────────────────────────

type Feat = {
  range: number; body: number; bodyPct: number; delta: number; vol: number; bullish: boolean;
  upperWick: number; lowerWick: number; closeInRangePct: number;
  prev5Net: number; prev5Delta: number; prev5Range: number; prev5ImpulseCount: number;
  prev15Net: number;
  rthHi: number; rthLo: number; rthMid: number; sessionRange: number;
  distFromHi: number; distFromLo: number;
  testedHi: boolean; testedLo: boolean;
  prev3MaxBar: number;
  mod: number;
  close: number;
  // Level proximity
  nearestAbove: Level | null;
  nearestBelow: Level | null;
  distAbove: number;
  distBelow: number;
  // Full level list for ad-hoc queries by filters
  levels: Level[];
  // Raw OHLC of the just-closed bar (used by sweep-style filters that need
  // explicit high/low rather than derived wick/body math).
  high: number;
  low:  number;
};

function feat(bars: Bar[], bi: number, rthHi: number, rthLo: number, levels: Level[]): Feat | null {
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
  let impulseCount = 0, prev3MaxBar = 0;
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
  // Nearest level above / below current close
  let nearestAbove: Level | null = null, distAbove = Infinity;
  let nearestBelow: Level | null = null, distBelow = Infinity;
  for (const lv of levels) {
    const d = lv.price - b.close;
    if (d > 0 && d < distAbove) { distAbove = d; nearestAbove = lv; }
    if (d < 0 && -d < distBelow) { distBelow = -d; nearestBelow = lv; }
  }
  return {
    range, body, bodyPct, delta: b.delta, vol: b.vol, bullish: body > 0,
    upperWick, lowerWick, closeInRangePct,
    prev5Net: b.close - first5.open, prev5Delta, prev5Range: prev5Hi - prev5Lo, prev5ImpulseCount: impulseCount,
    prev15Net: b.close - first15.open,
    rthHi, rthLo, rthMid: (rthHi + rthLo) / 2, sessionRange: rthHi - rthLo,
    distFromHi: rthHi - b.close, distFromLo: b.close - rthLo,
    testedHi: b.high >= rthHi - 0.25, testedLo: b.low <= rthLo + 0.25,
    prev3MaxBar, mod: etMinutesOfDay(b.minStartTs), close: b.close,
    nearestAbove, nearestBelow, distAbove, distBelow,
    levels,
    high: b.high, low: b.low,
  };
}

// ─── Labels ─────────────────────────────────────────────────────────────────

function labelEntry(trades: Trade[], entryTs: number, entryPrice: number, dir: 'long'|'short'): boolean {
  const endTs = entryTs + HORIZON_MS;
  let lo = 0, hi = trades.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (trades[mid].ts < entryTs) lo = mid + 1; else hi = mid; }
  for (let i = lo; i < trades.length && trades[i].ts <= endTs; i++) {
    const px = trades[i].price;
    if (dir === 'long') {
      const g = px - entryPrice, d = entryPrice - px;
      if (d > MAE_PTS) return false;
      if (g >= MFE_PTS) return true;
    } else {
      const g = entryPrice - px, d = px - entryPrice;
      if (d > MAE_PTS) return false;
      if (g >= MFE_PTS) return true;
    }
  }
  return false;
}

// ─── Filters ────────────────────────────────────────────────────────────────

type FilterFn = (f: Feat) => 'long' | 'short' | null;

// Base mechanical filter — H_extremeDelta15 unchanged
function isH(f: Feat): 'long' | 'short' | null {
  if (f.range < 5 || f.bodyPct < 0.60) return null;
  const dPct = f.vol > 0 ? Math.abs(f.delta) / f.vol : 0;
  if (dPct < 0.15) return null;
  if (f.bullish  && f.delta > 0 && f.distFromHi <= 1) return 'long';
  if (!f.bullish && f.delta < 0 && f.distFromLo <= 1) return 'short';
  return null;
}

// New base: pullback-to-level reaction. ANY bullish/bearish bar with decent
// body + delta — no session-extreme requirement. Confluence with a structural
// level (added separately) is what makes it tradeable.
function isPB(f: Feat): 'long' | 'short' | null {
  if (f.range < 4 || f.bodyPct < 0.55) return null;
  const dPct = f.vol > 0 ? Math.abs(f.delta) / f.vol : 0;
  if (dPct < 0.10) return null;
  if (f.bullish  && f.delta > 0) return 'long';
  if (!f.bullish && f.delta < 0) return 'short';
  return null;
}

// Helper: did the entry react FROM a level? For LONG: lower wick swept a level
// below current close (level was tested by the wick low and price closed
// above). For SHORT: upper wick swept a level above current close.
function wickSweptLevel(f: Feat, dir: 'long'|'short', levels: Level[], tol: number, sources?: Set<LevelSource>): Level | null {
  if (dir === 'long') {
    const wickLow = f.close - f.lowerWick;
    for (const lv of levels) {
      if (sources && !sources.has(lv.source)) continue;
      if (lv.price >= wickLow - tol && lv.price <= f.close) return lv;
    }
  } else {
    const wickHigh = f.close + f.upperWick;
    for (const lv of levels) {
      if (sources && !sources.has(lv.source)) continue;
      if (lv.price <= wickHigh + tol && lv.price >= f.close) return lv;
    }
  }
  return null;
}

// Helper: does a level exist within tol pts of the entry?
function nearAnyLevel(f: Feat, dir: 'long' | 'short', tol: number, sources?: Set<LevelSource>): { lv: Level; side: 'above'|'below' } | null {
  // For LONG breakout: we're breaking above a resistance level. The level
  // should be just BELOW entry (a level we just crossed) OR right at entry.
  // For SHORT breakout: mirror.
  const lvA = f.nearestAbove, lvB = f.nearestBelow;
  if (dir === 'long') {
    if (lvB && f.distBelow <= tol && (!sources || sources.has(lvB.source))) return { lv: lvB, side: 'below' };
    if (lvA && f.distAbove <= 0.5 && (!sources || sources.has(lvA.source))) return { lv: lvA, side: 'above' };
  } else {
    if (lvA && f.distAbove <= tol && (!sources || sources.has(lvA.source))) return { lv: lvA, side: 'above' };
    if (lvB && f.distBelow <= 0.5 && (!sources || sources.has(lvB.source))) return { lv: lvB, side: 'below' };
  }
  return null;
}

const KEY_SOURCES: Set<LevelSource>      = new Set(['PDH','PDL','PMH','PML','WkH','WkL','ORH','ORL','SwingH','SwingL','PrevWkL','IBL']);
const STRUCTURAL_SOURCES: Set<LevelSource>= new Set(['PDH','PDL','PMH','PML','WkH','WkL','PrevWkL','IBL']);
const ROUND_SOURCES: Set<LevelSource>     = new Set(['Round25','Round50']);

const FILTERS: Record<string, FilterFn> = {
  // Baseline reference
  'H_base': (f) => isH(f),
  'PB_base': (f) => isPB(f),

  // Pullback to level — wick sweep + rejection. The MOST canonical "trade at
  // a level" setup. For LONG: bar's lower wick swept a structural level and
  // close is back above. For SHORT: mirror.
  'PB_wickSweep_key':    (f) => {
    const d = isPB(f); if (!d) return null;
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    const sweep = wickSweptLevel(f, d, f.levels, 0.5, KEY_SOURCES);
    return sweep ? d : null;
  },
  'PB_wickSweep_struct': (f) => {
    const d = isPB(f); if (!d) return null;
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    const sweep = wickSweptLevel(f, d, f.levels, 0.5, STRUCTURAL_SOURCES);
    return sweep ? d : null;
  },
  'PB_wickSweep_swing':  (f) => {
    const d = isPB(f); if (!d) return null;
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    const sweep = wickSweptLevel(f, d, f.levels, 0.5, new Set(['Swing']));
    return sweep ? d : null;
  },
  'PB_wickSweep_round':  (f) => {
    const d = isPB(f); if (!d) return null;
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    const sweep = wickSweptLevel(f, d, f.levels, 0.5, ROUND_SOURCES);
    return sweep ? d : null;
  },
  // Stricter: PB + visible wick + decent body
  'PB_strict_key': (f) => {
    const d = isPB(f); if (!d) return null;
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (d === 'long'  && f.lowerWick < 1.5) return null;
    if (d === 'short' && f.upperWick < 1.5) return null;
    if (f.bodyPct < 0.40) return null;     // bar can have wick + body
    const sweep = wickSweptLevel(f, d, f.levels, 0.5, KEY_SOURCES);
    return sweep ? d : null;
  },
  // LOCKED — BSR_short_locked: broken-support-becomes-resistance, refined by
  // train data analysis (5 train + 1 test winner / 1 train loser when body
  // gate added):
  //   - day NOT in strong uptrend  (prev15Net < 25)
  //   - bearish bar, closeInRangePct ≤ 0.45 (close in lower half)
  //   - body ≥ 40% (real reversal bar, not a doji)
  //   - upperWick ≥ 1.0 pt
  //   - delta < 0 (sellers stepped in)
  //   - upper wick swept PDL / PML / ORL / WkL within 3 pts ABOVE close
  //   - lunch/late exclusions
  'BSR_short_locked': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 4) return null;
    if (f.bodyPct < 0.40) return null;
    if (f.closeInRangePct > 0.45) return null;
    if (f.upperWick < 1.0) return null;
    if (f.bullish) return null;
    if (f.delta >= 0) return null;
    if (f.prev15Net >= 25) return null;
    const formerLows = new Set<LevelSource>(['PDL','PML','ORL','WkL','ONL']);
    for (const lv of f.levels) {
      if (!formerLows.has(lv.source)) continue;
      const lvAbove = lv.price - f.close;
      if (lvAbove > 0 && lvAbove <= 3 && lv.price <= f.close + f.upperWick + 0.5) return 'short';
    }
    return null;
  },
  // Expanded — same gates as BSR_short_locked but the formerLows set adds the
  // top-3 new sources: PrevWkL (prior-week low), IBL (initial-balance low),
  // SwingL (5-bar fractal swing lows).
  'BSR_short_locked_v2': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 4) return null;
    if (f.bodyPct < 0.40) return null;
    if (f.closeInRangePct > 0.45) return null;
    if (f.upperWick < 1.0) return null;
    if (f.bullish) return null;
    if (f.delta >= 0) return null;
    if (f.prev15Net >= 25) return null;
    const formerLows = new Set<LevelSource>(['PDL','PML','ORL','WkL','ONL','PrevWkL','IBL','SwingL']);
    for (const lv of f.levels) {
      if (!formerLows.has(lv.source)) continue;
      const lvAbove = lv.price - f.close;
      if (lvAbove > 0 && lvAbove <= 3 && lv.price <= f.close + f.upperWick + 0.5) return 'short';
    }
    return null;
  },
  // ─── RR-style mirror filters for PDH, RTHOpen, PDC ───
  // Same shape gates as BSR_short_locked but inverted for LONG setups, and the
  // level must be just BELOW close (former resistance acting as support).
  // Specific level types only — no broad candidate set.

  // PDH_long_rr — failed breakdown of broken PDH (price retests PDH from above)
  'PDH_long_rr': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 4) return null;
    if (f.bodyPct < 0.40) return null;
    if (f.closeInRangePct < 0.55) return null;     // close in upper half
    if (f.lowerWick < 1.0) return null;
    if (!f.bullish) return null;
    if (f.delta <= 0) return null;
    if (f.prev15Net <= -25) return null;            // not in strong downtrend
    for (const lv of f.levels) {
      if (lv.source !== 'PDH') continue;
      const lvBelow = f.close - lv.price;
      if (lvBelow > 0 && lvBelow <= 3 && lv.price >= f.close - f.lowerWick - 0.5) return 'long';
    }
    return null;
  },
  // RTHOpen_long_rr — failed breakdown of today's RTH Open
  'RTHOpen_long_rr': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 4) return null;
    if (f.bodyPct < 0.40) return null;
    if (f.closeInRangePct < 0.55) return null;
    if (f.lowerWick < 1.0) return null;
    if (!f.bullish) return null;
    if (f.delta <= 0) return null;
    if (f.prev15Net <= -25) return null;
    for (const lv of f.levels) {
      if (lv.source !== 'RTHOpen') continue;
      const lvBelow = f.close - lv.price;
      if (lvBelow > 0 && lvBelow <= 3 && lv.price >= f.close - f.lowerWick - 0.5) return 'long';
    }
    return null;
  },
  // PDC_long_rr — failed breakdown of broken PDC (price retests PDC from above)
  'PDC_long_rr': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 4) return null;
    if (f.bodyPct < 0.40) return null;
    if (f.closeInRangePct < 0.55) return null;
    if (f.lowerWick < 1.0) return null;
    if (!f.bullish) return null;
    if (f.delta <= 0) return null;
    if (f.prev15Net <= -25) return null;
    for (const lv of f.levels) {
      if (lv.source !== 'PDC') continue;
      const lvBelow = f.close - lv.price;
      if (lvBelow > 0 && lvBelow <= 3 && lv.price >= f.close - f.lowerWick - 0.5) return 'long';
    }
    return null;
  },
  // PDC_short_rr — failed breakout of broken PDC (price retests PDC from below)
  'PDC_short_rr': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 4) return null;
    if (f.bodyPct < 0.40) return null;
    if (f.closeInRangePct > 0.45) return null;     // close in lower half
    if (f.upperWick < 1.0) return null;
    if (f.bullish) return null;
    if (f.delta >= 0) return null;
    if (f.prev15Net >= 25) return null;             // not in strong uptrend
    for (const lv of f.levels) {
      if (lv.source !== 'PDC') continue;
      const lvAbove = lv.price - f.close;
      if (lvAbove > 0 && lvAbove <= 3 && lv.price <= f.close + f.upperWick + 0.5) return 'short';
    }
    return null;
  },
  // ─── LR: Long Reclaim (failed breakdown of former-low) ───
  // Mechanic: a former-low level (PDL/PML/ORL/WkL/ONL) gets PIERCED DOWN by
  // the bar's low — looks like a breakdown, traps shorts — but the bar CLOSES
  // ABOVE the level. The reclaim signals failed breakdown → squeeze long.
  // Geometry:  bar.low < level  AND  bar.close > level.
  'LR_long_v1': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 4) return null;
    if (f.bodyPct < 0.40) return null;
    if (f.closeInRangePct < 0.55) return null;       // close in upper half
    if (f.lowerWick < 1.0) return null;               // visible sweep below
    if (!f.bullish) return null;
    if (f.delta <= 0) return null;
    const formerLows = new Set<LevelSource>(['PDL','PML','ORL','WkL','ONL']);
    for (const lv of f.levels) {
      if (!formerLows.has(lv.source)) continue;
      const sweepDist   = lv.price - f.low;            // how far below level the bar wicked
      const reclaimDist = f.close  - lv.price;         // how far above level we closed
      if (sweepDist   < 0.5) continue;
      if (reclaimDist < 0.5) continue;
      return 'long';
    }
    return null;
  },
  // v2: + trend gate — only in uptrending or neutral days (failed breakdowns
  //     work best when buy-side is dominant).
  'LR_long_v2_trendAgree': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 4) return null;
    if (f.bodyPct < 0.40) return null;
    if (f.closeInRangePct < 0.55) return null;
    if (f.lowerWick < 1.0) return null;
    if (!f.bullish) return null;
    if (f.delta <= 0) return null;
    if (f.prev15Net <= -10) return null;             // not in strong downtrend
    const formerLows = new Set<LevelSource>(['PDL','PML','ORL','WkL','ONL']);
    for (const lv of f.levels) {
      if (!formerLows.has(lv.source)) continue;
      const sweepDist   = lv.price - f.low;
      const reclaimDist = f.close  - lv.price;
      if (sweepDist   < 0.5) continue;
      if (reclaimDist < 0.5) continue;
      return 'long';
    }
    return null;
  },
  // v3: stricter — meaningful sweep (≥1pt) AND meaningful reclaim (≥1pt)
  'LR_long_v3_strict': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 5) return null;
    if (f.bodyPct < 0.45) return null;
    if (f.closeInRangePct < 0.60) return null;
    if (f.lowerWick < 2.0) return null;
    if (!f.bullish) return null;
    if (f.delta <= 0) return null;
    if (f.prev15Net <= -10) return null;
    const formerLows = new Set<LevelSource>(['PDL','PML','ORL','WkL','ONL']);
    for (const lv of f.levels) {
      if (!formerLows.has(lv.source)) continue;
      const sweepDist   = lv.price - f.low;
      const reclaimDist = f.close  - lv.price;
      if (sweepDist   < 1.0) continue;
      if (reclaimDist < 1.0) continue;
      return 'long';
    }
    return null;
  },
  // v4: PDL/PML only (the two proven RR sources)
  'LR_long_v4_pdlPmlOnly': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 4) return null;
    if (f.bodyPct < 0.40) return null;
    if (f.closeInRangePct < 0.55) return null;
    if (f.lowerWick < 1.0) return null;
    if (!f.bullish) return null;
    if (f.delta <= 0) return null;
    if (f.prev15Net <= -10) return null;
    const formerLows = new Set<LevelSource>(['PDL','PML']);
    for (const lv of f.levels) {
      if (!formerLows.has(lv.source)) continue;
      const sweepDist   = lv.price - f.low;
      const reclaimDist = f.close  - lv.price;
      if (sweepDist   < 0.5) continue;
      if (reclaimDist < 0.5) continue;
      return 'long';
    }
    return null;
  },
  // ─── SWP: Sweep-of-former-high then rejection (SHORT) ───
  // Mechanic: a former-high level (PDH/PMH/ORH/WkH/ONH) gets PIERCED by the
  // bar's high (stop sweep above the level), but the bar fails to hold above
  // and CLOSES BELOW the level. Mirror of RR — instead of price rejecting UP
  // off a former-low (RR), price rejects DOWN off a swept former-high.
  // Geometry:  level < bar.high  AND  level > close   AND  bar bearish.
  'SWP_short_v1': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 4) return null;
    if (f.bodyPct < 0.40) return null;
    if (f.closeInRangePct > 0.45) return null;
    if (f.bullish) return null;
    if (f.delta >= 0) return null;
    const formerHighs = new Set<LevelSource>(['PDH','PMH','ORH','WkH','ONH']);
    for (const lv of f.levels) {
      if (!formerHighs.has(lv.source)) continue;
      const sweepDist  = f.high  - lv.price;     // how far above level the bar wicked
      const rejectDist = lv.price - f.close;     // how far below level we closed
      if (sweepDist  < 0.5) continue;            // real sweep, not a tick
      if (rejectDist < 0.5) continue;            // real close below
      return 'short';
    }
    return null;
  },
  // v2: + trend gate (not in strong downtrend — sweeps work better when fading
  // upside extension, not adding to an already-extended down move).
  'SWP_short_v2': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 4) return null;
    if (f.bodyPct < 0.40) return null;
    if (f.closeInRangePct > 0.45) return null;
    if (f.bullish) return null;
    if (f.delta >= 0) return null;
    if (f.prev15Net <= -25) return null;
    const formerHighs = new Set<LevelSource>(['PDH','PMH','ORH','WkH','ONH']);
    for (const lv of f.levels) {
      if (!formerHighs.has(lv.source)) continue;
      const sweepDist  = f.high  - lv.price;
      const rejectDist = lv.price - f.close;
      if (sweepDist  < 0.5) continue;
      if (rejectDist < 0.5) continue;
      return 'short';
    }
    return null;
  },
  // v3: stricter — sweep ≥ 1pt AND rejectDist ≥ 1pt (genuine failure)
  'SWP_short_v3': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 5) return null;
    if (f.bodyPct < 0.45) return null;
    if (f.closeInRangePct > 0.40) return null;
    if (f.bullish) return null;
    if (f.delta >= 0) return null;
    if (f.prev15Net <= -25) return null;
    const formerHighs = new Set<LevelSource>(['PDH','PMH','ORH','WkH','ONH']);
    for (const lv of f.levels) {
      if (!formerHighs.has(lv.source)) continue;
      const sweepDist  = f.high  - lv.price;
      const rejectDist = lv.price - f.close;
      if (sweepDist  < 1.0) continue;
      if (rejectDist < 1.0) continue;
      return 'short';
    }
    return null;
  },
  // v5: Mild-trend only — fade-the-sweep works when day isn't already running
  //     in either direction (|prev15| < 25). Strong uptrend continues through
  //     the sweep; strong downtrend means the sweep is just a counter-bounce
  //     that may not have follow-through.
  'SWP_short_v5_mildOnly': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 4) return null;
    if (f.bodyPct < 0.45) return null;
    if (f.closeInRangePct > 0.40) return null;
    if (f.bullish) return null;
    if (f.delta >= 0) return null;
    if (Math.abs(f.prev15Net) >= 25) return null;     // mild trend only
    const formerHighs = new Set<LevelSource>(['PDH','PMH','ORH','WkH','ONH']);
    for (const lv of f.levels) {
      if (!formerHighs.has(lv.source)) continue;
      const sweepDist  = f.high  - lv.price;
      const rejectDist = lv.price - f.close;
      if (sweepDist  < 0.5) continue;
      if (rejectDist < 0.5) continue;
      return 'short';
    }
    return null;
  },
  // v6: mild-trend + stricter geometry (sweep ≥ 2pt, reject ≥ 2pt)
  'SWP_short_v6_mildStrict': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 5) return null;
    if (f.bodyPct < 0.50) return null;
    if (f.closeInRangePct > 0.35) return null;
    if (f.bullish) return null;
    if (f.delta >= 0) return null;
    if (Math.abs(f.prev15Net) >= 25) return null;
    const formerHighs = new Set<LevelSource>(['PDH','PMH','ORH','WkH','ONH']);
    for (const lv of f.levels) {
      if (!formerHighs.has(lv.source)) continue;
      const sweepDist  = f.high  - lv.price;
      const rejectDist = lv.price - f.close;
      if (sweepDist  < 2.0) continue;
      if (rejectDist < 2.0) continue;
      return 'short';
    }
    return null;
  },
  // v4: PDH/PMH/WkH only (drop ORH/ONH which were noise in per-level analysis)
  'SWP_short_v4': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 4) return null;
    if (f.bodyPct < 0.40) return null;
    if (f.closeInRangePct > 0.45) return null;
    if (f.bullish) return null;
    if (f.delta >= 0) return null;
    if (f.prev15Net <= -25) return null;
    const formerHighs = new Set<LevelSource>(['PDH','PMH','WkH']);
    for (const lv of f.levels) {
      if (!formerHighs.has(lv.source)) continue;
      const sweepDist  = f.high  - lv.price;
      const rejectDist = lv.price - f.close;
      if (sweepDist  < 0.5) continue;
      if (rejectDist < 0.5) continue;
      return 'short';
    }
    return null;
  },
  // ─── VWAP fade short variants ───
  // Common preconditions: post-10:00, not lunch, not late close, bearish bar,
  // delta < 0, range ≥ 4, close in lower 45%, upper wick ≥ 1pt, VWAP is ABOVE
  // close within tolerance, and the bar's upper wick reaches VWAP.
  // Variants differ in trend strictness, wick size and body criteria.
  'VWAP_fade_short_v1': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 4) return null;
    if (f.bodyPct < 0.40) return null;
    if (f.closeInRangePct > 0.45) return null;
    if (f.upperWick < 1.0) return null;
    if (f.bullish) return null;
    if (f.delta >= 0) return null;
    const v = f.levels.find(l => l.source === 'VWAP');
    if (!v) return null;
    const above = v.price - f.close;
    if (above <= 0 || above > 5) return null;
    if (v.price > f.close + f.upperWick + 0.5) return null;
    return 'short';
  },
  // v2: require established downtrend (prev15 net < -8)
  'VWAP_fade_short_v2': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 4) return null;
    if (f.bodyPct < 0.40) return null;
    if (f.closeInRangePct > 0.45) return null;
    if (f.upperWick < 1.0) return null;
    if (f.bullish) return null;
    if (f.delta >= 0) return null;
    if (f.prev15Net >= -8) return null;
    const v = f.levels.find(l => l.source === 'VWAP');
    if (!v) return null;
    const above = v.price - f.close;
    if (above <= 0 || above > 5) return null;
    if (v.price > f.close + f.upperWick + 0.5) return null;
    return 'short';
  },
  // v3: strong downtrend + bigger wick + stronger body (cleanest rejection)
  'VWAP_fade_short_v3': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 5) return null;
    if (f.bodyPct < 0.50) return null;
    if (f.closeInRangePct > 0.35) return null;     // close in bottom third
    if (f.upperWick < 2.5) return null;            // visible rejection wick
    if (f.bullish) return null;
    if (f.delta >= 0) return null;
    if (f.prev15Net >= -15) return null;
    if (f.prev5Net >= -2) return null;             // recent pullback up into VWAP
    const v = f.levels.find(l => l.source === 'VWAP');
    if (!v) return null;
    const above = v.price - f.close;
    if (above <= 0 || above > 5) return null;
    if (v.price > f.close + f.upperWick + 0.5) return null;
    return 'short';
  },
  // v4: VWAP touch with body close to VWAP but rejection clear
  'VWAP_fade_short_v4': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 4) return null;
    if (f.bodyPct < 0.45) return null;
    if (f.closeInRangePct > 0.40) return null;
    if (f.upperWick < 2.0) return null;
    if (f.bullish) return null;
    if (f.delta >= 0) return null;
    if (f.prev15Net >= -10) return null;
    const v = f.levels.find(l => l.source === 'VWAP');
    if (!v) return null;
    const above = v.price - f.close;
    if (above <= 0 || above > 3) return null;        // tight test
    if (v.price > f.close + f.upperWick + 0.5) return null;
    // Must NOT also coincide with a former-low level — keep it pure VWAP
    const formerLows = new Set<LevelSource>(['PDL','PML','ORL','WkL','ONL']);
    for (const lv of f.levels) {
      if (!formerLows.has(lv.source)) continue;
      const lvAbove = lv.price - f.close;
      if (lvAbove > 0 && lvAbove <= 3) return null;  // skip — already an RR trigger
    }
    return 'short';
  },
  // Extended candidate set — same rule, expanded source list to include the
  // newly wired-in batch (PDC / PDO / ONH / ONL / ONMid / VWAP). Used for the
  // per-level WR breakdown.
  'BSR_short_extended': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 4) return null;
    if (f.bodyPct < 0.40) return null;
    if (f.closeInRangePct > 0.45) return null;
    if (f.upperWick < 1.0) return null;
    if (f.bullish) return null;
    if (f.delta >= 0) return null;
    if (f.prev15Net >= 25) return null;
    const candidates = new Set<LevelSource>([
      'PDL','PML','ORL','WkL','ONL',
      'PDC','PDO','ONH','ONMid','VWAP',
      'PrevWkL','IBL','SwingL',
    ]);
    for (const lv of f.levels) {
      if (!candidates.has(lv.source)) continue;
      const lvAbove = lv.price - f.close;
      if (lvAbove > 0 && lvAbove <= 3 && lv.price <= f.close + f.upperWick + 0.5) return 'short';
    }
    return null;
  },
  // BROKEN-SUPPORT-BECOMES-RESISTANCE: short at PDL/PML/ORL acting as
  // resistance. The level must be ABOVE current close (we're below it now).
  // The bar's upper wick must have touched the level (current test of it).
  // The bar must close in the lower half (rejection).
  'BSR_short': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 4) return null;
    if (f.closeInRangePct > 0.45) return null;            // close in lower half
    if (f.upperWick < 1.0) return null;
    if (f.bullish) return null;
    if (f.delta >= 0) return null;
    // Find a "former low" level (PDL/PML/ORL/WkL) that is now ABOVE close
    const formerLows = new Set<LevelSource>(['PDL','PML','ORL','WkL']);
    for (const lv of f.levels) {
      if (!formerLows.has(lv.source)) continue;
      // Level must be above close, within reach of upper wick
      const lvAbove = lv.price - f.close;
      if (lvAbove > 0 && lvAbove <= 3 && lv.price <= f.close + f.upperWick + 0.5) return 'short';
    }
    return null;
  },
  // BRR: BROKEN-RESISTANCE-BECOMES-SUPPORT: long at PDH/PMH/ORH/WkH acting as support
  'BRS_long': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (f.range < 4) return null;
    if (f.closeInRangePct < 0.55) return null;
    if (f.lowerWick < 1.0) return null;
    if (!f.bullish) return null;
    if (f.delta <= 0) return null;
    const formerHighs = new Set<LevelSource>(['PDH','PMH','ORH','WkH']);
    for (const lv of f.levels) {
      if (!formerHighs.has(lv.source)) continue;
      const lvBelow = f.close - lv.price;
      if (lvBelow > 0 && lvBelow <= 3 && lv.price >= f.close - f.lowerWick - 0.5) return 'long';
    }
    return null;
  },
  // Trend agreement variant: PB + level + prev15 trend in entry direction
  'PB_trend_key': (f) => {
    const d = isPB(f); if (!d) return null;
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    if (d === 'long'  && f.prev15Net < 5)  return null;
    if (d === 'short' && f.prev15Net > -5) return null;
    const sweep = wickSweptLevel(f, d, f.levels, 0.5, KEY_SOURCES);
    return sweep ? d : null;
  },

  // Level-confluence variants
  'HL_any_2pt':  (f) => { const d = isH(f); return d && nearAnyLevel(f, d, 2, KEY_SOURCES)         ? d : null; },
  'HL_any_3pt':  (f) => { const d = isH(f); return d && nearAnyLevel(f, d, 3, KEY_SOURCES)         ? d : null; },
  'HL_any_5pt':  (f) => { const d = isH(f); return d && nearAnyLevel(f, d, 5, KEY_SOURCES)         ? d : null; },
  'HL_struct_3': (f) => { const d = isH(f); return d && nearAnyLevel(f, d, 3, STRUCTURAL_SOURCES) ? d : null; },
  'HL_struct_5': (f) => { const d = isH(f); return d && nearAnyLevel(f, d, 5, STRUCTURAL_SOURCES) ? d : null; },
  'HL_round_2':  (f) => { const d = isH(f); return d && nearAnyLevel(f, d, 2, ROUND_SOURCES)       ? d : null; },
  'HL_swing_2':  (f) => { const d = isH(f); return d && nearAnyLevel(f, d, 2, new Set(['Swing']))  ? d : null; },
  'HL_swing_5':  (f) => { const d = isH(f); return d && nearAnyLevel(f, d, 5, new Set(['Swing']))  ? d : null; },

  // Combined with no-lunch / no-late-close exclusions
  'HL_any_3_clean': (f) => {
    if (f.mod >= 11*60+50 && f.mod <= 13*60+15) return null;
    if (f.mod >= 15*60+25) return null;
    const d = isH(f); return d && nearAnyLevel(f, d, 3, KEY_SOURCES) ? d : null;
  },
};

// ─── Eval ──────────────────────────────────────────────────────────────────

type Stats = { triggers: number; wins: number; longs: number; longWins: number; shorts: number; shortWins: number };

async function main() {
  const arg = process.argv[2];
  let dates = TRAIN_DATES, mode = 'train';
  if (arg === 'test') { dates = TEST_DATES; mode = 'test'; }

  console.log(`Level-confluence filter test — mode=${mode}  MFE≥${MFE_PTS} MAE≤${MAE_PTS}  min ET=${Math.floor(MIN_ET_MIN/60)}:${String(MIN_ET_MIN%60).padStart(2,'0')}`);
  const db = new Database(TICKS_DB, { readonly: true });
  db.pragma('journal_mode = WAL');

  const totals: Record<string, Stats> = {};
  for (const name of Object.keys(FILTERS)) totals[name] = { triggers:0, wins:0, longs:0, longWins:0, shorts:0, shortWins:0 };
  let totalMinutes = 0;
  let cleanLong = 0, cleanShort = 0;
  // Per-level stats (against BSR_short_extended). Keyed by level source.
  const perLevel: Record<string, { triggers: number; wins: number }> = {};

  // Print all dumps for HL_any_3 to spot-check level confluence quality
  const DUMP = new Set(['LR_long_v1', 'LR_long_v2_trendAgree', 'LR_long_v3_strict', 'LR_long_v4_pdlPmlOnly']);

  for (const date of dates) {
    const trades = loadTrades(db, date, '04:00', '16:30');
    const bars = buildBars(trades);
    // Reference price for round numbers: first trade after RTH open
    const refTrade = trades.find(t => etMinutesOfDay(t.ts) >= 9*60+30);
    const refPrice = refTrade?.price ?? 0;
    const staticLevels = computeStaticLevels(db, date, refPrice);
    let rthHi = -Infinity, rthLo = Infinity;
    // VWAP accumulators — reset at RTH open (09:30 ET).
    let vwapCumPV = 0, vwapCumV = 0;

    for (let bi = 0; bi < bars.length - 1; bi++) {
      const b = bars[bi];
      const mod = etMinutesOfDay(b.minStartTs);
      if (mod < RTH_OPEN_MIN || mod > RTH_END_MIN) continue;
      if (b.high > rthHi) rthHi = b.high;
      if (b.low  < rthLo) rthLo = b.low;
      // Update VWAP using bar's typical price weighted by volume — causal,
      // includes only completed bars up through this one.
      const typPx = (b.high + b.low + b.close) / 3;
      vwapCumPV += typPx * b.vol;
      vwapCumV  += b.vol;
      const vwapNow = vwapCumV > 0 ? vwapCumPV / vwapCumV : NaN;
      if (mod < MIN_ET_MIN) continue;

      const swings = activeSwings(bars, bi);
      const intradayLevels = computeIntradayLevels(bars, b.minStartTs);
      const vwapLevels: Level[] = isFinite(vwapNow) ? [{ price: vwapNow, source: 'VWAP' }] : [];
      const allLevels = [...staticLevels, ...intradayLevels, ...swings, ...vwapLevels];

      const f = feat(bars, bi, rthHi, rthLo, allLevels);
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
        if (dir === 'long')  { s.longs++;  if (won) { s.longWins++;  s.wins++; } }
        else                 { s.shorts++; if (won) { s.shortWins++; s.wins++; } }
        // Per-level breakdown — only against BSR_short_extended (the full source-set rule).
        if (name === 'BSR_short_locked_v2') {
          // Per-level breakdown only for the locked-with-new-levels rule.
          // Mirrors the filter's formerLows set exactly.
          const candidates = new Set<LevelSource>([
            'PDL','PML','ORL','WkL','ONL','PrevWkL','IBL','SwingL',
          ]);
          let best: Level | null = null;
          let bestDist = Infinity;
          for (const lv of f.levels) {
            if (!candidates.has(lv.source)) continue;
            const lvAbove = lv.price - f.close;
            if (lvAbove <= 0 || lvAbove > 3) continue;
            if (lv.price > f.close + f.upperWick + 0.5) continue;
            if (lvAbove < bestDist) { best = lv; bestDist = lvAbove; }
          }
          if (best) {
            const key = best.source;
            if (!perLevel[key]) perLevel[key] = { triggers: 0, wins: 0 };
            perLevel[key]!.triggers++;
            if (won) perLevel[key]!.wins++;
          }
        }
        if (DUMP.has(name)) {
          // LR matched a former-low level that was swept below
          const formerLows = new Set<LevelSource>(['PDL','PML','ORL','WkL','ONL']);
          let matched: Level | undefined;
          for (const lv of f.levels) {
            if (!formerLows.has(lv.source)) continue;
            if (f.low >= lv.price || lv.price >= f.close) continue;
            const sd = lv.price - f.low;
            const rd = f.close  - lv.price;
            if (sd < 0.5 || rd < 0.5) continue;
            matched = lv; break;
          }
          const lvStr = matched ? `${matched.source}@${matched.price.toFixed(2)} sweep=${(matched.price-f.low).toFixed(2)} reclaim=${(f.close-matched.price).toFixed(2)}` : 'NONE';
          console.log(`  [${name}] ${date} ${String(Math.floor(f.mod/60)).padStart(2,'0')}:${String(f.mod%60).padStart(2,'0')} ${dir} entry=${entryPx.toFixed(2)} lo=${f.low.toFixed(2)} rng=${f.range.toFixed(1)} body=${(f.bodyPct*100).toFixed(0)} closeRng=${(f.closeInRangePct*100).toFixed(0)} wick=${f.lowerWick.toFixed(2)} d/v=${(f.vol>0?Math.abs(f.delta)/f.vol*100:0).toFixed(1)} prev15=${f.prev15Net.toFixed(1)} | ${lvStr}  ${won?'WIN':'lose'}`);
        }
      }
    }
  }
  db.close();

  console.log(`\nBaseline: ${totalMinutes} RTH minutes  cleanLong=${cleanLong}  cleanShort=${cleanShort}`);
  console.log(`Baseline P(cleanLong)  = ${(cleanLong /Math.max(totalMinutes,1)*100).toFixed(1)}%`);
  console.log(`Baseline P(cleanShort) = ${(cleanShort/Math.max(totalMinutes,1)*100).toFixed(1)}%`);

  console.log('\nPer-level breakdown (BSR_short_extended, nearest matching level above close):');
  console.log('source   triggers  wins   WR');
  for (const [src, s] of Object.entries(perLevel).sort()) {
    const wr = s.triggers ? (s.wins / s.triggers) * 100 : 0;
    console.log(`${src.padEnd(7)}  ${String(s.triggers).padStart(8)}  ${String(s.wins).padStart(4)}  ${wr.toFixed(1).padStart(5)}%`);
  }

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
