// L2 stacked-zone validation. Tests WALL_BROKEN as continuation signal:
//
//   ASK wall broken → sellers gave up → trade LONG (continuation up)
//   BID wall broken → buyers gave up → trade SHORT (continuation down)
//
// Multi-day backtest across all available NQ RTH days. Reports WIN/LOSS at
// fixed TP/SL grids, broken down by wall peak-size to find where edge lives.
//
// Entry: wall price at break-ts (first trade after WALL_BROKEN)
// TP/SL: tested at multiple grids
// Horizon: 15min max — beyond that, trade is OPEN at horizon end

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
// All RTH days with full data — same set as previous backtests
const DAYS: Array<[number, number, number]> = [
  [2026, 4, 5],  [2026, 4, 6],
  [2026, 4, 11], [2026, 4, 12], [2026, 4, 13], [2026, 4, 14], [2026, 4, 15],
  [2026, 4, 19], [2026, 4, 20], [2026, 4, 21], [2026, 4, 22],
  [2026, 4, 26], [2026, 4, 27], [2026, 4, 28], [2026, 4, 29],
  [2026, 5, 1],
];
function rthBounds(y: number, m: number, d: number): [number, number] {
  return [Date.UTC(y, m, d, 13, 30, 0), Date.UTC(y, m, d, 20, 0, 0)];
}

const HORIZON_MS = 15 * 60_000;
interface Grid { tp: number; sl: number; label: string; }
const GRIDS: Grid[] = [
  { tp: 10, sl: 5,  label: 'TP10/SL5  (2:1)' },
  { tp: 15, sl: 8,  label: 'TP15/SL8  (1.9:1)' },
  { tp: 20, sl: 10, label: 'TP20/SL10 (2:1)' },
  { tp: 30, sl: 10, label: 'TP30/SL10 (3:1)' },
];

// PEAK-SIZE BUCKETS — segment the WALL_BROKEN events by the wall's peak size.
const SIZE_BUCKETS = [
  { name: '30-49',   min: 30,  max: 50 },
  { name: '50-74',   min: 50,  max: 75 },
  { name: '75-99',   min: 75,  max: 100 },
  { name: '100-199', min: 100, max: 200 },
  { name: '200+',    min: 200, max: Infinity },
];

type Outcome = 'WIN' | 'LOSS' | 'OPEN';

interface BrokenWall {
  day: string;
  ts: number;            // when WALL_BROKEN fired
  side: 0 | 1;
  price: number;
  peakSize: number;
  persistMs: number;
  numUpdates: number;
}

const allBroken: BrokenWall[] = [];
// Per-day trade arrays for fast outcome lookup via binary search
const tradesByDay = new Map<string, Array<{ts:number; price:number}>>();

console.log(`\n══ Stacked-zone validation — WALL_BROKEN continuation test ══`);
console.log(`Days: ${DAYS.length} | symbol: ${SYMBOL} | horizon: ${HORIZON_MS/60_000} min\n`);

// 1) Collect WALL_BROKEN events across all days + cache trades per day
for (const [y, m, d] of DAYS) {
  const [from, to] = rthBounds(y, m, d);
  const dayStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

  const broken: WallEvent[] = [];
  const detector = new StackedZoneDetector({
    minWallSize: 30, minPersistMs: 10_000, erodeFraction: 0.5, holdEmitIntervalMs: 30_000,
    onWallEvent: (e) => { if (e.type === 'WALL_BROKEN') broken.push(e); },
  });

  const stmt = db.prepare(`
    SELECT id, ts, symbol, side, price, size
    FROM depth WHERE symbol = ? AND ts >= ? AND ts <= ?
    ORDER BY ts ASC, id ASC
  `);
  const iter = stmt.iterate(SYMBOL, from, to) as Iterable<DepthEvent>;
  for (const r of iter) detector.ingest(r);

  // Load trades for the day (+ 15-min tail for outcomes on events near close)
  const trades = db.prepare(`
    SELECT ts, price FROM trades WHERE symbol = ? AND ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `).all(SYMBOL, from, to + HORIZON_MS) as Array<{ts:number;price:number}>;
  tradesByDay.set(dayStr, trades);

  for (const e of broken) {
    allBroken.push({
      day: dayStr, ts: e.ts, side: e.side, price: e.price,
      peakSize: e.peakSize,
      persistMs: e.persistentDurationMs ?? 0,
      numUpdates: e.numUpdates,
    });
  }
  console.log(`  ${dayStr}: ${broken.length.toLocaleString()} WALL_BROKEN events, ${trades.length.toLocaleString()} trades cached`);
}
console.log(`\nTotal WALL_BROKEN events across all days: ${allBroken.length.toLocaleString()}\n`);

