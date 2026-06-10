// backtest_rth_train_test.ts
// Walk-forward validation for the RTH level-behavior backtest.
//   TRAIN = first 12 sessions in scope (chronologically)
//   TEST  = remaining sessions (~12)
//
// On TRAIN, for each label:
//   - tally react% / break% across all touches
//   - compute median react magnitude (used as TP) and median break magnitude
//   - classify the level as FADE / BREAKOUT / NEUTRAL:
//       FADE     if train_react% ≥ 60% AND react_count ≥ 3
//       BREAKOUT if train_break% ≥ 60% AND break_count ≥ 3
//       NEUTRAL  otherwise (skipped in TEST)
//
// On TEST, simulate the implied trade per touch:
//   FADE trade   : enter OPPOSITE approach direction; win = price reverses ≥TP, lose = price continues ≥SL
//   BREAKOUT trade: enter SAME direction as approach; win = price continues ≥TP, lose = price reverses ≥SL
//   TP = TRAIN median react (FADE) or TRAIN median break (BREAKOUT)
//   SL = 15pt fixed
//   Window = 60min from touch
//
// Output: TRAIN stats and TEST realized stats side by side, sorted by TEST $/touch desc.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const TICKS_DB = path.join(REPO_ROOT, 'data/ticks.db');
const LEVELS_PATH = path.join(REPO_ROOT, 'daily_levels.json');
const DOLLAR_PER_PT = 2; // MNQ

const TOUCH_PT = 1.0;
const REACT_PT = 10;
const BREAK_PT = 10;
const SL_PT = 15;
const WINDOW_MS = 60 * 60_000;
const PRE_MS = 5 * 60_000;

const TRAIN_DAYS = 12;
const MIN_TRAIN_TOUCHES = 3;        // need at least 3 touches in train to classify
const MIN_REACT_BREAK_COUNT = 3;    // require ≥3 of the dominant outcome
const FADE_THRESHOLD = 60;          // train react% to classify as FADE
const BREAKOUT_THRESHOLD = 60;      // train break% to classify as BREAKOUT

function etOffsetHours(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y!, m! - 1, d!, 12, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(utcNoon);
  return parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10) - 12;
}
function etDateTimeToMs(date: string, hh: number, mm: number): number {
  const offset = etOffsetHours(date);
  const [y, mo, d] = date.split('-').map(Number);
  return Date.UTC(y!, mo! - 1, d!, hh - offset, mm);
}

interface LevelEntry { price: number; label: string; }
interface DayLevelsFile {
  days: Record<string, { levels: Array<{
    symbol: string; additionalLevels?: LevelEntry[];
    bullZone?: { low: number; high: number }; bearZone?: { low: number; high: number };
    ddBands?: { upper: number; lower: number }; hedgePressure?: number; mhp?: number;
  }> }>;
}

// Same-session-derived labels: computed from TODAY's RTH ticks, so testing
// "did price react at <label>" during TODAY's RTH leaks future data. We keep
// them in daily_levels.json for chart/reference use but exclude from honest
// out-of-sample testing.
//   IBH/IBL/RTHO/VWAP  — derived from 09:30-16:00 today
//   HVN1/HVN2/LVN↑/LVN↓ — derived from today's volume profile
//   nPOC               — naked POC scan can include today's POC
// WkH/WkL were FIXED (2026-06-10) to exclude today via i=1 in computeWeekly,
// so they're now safe to include.
const LOOKAHEAD_LABELS = new Set(['IBH', 'IBL', 'RTHO', 'VWAP', 'HVN1', 'HVN2', 'LVN↑', 'LVN↓', 'nPOC']);

function collectLevels(entry: NonNullable<DayLevelsFile['days'][string]>['levels'][number]): LevelEntry[] {
  const out: LevelEntry[] = [];
  if (entry.additionalLevels) {
    for (const lvl of entry.additionalLevels) {
      if (!LOOKAHEAD_LABELS.has(lvl.label)) out.push(lvl);
    }
  }
  if (entry.bullZone) out.push({ price: entry.bullZone.low, label: 'Bull L' });
  if (entry.bearZone) out.push({ price: entry.bearZone.high, label: 'Bear H' });
  if (entry.ddBands) {
    out.push({ price: entry.ddBands.upper, label: 'DD↑' });
    out.push({ price: entry.ddBands.lower, label: 'DD↓' });
  }
  if (entry.hedgePressure !== undefined) out.push({ price: entry.hedgePressure, label: 'HP' });
  if (entry.mhp !== undefined) out.push({ price: entry.mhp, label: 'MHP' });
  return out;
}

