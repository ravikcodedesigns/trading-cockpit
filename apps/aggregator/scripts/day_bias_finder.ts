/**
 * day_bias_finder.ts
 *
 * Goal: find a pre-09:30 ET bias classifier (bullish / bearish / neutral)
 * that, used as a directional filter, would have removed the most net loser
 * PnL from V3-qualified trades historically.
 *
 * CONSTRAINTS (per user):
 *   - Features computed ONLY from data available BEFORE 09:30 ET on the day
 *   - No forward-looking inputs (no RTH price, no RS context, no daily levels)
 *   - Only tape data: overnight ticks, multi-timeframe bars derived from ticks
 *   - Used as a directional GATE: bullish day → block SHORTs; bearish day → block LONGs
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const tdb = new Database(TRADING_DB, { readonly: true });
const xdb = new Database(TICKS_DB,   { readonly: true });

// ── Helpers ────────────────────────────────────────────────────────────────

function etOfMs(tsMs: number): { dateStr: string; hour: number; min: number; weekday: string } {
  const d = new Date(tsMs - 4 * 60 * 60_000);
  return {
    dateStr: `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`,
    hour: d.getUTCHours(), min: d.getUTCMinutes(),
    weekday: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()] ?? '',
  };
}

function rthOpenMs(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!, 13, 30, 0); // 13:30 UTC ≈ 09:30 EDT
}
function rthCloseMs(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!, 20, 0, 0); // 20:00 UTC ≈ 16:00 EDT
}

// ── List of RTH trading days from ticks coverage ───────────────────────────

const dayList = (xdb.prepare(`
  SELECT DISTINCT date(ts/1000,'unixepoch','-4 hours') AS d
  FROM trades WHERE symbol='NQ'
    AND time(ts/1000,'unixepoch','-4 hours') >= '09:30:00'
    AND time(ts/1000,'unixepoch','-4 hours') <  '16:00:00'
  ORDER BY d
`).all() as { d: string }[]).map(r => r.d).filter(d => {
  const day = new Date(d + 'T12:00:00Z').getUTCDay();
  return day >= 1 && day <= 5; // weekdays only
});

console.log(`Trading days with RTH tick data: ${dayList.length}`);
console.log(`Range: ${dayList[0]} → ${dayList.at(-1)}\n`);

// ── Pre-09:30 features per day ──────────────────────────────────────────────

interface DayFeatures {
  date: string;
  // Outcome (used only for evaluation, not as feature):
  rthOpen: number; rthClose: number; rthNet: number;
  rthHigh: number; rthLow: number; rthRange: number;
  outcomeBias: 'bull' | 'bear' | 'neutral';

  // Pre-09:30 features:
  onHigh: number; onLow: number; onRange: number;     // overnight Globex range
  onClose: number;                                     // last price before 09:30
  onCvd: number;                                       // overnight CVD (signed by aggressor)
  priorRthClose: number | null;                        // prior trading day's RTH close
  gap: number | null;                                  // onClose - priorRthClose
  onVwap: number;                                      // overnight session VWAP
  onClose_vs_vwap: number;                             // onClose - onVwap
  preMkt60mDelta: number;                              // CVD in last 60 min before 09:30
  preMkt30mNet: number;                                // last-30-min net price change before 09:30
  fiveDayHigh: number | null;                          // max RTH high of past 5 days
  fiveDayLow: number | null;                           // min RTH low of past 5 days
  positionIn5DayRange: number | null;                  // (onClose - fiveDayLow) / (fiveDayHigh - fiveDayLow)
  prior4hSlope: number;                                // last 4h price change before 09:30
}

const stmtTicksInRange = xdb.prepare(`
  SELECT ts, price, size, is_bid_aggressor FROM trades
  WHERE symbol='NQ' AND ts >= ? AND ts < ?
  ORDER BY ts ASC, id ASC
`).raw(true);
const stmtFirstTick = xdb.prepare(`
  SELECT price FROM trades WHERE symbol='NQ' AND ts >= ? ORDER BY ts ASC LIMIT 1
`);
const stmtLastTickBefore = xdb.prepare(`
  SELECT price FROM trades WHERE symbol='NQ' AND ts <= ? ORDER BY ts DESC LIMIT 1
`);

function computeFeatures(dateStr: string, priorRthClose: number | null, last5DayHL: { hi: number; lo: number } | null): DayFeatures | null {
  const open09 = rthOpenMs(dateStr);
  const close16 = rthCloseMs(dateStr);
  const onStart = open09 - (15 * 60 + 30) * 60_000; // 15.5 hours before = 18:00 prior day approximately
  // Pull RTH OHLC (outcome)
  const rthRows = stmtTicksInRange.all(open09, close16) as Array<[number, number, number, number]>;
  if (rthRows.length === 0) return null;
  const rthOpenPx = rthRows[0]![1];
  const rthClosePx = rthRows[rthRows.length - 1]![1];
  let rthHi = -Infinity, rthLo = Infinity;
  for (const [, px] of rthRows) { if (px > rthHi) rthHi = px; if (px < rthLo) rthLo = px; }
  const rthNet = rthClosePx - rthOpenPx;
  const outcomeBias = rthNet >= 30 ? 'bull' : rthNet <= -30 ? 'bear' : 'neutral';

  // Pull overnight ticks (18:00 prior → 09:30 today)
  const onRows = stmtTicksInRange.all(onStart, open09) as Array<[number, number, number, number]>;
  if (onRows.length === 0) return null;
  let onHigh = -Infinity, onLow = Infinity;
  let onCvd = 0;
  let vwapNum = 0, vwapDen = 0;
  for (const [, px, sz, agg] of onRows) {
    if (px > onHigh) onHigh = px;
    if (px < onLow)  onLow  = px;
    onCvd += agg === 1 ? sz : -sz;
    vwapNum += px * sz; vwapDen += sz;
  }
  const onClose = onRows[onRows.length - 1]![1];
  const onVwap = vwapDen > 0 ? vwapNum / vwapDen : onClose;

  // Pre-mkt 60-min delta (08:30 → 09:30)
  const preStart = open09 - 60 * 60_000;
  const preRows = stmtTicksInRange.all(preStart, open09) as Array<[number, number, number, number]>;
  let pre60Cvd = 0;
  for (const [, , sz, agg] of preRows) pre60Cvd += agg === 1 ? sz : -sz;

  // Pre-mkt 30-min net price change
  const pre30Start = open09 - 30 * 60_000;
  const pre30Open = stmtFirstTick.get(pre30Start) as { price: number } | undefined;
  const pre30End  = stmtLastTickBefore.get(open09 - 1) as { price: number } | undefined;
  const preMkt30mNet = (pre30Open && pre30End) ? pre30End.price - pre30Open.price : 0;

  // 4h prior slope
  const fourHStart = open09 - 4 * 60 * 60_000;
  const fourHOpen = stmtFirstTick.get(fourHStart) as { price: number } | undefined;
  const fourHClose = stmtLastTickBefore.get(open09 - 1) as { price: number } | undefined;
  const prior4hSlope = (fourHOpen && fourHClose) ? fourHClose.price - fourHOpen.price : 0;

  // 5-day range position
  let positionIn5DayRange: number | null = null;
  if (last5DayHL && last5DayHL.hi > last5DayHL.lo) {
    positionIn5DayRange = (onClose - last5DayHL.lo) / (last5DayHL.hi - last5DayHL.lo);
  }

  return {
    date: dateStr,
    rthOpen: rthOpenPx, rthClose: rthClosePx, rthNet,
    rthHigh: rthHi, rthLow: rthLo, rthRange: rthHi - rthLo,
    outcomeBias,
    onHigh, onLow, onRange: onHigh - onLow,
    onClose, onCvd,
    priorRthClose,
    gap: priorRthClose != null ? onClose - priorRthClose : null,
    onVwap,
    onClose_vs_vwap: onClose - onVwap,
    preMkt60mDelta: pre60Cvd,
    preMkt30mNet,
    fiveDayHigh: last5DayHL?.hi ?? null,
    fiveDayLow: last5DayHL?.lo ?? null,
    positionIn5DayRange,
    prior4hSlope,
  };
}

const features: DayFeatures[] = [];
const recentRthHL: { date: string; hi: number; lo: number; close: number }[] = [];

for (const dateStr of dayList) {
  const priorClose = recentRthHL.at(-1)?.close ?? null;
  const last5 = recentRthHL.slice(-5);
  const last5HL = last5.length > 0 ? {
    hi: Math.max(...last5.map(d => d.hi)),
    lo: Math.min(...last5.map(d => d.lo)),
  } : null;
  const f = computeFeatures(dateStr, priorClose, last5HL);
  if (f) {
    features.push(f);
    recentRthHL.push({ date: dateStr, hi: f.rthHigh, lo: f.rthLow, close: f.rthClose });
    if (recentRthHL.length > 10) recentRthHL.shift();
  }
}
console.log(`Computed features for ${features.length} days.\n`);

// ── Pull V3-qualified trade outcomes for the same window ──────────────────
// Use the same backtest engine + V3 config we already validated.

import { runCombinedCooldownBacktest, type RuleSpec, type SignalRow } from './lib/cooldown-backtest.js';

const rules: RuleSpec[] = [
  { ruleId: 'absorption',                     tp: 80, sl: 140,
    entryPriceFromRationale: /absorbed at (\d+\.?\d*)/ },
  { ruleId: 'clean-impulse', pattern: 'FLIP', tp: 80, sl: { long: 55, short: 105 } },
  { ruleId: 'expl',                           tp: 80, sl: 70, fallbackToTickPriceAtTs: true },
];

// CVD lookup for V3 entry filter
function rthOpenMsForSignal(tsMs: number): number {
  const d = new Date(tsMs - 4 * 60 * 60_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 13, 30, 0, 0);
}
const stmtCvd = xdb.prepare(`
  SELECT SUM(CASE WHEN is_bid_aggressor=1 THEN size ELSE -size END) AS cvd
  FROM trades WHERE symbol='NQ' AND ts >= ? AND ts <= ?
`);
const cvdAt = (tsMs: number): number => {
  const row = stmtCvd.get(rthOpenMsForSignal(tsMs), tsMs) as { cvd: number | null } | undefined;
  return row?.cvd ?? 0;
};
const v3Filter = (s: SignalRow) => {
  if (!s.qualified) return false;
  if (s.ruleId === 'clean-impulse' && s.pattern === 'FLIP' && s.direction === 'short') return false;
  const cvd = cvdAt(s.ts);
  if (s.direction === 'long'  && cvd <= -3000) return false;
  if (s.direction === 'short' && cvd >= +3000) return false;
  return true;
};

const trades = runCombinedCooldownBacktest({
  symbol: 'NQ', tradingDb: tdb, ticksDb: xdb, rules,
  rthWindow: { startEt: '09:30:00', endEt: '16:00:00' },
  entryFilter: v3Filter,
  requireQualifiedExits: { long: true, short: false },
}).filter(t => t.outcome !== 'NO_DATA');

console.log(`V3-qualified trades to test against: ${trades.length}\n`);

// Group trades by date
function dateOf(tsMs: number): string {
  return etOfMs(tsMs).dateStr;
}
const tradesByDate = new Map<string, typeof trades>();
for (const t of trades) {
  const d = dateOf(t.sig.ts);
  if (!tradesByDate.has(d)) tradesByDate.set(d, []);
  tradesByDate.get(d)!.push(t);
}

// ── Define candidate bias classifiers ─────────────────────────────────────
// Each returns 'bull' | 'bear' | 'neutral' from pre-09:30 features alone.

type Bias = 'bull' | 'bear' | 'neutral';
interface Formula { label: string; classify: (f: DayFeatures) => Bias; }

const formulas: Formula[] = [
  {
    label: 'Gap > +20 bull / < -20 bear',
    classify: f => f.gap == null ? 'neutral' : f.gap > 20 ? 'bull' : f.gap < -20 ? 'bear' : 'neutral',
  },
  {
    label: 'Gap > +50 bull / < -50 bear',
    classify: f => f.gap == null ? 'neutral' : f.gap > 50 ? 'bull' : f.gap < -50 ? 'bear' : 'neutral',
  },
  {
    label: 'ON CVD > +500 bull / < -500 bear',
    classify: f => f.onCvd > 500 ? 'bull' : f.onCvd < -500 ? 'bear' : 'neutral',
  },
  {
    label: 'ON CVD > +1500 bull / < -1500 bear',
    classify: f => f.onCvd > 1500 ? 'bull' : f.onCvd < -1500 ? 'bear' : 'neutral',
  },
  {
    label: 'onClose vs VWAP > +10 bull / < -10 bear',
    classify: f => f.onClose_vs_vwap > 10 ? 'bull' : f.onClose_vs_vwap < -10 ? 'bear' : 'neutral',
  },
  {
    label: '4h prior slope > +20 bull / < -20 bear',
    classify: f => f.prior4hSlope > 20 ? 'bull' : f.prior4hSlope < -20 ? 'bear' : 'neutral',
  },
  {
    label: 'Pre-mkt 30m net > +10 bull / < -10 bear',
    classify: f => f.preMkt30mNet > 10 ? 'bull' : f.preMkt30mNet < -10 ? 'bear' : 'neutral',
  },
  {
    label: 'Pre-mkt 60m CVD > +500 bull / < -500 bear',
    classify: f => f.preMkt60mDelta > 500 ? 'bull' : f.preMkt60mDelta < -500 ? 'bear' : 'neutral',
  },
  {
    label: '5-day range pos > 0.8 bull (continuation) / < 0.2 bear',
    classify: f => f.positionIn5DayRange == null ? 'neutral'
                  : f.positionIn5DayRange > 0.8 ? 'bull'
                  : f.positionIn5DayRange < 0.2 ? 'bear' : 'neutral',
  },
  {
    label: 'Composite: Gap > +20 AND ON CVD > 0 bull; Gap < -20 AND ON CVD < 0 bear',
    classify: f => {
      const gapOk = f.gap != null;
      const bull = gapOk && f.gap! > 20 && f.onCvd > 0;
      const bear = gapOk && f.gap! < -20 && f.onCvd < 0;
      return bull ? 'bull' : bear ? 'bear' : 'neutral';
    },
  },
  {
    label: 'Composite: Gap-direction + 4h-slope-direction agree',
    classify: f => {
      if (f.gap == null) return 'neutral';
      if (f.gap > 10 && f.prior4hSlope > 10) return 'bull';
      if (f.gap < -10 && f.prior4hSlope < -10) return 'bear';
      return 'neutral';
    },
  },
  {
    label: 'Composite STRONG: Gap + ON CVD + onClose>VWAP all aligned',
    classify: f => {
      if (f.gap == null) return 'neutral';
      const bullCount =
        (f.gap > 10 ? 1 : 0) +
        (f.onCvd > 200 ? 1 : 0) +
        (f.onClose_vs_vwap > 5 ? 1 : 0);
      const bearCount =
        (f.gap < -10 ? 1 : 0) +
        (f.onCvd < -200 ? 1 : 0) +
        (f.onClose_vs_vwap < -5 ? 1 : 0);
      if (bullCount >= 2) return 'bull';
      if (bearCount >= 2) return 'bear';
      return 'neutral';
    },
  },
];

// ── Evaluate each formula ─────────────────────────────────────────────────
//
// For each trade: if formula says bias contradicts trade direction → SKIP.
//   - bull day + SHORT trade → SKIP
//   - bear day + LONG trade  → SKIP
//   - neutral day → take both directions
//
// Score:
//   savings = sum of pnl of trades skipped that were LOSSES (positive number)
//   cost    = sum of pnl of trades skipped that were WINS   (positive number, dollar opportunity cost)
//   net     = savings - cost   (positive = filter is profitable)

interface FormulaScore {
  label: string;
  bullDays: number; bearDays: number; neutralDays: number;
  correctBull: number; correctBear: number; correctNeutral: number;
  totalSkipped: number;
  skippedLosses: number; skippedWins: number;
  pnlSaved: number; pnlForegone: number; netImpact: number;
  baselineNet: number; filteredNet: number;
}

const featuresByDate = new Map(features.map(f => [f.date, f]));

function evaluate(formula: Formula): FormulaScore {
  let bullDays = 0, bearDays = 0, neutralDays = 0;
  let correctBull = 0, correctBear = 0, correctNeutral = 0;
  let totalSkipped = 0, skippedLosses = 0, skippedWins = 0;
  let pnlSaved = 0, pnlForegone = 0;
  let baselineNet = 0, filteredNet = 0;

  for (const f of features) {
    const bias = formula.classify(f);
    if (bias === 'bull') {
      bullDays++;
      if (f.outcomeBias === 'bull') correctBull++;
    } else if (bias === 'bear') {
      bearDays++;
      if (f.outcomeBias === 'bear') correctBear++;
    } else {
      neutralDays++;
      if (f.outcomeBias === 'neutral') correctNeutral++;
    }
  }

  for (const [date, dayTrades] of tradesByDate) {
    const f = featuresByDate.get(date);
    const bias: Bias = f ? formula.classify(f) : 'neutral';
    for (const t of dayTrades) {
      baselineNet += t.pnl;
      const trade_dir = t.sig.direction;
      const skipped =
        (bias === 'bull' && trade_dir === 'short') ||
        (bias === 'bear' && trade_dir === 'long');
      if (skipped) {
        totalSkipped++;
        if (t.pnl < 0) { skippedLosses++; pnlSaved += -t.pnl; }
        else if (t.pnl > 0) { skippedWins++; pnlForegone += t.pnl; }
      } else {
        filteredNet += t.pnl;
      }
    }
  }

  return {
    label: formula.label,
    bullDays, bearDays, neutralDays,
    correctBull, correctBear, correctNeutral,
    totalSkipped, skippedLosses, skippedWins,
    pnlSaved, pnlForegone, netImpact: pnlSaved - pnlForegone,
    baselineNet, filteredNet,
  };
}

const scores = formulas.map(evaluate);
scores.sort((a, b) => b.netImpact - a.netImpact);

// ── Output ────────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════════════════');
console.log('Day-bias formula ranking (pre-09:30 ET features only)');
console.log('═══════════════════════════════════════════════════════════════════════\n');
console.log(`Total days analyzed: ${features.length}`);
console.log(`Day outcomes: bull=${features.filter(f=>f.outcomeBias==='bull').length}  bear=${features.filter(f=>f.outcomeBias==='bear').length}  neutral=${features.filter(f=>f.outcomeBias==='neutral').length}`);
console.log(`Baseline V3 trades net PnL: ${scores[0]?.baselineNet.toFixed(0)} pts (unfiltered)`);
console.log('');

for (const s of scores) {
  console.log(`── ${s.label}`);
  console.log(`   days: bull=${s.bullDays}  bear=${s.bearDays}  neutral=${s.neutralDays}`);
  console.log(`   day-classification accuracy: bull ${s.correctBull}/${s.bullDays}  bear ${s.correctBear}/${s.bearDays}  neutral ${s.correctNeutral}/${s.neutralDays}`);
  console.log(`   trades skipped: ${s.totalSkipped}  (${s.skippedLosses} losses, ${s.skippedWins} wins)`);
  console.log(`   pnl saved by skipping: ${s.pnlSaved.toFixed(0)} pt`);
  console.log(`   pnl foregone by skipping: ${s.pnlForegone.toFixed(0)} pt`);
  console.log(`   ───  Net impact: ${s.netImpact >= 0 ? '+' : ''}${s.netImpact.toFixed(0)} pt`);
  console.log(`   Filtered V3 net: ${s.filteredNet.toFixed(0)} pt  (vs baseline ${s.baselineNet.toFixed(0)})`);
  console.log('');
}

// Per-day breakdown for the top formula
console.log('\n═══════════════════════════════════════════════════════════════════════');
console.log('Top formula — per-day classifications:');
console.log('═══════════════════════════════════════════════════════════════════════');
const top = formulas.find(f => f.label === scores[0]!.label)!;
console.log('date        predicted  actual    rthNet  gap      onCvd   onClose-vwap  4hSlope  pre30m');
for (const f of features) {
  const pred = top.classify(f);
  const match = pred === f.outcomeBias ? '✓' : (pred === 'neutral' || f.outcomeBias === 'neutral' ? ' ' : '✗');
  console.log(
    `${f.date}  ${pred.padEnd(8)}   ${f.outcomeBias.padEnd(8)}  ${(f.rthNet >= 0 ? '+' : '') + f.rthNet.toFixed(0)}    ` +
    `${(f.gap !== null ? (f.gap >= 0 ? '+' : '') + f.gap.toFixed(0) : '   -  ').padStart(6)}   ` +
    `${(f.onCvd >= 0 ? '+' : '') + f.onCvd.toString()}     ` +
    `${(f.onClose_vs_vwap >= 0 ? '+' : '') + f.onClose_vs_vwap.toFixed(1)}      ` +
    `${(f.prior4hSlope >= 0 ? '+' : '') + f.prior4hSlope.toFixed(1)}    ` +
    `${(f.preMkt30mNet >= 0 ? '+' : '') + f.preMkt30mNet.toFixed(1)}  ${match}`
  );
}

tdb.close(); xdb.close();
