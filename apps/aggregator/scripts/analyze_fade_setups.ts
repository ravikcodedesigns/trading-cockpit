// analyze_fade_setups.ts
// Deep-dive on the RTH fade-candidate levels. For each label, walks all RTH
// sessions and records EVERY touch's outcome (react magnitude or break
// magnitude). Outputs full distribution (min/p25/median/p75/max) per level
// for both reactions (TP sizing) and breakouts (SL sizing).
//
// Cohort = fade candidates surfaced from backtest_rth_levels.ts (RTH window).

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const TICKS_DB = path.join(REPO_ROOT, 'data/ticks.db');
const LEVELS_PATH = path.join(REPO_ROOT, 'daily_levels.json');
const DOLLAR_PER_PT = 2; // MNQ

const FADE_CANDIDATES = ['WkH', 'WkL', 'onVAL', 'HG', 'POC', 'S1', 'DD↓'] as const;

// ── ET helpers
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
  days: Record<string, { levels: Array<{ symbol: string; additionalLevels?: LevelEntry[]; bullZone?: { low: number; high: number }; bearZone?: { low: number; high: number }; ddBands?: { upper: number; lower: number }; hedgePressure?: number; mhp?: number }> }>;
}

function collectLevelsForLabel(entry: NonNullable<DayLevelsFile['days'][string]>['levels'][number], targetLabel: string): number | null {
  if (entry.additionalLevels) {
    for (const lvl of entry.additionalLevels) if (lvl.label === targetLabel) return lvl.price;
  }
  if (targetLabel === 'DD↑' && entry.ddBands) return entry.ddBands.upper;
  if (targetLabel === 'DD↓' && entry.ddBands) return entry.ddBands.lower;
  if (targetLabel === 'HP' && entry.hedgePressure !== undefined) return entry.hedgePressure;
  if (targetLabel === 'MHP' && entry.mhp !== undefined) return entry.mhp;
  if (targetLabel === 'Bull L' && entry.bullZone) return entry.bullZone.low;
  if (targetLabel === 'Bear H' && entry.bearZone) return entry.bearZone.high;
  return null;
}

interface TouchOutcome {
  day: string;
  approachDir: 'up' | 'down';
  outcome: 'REACT' | 'BREAK' | 'NEITHER';
  reactPts: number;       // max favorable move (against approach) within window
  breakPts: number;       // max adverse move (with approach) within window
  timeToReactMs?: number; // ms from touch to first hitting 10pt against approach
  timeToBreakMs?: number; // ms from touch to first hitting 10pt with approach
}

const TOUCH_PT = 1.0;
const REACT_PT = 10;
const BREAK_PT = 10;
const WINDOW_MS = 60 * 60_000;
const PRE_MS = 5 * 60_000;