// 2) Outcome simulator (in-memory binary-search, no SQL per event)
function simulate(events: BrokenWall[], tp: number, sl: number) {
  let win = 0, loss = 0, open = 0, netPts = 0;
  for (const e of events) {
    const trades = tradesByDay.get(e.day);
    if (!trades || trades.length === 0) { open++; continue; }
    // FADE test: invert continuation direction.
    // ASK wall broken → FADE the breakout → SHORT (direction=-1)
    // BID wall broken → FADE the breakdown → LONG (direction=+1)
    const direction = e.side === 1 ? -1 : 1;
    const entry = e.price;
    const tpPrice = entry + direction * tp;
    const slPrice = entry - direction * sl;
    const horizonTs = e.ts + HORIZON_MS;

    // Binary search for first trade with ts > e.ts
    let lo = 0, hi = trades.length - 1, startIdx = trades.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (trades[mid]!.ts > e.ts) { startIdx = mid; hi = mid - 1; }
      else { lo = mid + 1; }
    }
    let outcome: Outcome = 'OPEN';
    for (let i = startIdx; i < trades.length; i++) {
      const t = trades[i]!;
      if (t.ts > horizonTs) break;
      const hitTP = direction === 1 ? t.price >= tpPrice : t.price <= tpPrice;
      const hitSL = direction === 1 ? t.price <= slPrice : t.price >= slPrice;
      if (hitTP) { outcome = 'WIN'; break; }
      if (hitSL) { outcome = 'LOSS'; break; }
    }
    if (outcome === 'WIN')  { win++; netPts += tp; }
    if (outcome === 'LOSS') { loss++; netPts -= sl; }
    if (outcome === 'OPEN') open++;
  }
  return { win, loss, open, netPts };
}

// 3) Run grids across all events + per-bucket
console.log(`── Overall (all WALL_BROKEN, all peak sizes) ──`);
console.log(`  ${'grid'.padEnd(20)}  W      L      OPEN   WR(closed)  netPts`);
for (const g of GRIDS) {
  const r = simulate(allBroken, g.tp, g.sl);
  const closed = r.win + r.loss;
  const wr = closed > 0 ? r.win/closed*100 : 0;
  console.log(`  ${g.label.padEnd(20)}  ${String(r.win).padStart(5)}  ${String(r.loss).padStart(5)}  ${String(r.open).padStart(5)}    ${wr.toFixed(1).padStart(5)}%      ${r.netPts > 0 ? '+' : ''}${r.netPts}`);
}

// Per peak-size bucket
for (const bucket of SIZE_BUCKETS) {
  const subset = allBroken.filter(e => e.peakSize >= bucket.min && e.peakSize < bucket.max);
  if (subset.length === 0) continue;
  console.log(`\n── Peak-size bucket ${bucket.name} (n=${subset.length}) ──`);
  console.log(`  ${'grid'.padEnd(20)}  W      L      OPEN   WR(closed)  netPts`);
  for (const g of GRIDS) {
    const r = simulate(subset, g.tp, g.sl);
    const closed = r.win + r.loss;
    const wr = closed > 0 ? r.win/closed*100 : 0;
    console.log(`  ${g.label.padEnd(20)}  ${String(r.win).padStart(5)}  ${String(r.loss).padStart(5)}  ${String(r.open).padStart(5)}    ${wr.toFixed(1).padStart(5)}%      ${r.netPts > 0 ? '+' : ''}${r.netPts}`);
  }
}

// Side breakdown for the most useful peak-size bucket
console.log(`\n── Side breakdown (peakSize ≥ 75, TP20/SL10) ──`);
for (const side of [0, 1]) {
  const subset = allBroken.filter(e => e.side === side && e.peakSize >= 75);
  const r = simulate(subset, 20, 10);
  const closed = r.win + r.loss;
  const wr = closed > 0 ? r.win/closed*100 : 0;
  const sideName = side === 0 ? 'BID broken (→ LONG fade)' : 'ASK broken (→ SHORT fade)';
  console.log(`  ${sideName.padEnd(28)} n=${subset.length}  W=${r.win} L=${r.loss} OPEN=${r.open}  WR=${wr.toFixed(1)}%  netPts=${r.netPts > 0 ? '+' : ''}${r.netPts}`);
}

db.close();
