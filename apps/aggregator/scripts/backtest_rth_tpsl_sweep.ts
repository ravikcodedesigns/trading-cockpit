// backtest_rth_tpsl_sweep.ts
// Sweep TP/SL grid on TEST set for the 10 levels classified by TRAIN.
// Classification (FADE/BREAKOUT) is FROZEN from TRAIN. Only the TP and SL
// values vary — same TP/SL applied uniformly across all levels per combo.
//
// Outputs:
//   1. Grid: total $ for each (TP, SL) pair
//   2. Top 5 combos by total $
//   3. Per-level breakdown at the winning combo

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const TICKS_DB = path.join(REPO_ROOT, 'data/ticks.db');
const LEVELS_PATH = path.join(REPO_ROOT, 'daily_levels.json');
const DOLLAR_PER_PT = 2;

const TOUCH_PT = 1.0;
const REACT_PT = 10;
const BREAK_PT = 10;
const PRE_MS = 5 * 60_000;
// 2026-06-10: removed WINDOW_MS cap (was 60min). Per user's spec, trades walk
// forward from touch until TP hits, SL hits, or 15:54 ET (RTH close − 6min
// MOC buffer) — whichever comes FIRST. If neither TP nor SL hits by 15:54,
// the position closes at the last tick price; that PnL contributes to the
// level's total. No artificial time-in-trade cap.
function rthCloseMsFor(day: string): number {
  return etDateTimeToMs(day, 15, 54);
}

const TRAIN_DAYS = 12;
const MIN_TRAIN_TOUCHES = 3;
const MIN_REACT_BREAK_COUNT = 3;
const FADE_THRESHOLD = 60;
const BREAKOUT_THRESHOLD = 60;

const TP_GRID = [25, 30, 35, 40, 50, 60, 75, 100];
const SL_GRID = [10, 12, 15, 18, 20, 25];

const LOOKAHEAD_LABELS = new Set(['IBH', 'IBL', 'RTHO', 'VWAP', 'HVN1', 'HVN2', 'LVN↑', 'LVN↓', 'nPOC']);

