// backtest_rth_levels.ts
// Same touch/react/break framework as backtest_overnight_levels.ts but applied
// to the RTH session (09:30-16:00 ET) with time-of-day buckets:
//   OPEN  : 09:30-10:30 (IB period, opening drive)
//   MID   : 10:30-14:30 (mid-session, lower volume)
//   CLOSE : 14:30-16:00 (close auction, MOC pressure)
//
// All labels found in daily_levels.json are evaluated:
//   - Original 9 morning labels: PDH/PDL/PDC/ONH/ONL/ONO/POC/VAH/VAL
//   - New 10 RTH-context (2026-06-10): PMH/PML/gnVWAP/onPOC/onVAH/onVAL/Pivot/R1/S1/Halfback
//   - Evening labels: IBH/IBL/RTHO/VWAP/HVN1/HVN2/LVN↑/LVN↓/WkH/WkL/nPOC
//     (note: these are derived from TODAY's RTH so are not predictive — included
//      only because they sit in the JSON; treat their results as descriptive)
//   - RS framework: Bull H/L, Bear H/L, DD↑/DD↓, HP, MHP, HG, ON HP, ON MHP
//   - Index opens: QQQ Open/Close, SPY Open/Close, etc.
//
// Per touch: first touch per (session × bucket × label) is the data point.
// Multiple touches in the same bucket count once (the first one).
//
// Usage:
//   pnpm --filter @trading/aggregator exec tsx scripts/backtest_rth_levels.ts
//   pnpm --filter @trading/aggregator exec tsx scripts/backtest_rth_levels.ts --touch 1 --react 10 --break 10 --window 60

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

function parseArgs() {
  const argv = process.argv.slice(2);
  let symbol = 'NQ';
  let touchPt = 1.0;
  let reactPt = 10;
  let breakPt = 10;
  let windowMin = 60;
  let preMin = 5;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--symbol') symbol = argv[++i]!.toUpperCase();
    else if (argv[i] === '--touch') touchPt = parseFloat(argv[++i]!);
    else if (argv[i] === '--react') reactPt = parseFloat(argv[++i]!);
    else if (argv[i] === '--break') breakPt = parseFloat(argv[++i]!);
    else if (argv[i] === '--window') windowMin = parseInt(argv[++i]!, 10);
    else if (argv[i] === '--pre') preMin = parseInt(argv[++i]!, 10);
  }
  return { symbol, touchPt, reactPt, breakPt, windowMin, preMin };
}

function etOffsetHours(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y!, m! - 1, d!, 12, 0));
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
  return Date.UTC(y!, mo! - 1, d!, hh - offset, mm);
}

interface LevelEntry { price: number; label: string; }
interface DayLevelsFile {
  days: Record<string, { levels: Array<{ symbol: string; additionalLevels?: LevelEntry[]; bullZone?: { low: number; high: number }; bearZone?: { low: number; high: number }; ddBands?: { upper: number; lower: number }; hedgePressure?: number; mhp?: number }> }>;
}

interface Bucket { name: 'OPEN' | 'MID' | 'CLOSE'; startMs: number; endMs: number; }
function bucketsFor(day: string): Bucket[] {
  return [
    { name: 'OPEN',  startMs: etDateTimeToMs(day, 9, 30),  endMs: etDateTimeToMs(day, 10, 30) },
    { name: 'MID',   startMs: etDateTimeToMs(day, 10, 30), endMs: etDateTimeToMs(day, 14, 30) },
    { name: 'CLOSE', startMs: etDateTimeToMs(day, 14, 30), endMs: etDateTimeToMs(day, 16, 0)  },
  ];
}

// Pull additionalLevels + any RS-framework derived levels into a single list per day.
function collectLevels(entry: NonNullable<DayLevelsFile['days'][string]>['levels'][number]): LevelEntry[] {
  const out: LevelEntry[] = [];
  if (entry.additionalLevels) out.push(...entry.additionalLevels);
  // Per Ravi's spec: only Bull Zone LOW (support edge) and Bear Zone HIGH
  // (resistance edge) are tradable. Skip the other end of each band. Many
  // historical days have width=0 bullZone/bearZone (low==high collapsed to a
  // single line) — emitting both ends would double-count the same touch.
  if (entry.bullZone) out.push({ price: entry.bullZone.low,  label: 'Bull L' });
  if (entry.bearZone) out.push({ price: entry.bearZone.high, label: 'Bear H' });
  if (entry.ddBands) {
    out.push({ price: entry.ddBands.upper, label: 'DD↑' });
    out.push({ price: entry.ddBands.lower, label: 'DD↓' });
  }
  if (entry.hedgePressure !== undefined) out.push({ price: entry.hedgePressure, label: 'HP' });
  if (entry.mhp !== undefined) out.push({ price: entry.mhp, label: 'MHP' });
  return out;
}

interface Stats {
  sessions: number;
  touches: number;
  reactions: number;
  breakouts: number;
  reactPtsSum: number;
  breakPtsSum: number;
}
function newStats(): Stats { return { sessions: 0, touches: 0, reactions: 0, breakouts: 0, reactPtsSum: 0, breakPtsSum: 0 }; }

