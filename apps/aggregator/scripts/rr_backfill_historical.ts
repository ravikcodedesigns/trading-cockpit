/**
 * rr_backfill_historical.ts — insert the 5 historical RR winners discovered
 * during research (2026-05-27) into trading.db:signals so they appear on the
 * cockpit chart alongside live RR signals.
 *
 * Idempotent: skips rows that already exist (matched on ts + rule_id + symbol).
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const DB_PATH    = path.resolve(__dirname, '../../../data/trading.db');

type Hist = {
  dateEt: string;     // YYYY-MM-DD (ET)
  timeEt: string;     // HH:MM (ET) — bar OPEN time (signal ts uses bar open)
  entry:   number;
  level:   { source: 'PDH'|'PDL'|'PMH'|'PML'|'WkH'|'WkL'|'ORH'|'ORL'; price: number };
  range:   number;
  bodyPct: number;
  upperWick: number;
  delta:   number;
  prev15Net: number;
};

const ROWS: Hist[] = [
  { dateEt: '2026-05-15', timeEt: '14:15', entry: 29453.25,
    level: { source: 'PDL', price: 29454.00 },
    range: 22.0, bodyPct: 0.68, upperWick: 3.75, delta: -1500, prev15Net: -1.3 },
  { dateEt: '2026-05-18', timeEt: '10:44', entry: 29087.25,
    level: { source: 'PDL', price: 29089.50 },
    range: 35.8, bodyPct: 0.66, upperWick: 10.75, delta: -2200, prev15Net: -67.0 },
  { dateEt: '2026-05-18', timeEt: '11:15', entry: 29049.25,
    level: { source: 'PML', price: 29050.00 },
    range: 26.8, bodyPct: 0.59, upperWick: 5.0, delta: -1600, prev15Net: -61.5 },
  { dateEt: '2026-05-19', timeEt: '10:32', entry: 28739.50,
    level: { source: 'WkL', price: 28741.25 },
    range: 37.5, bodyPct: 0.48, upperWick: 7.0, delta: -1100, prev15Net: 32.3 },
  // Held-out test winner
  { dateEt: '2026-05-21', timeEt: '11:06', entry: 29175.75,
    level: { source: 'PML', price: 29178.25 },
    range: 38.3, bodyPct: 0.41, upperWick: 9.75, delta: -900, prev15Net: -26.5 },
];

function tsFor(dateEt: string, timeEt: string): number {
  return Date.parse(`${dateEt}T${timeEt}:00-04:00`);
}

function buildPayload(h: Hist, ts: number, stopDist: number): string {
  const stop = h.level.price + 0.25;
  const t1 = h.entry - stopDist;
  const t2 = h.entry - 2 * stopDist;
  const t3 = h.entry - 3 * stopDist;
  const rationale =
    `RR SHORT @ ${h.level.source}=${h.level.price.toFixed(2)} ` +
    `(${(h.level.price - h.entry).toFixed(2)}pt above close). ` +
    `range=${h.range.toFixed(1)} body=${(h.bodyPct*100).toFixed(0)}% ` +
    `wick=${h.upperWick.toFixed(1)} delta=${h.delta} prev15=${h.prev15Net.toFixed(1)}. ` +
    `Entry=${h.entry} Stop=${stop.toFixed(2)} (${stopDist.toFixed(2)}pts risk). ` +
    `T1=${t1.toFixed(2)} T2=${t2.toFixed(2)} T3=${t3.toFixed(2)}. [BACKFILLED HISTORICAL]`;
  return JSON.stringify({
    ts,
    source: 'rules-v2',
    type: 'confluence',
    symbol: 'NQ',
    ruleId: 'reject-resistance',
    score: 85,
    direction: 'short',
    rationale,
    strategyVersion: 'RR',
    ruleVersion: 'rr-v1',
    entry: h.entry,
    stopLevel: stop,
    stopDist,
    levelSource: h.level.source,
    levelPrice: h.level.price,
    range: h.range,
    bodyPct: h.bodyPct,
    upperWick: h.upperWick,
    delta: h.delta,
    prev15Net: h.prev15Net,
    isBackfill: true,
  });
}

function main(): void {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const exists = db.prepare(`SELECT 1 FROM signals WHERE ts=? AND rule_id='reject-resistance' AND symbol='NQ'`);
  const insert = db.prepare(`INSERT INTO signals (ts, symbol, rule_id, score, direction, payload, strategy_version, rule_version) VALUES (?, 'NQ', 'reject-resistance', 85, 'short', ?, 'RR', 'rr-v1')`);

  let inserted = 0, skipped = 0;
  for (const h of ROWS) {
    const ts = tsFor(h.dateEt, h.timeEt);
    if (exists.get(ts)) { skipped++; continue; }
    const stopDist = (h.level.price + 0.25) - h.entry;
    const payload = buildPayload(h, ts, stopDist);
    insert.run(ts, payload);
    inserted++;
    console.log(`inserted ${h.dateEt} ${h.timeEt} ${h.level.source}@${h.level.price.toFixed(2)} entry=${h.entry} stop=${(h.level.price+0.25).toFixed(2)} (${stopDist.toFixed(2)}pt)`);
  }
  console.log(`\nDone. inserted=${inserted}  skipped=${skipped}`);
  db.close();
}

main();