interface Touch {
  day: string;
  approachDir: 'up' | 'down';
  reactPts: number;     // max favorable move against approach within window
  breakPts: number;     // max adverse move in approach direction within window
  reactedFirst: boolean;
  brokeFirst: boolean;
}

function evaluateFirstTouch(
  ticks: Array<{ ts: number; price: number }>,
  rthStart: number, rthEnd: number,
  level: number, day: string,
): Touch | null {
  let firstIdx = -1;
  for (let i = 0; i < ticks.length; i++) {
    if (ticks[i]!.ts < rthStart) continue;
    if (ticks[i]!.ts >= rthEnd) break;
    if (Math.abs(ticks[i]!.price - level) <= TOUCH_PT) { firstIdx = i; break; }
  }
  if (firstIdx === -1) return null;
  const touchTs = ticks[firstIdx]!.ts;
  const touchPrice = ticks[firstIdx]!.price;

  let preIdx = firstIdx;
  while (preIdx > 0 && ticks[preIdx]!.ts > touchTs - PRE_MS) preIdx--;
  const delta = touchPrice - ticks[preIdx]!.price;
  if (Math.abs(delta) < 0.5) return null;
  const approachDir: 'up' | 'down' = delta > 0 ? 'up' : 'down';

  const endTs = Math.min(touchTs + WINDOW_MS, rthEnd);
  let maxAgainst = 0, maxWith = 0;
  let reactedFirst = false, brokeFirst = false;
  for (let i = firstIdx + 1; i < ticks.length && ticks[i]!.ts <= endTs; i++) {
    const dp = ticks[i]!.price - touchPrice;
    const dpWith = approachDir === 'up' ? dp : -dp;
    const dpAgainst = -dpWith;
    if (dpWith > maxWith) maxWith = dpWith;
    if (dpAgainst > maxAgainst) maxAgainst = dpAgainst;
    if (!reactedFirst && !brokeFirst) {
      if (dpAgainst >= REACT_PT) reactedFirst = true;
      else if (dpWith >= BREAK_PT) brokeFirst = true;
    }
  }
  return { day, approachDir, reactPts: maxAgainst, breakPts: maxWith, reactedFirst, brokeFirst };
}

// Simulate a trade given strategy direction + TP/SL.
// strategyDir = 'against' (FADE) | 'with' (BREAKOUT)
// Returns realized PnL in pts (+ TP, - SL, or partial if window expires).
function simulateTrade(
  ticks: Array<{ ts: number; price: number }>,
  touchIdx: number,
  approachDir: 'up' | 'down',
  strategyDir: 'against' | 'with',
  tpPt: number,
  slPt: number,
  windowEnd: number,
): { outcome: 'TP' | 'SL' | 'EXPIRE'; pnlPts: number } {
  const touchTs = ticks[touchIdx]!.ts;
  const touchPrice = ticks[touchIdx]!.price;
  const tradeDir: 'long' | 'short' = strategyDir === 'against'
    ? (approachDir === 'up' ? 'short' : 'long')      // fade: opposite of approach
    : (approachDir === 'up' ? 'long' : 'short');     // breakout: same as approach
  const endTs = Math.min(touchTs + WINDOW_MS, windowEnd);

  let lastPrice = touchPrice;
  for (let i = touchIdx + 1; i < ticks.length && ticks[i]!.ts <= endTs; i++) {
    const p = ticks[i]!.price;
    lastPrice = p;
    const dp = tradeDir === 'long' ? p - touchPrice : touchPrice - p;
    if (dp >= tpPt) return { outcome: 'TP', pnlPts: tpPt };
    if (dp <= -slPt) return { outcome: 'SL', pnlPts: -slPt };
  }
  const finalDp = tradeDir === 'long' ? lastPrice - touchPrice : touchPrice - lastPrice;
  return { outcome: 'EXPIRE', pnlPts: finalDp };
}

