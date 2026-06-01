/**
 * clean_moves_scan.ts — Find every "clean 30/10" move in NQ RTH and report.
 *
 * Definition of a clean entry minute:
 *   Suppose entry price = close of bar at minute m (causal — no lookahead in
 *   the entry decision; we use the close as a proxy for next-bar fill).
 *   Look at trades in the next HORIZON_MS:
 *     MFE_long  = max(price - entry)
 *     MAE_long  = max(entry - price)  during the window OR until entry would
 *                                       have hit a stop
 *   "Clean LONG" if MFE_long ≥ 30 AND MAE_long ≤ 10  (i.e. price moves 30 up
 *                                       with at most 10pt drawdown).
 *   Symmetric for SHORT.
 *
 * Per minute, also dump features over the trailing TRAIL_MS so we can later
 * eyeball what was happening: bar OHLC, delta, volume, range, recent session
 * high/low, position-in-day, etc.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const HORIZON_MS = 10 * 60 * 1000;   // 10 min forward
const MFE_PTS    = Number(process.env.MFE_PTS ?? 30);
const MAE_PTS    = Number(process.env.MAE_PTS ?? 10);
const MIN_ET_MIN = Number(process.env.MIN_ET_MIN ?? (9 * 60 + 35));   // skip opening range

const TRAIN_DATES = ['2026-05-05','2026-05-06','2026-05-08','2026-05-11','2026-05-12',
                     '2026-05-13','2026-05-14','2026-05-15','2026-05-18','2026-05-19'];
const TEST_DATES  = ['2026-05-20','2026-05-21','2026-05-22','2026-05-26','2026-05-27'];

const RTH_START_MIN = 9 * 60 + 35;
const RTH_END_MIN   = 15 * 60 + 55;

type Trade = { ts: number; price: number; size: number; isBidAgg: 0 | 1 };
type Bar = {
  minStartTs: number;
  open: number; high: number; low: number; close: number;
  vol: number; delta: number;
};

function etMinutesOfDay(tsMs: number): number {
  const d = new Date(tsMs - 4 * 60 * 60 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function etHHMM(tsMs: number): string {
  const d = new Date(tsMs - 4 * 60 * 60 * 1000);
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}

function loadTrades(db: Database.Database, date: string): Trade[] {
  const startTs = Date.parse(`${date}T08:00:00-04:00`);
  const endTs   = Date.parse(`${date}T16:30:00-04:00`);
  return db.prepare(
    `SELECT ts, price, size, is_bid_aggressor AS isBidAgg
     FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?
     ORDER BY ts ASC, id ASC`
  ).all(startTs, endTs) as Trade[];
}

function buildMinuteBars(trades: Trade[]): Bar[] {
  const bars: Bar[] = [];
  let cur: Bar | null = null;
  for (const t of trades) {
    const minStart = Math.floor(t.ts / 60000) * 60000;
    if (!cur || cur.minStartTs !== minStart) {
      if (cur) bars.push(cur);
      cur = { minStartTs: minStart, open: t.price, high: t.price, low: t.price, close: t.price, vol: 0, delta: 0 };
    }
    if (t.price > cur.high) cur.high = t.price;
    if (t.price < cur.low)  cur.low  = t.price;
    cur.close = t.price;
    cur.vol += t.size;
    cur.delta += (t.isBidAgg === 1 ? t.size : -t.size);  // agg=1 → BUY
  }
  if (cur) bars.push(cur);
  return bars;
}

type CleanMove = {
  date: string;
  entryEt: string;
  entryTs: number;
  entryPrice: number;
  direction: 'long' | 'short';
  mfe: number;
  mae: number;
  timeToMfeMs: number;
  // Prior 5-minute features
  prev5: { range: number; net: number; delta: number; vol: number; impulseCount: number };
  // Session position context
  rthHighSoFar: number;
  rthLowSoFar:  number;
  distFromHigh: number;   // pts from entry to rth high
  distFromLow:  number;   // pts from entry to rth low
};

function scanDate(db: Database.Database, date: string): CleanMove[] {
  const trades = loadTrades(db, date);
  const bars = buildMinuteBars(trades);
  if (!trades.length || !bars.length) return [];

  const out: CleanMove[] = [];

  // Binary-search helper for tick > ts.
  function firstIdxAfter(ts: number): number {
    let lo = 0, hi = trades.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (trades[mid].ts <= ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // Track session H/L causally as we sweep.
  let rthHi = -Infinity, rthLo = Infinity;

  const RTH_OPEN_MIN = 9 * 60 + 30;   // session extremes track from 9:30
  for (let bi = 0; bi < bars.length - 1; bi++) {
    const b = bars[bi];
    const mod = etMinutesOfDay(b.minStartTs);
    if (mod < RTH_OPEN_MIN || mod > RTH_END_MIN) continue;

    // Update session extremes — always, even during opening range.
    if (b.high > rthHi) rthHi = b.high;
    if (b.low  < rthLo) rthLo = b.low;
    // Entries only after MIN_ET_MIN.
    if (mod < MIN_ET_MIN) continue;

    const entryTs    = b.minStartTs + 60_000;  // open of next minute (proxy for execution)
    const entryPrice = b.close;
    const endTs      = entryTs + HORIZON_MS;

    // Forward scan: compute LONG and SHORT MFE/MAE.
    let i = firstIdxAfter(entryTs - 1);
    let mfeLong = 0, maeLong = 0, mfeShort = 0, maeShort = 0;
    let timeToMfeLongMs = HORIZON_MS, timeToMfeShortMs = HORIZON_MS;
    for (; i < trades.length && trades[i].ts <= endTs; i++) {
      const px = trades[i].price;
      const gL = px - entryPrice;
      const dL = entryPrice - px;
      if (gL > mfeLong)  { mfeLong  = gL; timeToMfeLongMs  = trades[i].ts - entryTs; }
      if (dL > maeLong)  maeLong  = dL;
      const gS = entryPrice - px;
      const dS = px - entryPrice;
      if (gS > mfeShort) { mfeShort = gS; timeToMfeShortMs = trades[i].ts - entryTs; }
      if (dS > maeShort) maeShort = dS;
    }

    // Trailing 5-min features (5 bars including the current).
    const startBi = Math.max(0, bi - 4);
    let prev5Range = 0, prev5Net = 0, prev5Delta = 0, prev5Vol = 0, impulseCount = 0;
    const firstBar = bars[startBi];
    const lastBar  = bars[bi];
    prev5Net   = lastBar.close - firstBar.open;
    let prev5Hi = -Infinity, prev5Lo = Infinity;
    for (let k = startBi; k <= bi; k++) {
      const x = bars[k];
      if (x.high > prev5Hi) prev5Hi = x.high;
      if (x.low  < prev5Lo) prev5Lo = x.low;
      prev5Delta += x.delta;
      prev5Vol   += x.vol;
      // impulse: range ≥ 8 AND |body|/range ≥ 0.5 (informal)
      const range = x.high - x.low;
      const body  = Math.abs(x.close - x.open);
      if (range >= 8 && range > 0 && body / range >= 0.5) impulseCount++;
    }
    prev5Range = prev5Hi - prev5Lo;

    const distFromHigh = rthHi - entryPrice;
    const distFromLow  = entryPrice - rthLo;

    if (mfeLong >= MFE_PTS && maeLong <= MAE_PTS) {
      out.push({
        date, entryEt: etHHMM(entryTs), entryTs, entryPrice, direction: 'long',
        mfe: mfeLong, mae: maeLong, timeToMfeMs: timeToMfeLongMs,
        prev5: { range: prev5Range, net: prev5Net, delta: prev5Delta, vol: prev5Vol, impulseCount },
        rthHighSoFar: rthHi, rthLowSoFar: rthLo,
        distFromHigh, distFromLow,
      });
    }
    if (mfeShort >= MFE_PTS && maeShort <= MAE_PTS) {
      out.push({
        date, entryEt: etHHMM(entryTs), entryTs, entryPrice, direction: 'short',
        mfe: mfeShort, mae: maeShort, timeToMfeMs: timeToMfeShortMs,
        prev5: { range: prev5Range, net: prev5Net, delta: prev5Delta, vol: prev5Vol, impulseCount },
        rthHighSoFar: rthHi, rthLowSoFar: rthLo,
        distFromHigh, distFromLow,
      });
    }
  }
  return out;
}

async function main() {
  const arg = process.argv[2];
  let dates: string[] = TRAIN_DATES;
  let mode = 'train';
  if (arg === 'test') { dates = TEST_DATES; mode = 'test'; }
  else if (arg && arg.startsWith('2026-')) { dates = [arg]; mode = 'one'; }

  console.log(`Clean 30/10 move scan — mode=${mode}  horizon=${HORIZON_MS/60_000}min  MFE≥${MFE_PTS}  MAE≤${MAE_PTS}`);
  const db = new Database(TICKS_DB, { readonly: true });
  db.pragma('journal_mode = WAL');

  const all: CleanMove[] = [];
  for (const date of dates) {
    const t0 = Date.now();
    const ms = scanDate(db, date);
    all.push(...ms);
    const longs = ms.filter(x => x.direction === 'long').length;
    const shorts = ms.filter(x => x.direction === 'short').length;
    console.log(`${date}: cleanMoves=${ms.length} (L=${longs} S=${shorts})  [${((Date.now()-t0)/1000).toFixed(1)}s]`);
  }
  db.close();

  console.log(`\nTOTAL: ${all.length} clean moves  (L=${all.filter(x=>x.direction==='long').length}  S=${all.filter(x=>x.direction==='short').length})`);
  console.log(`Avg per day: ${(all.length / dates.length).toFixed(1)}`);

  // Dedupe to distinct WAVE STARTS: keep a move only if the previous minute
  // for the same direction on the same date was NOT also a clean move.
  const moveByKey = new Map<string, CleanMove>();
  for (const m of all) {
    moveByKey.set(`${m.date}|${m.direction}|${m.entryTs}`, m);
  }
  const waveStarts: CleanMove[] = [];
  for (const m of all) {
    const prevTs = m.entryTs - 60_000;
    const prevKey = `${m.date}|${m.direction}|${prevTs}`;
    if (!moveByKey.has(prevKey)) waveStarts.push(m);
  }
  console.log(`\nWAVE STARTS: ${waveStarts.length}  (L=${waveStarts.filter(x=>x.direction==='long').length}  S=${waveStarts.filter(x=>x.direction==='short').length})`);
  console.log(`Avg per day: ${(waveStarts.length / dates.length).toFixed(1)}`);

  // Bucket by time of day.
  const byHour = new Map<string, number>();
  for (const m of waveStarts) {
    const h = m.entryEt.slice(0, 2);
    byHour.set(h, (byHour.get(h) ?? 0) + 1);
  }
  console.log('\nWave starts by hour (ET):');
  for (const [h, n] of [...byHour].sort()) console.log(`  ${h}:00 → ${n}`);

  // Bucket by distance from RTH extreme.
  console.log('\nLong wave starts — distance from RTH low (pts):');
  const longs = waveStarts.filter(m => m.direction === 'long');
  for (const bucket of [
    { name: '0–5',   lo: 0,   hi: 5 },
    { name: '5–15',  lo: 5,   hi: 15 },
    { name: '15–30', lo: 15,  hi: 30 },
    { name: '30–60', lo: 30,  hi: 60 },
    { name: '60+',   lo: 60,  hi: Infinity },
  ]) {
    const n = longs.filter(m => m.distFromLow >= bucket.lo && m.distFromLow < bucket.hi).length;
    console.log(`  ${bucket.name.padEnd(6)} → ${n}`);
  }
  console.log('\nShort wave starts — distance from RTH high (pts):');
  const shorts = waveStarts.filter(m => m.direction === 'short');
  for (const bucket of [
    { name: '0–5',   lo: 0,   hi: 5 },
    { name: '5–15',  lo: 5,   hi: 15 },
    { name: '15–30', lo: 15,  hi: 30 },
    { name: '30–60', lo: 30,  hi: 60 },
    { name: '60+',   lo: 60,  hi: Infinity },
  ]) {
    const n = shorts.filter(m => m.distFromHigh >= bucket.lo && m.distFromHigh < bucket.hi).length;
    console.log(`  ${bucket.name.padEnd(6)} → ${n}`);
  }

  console.log('\n── Wave starts only ──');
  const wavePrint = waveStarts;
  console.log('date       et    dir   entry      mfe   mae  ttMfe(s) p5rng p5net p5dlta  p5vol  imp  rthHi      rthLo      dFromHi dFromLo');
  for (const m of wavePrint) {
    console.log(
      `${m.date}  ${m.entryEt}  ${m.direction.padEnd(5)} ${m.entryPrice.toFixed(2).padStart(8)} ` +
      `${m.mfe.toFixed(1).padStart(5)} ${m.mae.toFixed(1).padStart(4)} ${(m.timeToMfeMs/1000).toFixed(0).padStart(5)}    ` +
      `${m.prev5.range.toFixed(1).padStart(5)} ${m.prev5.net.toFixed(1).padStart(5)} ${m.prev5.delta.toString().padStart(6)} ${String(m.prev5.vol).padStart(6)}  ${String(m.prev5.impulseCount).padStart(2)}  ` +
      `${m.rthHighSoFar.toFixed(2).padStart(8)}  ${m.rthLowSoFar.toFixed(2).padStart(8)}  ${m.distFromHigh.toFixed(1).padStart(6)} ${m.distFromLow.toFixed(1).padStart(6)}`
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); });
