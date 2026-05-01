/**
 * Rescore Signals
 *
 * Replays all signals fired since a given timestamp, recomputing their
 * scores using the CURRENT levels in daily_levels.json. This is for the
 * case where levels were uploaded late (e.g., after RTH open) so the
 * signals that fired between 09:30 and the upload missed the zone-
 * confluence boost in their score.
 *
 * After rescoring, calls the outcome scorer to refresh the matured table.
 *
 * Usage:
 *   pnpm --filter aggregator rescore --since "2026-05-01 09:30"
 *
 * No audit trail kept by design (per user choice). Original scores are
 * overwritten with corrected values.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../../data/trading.db');
const LEVELS_PATH = path.resolve(__dirname, '../../../daily_levels.json');

// --- Args ---

const args = process.argv.slice(2);
const sinceFlagIdx = args.indexOf('--since');
const skipOutcome = args.includes('--skip-outcome');

let sinceMs = 0;  // 0 = rescore all signals from epoch
let sinceLabel = 'all time';
if (sinceFlagIdx !== -1 && args[sinceFlagIdx + 1] && args[sinceFlagIdx + 1] !== 'all') {
  const sinceStr = args[sinceFlagIdx + 1];
  sinceMs = parseSinceNY(sinceStr);
  sinceLabel = sinceStr + ' NY';
}

// Parse "YYYY-MM-DD HH:MM" as NY time -> Unix ms.
function parseSinceNY(s: string): number {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) {
    console.error(`Invalid --since format: ${s}. Expected YYYY-MM-DD HH:MM, or "all"`);
    process.exit(1);
  }
  const [, y, mo, d, h, mi] = m;
  // Build a UTC-ish wall-clock then correct for NY offset using Intl probe.
  const probe = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, 0));
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hour12: false,
  });
  const nyHour = parseInt(fmt.format(probe), 10);
  const offsetCorrection = (+h - nyHour) * 60 * 60 * 1000;
  return probe.getTime() + offsetCorrection;
}

console.log(`Rescoring signals since ${sinceLabel} (ts >= ${sinceMs})`);

// --- Load levels file (current state, mirrors what aggregator has) ---

interface RawLevel {
  symbol: string;
  bullZone: { low: number; high: number };
  bearZone: { low: number; high: number };
  ddBands: { upper: number; lower: number };
  hedgePressure: number;
  additionalLevels?: unknown[];
}

interface FileShape {
  days?: Record<string, { levels: RawLevel[] }>;
  levels?: RawLevel[];
}

const fileRaw = fs.readFileSync(LEVELS_PATH, 'utf-8');
const fileData = JSON.parse(fileRaw) as FileShape;

// Build a date -> symbol -> RawLevel lookup
const levelsByDay: Record<string, Record<string, RawLevel>> = {};
if (fileData.days) {
  for (const [date, entry] of Object.entries(fileData.days)) {
    levelsByDay[date] = {};
    for (const lv of entry.levels) {
      levelsByDay[date][lv.symbol] = lv;
    }
  }
}

// --- Trading day classifier (mirrors contracts/tradingDayFor) ---

function tradingDayFor(tsMs: number): string {
  const d = new Date(tsMs);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const today = `${get('year')}-${get('month')}-${get('day')}`;
  const weekday = get('weekday');
  const minutesOfDay = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  const RTH_OPEN = 9 * 60 + 30;

  const minusDays = (dateStr: string, days: number): string => {
    const dt = new Date(dateStr + 'T12:00:00Z');
    dt.setUTCDate(dt.getUTCDate() - days);
    return dt.toISOString().slice(0, 10);
  };

  if (weekday === 'Sat') return minusDays(today, 1);
  if (weekday === 'Sun') return minusDays(today, 2);
  if (weekday === 'Mon') return minutesOfDay < RTH_OPEN ? minusDays(today, 3) : today;
  return minutesOfDay < RTH_OPEN ? minusDays(today, 1) : today;
}

// --- Session classifier (mirrors thresholds.ts) ---

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
  const RTH_START = 570;   // 09:30
  const RTH_END = 960;     // 16:00
  const ON_RESUME = 1080;  // 18:00
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

function inZone(price: number, zone: { low: number; high: number }, padding = 0): boolean {
  return price >= zone.low - padding && price <= zone.high + padding;
}

// --- Rescoring (mirrors ruleSweep / ruleDeltaDivergence exactly minus dedup) ---

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

function rescoreSweep(ts: number, sourcePayload: SweepPayload): { score: number; rationale: string } | null {
  const session = classifySession(ts);
  const thresholds = SWEEP_THRESHOLDS[session];
  if (sourcePayload.volume < thresholds.minVolume) return null;
  if (sourcePayload.levels < thresholds.minLevels) return null;

  const volumeRatio = sourcePayload.volume / thresholds.minVolume;
  const levelsRatio = sourcePayload.levels / thresholds.minLevels;
  let score = 50;
  if (volumeRatio >= 1.5) score += 10;
  if (volumeRatio >= 2.0) score += 10;
  if (levelsRatio >= 1.5) score += 5;
  if (sourcePayload.durationMs <= 100) score += 5;

  // Zone confluence — DISABLED (matches live rule). Kept commented for
  // future re-enable once we have empirical zone-proximity vs outcome data.
  const zoneNote = '';
  // const day = tradingDayFor(ts);
  // const lv = levelsByDay[day]?.[sourcePayload.symbol];
  // if (lv) {
  //   const padding = sourcePayload.endPrice * 0.0005;
  //   const inBull = inZone(sourcePayload.endPrice, lv.bullZone, padding);
  //   const inBear = inZone(sourcePayload.endPrice, lv.bearZone, padding);
  //   if (inBull) {
  //     score += 15;
  //     zoneNote = sourcePayload.direction === 'long'
  //       ? ' INTO bull zone (breakout candidate)'
  //       : ' INTO bull zone (rejection candidate)';
  //   } else if (inBear) {
  //     score += 15;
  //     zoneNote = sourcePayload.direction === 'short'
  //       ? ' INTO bear zone (breakdown candidate)'
  //       : ' INTO bear zone (rejection candidate)';
  //   }
  // }

  score = Math.min(100, score);
  const moveTicks = Math.abs(sourcePayload.endPrice - sourcePayload.startPrice);
  const rationale =
    `${sourcePayload.direction.toUpperCase()} sweep [${session.toUpperCase()}]: ${sourcePayload.volume} contracts across ` +
    `${sourcePayload.levels} levels in ${sourcePayload.durationMs}ms ` +
    `(${sourcePayload.startPrice} -> ${sourcePayload.endPrice}, ${moveTicks.toFixed(2)} pts).` +
    zoneNote;

  return { score, rationale };
}

function rescoreDivergence(ts: number, sourcePayload: DivergencePayload): { score: number; rationale: string } | null {
  const session = classifySession(ts);
  const thresholds = DIVERGENCE_THRESHOLDS[session];
  if (sourcePayload.magnitude < thresholds.minMagnitude) return null;
  if (sourcePayload.deltaDiff < thresholds.minDeltaDiff) return null;

  const direction: 'long' | 'short' = sourcePayload.direction === 'bullish' ? 'long' : 'short';

  const score = Math.min(100, sourcePayload.magnitude);

  // Zone confluence — DISABLED (matches live rule). Kept commented for
  // future re-enable once we have empirical zone-proximity vs outcome data.
  const zoneNote = '';
  // const day = tradingDayFor(ts);
  // const lv = levelsByDay[day]?.[sourcePayload.symbol];
  // if (lv) {
  //   const padding = sourcePayload.currentPrice * 0.0005;
  //   const inBull = inZone(sourcePayload.currentPrice, lv.bullZone, padding);
  //   const inBear = inZone(sourcePayload.currentPrice, lv.bearZone, padding);
  //   if (inBull && direction === 'long') {
  //     score += 20;
  //     zoneNote = ' AT bull zone (defended low setup)';
  //   } else if (inBear && direction === 'short') {
  //     score += 20;
  //     zoneNote = ' AT bear zone (defended high setup)';
  //   } else if (inBull || inBear) {
  //     score += 10;
  //     zoneNote = ' near zone';
  //   }
  // }

  const priceMove = (sourcePayload.currentPrice - sourcePayload.priorPrice).toFixed(2);
  const rationale =
    `${sourcePayload.direction.toUpperCase()} divergence [${session.toUpperCase()}]: ` +
    `price ${sourcePayload.priorPrice} -> ${sourcePayload.currentPrice} (${priceMove}), ` +
    `delta ${sourcePayload.priorDelta} -> ${sourcePayload.currentDelta} (diff ${sourcePayload.deltaDiff}).` +
    zoneNote;

  return { score, rationale };
}

// --- Main pass over signals ---

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

interface SignalRow {
  id: number;
  ts: number;
  symbol: string;
  rule_id: string;
  score: number;
  direction: string;
  payload: string;
}

const signals = db.prepare(`
  SELECT id, ts, symbol, rule_id, score, direction, payload
  FROM signals
  WHERE ts >= ?
  ORDER BY ts ASC
`).all(sinceMs) as SignalRow[];

console.log(`Found ${signals.length} signal(s) since ${sinceLabel}`);

const updateStmt = db.prepare(`
  UPDATE signals SET score = ?, payload = ? WHERE id = ?
`);

let nUpdated = 0;
let nUnchanged = 0;
let nSkipped = 0;

for (const sig of signals) {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(sig.payload);
  } catch {
    nSkipped++;
    continue;
  }

  // The signal's payload contains the original confluence-signal shape.
  // To rescore, we need the underlying source-event fields. The aggregator
  // stuffed those into the payload; pull them by rule_id.
  let result: { score: number; rationale: string } | null = null;

  if (sig.rule_id === 'sweep') {
    // Sweep confluence payload contains: rationale, ruleId, score, direction, etc.
    // The source SweepEvent fields (volume/levels/etc) are NOT in the confluence
    // payload — they were in the original bookmap event. We need to fetch them.
    const evt = db.prepare(`
      SELECT payload FROM events
      WHERE source = 'bookmap' AND type = 'sweep'
        AND symbol = ? AND ts BETWEEN ? AND ?
      ORDER BY ABS(ts - ?) ASC
      LIMIT 1
    `).get(sig.symbol, sig.ts - 2000, sig.ts + 2000, sig.ts) as { payload: string } | undefined;
    if (!evt) { nSkipped++; continue; }
    const evtPayload = JSON.parse(evt.payload) as SweepPayload;
    result = rescoreSweep(sig.ts, evtPayload);
  } else if (sig.rule_id === 'delta-divergence') {
    const evt = db.prepare(`
      SELECT payload FROM events
      WHERE source = 'bookmap' AND type = 'delta_divergence'
        AND symbol = ? AND ts BETWEEN ? AND ?
      ORDER BY ABS(ts - ?) ASC
      LIMIT 1
    `).get(sig.symbol, sig.ts - 2000, sig.ts + 2000, sig.ts) as { payload: string } | undefined;
    if (!evt) { nSkipped++; continue; }
    const evtPayload = JSON.parse(evt.payload) as DivergencePayload;
    result = rescoreDivergence(sig.ts, evtPayload);
  } else {
    nSkipped++;
    continue;
  }

  if (!result) { nSkipped++; continue; }

  if (result.score === sig.score) {
    nUnchanged++;
    continue;
  }

  // Update payload's rationale and score, persist back.
  payload.score = result.score;
  payload.rationale = result.rationale;
  updateStmt.run(result.score, JSON.stringify(payload), sig.id);
  nUpdated++;
}

console.log('');
console.log(`Updated: ${nUpdated}`);
console.log(`Unchanged (already correct): ${nUnchanged}`);
console.log(`Skipped (no source event found or filtered out): ${nSkipped}`);

db.close();

// --- Run outcome tracker ---

if (!skipOutcome) {
  console.log('');
  console.log('Wiping matured outcomes table (old scores stale after rescore)...');
  // Open in a fresh connection because db was closed above
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
  console.log('Outcome rescore complete. View report with: pnpm score:report');
} else {
  console.log('');
  console.log('Skipped outcome scorer. Run manually with: pnpm score');
}