// Drop these labels even if TRAIN classifies them — the first sweep showed
// they bleed money across nearly all TP/SL combos. (2026-06-10: gnVWAP/onPOC/
// POC/DD↑ removed per Ravi.) Re-run from scratch will refresh this list.
const EXCLUDE_LABELS = new Set(['gnVWAP', 'onPOC', 'POC', 'DD↑', 'R1']);

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
function collectLevels(entry: NonNullable<DayLevelsFile['days'][string]>['levels'][number]): LevelEntry[] {
  const out: LevelEntry[] = [];
  if (entry.additionalLevels) for (const lvl of entry.additionalLevels) if (!LOOKAHEAD_LABELS.has(lvl.label)) out.push(lvl);
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

interface Touch { reactPts: number; breakPts: number; reactedFirst: boolean; brokeFirst: boolean; }
function evaluateFirstTouch(
  ticks: Array<{ ts: number; price: number }>,
  rthStart: number, rthEnd: number, level: number,
): { touchIdx: number; approachDir: 'up' | 'down'; outcome: Touch } | null {
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

  // Walk to 15:54 ET (or end of available ticks). No 60-min cap.
  const endTs = rthEnd;
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
  return { touchIdx: firstIdx, approachDir, outcome: { reactPts: maxAgainst, breakPts: maxWith, reactedFirst, brokeFirst } };
}

function simulateTrade(
  ticks: Array<{ ts: number; price: number }>,
  touchIdx: number,
  approachDir: 'up' | 'down',
  classification: 'FADE' | 'BREAKOUT',
  tpPt: number, slPt: number, rthEnd: number,
): { outcome: 'TP' | 'SL' | 'EXPIRE'; pnlPts: number } {
  const touchTs = ticks[touchIdx]!.ts;
  const touchPrice = ticks[touchIdx]!.price;
  const tradeDir: 'long' | 'short' = classification === 'FADE'
    ? (approachDir === 'up' ? 'short' : 'long')
    : (approachDir === 'up' ? 'long' : 'short');
  // Walk to 15:54 ET. No artificial time cap.
  const endTs = rthEnd;
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

interface CachedTouch { day: string; label: string; classification: 'FADE' | 'BREAKOUT'; touchIdx: number; approachDir: 'up' | 'down'; sessionTicks: Array<{ ts: number; price: number }>; rthEnd: number; }

function main() {
  const symbol = 'NQ';
  const levelsFile = JSON.parse(fs.readFileSync(LEVELS_PATH, 'utf-8')) as DayLevelsFile;
  const ticks = new Database(TICKS_DB, { readonly: true });
  ticks.pragma('journal_mode = WAL');

  // Build valid session list
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
  const trainDays = validDays.slice(0, TRAIN_DAYS);
  const testDays = validDays.slice(TRAIN_DAYS);

  console.log(`\n══ RTH TP/SL sweep — ${symbol} ══`);
  console.log(`TRAIN ${trainDays.length}d: ${trainDays[0]} → ${trainDays[trainDays.length - 1]}`);
  console.log(`TEST  ${testDays.length}d: ${testDays[0]} → ${testDays[testDays.length - 1]}`);
  console.log(`TP grid:  [${TP_GRID.join(', ')}] pt`);
  console.log(`SL grid:  [${SL_GRID.join(', ')}] pt`);
  console.log(`Classification frozen from TRAIN (FADE/BREAKOUT only — NEUTRAL/SPARSE excluded)\n`);

  // Phase 1: TRAIN — classify labels
  const trainTouchesByLabel = new Map<string, Touch[]>();
  for (const day of trainDays) {
    const entry = levelsFile.days[day]?.levels.find(l => l.symbol === symbol);
    if (!entry) continue;
    const rthStart = etDateTimeToMs(day, 9, 30);
    const rthEndTicks = etDateTimeToMs(day, 16, 0);  // for tick fetch only
    const rthEnd = rthCloseMsFor(day);                // 15:54 ET — touch + walk boundary
    const sessionTicks = ticks.prepare(
      `SELECT ts, price FROM trades WHERE symbol=? AND ts >= ? AND ts < ? ORDER BY ts ASC`
    ).all(symbol, rthStart, rthEndTicks) as Array<{ ts: number; price: number }>;
    for (const lvl of collectLevels(entry)) {
      const r = evaluateFirstTouch(sessionTicks, rthStart, rthEnd, lvl.price);
      if (r) {
        const arr = trainTouchesByLabel.get(lvl.label) ?? [];
        arr.push(r.outcome);
        trainTouchesByLabel.set(lvl.label, arr);
      }
    }
  }

  const classifications = new Map<string, 'FADE' | 'BREAKOUT'>();
  for (const [label, touches] of trainTouchesByLabel) {
    if (touches.length < MIN_TRAIN_TOUCHES) continue;
    const reacts = touches.filter(t => t.reactedFirst).length;
    const breaks = touches.filter(t => t.brokeFirst).length;
    const reactPct = 100 * reacts / touches.length;
    const breakPct = 100 * breaks / touches.length;
    if (EXCLUDE_LABELS.has(label)) continue;
    if (reactPct >= FADE_THRESHOLD && reacts >= MIN_REACT_BREAK_COUNT) classifications.set(label, 'FADE');
    else if (breakPct >= BREAKOUT_THRESHOLD && breaks >= MIN_REACT_BREAK_COUNT) classifications.set(label, 'BREAKOUT');
  }
  console.log(`Classified labels: ${[...classifications.entries()].map(([l, c]) => `${l}=${c}`).join(', ')}\n`);

  // Phase 2: pre-collect TEST touches (only for classified labels)
  const testTouches: CachedTouch[] = [];
  for (const day of testDays) {
    const entry = levelsFile.days[day]?.levels.find(l => l.symbol === symbol);
    if (!entry) continue;
    const rthStart = etDateTimeToMs(day, 9, 30);
    const rthEndTicks = etDateTimeToMs(day, 16, 0);  // for tick fetch only
    const rthEnd = rthCloseMsFor(day);                // 15:54 ET — touch + walk boundary
    const sessionTicks = ticks.prepare(
      `SELECT ts, price FROM trades WHERE symbol=? AND ts >= ? AND ts < ? ORDER BY ts ASC`
    ).all(symbol, rthStart, rthEndTicks) as Array<{ ts: number; price: number }>;
    for (const lvl of collectLevels(entry)) {
      const cls = classifications.get(lvl.label);
      if (!cls) continue;
      const r = evaluateFirstTouch(sessionTicks, rthStart, rthEnd, lvl.price);
      if (r) {
        testTouches.push({ day, label: lvl.label, classification: cls, touchIdx: r.touchIdx, approachDir: r.approachDir, sessionTicks, rthEnd });
      }
    }
  }
  console.log(`TEST touches gathered: ${testTouches.length}\n`);

  // Phase 3: sweep grid
  interface ComboResult { tp: number; sl: number; wins: number; losses: number; expires: number; pnlPts: number; perLabel: Map<string, { w: number; l: number; e: number; pnl: number }>; }
  const results: ComboResult[] = [];
  for (const tp of TP_GRID) {
    for (const sl of SL_GRID) {
      const combo: ComboResult = { tp, sl, wins: 0, losses: 0, expires: 0, pnlPts: 0, perLabel: new Map() };
      for (const t of testTouches) {
        const trade = simulateTrade(t.sessionTicks, t.touchIdx, t.approachDir, t.classification, tp, sl, t.rthEnd);
        if (trade.outcome === 'TP') combo.wins++;
        else if (trade.outcome === 'SL') combo.losses++;
        else combo.expires++;
        combo.pnlPts += trade.pnlPts;
        const lr = combo.perLabel.get(t.label) ?? { w: 0, l: 0, e: 0, pnl: 0 };
        if (trade.outcome === 'TP') lr.w++; else if (trade.outcome === 'SL') lr.l++; else lr.e++;
        lr.pnl += trade.pnlPts;
        combo.perLabel.set(t.label, lr);
      }
      results.push(combo);
    }
  }

  // Output: grid total $
  const pad = (s: string, n: number, right = false) => right ? s.padStart(n) : s.padEnd(n);
  console.log(`── Grid: total $ across all ${testTouches.length} TEST touches ──`);
  let header = '       ';
  for (const sl of SL_GRID) header += pad(`SL=${sl}`, 9, true);
  console.log(header);
  for (const tp of TP_GRID) {
    let line = pad(`TP=${tp}`, 7, false);
    for (const sl of SL_GRID) {
      const r = results.find(x => x.tp === tp && x.sl === sl)!;
      const usd = r.pnlPts * DOLLAR_PER_PT;
      const cellStr = usd >= 0 ? `+$${usd.toFixed(0)}` : `-$${Math.abs(usd).toFixed(0)}`;
      line += pad(cellStr, 9, true);
    }
    console.log(line);
  }

  // Top 5 combos
  results.sort((a, b) => b.pnlPts - a.pnlPts);
  console.log(`\n── Top 5 combos by total $ ──`);
  console.log('  TP / SL   |  W /  L / E  |  Win%  |  Total $   |  $/touch');
  console.log('  ─────────────────────────────────────────────────────────');
  for (let i = 0; i < 5 && i < results.length; i++) {
    const r = results[i]!;
    const n = r.wins + r.losses + r.expires;
    const winPct = n ? (100 * r.wins / n).toFixed(0) : '—';
    const usd = r.pnlPts * DOLLAR_PER_PT;
    const usdStr = usd >= 0 ? `+$${usd.toFixed(0)}` : `-$${Math.abs(usd).toFixed(0)}`;
    const perT = n ? r.pnlPts * DOLLAR_PER_PT / n : 0;
    const perTStr = perT >= 0 ? `+$${perT.toFixed(1)}` : `-$${Math.abs(perT).toFixed(1)}`;
    console.log(`  ${pad(`${r.tp}/${r.sl}`, 9)} | ${pad(`${r.wins}/${r.losses}/${r.expires}`, 12)} | ${pad(winPct + '%', 6, true)} | ${pad(usdStr, 10, true)} | ${pad(perTStr, 8, true)}`);
  }

  // Per-label breakdown at best combo
  const best = results[0]!;
  console.log(`\n── Per-level breakdown at best combo (TP=${best.tp}, SL=${best.sl}) ──`);
  console.log('  Label        | Class      |  W /  L / E  |  Win%  |  Total $   |  $/touch');
  console.log('  ──────────────────────────────────────────────────────────────────────────');
  const labelRows = [...best.perLabel.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
  for (const [label, lr] of labelRows) {
    const cls = classifications.get(label)!;
    const n = lr.w + lr.l + lr.e;
    const winPct = n ? (100 * lr.w / n).toFixed(0) : '—';
    const usd = lr.pnl * DOLLAR_PER_PT;
    const usdStr = usd >= 0 ? `+$${usd.toFixed(0)}` : `-$${Math.abs(usd).toFixed(0)}`;
    const perT = n ? lr.pnl * DOLLAR_PER_PT / n : 0;
    const perTStr = perT >= 0 ? `+$${perT.toFixed(1)}` : `-$${Math.abs(perT).toFixed(1)}`;
    console.log(`  ${pad(label, 12)} | ${pad(cls, 10)} | ${pad(`${lr.w}/${lr.l}/${lr.e}`, 12)} | ${pad(winPct + '%', 6, true)} | ${pad(usdStr, 10, true)} | ${pad(perTStr, 8, true)}`);
  }

  // Per-label breakdown at requested cell (TP=50, SL=20) — for comparison.
  const PROBE_TP = 50, PROBE_SL = 20;
  const probe = results.find(r => r.tp === PROBE_TP && r.sl === PROBE_SL);
  if (probe) {
    console.log(`\n── Per-level breakdown at probe combo (TP=${PROBE_TP}, SL=${PROBE_SL}) ──`);
    console.log('  Label        | Class      |  W /  L / E  |  Win%  |  Total $   |  $/touch');
    console.log('  ──────────────────────────────────────────────────────────────────────────');
    const probeRows = [...probe.perLabel.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
    for (const [label, lr] of probeRows) {
      const cls = classifications.get(label)!;
      const n = lr.w + lr.l + lr.e;
      const winPct = n ? (100 * lr.w / n).toFixed(0) : '—';
      const usd = lr.pnl * DOLLAR_PER_PT;
      const usdStr = usd >= 0 ? `+$${usd.toFixed(0)}` : `-$${Math.abs(usd).toFixed(0)}`;
      const perT = n ? lr.pnl * DOLLAR_PER_PT / n : 0;
      const perTStr = perT >= 0 ? `+$${perT.toFixed(1)}` : `-$${Math.abs(perT).toFixed(1)}`;
      console.log(`  ${pad(label, 12)} | ${pad(cls, 10)} | ${pad(`${lr.w}/${lr.l}/${lr.e}`, 12)} | ${pad(winPct + '%', 6, true)} | ${pad(usdStr, 10, true)} | ${pad(perTStr, 8, true)}`);
    }
  }

  ticks.close();
}

main();