function evaluateBucket(
  ticks: Array<{ ts: number; price: number }>,
  bucket: Bucket,
  target: number,
  touchPt: number,
  reactPt: number,
  breakPt: number,
  windowMs: number,
  preMs: number,
): { touched: boolean; outcome?: 'REACT' | 'BREAK' | 'NEITHER'; reactPts?: number; breakPts?: number } {
  // First touch INSIDE this bucket.
  let firstIdx = -1;
  for (let i = 0; i < ticks.length; i++) {
    if (ticks[i]!.ts < bucket.startMs) continue;
    if (ticks[i]!.ts >= bucket.endMs) break;
    if (Math.abs(ticks[i]!.price - target) <= touchPt) { firstIdx = i; break; }
  }
  if (firstIdx === -1) return { touched: false };

  const touchTs = ticks[firstIdx]!.ts;
  const touchPrice = ticks[firstIdx]!.price;

  // Approach direction: price preMin earlier vs touch (clamp to session start).
  let preIdx = firstIdx;
  while (preIdx > 0 && ticks[preIdx]!.ts > touchTs - preMs) preIdx--;
  const prePrice = ticks[preIdx]!.price;
  const approachDelta = touchPrice - prePrice;
  if (Math.abs(approachDelta) < 0.5) return { touched: true, outcome: 'NEITHER' };
  const approachDir: 'up' | 'down' = approachDelta > 0 ? 'up' : 'down';

  // Walk forward windowMin minutes (or until RTH close — whichever first).
  // Don't restrict to the bucket — reaction can span into next bucket.
  const rthEnd = etDateTimeToMs(
    new Date(touchTs).toISOString().slice(0, 10),
    16, 0,
  );
  const endTs = Math.min(touchTs + windowMs, rthEnd);
  let outcome: 'REACT' | 'BREAK' | 'NEITHER' = 'NEITHER';
  let reactMag = 0, breakMag = 0, maxAgainst = 0, maxWith = 0;
  for (let i = firstIdx + 1; i < ticks.length && ticks[i]!.ts <= endTs; i++) {
    const dp = ticks[i]!.price - touchPrice;
    const dpWith = approachDir === 'up' ? dp : -dp;
    const dpAgainst = -dpWith;
    if (dpWith > maxWith) maxWith = dpWith;
    if (dpAgainst > maxAgainst) maxAgainst = dpAgainst;
    if (outcome === 'NEITHER') {
      if (dpAgainst >= reactPt) { outcome = 'REACT'; reactMag = dpAgainst; }
      else if (dpWith >= breakPt) { outcome = 'BREAK'; breakMag = dpWith; }
    }
  }
  if (outcome === 'REACT' && maxAgainst > reactMag) reactMag = maxAgainst;
  if (outcome === 'BREAK' && maxWith > breakMag) breakMag = maxWith;
  return { touched: true, outcome, reactPts: reactMag, breakPts: breakMag };
}

