// Smoke test for L2 stacked-zone detector. Runs on one RTH day, characterizes
// wall events found. Goals:
//   1. Verify the detector emits sensible events
//   2. Characterize the distribution (how many walls per day, side bias, etc.)
//   3. Calibrate thresholds (minWallSize, minPersistMs) by inspecting top events

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StackedZoneDetector, type WallEvent } from './lib/stacked-zone-detector.js';
import type { DepthEvent } from './lib/depth-replay.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TICKS_DB = path.resolve(__dirname, '../../../data/ticks.db');

const db = new Database(TICKS_DB, { readonly: true });

const SYMBOL = 'NQ';
const DAY = '2026-05-28';   // a recent full-RTH day with active flow
const RTH_FROM_UTC = Date.UTC(2026, 4, 28, 13, 30, 0);   // 09:30 ET
const RTH_TO_UTC   = Date.UTC(2026, 4, 28, 20, 0, 0);    // 16:00 ET

console.log(`\n══ L2 stacked-zone detector — smoke test ══`);
console.log(`Day:    ${DAY} RTH (09:30 → 16:00 ET)`);
console.log(`Config: minWallSize=30, minPersistMs=10s, erodeFraction=0.5, holdInterval=30s\n`);

const events: WallEvent[] = [];
const detector = new StackedZoneDetector({
  minWallSize: 30,
  minPersistMs: 10_000,
  erodeFraction: 0.5,
  holdEmitIntervalMs: 30_000,
  onWallEvent: (e) => events.push(e),
});

// Stream depth events for the RTH day, batched to avoid loading all at once
const stmt = db.prepare(`
  SELECT id, ts, symbol, side, price, size
  FROM depth
  WHERE symbol = ? AND ts >= ? AND ts <= ?
  ORDER BY ts ASC, id ASC
`);

const t0 = Date.now();
let depthCount = 0;
const iter = stmt.iterate(SYMBOL, RTH_FROM_UTC, RTH_TO_UTC) as Iterable<DepthEvent>;
for (const r of iter) {
  detector.ingest(r);
  depthCount++;
}
const elapsedMs = Date.now() - t0;
console.log(`Processed ${depthCount.toLocaleString()} depth events in ${(elapsedMs/1000).toFixed(1)}s`);
console.log(`Total wall events emitted: ${events.length.toLocaleString()}\n`);

// Summary by event type
const byType: Record<string, number> = {};
for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1;
console.log(`── Wall events by type ──`);
for (const t of ['WALL_FORMED','WALL_ERODING','WALL_BROKEN','WALL_HELD','WALL_RECOVERED']) {
  console.log(`  ${t.padEnd(15)} ${(byType[t] ?? 0).toString().padStart(6)}`);
}

// Side bias on WALL_FORMED
const formed = events.filter(e => e.type === 'WALL_FORMED');
const bidWalls = formed.filter(e => e.side === 0).length;
const askWalls = formed.filter(e => e.side === 1).length;
console.log(`\n── WALL_FORMED side breakdown ──`);
console.log(`  BID-side (support, defends from below): ${bidWalls}`);
console.log(`  ASK-side (resistance, defends from above): ${askWalls}`);

// Outcome split — of the walls that formed, what eventually happened?
// Map by (side, price, firstSeenTs) → outcome
type Outcome = 'BROKEN' | 'ERODED_THEN_BROKEN' | 'ERODED_AND_RECOVERED' | 'STILL_PERSISTENT_AT_EOD' | 'UNKNOWN';
const walls = new Map<string, { formed: WallEvent; outcome: Outcome; brokeTs?: number; erodeTs?: number; }>();
for (const e of events) {
  const key = `${e.symbol}|${e.side}|${e.price}|${e.firstSeenTs}`;
  if (e.type === 'WALL_FORMED') {
    walls.set(key, { formed: e, outcome: 'UNKNOWN' });
  } else {
    const w = walls.get(key);
    if (!w) continue;
    if (e.type === 'WALL_BROKEN') {
      w.outcome = w.erodeTs ? 'ERODED_THEN_BROKEN' : 'BROKEN';
      w.brokeTs = e.ts;
    } else if (e.type === 'WALL_ERODING') {
      w.erodeTs = e.ts;
    } else if (e.type === 'WALL_RECOVERED' && w.outcome === 'UNKNOWN') {
      w.outcome = 'ERODED_AND_RECOVERED';
    }
  }
}
// Walls that never had a BROKEN event by EOD → still persistent
for (const w of walls.values()) {
  if (w.outcome === 'UNKNOWN') w.outcome = 'STILL_PERSISTENT_AT_EOD';
}

const outcomeCounts: Record<Outcome, number> = {
  BROKEN: 0, ERODED_THEN_BROKEN: 0, ERODED_AND_RECOVERED: 0,
  STILL_PERSISTENT_AT_EOD: 0, UNKNOWN: 0,
};
for (const w of walls.values()) outcomeCounts[w.outcome]++;
const totalWalls = walls.size;
console.log(`\n── Wall outcomes (n=${totalWalls}) ──`);
for (const [o, n] of Object.entries(outcomeCounts)) {
  if (n === 0 && o === 'UNKNOWN') continue;
  console.log(`  ${o.padEnd(28)} ${n.toString().padStart(6)} (${(n/totalWalls*100).toFixed(1)}%)`);
}

// Show top 20 longest-lived walls
console.log(`\n── Top 20 longest-lived walls (by persistentDurationMs) ──`);
const wallsWithDuration = [...walls.values()]
  .map(w => {
    const endTs = w.brokeTs ?? RTH_TO_UTC;
    const persistMs = endTs - (w.formed.persistentSinceTs ?? w.formed.ts);
    return { ...w, persistMs };
  })
  .sort((a, b) => b.persistMs - a.persistMs)
  .slice(0, 20);
console.log(`\n  ts (ET formed)  price       side  peak  outcome                    held for`);
for (const w of wallsWithDuration) {
  const et = new Date(w.formed.ts - 4*60*60_000).toISOString().substring(11, 19);
  const side = w.formed.side === 0 ? 'BID' : 'ASK';
  const dur = (w.persistMs / 1000).toFixed(1) + 's';
  console.log(
    `  ${et}        ${w.formed.price.toFixed(2).padStart(8)}  ${side}   ` +
    `${w.formed.peakSize.toString().padStart(4)}  ${w.outcome.padEnd(26)} ${dur.padStart(8)}`
  );
}

// Peak-size distribution
console.log(`\n── WALL_FORMED peak-size distribution ──`);
const peakBins = [30, 50, 75, 100, 150, 200, 500];
for (let i = 0; i < peakBins.length; i++) {
  const lo = peakBins[i]!;
  const hi = i+1 < peakBins.length ? peakBins[i+1]! : Infinity;
  const n = formed.filter(e => e.peakSize >= lo && e.peakSize < hi).length;
  const label = hi === Infinity ? `≥${lo}` : `${lo}-${hi-1}`;
  console.log(`  ${label.padStart(8)}:  ${n.toString().padStart(5)}`);
}

db.close();