function findFirstTouchIdx(ticks: Array<{ ts: number; price: number }>, start: number, end: number, level: number): number {
  for (let i = 0; i < ticks.length; i++) {
    if (ticks[i]!.ts < start) continue;
    if (ticks[i]!.ts >= end) break;
    if (Math.abs(ticks[i]!.price - level) <= TOUCH_PT) return i;
  }
  return -1;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function main() {
  const symbol = 'NQ';
  const levelsFile = JSON.parse(fs.readFileSync(LEVELS_PATH, 'utf-8')) as DayLevelsFile;
  const ticks = new Database(TICKS_DB, { readonly: true });
  ticks.pragma('journal_mode = WAL');

  // Build session list of days with sufficient RTH data, sorted
  const allDays = Object.keys(levelsFile.days).sort();
  const validDays: string[] = [];
  for (const day of allDays) {
    const entry = levelsFile.days[day]?.levels.find(l => l.symbol === symbol);
    if (!entry) continue;
    const rthStart = etDateTimeToMs(day, 9, 30);
    const rthEnd = etDateTimeToMs(day, 16, 0);
    const n = (ticks.prepare(`SELECT COUNT(*) AS n FROM trades WHERE symbol=? AND ts >= ? AND ts < ?`).get(symbol, rthStart, rthEnd) as { n: number }).n;
    if (n >= 10000) validDays.push(day);
  }

  if (validDays.length < TRAIN_DAYS + 3) {
    console.error(`Not enough valid sessions (${validDays.length}) — need ≥ ${TRAIN_DAYS + 3}`);
    process.exit(1);
  }

  const trainDays = validDays.slice(0, TRAIN_DAYS);
  const testDays = validDays.slice(TRAIN_DAYS);
  console.log(`\n══ RTH train/test backtest — ${symbol} ══`);
  console.log(`Params: touch=±${TOUCH_PT}pt  react=≥${REACT_PT}pt  break=≥${BREAK_PT}pt  SL=${SL_PT}pt  window=${WINDOW_MS / 60_000}min\n`);
  console.log(`TRAIN: ${trainDays.length} sessions  ${trainDays[0]} → ${trainDays[trainDays.length - 1]}`);
  console.log(`TEST:  ${testDays.length} sessions  ${testDays[0]} → ${testDays[testDays.length - 1]}\n`);

  // Discover all labels present in TRAIN
  const allLabels = new Set<string>();
  for (const day of [...trainDays, ...testDays]) {
    const entry = levelsFile.days[day]?.levels.find(l => l.symbol === symbol);
    if (!entry) continue;
    for (const lvl of collectLevels(entry)) allLabels.add(lvl.label);
  }

  // Phase 1: TRAIN — collect touches per label
  const trainTouchesByLabel = new Map<string, Touch[]>();
  for (const day of trainDays) {
    const entry = levelsFile.days[day]?.levels.find(l => l.symbol === symbol);
    if (!entry) continue;
    const rthStart = etDateTimeToMs(day, 9, 30);
    const rthEnd = etDateTimeToMs(day, 16, 0);
    const sessionTicks = ticks.prepare(
      `SELECT ts, price FROM trades WHERE symbol=? AND ts >= ? AND ts < ? ORDER BY ts ASC`
    ).all(symbol, rthStart, rthEnd) as Array<{ ts: number; price: number }>;
    for (const lvl of collectLevels(entry)) {
      const t = evaluateFirstTouch(sessionTicks, rthStart, rthEnd, lvl.price, day);
      if (t) {
        const arr = trainTouchesByLabel.get(lvl.label) ?? [];
        arr.push(t);
        trainTouchesByLabel.set(lvl.label, arr);
      }
    }
  }

  // Classify each label from TRAIN
  interface Spec { classification: 'FADE' | 'BREAKOUT' | 'NEUTRAL' | 'SPARSE'; trainTouches: number; trainReactPct: number; trainBreakPct: number; tpPt: number | null; medianReact: number | null; medianBreak: number | null; }
  const specByLabel = new Map<string, Spec>();
  for (const label of allLabels) {
    const touches = trainTouchesByLabel.get(label) ?? [];
    const reacts = touches.filter(t => t.reactedFirst);
    const breaks = touches.filter(t => t.brokeFirst);
    if (touches.length < MIN_TRAIN_TOUCHES) {
      specByLabel.set(label, { classification: 'SPARSE', trainTouches: touches.length, trainReactPct: 0, trainBreakPct: 0, tpPt: null, medianReact: null, medianBreak: null });
      continue;
    }
    const reactPct = 100 * reacts.length / touches.length;
    const breakPct = 100 * breaks.length / touches.length;
    const medianReact = reacts.length ? percentile(reacts.map(r => r.reactPts), 50) : null;
    const medianBreak = breaks.length ? percentile(breaks.map(r => r.breakPts), 50) : null;
    let classification: 'FADE' | 'BREAKOUT' | 'NEUTRAL' = 'NEUTRAL';
    let tpPt: number | null = null;
    if (reactPct >= FADE_THRESHOLD && reacts.length >= MIN_REACT_BREAK_COUNT && medianReact !== null) {
      classification = 'FADE';
      tpPt = Math.max(15, Math.round(medianReact));
    } else if (breakPct >= BREAKOUT_THRESHOLD && breaks.length >= MIN_REACT_BREAK_COUNT && medianBreak !== null) {
      classification = 'BREAKOUT';
      tpPt = Math.max(15, Math.round(medianBreak));
    }
    specByLabel.set(label, { classification, trainTouches: touches.length, trainReactPct: reactPct, trainBreakPct: breakPct, tpPt, medianReact, medianBreak });
  }

  // Phase 2: TEST — simulate trades using TRAIN-derived spec
  interface TestResult { wins: number; losses: number; expires: number; pnlPts: number; touches: number; }
  const testResultByLabel = new Map<string, TestResult>();
  for (const day of testDays) {
    const entry = levelsFile.days[day]?.levels.find(l => l.symbol === symbol);
    if (!entry) continue;
    const rthStart = etDateTimeToMs(day, 9, 30);
    const rthEnd = etDateTimeToMs(day, 16, 0);
    const sessionTicks = ticks.prepare(
      `SELECT ts, price FROM trades WHERE symbol=? AND ts >= ? AND ts < ? ORDER BY ts ASC`
    ).all(symbol, rthStart, rthEnd) as Array<{ ts: number; price: number }>;
    for (const lvl of collectLevels(entry)) {
      const spec = specByLabel.get(lvl.label);
      if (!spec || (spec.classification !== 'FADE' && spec.classification !== 'BREAKOUT')) continue;
      const touchIdx = findFirstTouchIdx(sessionTicks, rthStart, rthEnd, lvl.price);
      if (touchIdx === -1) continue;
      const touchTs = sessionTicks[touchIdx]!.ts;
      const touchPrice = sessionTicks[touchIdx]!.price;
      // Approach dir
      let preIdx = touchIdx;
      while (preIdx > 0 && sessionTicks[preIdx]!.ts > touchTs - PRE_MS) preIdx--;
      const delta = touchPrice - sessionTicks[preIdx]!.price;
      if (Math.abs(delta) < 0.5) continue;
      const approachDir: 'up' | 'down' = delta > 0 ? 'up' : 'down';

      const strategyDir = spec.classification === 'FADE' ? 'against' : 'with';
      const trade = simulateTrade(sessionTicks, touchIdx, approachDir, strategyDir, spec.tpPt!, SL_PT, rthEnd);
      const r = testResultByLabel.get(lvl.label) ?? { wins: 0, losses: 0, expires: 0, pnlPts: 0, touches: 0 };
      r.touches++;
      if (trade.outcome === 'TP') r.wins++;
      else if (trade.outcome === 'SL') r.losses++;
      else r.expires++;
      r.pnlPts += trade.pnlPts;
      testResultByLabel.set(lvl.label, r);
    }
  }

  // Output
  const pad = (s: string, n: number, right = false) => right ? s.padStart(n) : s.padEnd(n);
  const rows: Array<{ label: string; spec: Spec; test: TestResult | null }> = [];
  for (const label of allLabels) {
    const spec = specByLabel.get(label)!;
    const test = testResultByLabel.get(label) ?? null;
    rows.push({ label, spec, test });
  }
  // Sort by TEST $/touch desc (so traded-and-profitable rises to top), classification, label
  rows.sort((a, b) => {
    const aPnl = a.test ? (a.test.pnlPts * DOLLAR_PER_PT / Math.max(1, a.test.touches)) : -Infinity;
    const bPnl = b.test ? (b.test.pnlPts * DOLLAR_PER_PT / Math.max(1, b.test.touches)) : -Infinity;
    return bPnl - aPnl;
  });

  console.log('┌──────────────┬──────────────┬───────┬──────────────┬─────────┬───────┬──────────────────────┬──────────────────┐');
  console.log('│ Level        │ Classified   │ TP    │ TRAIN R%/B%  │ T-Tch   │ T-W/L │ TEST W-L-Exp         │ TEST $/touch     │');
  console.log('├──────────────┼──────────────┼───────┼──────────────┼─────────┼───────┼──────────────────────┼──────────────────┤');
  for (const { label, spec, test } of rows) {
    const tp = spec.tpPt !== null ? `${spec.tpPt}pt` : '—';
    const trainRB = spec.trainTouches >= MIN_TRAIN_TOUCHES
      ? `${spec.trainReactPct.toFixed(0)}/${spec.trainBreakPct.toFixed(0)} (${spec.trainTouches})`
      : `(${spec.trainTouches} tch)`;
    const testStr = test ? `${test.wins}-${test.losses}-${test.expires} (${test.touches})` : 'not tested';
    const testWL = test ? `${test.wins}/${test.losses}` : '—';
    const pnlStr = test
      ? (() => {
        const usd = test.pnlPts * DOLLAR_PER_PT;
        const perTouch = test.touches ? usd / test.touches : 0;
        return `${usd >= 0 ? '+$' : '-$'}${Math.abs(usd).toFixed(0)} (${perTouch >= 0 ? '+$' : '-$'}${Math.abs(perTouch).toFixed(1)}/t)`;
      })()
      : '—';
    console.log(
      `│ ${pad(label, 12)} │ ${pad(spec.classification, 12)} │ ${pad(tp, 5, true)} │ ${pad(trainRB, 12)} │ ${pad(String(test?.touches ?? 0), 7, true)} │ ${pad(testWL, 5, true)} │ ${pad(testStr, 20)} │ ${pad(pnlStr, 16)} │`
    );
  }
  console.log('└──────────────┴──────────────┴───────┴──────────────┴─────────┴───────┴──────────────────────┴──────────────────┘');

  // Aggregate stats
  let totalTestTouches = 0, totalTestWins = 0, totalTestLosses = 0, totalTestExpires = 0, totalTestPnl = 0;
  let fadeCount = 0, breakoutCount = 0, neutralCount = 0, sparseCount = 0;
  for (const { spec, test } of rows) {
    if (spec.classification === 'FADE') fadeCount++;
    else if (spec.classification === 'BREAKOUT') breakoutCount++;
    else if (spec.classification === 'NEUTRAL') neutralCount++;
    else sparseCount++;
    if (test) {
      totalTestTouches += test.touches;
      totalTestWins += test.wins;
      totalTestLosses += test.losses;
      totalTestExpires += test.expires;
      totalTestPnl += test.pnlPts;
    }
  }
  console.log(`\nClassified from TRAIN: FADE=${fadeCount} BREAKOUT=${breakoutCount} NEUTRAL=${neutralCount} SPARSE=${sparseCount}`);
  console.log(`TEST aggregate: ${totalTestTouches} touches, ${totalTestWins}W / ${totalTestLosses}L / ${totalTestExpires}Exp`);
  console.log(`TEST aggregate PnL: ${totalTestPnl >= 0 ? '+$' : '-$'}${Math.abs(totalTestPnl * DOLLAR_PER_PT).toFixed(0)}  (avg ${totalTestPnl / Math.max(1, totalTestTouches) >= 0 ? '+$' : '-$'}${Math.abs(totalTestPnl * DOLLAR_PER_PT / Math.max(1, totalTestTouches)).toFixed(1)}/touch)\n`);

  ticks.close();
}

main();