function main() {
  const { symbol, touchPt, reactPt, breakPt, windowMin, preMin } = parseArgs();
  const levelsPath = LEVELS_BY_SYMBOL[symbol];
  if (!levelsPath || !fs.existsSync(levelsPath)) {
    console.error(`No levels file for ${symbol}`); process.exit(1);
  }
  const levelsFile = JSON.parse(fs.readFileSync(levelsPath, 'utf-8')) as DayLevelsFile;
  const ticks = new Database(TICKS_DB, { readonly: true });
  ticks.pragma('journal_mode = WAL');

  const windowMs = windowMin * 60_000;
  const preMs = preMin * 60_000;
  const sessionDays = Object.keys(levelsFile.days).sort();

  console.log(`\n══ RTH level-behavior backtest — ${symbol} ══`);
  console.log(`Params: touch=±${touchPt}pt  react=≥${reactPt}pt  break=≥${breakPt}pt  window=${windowMin}min  pre=${preMin}min`);
  console.log(`Buckets: OPEN 09:30-10:30  |  MID 10:30-14:30  |  CLOSE 14:30-16:00`);
  console.log(`Sessions in scope: ${sessionDays.length}\n`);

  // per-bucket stats per label
  const stats: Record<'OPEN' | 'MID' | 'CLOSE' | 'ALL', Map<string, Stats>> = {
    OPEN: new Map(), MID: new Map(), CLOSE: new Map(), ALL: new Map(),
  };

  let sessionsProcessed = 0, sessionsSkipped = 0;

  for (const day of sessionDays) {
    const entry = levelsFile.days[day]?.levels.find(l => l.symbol === symbol);
    if (!entry) { sessionsSkipped++; continue; }
    const levels = collectLevels(entry);
    if (levels.length === 0) { sessionsSkipped++; continue; }

    const rthStart = etDateTimeToMs(day, 9, 30);
    const rthEnd = etDateTimeToMs(day, 16, 0);
    const tickCount = (ticks.prepare(
      `SELECT COUNT(*) AS n FROM trades WHERE symbol=? AND ts >= ? AND ts < ?`
    ).get(symbol, rthStart, rthEnd) as { n: number }).n;
    if (tickCount < 10000) { sessionsSkipped++; continue; }
    sessionsProcessed++;

    const sessionTicks = ticks.prepare(
      `SELECT ts, price FROM trades WHERE symbol=? AND ts >= ? AND ts < ? ORDER BY ts ASC`
    ).all(symbol, rthStart, rthEnd) as Array<{ ts: number; price: number }>;
    const buckets = bucketsFor(day);

    for (const lvl of levels) {
      // Per-bucket evaluation
      let touchedAnyBucket = false;
      let firstAllOutcome: 'REACT' | 'BREAK' | 'NEITHER' | null = null;
      let firstAllReact = 0, firstAllBreak = 0;
      for (const bk of buckets) {
        const r = evaluateBucket(sessionTicks, bk, lvl.price, touchPt, reactPt, breakPt, windowMs, preMs);
        const s = stats[bk.name].get(lvl.label) ?? newStats();
        s.sessions++;
        if (r.touched) {
          s.touches++;
          if (r.outcome === 'REACT')  { s.reactions++; s.reactPtsSum += r.reactPts!; }
          else if (r.outcome === 'BREAK') { s.breakouts++; s.breakPtsSum += r.breakPts!; }
          if (!touchedAnyBucket) {
            touchedAnyBucket = true;
            firstAllOutcome = r.outcome ?? 'NEITHER';
            firstAllReact = r.reactPts ?? 0;
            firstAllBreak = r.breakPts ?? 0;
          }
        }
        stats[bk.name].set(lvl.label, s);
      }
      // ALL = first-touch-of-session aggregate (single data point per session)
      const sAll = stats.ALL.get(lvl.label) ?? newStats();
      sAll.sessions++;
      if (touchedAnyBucket) {
        sAll.touches++;
        if (firstAllOutcome === 'REACT')  { sAll.reactions++; sAll.reactPtsSum += firstAllReact; }
        else if (firstAllOutcome === 'BREAK') { sAll.breakouts++; sAll.breakPtsSum += firstAllBreak; }
      }
      stats.ALL.set(lvl.label, sAll);
    }
  }

  console.log(`Processed: ${sessionsProcessed}  Skipped: ${sessionsSkipped}\n`);

  for (const bucket of ['ALL', 'OPEN', 'MID', 'CLOSE'] as const) {
    printBucketTable(bucket, stats[bucket]);
  }

  ticks.close();
}

function printBucketTable(bucketName: string, stats: Map<string, Stats>) {
  const pad = (s: string, n: number, right = false) => right ? s.padStart(n) : s.padEnd(n);
  const rows = [...stats.entries()]
    .filter(([_, s]) => s.sessions >= 5)
    .sort((a, b) => (b[1].touches / b[1].sessions) - (a[1].touches / a[1].sessions));

  console.log(`\n── Bucket: ${bucketName} ──`);
  console.log('┌──────────────┬───────┬─────────┬──────────────┬──────────────┬────────────┬────────────┬──────────────┐');
  console.log('│ Level        │  Sess │  Touch% │ React/Touch  │ Break/Touch  │  Avg React │  Avg Break │ React$-Break$│');
  console.log('├──────────────┼───────┼─────────┼──────────────┼──────────────┼────────────┼────────────┼──────────────┤');
  for (const [label, s] of rows) {
    const touchPct = s.sessions ? (100 * s.touches / s.sessions).toFixed(1) + '%' : '—';
    const reactPctOfTouch = s.touches ? (100 * s.reactions / s.touches).toFixed(1) + '%' : '—';
    const breakPctOfTouch = s.touches ? (100 * s.breakouts / s.touches).toFixed(1) + '%' : '—';
    const avgReact = s.reactions ? (s.reactPtsSum / s.reactions).toFixed(1) + 'pt' : '—';
    const avgBreak = s.breakouts ? (s.breakPtsSum / s.breakouts).toFixed(1) + 'pt' : '—';
    const fadeEv = s.touches
      ? (((s.reactions ? s.reactPtsSum / s.touches : 0) - (s.breakouts ? s.breakPtsSum / s.touches : 0)) * DOLLAR_PER_PT)
      : null;
    const fadeStr = fadeEv === null ? '—' : (fadeEv >= 0 ? '+$' : '-$') + Math.abs(fadeEv).toFixed(1);
    console.log(
      `│ ${pad(label, 12)} │ ${pad(String(s.sessions), 5, true)} │ ${pad(touchPct, 7, true)} │ ${pad(reactPctOfTouch + ' (' + s.reactions + ')', 12, true)} │ ${pad(breakPctOfTouch + ' (' + s.breakouts + ')', 12, true)} │ ${pad(avgReact, 10, true)} │ ${pad(avgBreak, 10, true)} │ ${pad(fadeStr, 12, true)} │`
    );
  }
  console.log('└──────────────┴───────┴─────────┴──────────────┴──────────────┴────────────┴────────────┴──────────────┘');
}

main();
