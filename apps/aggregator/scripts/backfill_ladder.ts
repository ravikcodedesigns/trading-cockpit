/**
 * LADDER — Consolidation-Breakout detector.
 *
 * A "price ladder" is N≥3 consecutive same-direction bars where price moves
 * nearly linearly (small open-close gaps, strong bodies). This script detects
 * the CONSOLIDATION that precedes a ladder and the BREAKOUT bar that starts it.
 *
 * Detection conditions (swept across threshold combinations):
 *   1. RTH only, after 10:00 ET
 *   2. Compression gate: last CON_N bars all have range < CON_MAX_RANGE
 *   3. Breakout bar: current bar body ≥ BODY_MIN AND body/range ≥ BODY_PCT_MIN
 *   4. Delta confirmation: bar delta aligns with direction (not opposing)
 *   5. Cooldown: 15 min per direction
 *
 * Outcome: within FORWARD_BARS, does a ladder of ≥3 bars form with total ≥ TARGET_PTS?
 * Also tracks simple TP80/SL20 outcome as secondary metric.
 *
 * Run: npx tsx scripts/backfill_ladder.ts
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const TICKS_PATH = path.resolve(__dirname, '../../../data/ticks.db');

const MIN_1         = 60_000;
const FORWARD_BARS  = 60;     // 1h to form a ladder
const TARGET_PTS    = 80;     // TP for secondary metric
const STOP_PTS      = 20;     // SL for secondary metric
const LADDER_BARS   = 3;      // min bars for a ladder (including bar 1 = trigger bar)
const LADDER_TOTAL  = 30;     // min pts for a ladder to count as win
const OPEN_GATE_MIN = 600;    // no signals before 10:00 ET
const COOLDOWN_MS   = 0;      // no cooldown — measure raw hit rate
const GAP_MAX       = 8;      // max gap between ladder bar opens/closes

const ET = 'America/New_York';
function etMin(ts: number) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(ts));
  return parseInt(p.find(x => x.type === 'hour')!.value) * 60 +
         parseInt(p.find(x => x.type === 'minute')!.value);
}
function isRTH(ts: number) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: ET, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(ts));
  const wd = p.find(x => x.type === 'weekday')!.value;
  const m  = etMin(ts);
  return ['Mon','Tue','Wed','Thu','Fri'].includes(wd) && m >= 570 && m < 960;
}
function etLabel(ts: number) {
  return new Intl.DateTimeFormat('en-US', { timeZone: ET, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(ts));
}

// ── Build 1-min bars ──────────────────────────────────────────────────────────
console.log('Building 1-min bars from ticks...');
const ticksDb = new Database(TICKS_PATH, { readonly: true });
const raw = ticksDb.prepare(`
  SELECT ts, price, size, is_bid_aggressor
  FROM trades WHERE symbol='NQ' ORDER BY ts ASC
`).all() as { ts: number; price: number; size: number; is_bid_aggressor: number }[];
ticksDb.close();

type Bar = { ts: number; open: number; high: number; low: number; close: number; delta: number };
const bmap = new Map<number, { open: number; high: number; low: number; close: number; askVol: number; bidVol: number }>();
for (const t of raw) {
  const bts = Math.floor(t.ts / MIN_1) * MIN_1;
  let b = bmap.get(bts);
  if (!b) { b = { open: t.price, high: t.price, low: t.price, close: t.price, askVol: 0, bidVol: 0 }; bmap.set(bts, b); }
  if (t.price > b.high) b.high = t.price;
  if (t.price < b.low)  b.low  = t.price;
  b.close = t.price;
  if (t.is_bid_aggressor) b.bidVol += t.size; else b.askVol += t.size;
}
const allBars: Bar[] = [...bmap.entries()].sort(([a], [b]) => a - b)
  .map(([ts, b]) => ({ ts, open: b.open, high: b.high, low: b.low, close: b.close,
    delta: b.askVol - b.bidVol }));
const rthBars = allBars.filter(b => isRTH(b.ts));
console.log(`  ${rthBars.length} RTH 1-min bars\n`);

// ── Ladder checker ────────────────────────────────────────────────────────────
// startIdx is bar 1 (the trigger bar itself). A ladder requires LADDER_BARS
// consecutive same-direction bars starting at startIdx, with small open gaps
// and total body >= LADDER_TOTAL.
function measureLadder(bars: Bar[], startIdx: number, dir: 'long' | 'short', bodyMin: number): {
  formed: boolean; barCount: number; totalPts: number;
} {
  const isLong = dir === 'long';
  let count = 0;
  let totalPts = 0;
  let prev: Bar | null = null;

  for (let j = startIdx; j < Math.min(bars.length, startIdx + FORWARD_BARS); j++) {
    const b = bars[j]!;
    const isCorrectDir = isLong ? b.close > b.open : b.close < b.open;
    if (!isCorrectDir) break;
    const body = Math.abs(b.close - b.open);
    if (body < bodyMin) break;
    if (prev !== null) {
      const gap = Math.abs(b.open - prev.close);
      if (gap > GAP_MAX) break;
    }
    count++;
    totalPts += body;
    prev = b;
    if (count >= LADDER_BARS && totalPts >= LADDER_TOTAL) {
      return { formed: true, barCount: count, totalPts };
    }
  }
  return { formed: false, barCount: count, totalPts };
}

// ── TP80/SL20 outcome ─────────────────────────────────────────────────────────
function measureTPSL(bars: Bar[], startIdx: number, dir: 'long' | 'short'): 'win' | 'fail' | 'open' {
  const entry = bars[startIdx]!.close;
  const isLong = dir === 'long';
  for (let j = startIdx + 1; j < Math.min(bars.length, startIdx + FORWARD_BARS); j++) {
    const b = bars[j]!;
    const gain = isLong ? b.high - entry : entry - b.low;
    const dd   = isLong ? entry - b.low  : b.high - entry;
    if (gain >= TARGET_PTS) return 'win';
    if (dd   >= STOP_PTS)   return 'fail';
  }
  return 'open';
}

// ── Base rate (no filter) ─────────────────────────────────────────────────────
{
  let ladderBase = 0, tpslWins = 0, tpslClosed = 0;
  for (let i = 1; i < rthBars.length - FORWARD_BARS; i++) {
    const cur = rthBars[i]!;
    if (etMin(cur.ts) < OPEN_GATE_MIN) continue;
    const barBody = Math.abs(cur.close - cur.open);
    if (barBody < 6) continue;  // need at least a directional bar
    const dir: 'long'|'short' = cur.close > cur.open ? 'long' : 'short';
    const { formed } = measureLadder(rthBars, i, dir, 6);
    const tpsl = measureTPSL(rthBars, i, dir);
    if (formed) ladderBase++;
    if (tpsl === 'win') tpslWins++;
    if (tpsl !== 'open') tpslClosed++;
  }
  const n = rthBars.filter(b => etMin(b.ts) >= OPEN_GATE_MIN).length;
  console.log(`Base rate (any directional bar ≥6pts body, no compression filter):`);
  console.log(`  n=${n}, ladderWR=${ladderBase}/${n} (${(100*ladderBase/n).toFixed(1)}%), tpslWR=${tpslWins}/${tpslClosed} (${Math.round(100*tpslWins/tpslClosed)}%)\n`);
}

// ── Threshold sweep ───────────────────────────────────────────────────────────
// CON_N: lookback window for compression check (5 or 10 bars)
// CON_MAX: each bar in window must have range < this
// BODY_MIN: breakout bar body must be >= this
// BODY_PCT: breakout bar body/range must be >= this

const CON_N_VALS    = [5, 8];
const CON_MAX_VALS  = [25, 35, 50];   // pts — max range of each compression bar
const BODY_MIN_VALS = [6, 8, 10, 14]; // pts — min body of bar 1 (trigger = ladder bar 1)
const BODY_PCT_VALS = [0.45, 0.55, 0.65]; // body/range ratio

type Result = {
  conN: number; conMax: number; bodyMin: number; bodyPct: number;
  n: number; ladderWins: number; tpslWins: number; tpslFails: number;
};

const results: Result[] = [];

for (const conN of CON_N_VALS) {
  for (const conMax of CON_MAX_VALS) {
    for (const bodyMin of BODY_MIN_VALS) {
      for (const bodyPct of BODY_PCT_VALS) {
        const signals: { ts: number; dir: 'long'|'short'; ladderFormed: boolean; tpsl: 'win'|'fail'|'open' }[] = [];
        const lastFiredMs: Record<string, number> = { long: 0, short: 0 };

        for (let i = conN + 1; i < rthBars.length - FORWARD_BARS; i++) {
          const cur = rthBars[i]!;
          if (etMin(cur.ts) < OPEN_GATE_MIN) continue;

          const barRange = cur.high - cur.low;
          const barBody  = Math.abs(cur.close - cur.open);
          if (barRange === 0) continue;
          if (barBody < bodyMin) continue;
          if (barBody / barRange < bodyPct) continue;

          const dir: 'long' | 'short' = cur.close > cur.open ? 'long' : 'short';
          if (cur.ts - lastFiredMs[dir]! < COOLDOWN_MS) continue;

          // Compression check: each of last conN bars must have range < conMax
          const window = rthBars.slice(i - conN, i);
          const compressed = window.every(b => (b.high - b.low) < conMax);
          if (!compressed) continue;

          // Delta alignment: delta must not strongly oppose direction
          const isLong = dir === 'long';
          if (isLong  && cur.delta < -200) continue;
          if (!isLong && cur.delta >  200) continue;

          const { formed } = measureLadder(rthBars, i, dir, bodyMin);
          const tpsl = measureTPSL(rthBars, i, dir);

          lastFiredMs[dir] = cur.ts;
          signals.push({ ts: cur.ts, dir, ladderFormed: formed, tpsl });
        }

        const n = signals.length;
        const ladderWins = signals.filter(s => s.ladderFormed).length;
        const tpslWins   = signals.filter(s => s.tpsl === 'win').length;
        const tpslFails  = signals.filter(s => s.tpsl === 'fail').length;
        results.push({ conN, conMax, bodyMin, bodyPct, n, ladderWins, tpslWins, tpslFails });
      }
    }
  }
}

// ── Print sweep table ─────────────────────────────────────────────────────────
console.log('conN  conMax  bodyMin  bodyPct    n   ladderWR   tpslWR');
console.log('-'.repeat(62));
for (const r of results.sort((a, b) => b.ladderWins / (b.n || 1) - a.ladderWins / (a.n || 1))) {
  if (r.n < 5) continue;
  const ladderWR = r.n ? `${r.ladderWins}/${r.n} (${Math.round(100 * r.ladderWins / r.n)}%)` : 'n/a';
  const tpslClosed = r.tpslWins + r.tpslFails;
  const tpslWR = tpslClosed ? `${r.tpslWins}/${tpslClosed} (${Math.round(100 * r.tpslWins / tpslClosed)}%)` : 'n/a';
  console.log(
    `${String(r.conN).padStart(4)}  ${String(r.conMax).padStart(6)}  ${String(r.bodyMin).padStart(7)}  ${String(r.bodyPct).padStart(7)}` +
    `  ${String(r.n).padStart(4)}   ${ladderWR.padEnd(12)} ${tpslWR}`
  );
}

// ── Best config detail print ──────────────────────────────────────────────────
const best = results.filter(r => r.n >= 10).sort((a, b) =>
  b.ladderWins / (b.n || 1) - a.ladderWins / (a.n || 1)
)[0];

if (best) {
  console.log(`\nBest config: conN=${best.conN}, conMax=${best.conMax}, bodyMin=${best.bodyMin}, bodyPct=${best.bodyPct}`);
  console.log(`  n=${best.n}, ladderWR=${best.ladderWins}/${best.n} (${Math.round(100*best.ladderWins/best.n)}%)`);

  // Re-run to get per-signal detail
  const signals: { ts: number; dir: string; ladderFormed: boolean; barCount: number; totalPts: number; tpsl: string }[] = [];
  const lastFiredMs: Record<string, number> = { long: 0, short: 0 };
  const { conN, conMax, bodyMin, bodyPct } = best;

  for (let i = conN + 1; i < rthBars.length - FORWARD_BARS; i++) {
    const cur = rthBars[i]!;
    if (etMin(cur.ts) < OPEN_GATE_MIN) continue;
    const barRange = cur.high - cur.low;
    const barBody  = Math.abs(cur.close - cur.open);
    if (barRange === 0 || barBody < bodyMin || barBody / barRange < bodyPct) continue;
    const dir: 'long' | 'short' = cur.close > cur.open ? 'long' : 'short';
    if (cur.ts - lastFiredMs[dir]! < COOLDOWN_MS) continue;
    const window = rthBars.slice(i - conN, i);
    if (!window.every(b => (b.high - b.low) < conMax)) continue;
    const isLong = dir === 'long';
    if (isLong && cur.delta < -200) continue;
    if (!isLong && cur.delta > 200) continue;

    const { formed, barCount, totalPts } = measureLadder(rthBars, i, dir, bodyMin);
    const tpsl = measureTPSL(rthBars, i, dir);
    lastFiredMs[dir] = cur.ts;
    signals.push({ ts: cur.ts, dir, ladderFormed: formed, barCount, totalPts, tpsl });
  }

  console.log(`\n  ${'Time'.padEnd(14)} ${'Dir'.padEnd(6)} ${'Ladder'.padEnd(7)} ${'Bars'.padEnd(5)} ${'Pts'.padEnd(7)} TPSL`);
  console.log('  ' + '-'.repeat(52));
  for (const s of signals) {
    console.log(
      `  ${etLabel(s.ts).padEnd(14)} ${s.dir.padEnd(6)} ${(s.ladderFormed ? 'YES' : 'no').padEnd(7)}` +
      ` ${String(s.barCount).padEnd(5)} ${s.totalPts.toFixed(1).padEnd(7)} ${s.tpsl}`
    );
  }
}
