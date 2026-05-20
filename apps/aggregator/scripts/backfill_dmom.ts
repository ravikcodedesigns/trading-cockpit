/**
 * DMOM — Delta Momentum Burst calibration backfill.
 *
 * Pattern: cumulative 15-bar delta surges strongly in one direction WHILE
 * price drifts the OTHER way — classic absorption / trapped-crowd setup.
 * Buyers absorb sellers on the way down (→ long), sellers absorb buyers on
 * the way up (→ short). Price eventually exhausts against the delta and rips.
 *
 * Probe on known missed moves confirmed: zero of them had a breakout bar —
 * all had price moving AGAINST the delta. Detection must reflect that.
 *
 * Detection conditions:
 *   1. RTH only, after 10:00 ET (opening gate)
 *   2. |delta15| >= THRESHOLD in direction of trade
 *   3. DIVERGENCE: price velocity last 5 bars opposes delta
 *      (long: vel5 <= -1 pt/min; short: vel5 >= +1 pt/min)
 *   4. No broadcast gold signal (H/EXPL/J) in same direction within 30 min
 *   5. Cooldown: 30 min per direction
 *
 * Outcome: hit +80pts before -20pts adverse within 4h.
 *
 * Run: npx tsx scripts/backfill_dmom.ts
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH    = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_PATH = path.resolve(__dirname, '../../../data/ticks.db');

const db      = new Database(DB_PATH,    { readonly: true });
const ticksDb = new Database(TICKS_PATH, { readonly: true });

const MIN_1          = 60_000;
const STANDALONE_WIN = 45 * MIN_1;   // no broadcast signal within this window
const COOLDOWN_MS    = 30 * MIN_1;
const FORWARD_BARS   = 240;          // 4h
const TARGET_PTS     = 80;
const STOP_PTS       = 20;
const OPEN_GATE_MIN  = 600;          // no DMOM before 10:00 ET
const VEL5_THRESHOLD = 1.0;          // pts/min divergence minimum

// Test these thresholds to find the optimal cut
const THRESHOLDS = [1500, 2000, 2500, 3000, 4000, 5000];

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

// ── Load broadcast signals (H/EXPL/J) for standalone check ───────────────────
const broadcastSignals = db.prepare(`
  SELECT ts, direction FROM signals
  WHERE symbol='NQ' AND rs_hard_filtered IS NOT 1
    AND (
      strategy_version='H'
      OR (strategy_version='EXPL' AND direction='long'
          AND json_array_length(json_extract(payload,'$.stackedBidZones')) > 0
          AND (json_extract(payload,'$.rangePct') IS NULL OR json_extract(payload,'$.rangePct') >= 0.5))
      OR strategy_version='J'
    )
  ORDER BY ts
`).all() as { ts: number; direction: string }[];
db.close();
console.log(`Broadcast signals for standalone check: ${broadcastSignals.length}`);

// ── Build 1-min bars with delta ───────────────────────────────────────────────
console.log('Building 1-min bars...');
const raw = ticksDb.prepare(`
  SELECT ts, price, size, is_bid_aggressor
  FROM trades WHERE symbol='NQ' ORDER BY ts ASC
`).all() as { ts: number; price: number; size: number; is_bid_aggressor: number }[];
ticksDb.close();

type Bar = { ts: number; open: number; high: number; low: number; close: number; vol: number; delta: number };
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
const bars: Bar[] = [...bmap.entries()].sort(([a],[b]) => a - b)
  .map(([ts, b]) => ({ ts, open: b.open, high: b.high, low: b.low, close: b.close,
    vol: b.askVol + b.bidVol, delta: b.askVol - b.bidVol }));
const rthBars = bars.filter(b => isRTH(b.ts));
console.log(`  ${rthBars.length} RTH bars\n`);

// ── Helpers ───────────────────────────────────────────────────────────────────
function hasRecentBroadcast(moveTs: number, dir: string): boolean {
  for (const g of broadcastSignals) {
    if (g.direction !== dir) continue;
    const lag = moveTs - g.ts;
    if (lag >= 0 && lag <= STANDALONE_WIN) return true;
  }
  return false;
}

type Signal = {
  ts: number; direction: string; entry: number;
  delta15: number; vel5: number; compPos: number;
  score: number;
  outcome: 'win' | 'fail' | 'open'; maxGain: number; maxDD: number;
};

// ── Scan at each threshold ────────────────────────────────────────────────────
const LOOKBACK = 15;

for (const DELTA_THRESHOLD of THRESHOLDS) {
  const signals: Signal[] = [];
  const lastFiredMs: Record<string, number> = { long: 0, short: 0 };

  for (let i = LOOKBACK + 5; i < rthBars.length - FORWARD_BARS; i++) {
    const cur = rthBars[i]!;
    if (!isRTH(cur.ts)) continue;
    if (etMin(cur.ts) < OPEN_GATE_MIN) continue;

    for (const dir of ['long', 'short'] as const) {
      if (cur.ts - lastFiredMs[dir]! < COOLDOWN_MS) continue;
      if (hasRecentBroadcast(cur.ts, dir)) continue;

      const pre = rthBars.slice(i - LOOKBACK, i);  // 15 bars before current

      // Delta: cumulative over 15 bars — must be strong in direction of trade
      const delta15 = pre.reduce((s, b) => s + b.delta, 0);
      const isLong  = dir === 'long';
      if (isLong  && delta15 < DELTA_THRESHOLD)  continue;
      if (!isLong && delta15 > -DELTA_THRESHOLD) continue;

      // DIVERGENCE: price velocity last 5 bars must oppose the delta direction.
      // Long: buyers absorbing while price drifts down (vel5 <= -VEL5_THRESHOLD)
      // Short: sellers absorbing while price drifts up  (vel5 >= +VEL5_THRESHOLD)
      const last5 = pre.slice(-5);
      const vel5  = (last5[last5.length - 1]!.close - last5[0]!.open) / 5;
      if (isLong  && vel5 > -VEL5_THRESHOLD) continue;
      if (!isLong && vel5 <  VEL5_THRESHOLD) continue;

      // comp_pos: where is price relative to 30-bar range? (context, not filter)
      const macro    = rthBars.slice(Math.max(0, i - 30), i);
      const macroHigh = Math.max(...macro.map(b => b.high));
      const macroLow  = Math.min(...macro.map(b => b.low));
      const compPos   = macroHigh > macroLow
        ? (cur.close - macroLow) / (macroHigh - macroLow)
        : 0.5;

      // Score: delta magnitude + velocity divergence strength
      let score = 70;
      const absDelta = Math.abs(delta15);
      if (absDelta >= 8000) score += 20;
      else if (absDelta >= 4000) score += 15;
      else if (absDelta >= 2000) score += 10;
      const absVel = Math.abs(vel5);
      if (absVel >= 5) score += 10;
      else if (absVel >= 2) score += 5;
      score = Math.min(100, score);

      // Outcome
      const entry = cur.close;
      const fwd   = rthBars.slice(i, i + FORWARD_BARS);
      let maxGain = 0, maxDD = 0;
      let outcome: 'win' | 'fail' | 'open' = 'open';

      for (const fb of fwd) {
        const gain = isLong ? fb.high - entry : entry - fb.low;
        const dd   = isLong ? entry - fb.low  : fb.high - entry;
        if (gain > maxGain) maxGain = gain;
        if (dd   > maxDD)   maxDD   = dd;
        if (gain >= TARGET_PTS) { outcome = 'win'; break; }
        if (dd   >= STOP_PTS)   { outcome = 'fail'; break; }
      }

      lastFiredMs[dir] = cur.ts;
      signals.push({ ts: cur.ts, direction: dir, entry,
        delta15, vel5, compPos,
        score, outcome, maxGain, maxDD });
    }
  }

  const wins   = signals.filter(s => s.outcome === 'win');
  const fails  = signals.filter(s => s.outcome === 'fail');
  const closed = signals.filter(s => s.outcome !== 'open');
  const wr     = closed.length ? `${wins.length}/${closed.length} (${Math.round(100*wins.length/closed.length)}%)` : 'n/a';
  const avgGain = wins.length ? (wins.reduce((s,x) => s + x.maxGain, 0) / wins.length).toFixed(1) : 'n/a';
  const avgDD   = fails.length ? (fails.reduce((s,x) => s + x.maxDD, 0) / fails.length).toFixed(1) : 'n/a';

  console.log(`δ≥${String(DELTA_THRESHOLD).padStart(5)}:  n=${String(signals.length).padStart(3)}  WR=${wr.padEnd(14)}  avgWinGain=${avgGain.padStart(6)}  avgFailDD=${avgDD.padStart(6)}  long=${signals.filter(s=>s.direction==='long').length}  short=${signals.filter(s=>s.direction==='short').length}`);

  // Print signal detail for thresholds with reasonable signal count
  if (DELTA_THRESHOLD === 2000) {
    console.log(`\n  ── δ≥2000 signal detail ──`);
    console.log(`  ${'Time'.padEnd(14)} ${'Dir'.padEnd(6)} ${'Entry'.padStart(8)} ${'δ15'.padStart(7)} ${'vel5'.padStart(6)} ${'Scr'.padStart(4)} ${'Out'.padEnd(5)} ${'Gain'.padStart(6)} ${'DD'.padStart(6)}`);
    console.log('  ' + '-'.repeat(74));
    for (const s of signals) {
      console.log(
        `  ${etLabel(s.ts).padEnd(14)} ${s.direction.padEnd(6)} ${s.entry.toFixed(2).padStart(8)} ` +
        `${s.delta15.toString().padStart(7)} ${s.vel5.toFixed(1).padStart(6)} ${s.score.toString().padStart(4)} ` +
        `${s.outcome.padEnd(5)} ${s.maxGain.toFixed(1).padStart(6)} ${s.maxDD.toFixed(1).padStart(6)}`
      );
    }
    console.log('');
  }
}