function evaluateSession(
  ticks: Array<{ ts: number; price: number }>,
  rthStart: number, rthEnd: number,
  level: number, day: string,
): TouchOutcome | null {
  // First touch in RTH window
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
  const prePrice = ticks[preIdx]!.price;
  const delta = touchPrice - prePrice;
  if (Math.abs(delta) < 0.5) return { day, approachDir: 'up', outcome: 'NEITHER', reactPts: 0, breakPts: 0 };
  const approachDir: 'up' | 'down' = delta > 0 ? 'up' : 'down';

  const endTs = Math.min(touchTs + WINDOW_MS, rthEnd);
  let outcome: 'REACT' | 'BREAK' | 'NEITHER' = 'NEITHER';
  let maxAgainst = 0, maxWith = 0;
  let timeToReactMs: number | undefined, timeToBreakMs: number | undefined;
  for (let i = firstIdx + 1; i < ticks.length && ticks[i]!.ts <= endTs; i++) {
    const dp = ticks[i]!.price - touchPrice;
    const dpWith = approachDir === 'up' ? dp : -dp;
    const dpAgainst = -dpWith;
    if (dpWith > maxWith) maxWith = dpWith;
    if (dpAgainst > maxAgainst) maxAgainst = dpAgainst;
    if (outcome === 'NEITHER') {
      if (dpAgainst >= REACT_PT) { outcome = 'REACT'; timeToReactMs = ticks[i]!.ts - touchTs; }
      else if (dpWith >= BREAK_PT) { outcome = 'BREAK'; timeToBreakMs = ticks[i]!.ts - touchTs; }
    }
  }
  return { day, approachDir, outcome, reactPts: maxAgainst, breakPts: maxWith, timeToReactMs, timeToBreakMs };
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function main() {
  const symbol = 'NQ';
  const levelsFile = JSON.parse(fs.readFileSync(LEVELS_PATH, 'utf-8')) as DayLevelsFile;
  const ticks = new Database(TICKS_DB, { readonly: true });
  ticks.pragma('journal_mode = WAL');

  const sessionDays = Object.keys(levelsFile.days).sort();
  console.log(`\n══ Fade-setup deep-dive — ${symbol} RTH session ══`);
  console.log(`Params: touch=±${TOUCH_PT}pt  react=≥${REACT_PT}pt  break=≥${BREAK_PT}pt  window=${WINDOW_MS / 60_000}min\n`);

  const perLabel = new Map<string, TouchOutcome[]>();
  for (const lbl of FADE_CANDIDATES) perLabel.set(lbl, []);

  let sessionsScanned = 0;
  for (const day of sessionDays) {
    const entry = levelsFile.days[day]?.levels.find(l => l.symbol === symbol);
    if (!entry) continue;
    const rthStart = etDateTimeToMs(day, 9, 30);
    const rthEnd = etDateTimeToMs(day, 16, 0);
    const tickCount = (ticks.prepare(
      `SELECT COUNT(*) AS n FROM trades WHERE symbol=? AND ts >= ? AND ts < ?`
    ).get(symbol, rthStart, rthEnd) as { n: number }).n;
    if (tickCount < 10000) continue;
    sessionsScanned++;

    const sessionTicks = ticks.prepare(
      `SELECT ts, price FROM trades WHERE symbol=? AND ts >= ? AND ts < ? ORDER BY ts ASC`
    ).all(symbol, rthStart, rthEnd) as Array<{ ts: number; price: number }>;

    for (const lbl of FADE_CANDIDATES) {
      const price = collectLevelsForLabel(entry, lbl);
      if (price === null) continue;
      const r = evaluateSession(sessionTicks, rthStart, rthEnd, price, day);
      if (r) perLabel.get(lbl)!.push(r);
    }
  }

  console.log(`Sessions scanned: ${sessionsScanned}\n`);

  // Per-level distribution
  for (const lbl of FADE_CANDIDATES) {
    const arr = perLabel.get(lbl)!;
    const reacts = arr.filter(a => a.outcome === 'REACT').map(a => a.reactPts);
    const breaks = arr.filter(a => a.outcome === 'BREAK').map(a => a.breakPts);
    const touches = arr.length;
    const reactPct = touches ? 100 * reacts.length / touches : 0;
    const breakPct = touches ? 100 * breaks.length / touches : 0;
    const timeToReactMin = arr.filter(a => a.timeToReactMs).map(a => a.timeToReactMs! / 60_000);

    console.log(`── ${lbl} ──`);
    console.log(`  Touches:     ${touches}  (react ${reacts.length} / break ${breaks.length} / neither ${touches - reacts.length - breaks.length})`);
    console.log(`  React%:      ${reactPct.toFixed(1)}%   Break%:  ${breakPct.toFixed(1)}%`);
    if (reacts.length > 0) {
      console.log(`  React magnitude (pt): min=${Math.min(...reacts).toFixed(1)}  p25=${percentile(reacts, 25).toFixed(1)}  median=${percentile(reacts, 50).toFixed(1)}  p75=${percentile(reacts, 75).toFixed(1)}  max=${Math.max(...reacts).toFixed(1)}  mean=${(reacts.reduce((s, x) => s + x, 0) / reacts.length).toFixed(1)}`);
    }
    if (breaks.length > 0) {
      console.log(`  Break magnitude (pt): min=${Math.min(...breaks).toFixed(1)}  p25=${percentile(breaks, 25).toFixed(1)}  median=${percentile(breaks, 50).toFixed(1)}  p75=${percentile(breaks, 75).toFixed(1)}  max=${Math.max(...breaks).toFixed(1)}  mean=${(breaks.reduce((s, x) => s + x, 0) / breaks.length).toFixed(1)}`);
    }
    if (timeToReactMin.length > 0) {
      console.log(`  Time-to-react (min):  min=${Math.min(...timeToReactMin).toFixed(0)}  median=${percentile(timeToReactMin, 50).toFixed(0)}  max=${Math.max(...timeToReactMin).toFixed(0)}`);
    }
    // Recommended TP/SL
    if (reacts.length >= 3 && breaks.length >= 1) {
      const tpConservative = Math.max(15, Math.floor(percentile(reacts, 25)));
      const tpModerate = Math.max(20, Math.floor(percentile(reacts, 50)));
      const tpStretch = Math.max(30, Math.floor(percentile(reacts, 75)));
      // SL: tight enough to limit damage, loose enough to weather noise. Use
      // p25 of break (most failures get to here fast).
      const slBreakBase = Math.max(10, Math.ceil(percentile(breaks, 25)));
      console.log(`  → SUGGESTED:  SL=${slBreakBase}pt  |  TP1=${tpConservative}pt (conservative, ~75% capture)  TP2=${tpModerate}pt (median)  TP3=${tpStretch}pt (stretch, ~25% capture)`);
    } else if (reacts.length >= 3) {
      const tpModerate = Math.max(20, Math.floor(percentile(reacts, 50)));
      console.log(`  → SUGGESTED:  SL=15pt (no break data)  |  TP=${tpModerate}pt (median)`);
    }
    console.log('');
  }

  ticks.close();
}

main();
