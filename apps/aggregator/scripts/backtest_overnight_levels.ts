// backtest_overnight_levels.ts
// For each historical overnight session (18:00 ET D → 09:30 ET D+1),
// measure how price interacts with the prior day's structural levels:
//   - Touch rate  : % of sessions where price came within TOUCH_PT of the level
//   - React rate  : % of touches where price reversed ≥ REACT_PT within REACT_MIN
//   - Break rate  : % of touches where price continued ≥ BREAK_PT in approach dir
//   - Mean react / break magnitude  (in points, dollar-equiv via $2/pt MNQ)
//
// Per-label table is meant to surface which levels are tradable as fades
// (high react %, meaningful magnitude) vs breakouts (high break %) vs reference-only.
//
// Conventions:
//   - "Approach direction" = direction price was moving in the 5 min before first touch
//     (computed from price change vs 5-min-prior tick).
//   - Reversal/continuation measured in the 60 min AFTER first touch.
//   - If both REACT and BREAK conditions trip, the FIRST one chronologically wins.
//
// Usage:
//   pnpm --filter @trading/aggregator exec tsx scripts/backtest_overnight_levels.ts
//   pnpm --filter @trading/aggregator exec tsx scripts/backtest_overnight_levels.ts --symbol NQ --touch 1.0 --react 10 --break 10 --window 60

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const TICKS_DB = path.join(REPO_ROOT, 'data/ticks.db');
const LEVELS_BY_SYMBOL: Record<string, string> = {
  NQ: path.join(REPO_ROOT, 'daily_levels.json'),
  ES: path.join(REPO_ROOT, 'daily_levels_es.json'),
};
const DOLLAR_PER_PT = 2; // MNQ

// ---- args ----
function parseArgs() {
  const argv = process.argv.slice(2);
  let symbol = 'NQ';
  let touchPt = 1.0;          // proximity to count as touch (1pt = 4 ticks)
  let reactPt = 10;           // points moved against approach to count as reaction
  let breakPt = 10;           // points moved with approach to count as breakout
  let windowMin = 60;         // minutes after first touch to evaluate
  let preMin = 5;             // minutes before touch used to infer approach direction
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--symbol') symbol = argv[++i].toUpperCase();
    else if (argv[i] === '--touch') touchPt = parseFloat(argv[++i]);
    else if (argv[i] === '--react') reactPt = parseFloat(argv[++i]);
    else if (argv[i] === '--break') breakPt = parseFloat(argv[++i]);
    else if (argv[i] === '--window') windowMin = parseInt(argv[++i], 10);
    else if (argv[i] === '--pre') preMin = parseInt(argv[++i], 10);
  }
  return { symbol, touchPt, reactPt, breakPt, windowMin, preMin };
}

