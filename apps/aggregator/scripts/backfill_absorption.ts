/**
 * Backfill Absorption Signals
 *
 * Replays historical tick data from ticks.db through the corrected
 * absorption detection logic and inserts qualifying signals into
 * trading.db for outcome tracking and reporting.
 *
 * Uses sliding 3s (RTH) / 5s (overnight) windows stepped every 500ms
 * to match the live rule's polling behavior.
 *
 * Usage:
 *   pnpm --filter aggregator backfill:absorption
 *   pnpm --filter aggregator backfill:absorption --since "2026-05-04 17:00"
 *   pnpm --filter aggregator backfill:absorption --skip-outcome
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TICKS_DB_PATH = path.resolve(__dirname, '../../../data/ticks.db');
const TRADING_DB_PATH = path.resolve(__dirname, '../../../data/trading.db');

const args = process.argv.slice(2);
const sinceFlagIdx = args.indexOf('--since');
const skipOutcome = args.includes('--skip-outcome');

let sinceMs = 0;
let sinceLabel = 'all time';
if (sinceFlagIdx !== -1 && args[sinceFlagIdx + 1] && args[sinceFlagIdx + 1] !== 'all') {
  const s = args[sinceFlagIdx + 1];
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) { console.error('Invalid --since format. Use YYYY-MM-DD HH:MM'); process.exit(1); }
  const [, y, mo, d, h, mi] = m;
  const probe = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, 0));
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
  const nyHour = parseInt(fmt.format(probe), 10);
  sinceMs = probe.getTime() + (+h - nyHour) * 3600000;
  sinceLabel = s + ' NY';
}

console.log(`Backfilling absorption signals since ${sinceLabel}`);

// --- Session classifier ---
type Session = 'rth' | 'overnight' | 'closed';
function classifySession(tsMs: number): Session {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  const min = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  const isWeekday = ['Mon','Tue','Wed','Thu','Fri'].includes(weekday);
  if (isWeekday && min >= 570 && min < 960) return 'rth';
  if (isWeekday) {
    if (min < 570) return 'overnight';
    if (weekday !== 'Fri' && min >= 1080) return 'overnight';
    return 'closed';
  }
  if (weekday === 'Sun' && min >= 1080) return 'overnight';
  return 'closed';
}

// --- Thresholds ---
const THRESHOLDS = {
  rth:       { windowMs: 3000, minVolume: 150, maxRangeTicks: 1, minAggrPct: 0.65, cooldownMs: 45000 },
  overnight: { windowMs: 5000, minVolume: 60,  maxRangeTicks: 1, minAggrPct: 0.65, cooldownMs: 60000 },
  closed:    { windowMs: 0,    minVolume: 99999, maxRangeTicks: 0, minAggrPct: 1,   cooldownMs: 999999 },
};
const TICK_SIZE = 0.25;
const POLL_MS = 500;
const SYMBOLS = ['NQ', 'ES'];

// --- Scoring ---
function scoreAbsorption(volume: number, minVolume: number, rangeTicks: number, aggrPct: number, durationMs: number): number {
  let score = 50;
  const ratio = volume / minVolume;
  if (ratio >= 2.0) score += 20;
  else if (ratio >= 1.5) score += 10;
  if (rangeTicks === 0) score += 10;
  if (aggrPct >= 0.80) score += 5;
  if (durationMs < 1000) score += 5;
  return Math.min(100, score);
}

// --- DBs ---
const ticksDb = new Database(TICKS_DB_PATH, { readonly: true });
const tradingDb = new Database(TRADING_DB_PATH);
tradingDb.pragma('journal_mode = WAL');

// Determine time range to replay
const tickRange = ticksDb.prepare(`
  SELECT MIN(ts) AS first, MAX(ts) AS last FROM trades
  WHERE symbol = 'NQ' AND ts >= ?
`).get(sinceMs) as { first: number; last: number };

if (!tickRange.first) {
  console.log('No tick data found for the specified range.');
  process.exit(0);
}

const startMs = tickRange.first;
const endMs = tickRange.last;
console.log(`Tick data spans: ${new Date(startMs).toLocaleString()} -> ${new Date(endMs).toLocaleString()}`);

// Idempotency: track existing absorption signals to avoid duplication
const existing = new Set<string>(
  (tradingDb.prepare(`
    SELECT ts, symbol FROM signals
    WHERE rule_id = 'absorption' AND strategy_version = 'B' AND ts >= ?
  `).all(sinceMs) as Array<{ ts: number; symbol: string }>)
    .map(r => `${Math.floor(r.ts / POLL_MS)}:${r.symbol}`)
);

const insertSignal = tradingDb.prepare(`
  INSERT INTO signals (ts, symbol, rule_id, score, direction, strategy_version, rule_version, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

// Cooldown tracker per symbol+direction
const lastSignalMs = new Map<string, number>();
function isCoolingDown(symbol: string, direction: string, tsMs: number, cooldownMs: number): boolean {
  const last = lastSignalMs.get(`${symbol}:${direction}`) ?? 0;
  return tsMs - last < cooldownMs;
}
function recordSignal(symbol: string, direction: string, tsMs: number): void {
  lastSignalMs.set(`${symbol}:${direction}`, tsMs);
}

let nInserted = 0;
let nFiltered = 0;
let nCooldown = 0;
let nDuplicate = 0;

// Step through time in POLL_MS increments
for (const symbol of SYMBOLS) {
  console.log(`\nProcessing ${symbol}...`);
  let ts = startMs;
  let step = 0;

  while (ts <= endMs) {
    ts += POLL_MS;
    step++;

    const session = classifySession(ts);
    if (session === 'closed') continue;
    const t = THRESHOLDS[session];

    // Fetch trades in the sliding window
    const trades = ticksDb.prepare(`
      SELECT price, size, is_bid_aggressor, ts
      FROM trades
      WHERE symbol = ? AND ts BETWEEN ? AND ?
      ORDER BY ts ASC
    `).all(symbol, ts - t.windowMs, ts) as Array<{ price: number; size: number; is_bid_aggressor: number; ts: number }>;

    if (trades.length === 0) { nFiltered++; continue; }

    // Group by price bucket
    const byPrice = new Map<number, { buyVol: number; sellVol: number; times: number[]; prices: number[] }>();
    for (const trade of trades) {
      const tickPrice = Math.round(trade.price / TICK_SIZE) * TICK_SIZE;
      if (!byPrice.has(tickPrice)) byPrice.set(tickPrice, { buyVol: 0, sellVol: 0, times: [], prices: [] });
      const entry = byPrice.get(tickPrice)!;
      entry.times.push(trade.ts);
      entry.prices.push(trade.price);
      if (trade.is_bid_aggressor) entry.sellVol += trade.size;
      else entry.buyVol += trade.size;
    }

    // Find best bucket (per-bucket range check)
    let bestPrice = 0, bestTotal = 0, bestBuy = 0, bestSell = 0;
    let bestTimes: number[] = [], bestRangeTicks = 0;

    for (const [price, entry] of byPrice.entries()) {
      const total = entry.buyVol + entry.sellVol;
      if (total <= bestTotal) continue;
      const minP = Math.min(...entry.prices);
      const maxP = Math.max(...entry.prices);
      const rangeTicks = Math.round((maxP - minP) / TICK_SIZE);
      if (rangeTicks > t.maxRangeTicks) continue;
      bestTotal = total;
      bestPrice = price;
      bestBuy = entry.buyVol;
      bestSell = entry.sellVol;
      bestTimes = entry.times;
      bestRangeTicks = rangeTicks;
    }

    if (bestTotal < t.minVolume) { nFiltered++; continue; }

    const dominantVol = Math.max(bestBuy, bestSell);
    const aggrPct = dominantVol / bestTotal;
    if (aggrPct < t.minAggrPct) { nFiltered++; continue; }

    const isBuyAggression = bestBuy > bestSell;
    const direction: 'long' | 'short' = isBuyAggression ? 'short' : 'long';

    if (isCoolingDown(symbol, direction, ts, t.cooldownMs)) { nCooldown++; continue; }

    // Idempotency check
    const idemKey = `${Math.floor(ts / POLL_MS)}:${symbol}`;
    if (existing.has(idemKey)) { nDuplicate++; continue; }

    const durationMs = bestTimes.length > 1
      ? Math.max(...bestTimes) - Math.min(...bestTimes)
      : t.windowMs;

    const score = scoreAbsorption(bestTotal, t.minVolume, bestRangeTicks, aggrPct, durationMs);
    const absorptionSide = isBuyAggression ? 'sell' : 'buy';
    const aggrDesc = isBuyAggression ? 'buy aggression' : 'sell aggression';
    const rationale = `ABSORPTION [${session.toUpperCase()}]: ${bestTotal} contracts of ${aggrDesc} ` +
      `absorbed at ${bestPrice} over ${durationMs}ms. ` +
      `Price range: ${bestRangeTicks} tick(s). ` +
      `Aggression concentration: ${Math.round(aggrPct * 100)}%. ` +
      `${absorptionSide.toUpperCase()} side defended.`;

    const signal = {
      ts,
      source: 'rules-v2',
      type: 'confluence',
      symbol,
      ruleId: 'absorption',
      score,
      direction,
      rationale,
      strategyVersion: 'B',
      ruleVersion: 'absorption-v1',
    };

    insertSignal.run(ts, symbol, 'absorption', score, direction, 'B', 'absorption-v1', JSON.stringify(signal));
    recordSignal(symbol, direction, ts);
    existing.add(idemKey);
    nInserted++;
  }

  console.log(`  ${symbol}: ${step} windows evaluated`);
}

ticksDb.close();

console.log('\n--- Results ---');
console.log(`Inserted:  ${nInserted}`);
console.log(`Filtered:  ${nFiltered} (below threshold)`);
console.log(`Cooldown:  ${nCooldown} (within cooldown window)`);
console.log(`Duplicate: ${nDuplicate} (already in DB)`);

tradingDb.close();

if (!skipOutcome && nInserted > 0) {
  console.log('\nRunning outcome scorer...');
  const result = spawnSync('tsx', [path.resolve(__dirname, 'score_outcomes.ts')], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('Outcome scorer failed. Run manually: pnpm score');
    process.exit(1);
  }
  console.log('Done. View report: pnpm score:report:b');
} else if (nInserted === 0) {
  console.log('\nNo signals inserted - nothing to score.');
} else {
  console.log('\nSkipped outcome scorer. Run: pnpm score');
}
