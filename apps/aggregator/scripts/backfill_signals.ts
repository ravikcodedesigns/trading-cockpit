/**
 * Backfill Signals
 *
 * Walks the `events` table for sweep + delta_divergence events, runs each
 * one through the current rules engine logic, and inserts the qualifying
 * ones as new rows in the `signals` table.
 *
 * This recovers a window where the rules engine was crashing on every
 * event due to a stale `getLevels` accessor (the per-day levels refactor
 * left index.ts pointing at the old `state.levels` field which became
 * undefined). Events were captured normally; signal inserts were not.
 *
 * Idempotent: if a signal already exists at the same timestamp + symbol +
 * rule_id, the event is skipped. So you can re-run safely.
 *
 * After backfill, runs the outcome scorer to compute outcomes for the
 * newly-inserted signals.
 *
 * Usage:
 *   pnpm --filter aggregator backfill --since "2026-05-01 11:00"
 *   pnpm --filter aggregator backfill                # all events
 *   pnpm --filter aggregator backfill --skip-outcome # skip scorer rebuild
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../../data/trading.db');

// --- Args ---

const args = process.argv.slice(2);
const sinceFlagIdx = args.indexOf('--since');
const skipOutcome = args.includes('--skip-outcome');

let sinceMs = 0;
let sinceLabel = 'all time';
if (sinceFlagIdx !== -1 && args[sinceFlagIdx + 1] && args[sinceFlagIdx + 1] !== 'all') {
  const s = args[sinceFlagIdx + 1];
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) {
    console.error(`Invalid --since format: ${s}. Expected YYYY-MM-DD HH:MM`);
    process.exit(1);
  }
  const [, y, mo, d, h, mi] = m;
  const probe = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, 0));
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hour12: false,
  });
  const nyHour = parseInt(fmt.format(probe), 10);
  const offsetCorrection = (+h - nyHour) * 60 * 60 * 1000;
  sinceMs = probe.getTime() + offsetCorrection;
  sinceLabel = s + ' NY';
}

console.log(`Backfilling signals since ${sinceLabel} (ts >= ${sinceMs})`);

// --- Session classifier (same as live thresholds) ---

type Session = 'overnight' | 'rth' | 'closed';

function classifySession(tsMs: number): Session {
  const d = new Date(tsMs);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  const minutesOfDay = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  const RTH_START = 570;
  const RTH_END = 960;
  const ON_RESUME = 1080;
  const isWeekday = ['Mon','Tue','Wed','Thu','Fri'].includes(weekday);
  if (isWeekday && minutesOfDay >= RTH_START && minutesOfDay < RTH_END) return 'rth';
  if (isWeekday) {
    if (minutesOfDay < RTH_START) return 'overnight';
    if (weekday !== 'Fri' && minutesOfDay >= ON_RESUME) return 'overnight';
    return 'closed';
  }
  if (weekday === 'Sun' && minutesOfDay >= ON_RESUME) return 'overnight';
  return 'closed';
}

const SWEEP_THRESHOLDS: Record<Session, { minVolume: number; minLevels: number }> = {
  overnight: { minVolume: 120, minLevels: 13 },
  rth: { minVolume: 215, minLevels: 18 },
  closed: { minVolume: Number.POSITIVE_INFINITY, minLevels: Number.POSITIVE_INFINITY },
};

const DIVERGENCE_THRESHOLDS: Record<Session, { minMagnitude: number; minDeltaDiff: number }> = {
  overnight: { minMagnitude: 50, minDeltaDiff: 200 },
  rth: { minMagnitude: 60, minDeltaDiff: 400 },
  closed: { minMagnitude: Number.POSITIVE_INFINITY, minDeltaDiff: Number.POSITIVE_INFINITY },
};

// --- Scoring (zone-disabled, matches live rules as of 2026-05-01) ---

interface SweepPayload {
  symbol: string;
  direction: 'long' | 'short';
  volume: number;
  levels: number;
  durationMs: number;
  startPrice: number;
  endPrice: number;
}

interface DivergencePayload {
  symbol: string;
  direction: 'bullish' | 'bearish';
  currentPrice: number;
  currentDelta: number;
  priorPrice: number;
  priorDelta: number;
  deltaDiff: number;
  magnitude: number;
}

function scoreSweep(ts: number, p: SweepPayload): { score: number; rationale: string; direction: 'long'|'short' } | null {
  const session = classifySession(ts);
  const thresholds = SWEEP_THRESHOLDS[session];
  if (p.volume < thresholds.minVolume) return null;
  if (p.levels < thresholds.minLevels) return null;

  const volumeRatio = p.volume / thresholds.minVolume;
  const levelsRatio = p.levels / thresholds.minLevels;
  let score = 50;
  if (volumeRatio >= 1.5) score += 10;
  if (volumeRatio >= 2.0) score += 10;
  if (levelsRatio >= 1.5) score += 5;
  if (p.durationMs <= 100) score += 5;
  score = Math.min(100, score);

  const moveTicks = Math.abs(p.endPrice - p.startPrice);
  const rationale =
    `${p.direction.toUpperCase()} sweep [${session.toUpperCase()}]: ${p.volume} contracts across ` +
    `${p.levels} levels in ${p.durationMs}ms ` +
    `(${p.startPrice} -> ${p.endPrice}, ${moveTicks.toFixed(2)} pts).`;

  return { score, rationale, direction: p.direction };
}

function scoreDivergence(ts: number, p: DivergencePayload): { score: number; rationale: string; direction: 'long'|'short' } | null {
  const session = classifySession(ts);
  const thresholds = DIVERGENCE_THRESHOLDS[session];
  if (p.magnitude < thresholds.minMagnitude) return null;
  if (p.deltaDiff < thresholds.minDeltaDiff) return null;

  const direction: 'long' | 'short' = p.direction === 'bullish' ? 'long' : 'short';
  const score = Math.min(100, p.magnitude);

  const priceMove = (p.currentPrice - p.priorPrice).toFixed(2);
  const rationale =
    `${p.direction.toUpperCase()} divergence [${session.toUpperCase()}]: ` +
    `price ${p.priorPrice} -> ${p.currentPrice} (${priceMove}), ` +
    `delta ${p.priorDelta} -> ${p.currentDelta} (diff ${p.deltaDiff}).`;

  return { score, rationale, direction };
}

// --- Dedup window (same as live: 60s same-direction same-rule) ---

const DEDUP_WINDOW_MS = 60_000;
const recentSignalKeys = new Map<string, number>();

function isDedupHit(ts: number, key: string): boolean {
  const last = recentSignalKeys.get(key);
  if (last && ts - last < DEDUP_WINDOW_MS) return true;
  recentSignalKeys.set(key, ts);
  return false;
}

// --- DB ---

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

interface EventRow {
  ts: number;
  symbol: string;
  type: string;
  payload: string;
}

const events = db.prepare(`
  SELECT ts, symbol, type, payload
  FROM events
  WHERE source = 'bookmap'
    AND type IN ('sweep', 'delta_divergence')
    AND ts >= ?
  ORDER BY ts ASC
`).all(sinceMs) as EventRow[];

console.log(`Found ${events.length} candidate event(s)`);

// Pre-cache existing signals to avoid duplicates
const existingSignals = new Set<string>(
  (db.prepare(`SELECT ts, symbol, rule_id FROM signals WHERE ts >= ?`).all(sinceMs) as Array<{ ts: number; symbol: string; rule_id: string }>)
    .map(r => `${r.ts}|${r.symbol}|${r.rule_id}`)
);

const insertSignal = db.prepare(`
  INSERT INTO signals (ts, symbol, rule_id, score, direction, payload)
  VALUES (?, ?, ?, ?, ?, ?)
`);

let nInserted = 0;
let nFiltered = 0;
let nDedup = 0;
let nDuplicate = 0;

for (const ev of events) {
  let result: { score: number; rationale: string; direction: 'long'|'short' } | null = null;
  let ruleId = '';

  let payload: SweepPayload | DivergencePayload;
  try {
    payload = JSON.parse(ev.payload);
  } catch {
    nFiltered++;
    continue;
  }

  if (ev.type === 'sweep') {
    result = scoreSweep(ev.ts, payload as SweepPayload);
    ruleId = 'sweep';
  } else if (ev.type === 'delta_divergence') {
    result = scoreDivergence(ev.ts, payload as DivergencePayload);
    ruleId = 'delta-divergence';
  }

  if (!result) {
    nFiltered++;
    continue;
  }

  // Dedup check (same logic as live rule)
  const dedupKey = `${ruleId}:${ev.symbol}:${result.direction}`;
  if (isDedupHit(ev.ts, dedupKey)) {
    nDedup++;
    continue;
  }

  // Idempotency: don't insert if signals table already has one at this ts
  const idemKey = `${ev.ts}|${ev.symbol}|${ruleId}`;
  if (existingSignals.has(idemKey)) {
    nDuplicate++;
    continue;
  }

  // Build the ConfluenceSignal payload shape the live engine produces
  const confluenceSignal = {
    ts: ev.ts,
    source: 'rules',
    type: 'confluence',
    symbol: ev.symbol,
    ruleId,
    score: result.score,
    direction: result.direction,
    rationale: result.rationale,
  };

  insertSignal.run(
    ev.ts,
    ev.symbol,
    ruleId,
    result.score,
    result.direction,
    JSON.stringify(confluenceSignal),
  );
  nInserted++;
  existingSignals.add(idemKey);
}

console.log('');
console.log(`Inserted: ${nInserted}`);
console.log(`Filtered (below threshold): ${nFiltered}`);
console.log(`Skipped by dedup window: ${nDedup}`);
console.log(`Skipped (already in signals table): ${nDuplicate}`);

db.close();

// --- Refresh outcomes ---

if (!skipOutcome && nInserted > 0) {
  console.log('');
  console.log('Wiping matured outcomes table to incorporate backfilled signals...');
  const db2 = new Database(DB_PATH);
  db2.exec('DELETE FROM signal_outcomes_matured');
  db2.exec('DELETE FROM signal_outcomes_partial');
  db2.close();

  console.log('Re-running outcome scorer...');
  const result = spawnSync('tsx', [path.resolve(__dirname, 'score_outcomes.ts')], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error('Outcome scorer exited non-zero. Re-run manually with: pnpm score');
    process.exit(1);
  }
  console.log('');
  console.log('Backfill + outcome rebuild complete. View report with: pnpm score:report');
} else if (skipOutcome) {
  console.log('Skipped outcome scorer. Run manually with: pnpm score');
} else {
  console.log('No new signals inserted; outcome scorer not re-run.');
}