// ---- ET/UTC helpers ----
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function dayOfWeek(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function etOffsetHours(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, m - 1, d, 12, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(utcNoon);
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  return hour - 12;
}
function etDateTimeToMs(date: string, hh: number, mm: number): number {
  const offset = etOffsetHours(date);
  const [y, mo, d] = date.split('-').map(Number);
  return Date.UTC(y, mo - 1, d, hh - offset, mm);
}
function findNextTradingDay(day: string): string {
  for (let i = 1; i <= 7; i++) {
    const c = addDays(day, i);
    const dow = dayOfWeek(c);
    if (dow !== 0 && dow !== 6) return c;
  }
  throw new Error(`No next trading day from ${day}`);
}

// ---- types ----
interface LevelEntry { price: number; label: string; }
interface DayLevelsFile {
  days: Record<string, { levels: Array<{ symbol: string; additionalLevels?: LevelEntry[] }> }>;
}

interface TouchResult {
  label: string;
  basePrice: number;
  touched: boolean;
  approachDir?: 'up' | 'down';       // direction of approach (price moving up = approach from below)
  reactPts?: number;                  // pts moved AGAINST approach within window (positive = reaction)
  breakPts?: number;                  // pts moved WITH approach within window (positive = breakout)
  outcome?: 'REACT' | 'BREAK' | 'NEITHER';
}

// ---- main ----
function main() {
  const { symbol, touchPt, reactPt, breakPt, windowMin, preMin } = parseArgs();
  const levelsPath = LEVELS_BY_SYMBOL[symbol];
  if (!levelsPath || !fs.existsSync(levelsPath)) {
    console.error(`No levels file for ${symbol}`);
    process.exit(1);
  }

  const levelsFile = JSON.parse(fs.readFileSync(levelsPath, 'utf-8')) as DayLevelsFile;
  const ticks = new Database(TICKS_DB, { readonly: true });
  ticks.pragma('journal_mode = WAL');

  // Walk all overnight sessions for which we have levels
  const sessionDays = Object.keys(levelsFile.days).sort();
  console.log(`\n══ Overnight level-behavior backtest — ${symbol} ══`);
  console.log(`Params: touch=±${touchPt}pt  react=≥${reactPt}pt  break=≥${breakPt}pt  window=${windowMin}min  pre=${preMin}min`);
  console.log(`Sessions in scope: ${sessionDays.length}\n`);

  // accumulator: label → {sessions, touches, reactions, breakouts, reactMagSum, breakMagSum}
  interface Stats {
    sessions: number;     // # sessions where level was defined
    touches: number;      // # sessions where price touched the level overnight
    reactions: number;    // # touches that produced a reaction
    breakouts: number;    // # touches that produced a breakout
    reactPtsSum: number;  // sum of reaction magnitudes (across touches that reacted)
    breakPtsSum: number;  // sum of breakout magnitudes (across touches that broke)
  }
  const stats = new Map<string, Stats>();

  let sessionsProcessed = 0;
  let sessionsSkipped = 0;

  for (const day of sessionDays) {
    const entry = levelsFile.days[day]?.levels.find(l => l.symbol === symbol);
    if (!entry || !entry.additionalLevels || entry.additionalLevels.length === 0) {
      sessionsSkipped++;
      continue;
    }

    let nextDay: string;
    try {
      nextDay = findNextTradingDay(day);
    } catch {
      sessionsSkipped++;
      continue;
    }
    const sessionStart = etDateTimeToMs(day, 18, 0);       // 18:00 ET day
    const sessionEnd = etDateTimeToMs(nextDay, 9, 30);     // 09:30 ET next day

    // Confirm we have ticks for this overnight window
    const tickCount = (ticks.prepare(
      `SELECT COUNT(*) AS n FROM trades WHERE symbol=? AND ts >= ? AND ts < ?`
    ).get(symbol, sessionStart, sessionEnd) as { n: number }).n;
    if (tickCount < 1000) {
      sessionsSkipped++;
      continue;
    }
    sessionsProcessed++;

    // Pull all ticks for the session into memory (we'll need to scan multiple
    // times per level, but each session is bounded ~12,000 ticks/hour × 15.5 hr ≈ 200K).
    const sessionTicks = ticks.prepare(
      `SELECT ts, price FROM trades WHERE symbol=? AND ts >= ? AND ts < ? ORDER BY ts ASC`
    ).all(symbol, sessionStart, sessionEnd) as Array<{ ts: number; price: number }>;
    if (sessionTicks.length === 0) continue;

    for (const lvl of entry.additionalLevels) {
      const r = evaluateLevel(sessionTicks, lvl, touchPt, reactPt, breakPt, windowMin, preMin);
      const s = stats.get(r.label) ?? { sessions: 0, touches: 0, reactions: 0, breakouts: 0, reactPtsSum: 0, breakPtsSum: 0 };
      s.sessions++;
      if (r.touched) {
        s.touches++;
        if (r.outcome === 'REACT') {
          s.reactions++;
          s.reactPtsSum += r.reactPts!;
        } else if (r.outcome === 'BREAK') {
          s.breakouts++;
          s.breakPtsSum += r.breakPts!;
        }
      }
      stats.set(r.label, s);
    }
  }

  console.log(`Processed: ${sessionsProcessed}  Skipped: ${sessionsSkipped}\n`);

  // Sort labels by touch rate descending
  const rows = [...stats.entries()]
    .filter(([_, s]) => s.sessions >= 5)
    .sort((a, b) => (b[1].touches / b[1].sessions) - (a[1].touches / a[1].sessions));

  // Print table
  const pad = (s: string, n: number, right = false) => right ? s.padStart(n) : s.padEnd(n);
  console.log('┌──────────────┬───────┬─────────┬──────────────┬──────────────┬────────────┬────────────┬──────────────┐');
  console.log('│ Level        │  Sess │  Touch% │ React/Touch  │ Break/Touch  │  Avg React │  Avg Break │ React$-Break$│');
  console.log('├──────────────┼───────┼─────────┼──────────────┼──────────────┼────────────┼────────────┼──────────────┤');
  for (const [label, s] of rows) {
    const touchPct = s.sessions ? (100 * s.touches / s.sessions).toFixed(1) + '%' : '—';
    const reactPctOfTouch = s.touches ? (100 * s.reactions / s.touches).toFixed(1) + '%' : '—';
    const breakPctOfTouch = s.touches ? (100 * s.breakouts / s.touches).toFixed(1) + '%' : '—';
    const avgReact = s.reactions ? (s.reactPtsSum / s.reactions).toFixed(1) + 'pt' : '—';
    const avgBreak = s.breakouts ? (s.breakPtsSum / s.breakouts).toFixed(1) + 'pt' : '—';
    // "Fade-EV" proxy per touch: avg(react$) × P(react|touch) − avg(break$) × P(break|touch)
    // assuming a 10pt-stop fade trade. Just informational.
    const fadeEvPerTouch = s.touches
      ? (((s.reactions ? s.reactPtsSum / s.touches : 0) - (s.breakouts ? s.breakPtsSum / s.touches : 0)) * DOLLAR_PER_PT).toFixed(1)
      : '—';
    const fadeStr = typeof fadeEvPerTouch === 'string' && fadeEvPerTouch !== '—'
      ? (parseFloat(fadeEvPerTouch) >= 0 ? '+$' : '-$') + Math.abs(parseFloat(fadeEvPerTouch)).toFixed(1)
      : '—';
    console.log(
      `│ ${pad(label, 12)} │ ${pad(String(s.sessions), 5, true)} │ ${pad(touchPct, 7, true)} │ ${pad(reactPctOfTouch + ' (' + s.reactions + ')', 12, true)} │ ${pad(breakPctOfTouch + ' (' + s.breakouts + ')', 12, true)} │ ${pad(avgReact, 10, true)} │ ${pad(avgBreak, 10, true)} │ ${pad(fadeStr, 12, true)} │`
    );
  }
  console.log('└──────────────┴───────┴─────────┴──────────────┴──────────────┴────────────┴────────────┴──────────────┘');
  console.log('\nNotes:');
  console.log('  - Sess  = # overnight sessions where this label existed in daily_levels.json');
  console.log('  - Touch% = % of sessions where price came within ±touchPt of the level');
  console.log('  - React/Touch = % of touches that reversed ≥reactPt within window');
  console.log('  - Break/Touch = % of touches that continued ≥breakPt in approach direction');
  console.log('  - React$-Break$ = naïve fade-EV per touch in MNQ $ (avg react $ − avg break $, both weighted by P(outcome|touch))');
  console.log('  - Higher React% + bigger Avg React = better mean-revert candidate.');
  console.log('  - Higher Break% + bigger Avg Break = better breakout-trigger candidate.\n');

  ticks.close();
}

function evaluateLevel(
  ticks: Array<{ ts: number; price: number }>,
  lvl: LevelEntry,
  touchPt: number,
  reactPt: number,
  breakPt: number,
  windowMin: number,
  preMin: number,
): TouchResult {
  const target = lvl.price;
  // Find first touch (price within touchPt of target)
  let firstIdx = -1;
  for (let i = 0; i < ticks.length; i++) {
    if (Math.abs(ticks[i]!.price - target) <= touchPt) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) {
    return { label: lvl.label, basePrice: target, touched: false };
  }
  const touchTs = ticks[firstIdx]!.ts;
  const touchPrice = ticks[firstIdx]!.price;

  // Approach direction: price preMin minutes ago vs now
  const preMs = preMin * 60_000;
  let preIdx = firstIdx;
  while (preIdx > 0 && ticks[preIdx]!.ts > touchTs - preMs) preIdx--;
  const prePrice = ticks[preIdx]!.price;
  const approachDelta = touchPrice - prePrice;
  // If preMin price > current, approach was from above (price dropping) → approachDir = 'down'
  // If preMin price < current, approach was from below (price rising) → approachDir = 'up'
  let approachDir: 'up' | 'down';
  if (Math.abs(approachDelta) < 0.5) {
    // No clear approach direction (price stationary) — skip outcome eval
    return { label: lvl.label, basePrice: target, touched: true, outcome: 'NEITHER' };
  }
  approachDir = approachDelta > 0 ? 'up' : 'down';

  // Walk forward windowMin minutes from first touch
  const endTs = touchTs + windowMin * 60_000;
  // REACT = price moves AGAINST approach by ≥reactPt
  // BREAK = price moves WITH approach by ≥breakPt
  // Whichever happens FIRST chronologically wins.
  let outcome: 'REACT' | 'BREAK' | 'NEITHER' = 'NEITHER';
  let reactMag = 0;
  let breakMag = 0;
  let maxAgainst = 0;
  let maxWith = 0;
  for (let i = firstIdx + 1; i < ticks.length && ticks[i]!.ts <= endTs; i++) {
    const dp = ticks[i]!.price - touchPrice;
    // delta in approach direction
    const dpWith = approachDir === 'up' ? dp : -dp;
    const dpAgainst = -dpWith;
    if (dpWith > maxWith) maxWith = dpWith;
    if (dpAgainst > maxAgainst) maxAgainst = dpAgainst;
    if (outcome === 'NEITHER') {
      if (dpAgainst >= reactPt) { outcome = 'REACT'; reactMag = dpAgainst; }
      else if (dpWith >= breakPt) { outcome = 'BREAK'; breakMag = dpWith; }
    }
  }
  // If outcome decided early, allow magnitude to keep growing (track max in that direction)
  if (outcome === 'REACT' && maxAgainst > reactMag) reactMag = maxAgainst;
  if (outcome === 'BREAK' && maxWith > breakMag) breakMag = maxWith;

  return {
    label: lvl.label, basePrice: target, touched: true, approachDir,
    reactPts: reactMag, breakPts: breakMag, outcome,
  };
}

main();
