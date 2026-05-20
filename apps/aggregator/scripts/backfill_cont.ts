/**
 * Backfill validation for Strategy CONT.
 *
 * Replays the CONT detection logic against historical data and measures
 * win rates (hit +80pts before -20pts adverse within 4h).
 *
 * Run: npx tsx scripts/backfill_cont.ts
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH    = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_PATH = path.resolve(__dirname, '../../../data/ticks.db');

const db      = new Database(DB_PATH, { readonly: true });
const ticksDb = new Database(TICKS_PATH, { readonly: true });

const MIN_1         = 60_000;
const PARENT_WINDOW = 90 * MIN_1;
const MIN_EXTENSION = 60;   // <60pt extensions all fail historically
const RETRACE_MIN   = 0.25;  // calibrated: 20-24% retraces all fail
const RETRACE_MAX   = 0.48;  // >48% retraces all fail historically
const DELTA_REALIGN = 600;
const DELTA_BAR_MIN = 100;
const COOLDOWN_MS   = 30 * MIN_1;
const OPEN_GATE_MIN = 600;   // no CONT before 10:00 ET
const TARGET_PTS    = 80;
const STOP_PTS      = 20;
const FORWARD_MS    = 4 * 60 * 60_000;

// ── Load parent gold signals ───────────────────────────────────────────────────
const goldSignals = db.prepare(`
  SELECT ts, direction, strategy_version,
    json_extract(payload,'$.entry') as entry
  FROM signals
  WHERE symbol='NQ'
    AND rs_hard_filtered IS NOT 1
    AND json_extract(payload,'$.entry') IS NOT NULL
    AND (
      strategy_version='H'
      OR (strategy_version='EXPL' AND direction='long')
      OR (strategy_version='B' AND score>=80)
    )
  ORDER BY ts
`).all() as { ts: number; direction: string; strategy_version: string; entry: number }[];

console.log(`Loaded ${goldSignals.length} gold parent signals`);

// ── Build 1-min bars from tick data ──────────────────────────────────────────
console.log('Building 1-min bars from tick data...');

const allTicks = ticksDb.prepare(`
  SELECT ts, price, size, is_bid_aggressor
  FROM trades WHERE symbol='NQ'
  ORDER BY ts ASC
`).all() as { ts: number; price: number; size: number; is_bid_aggressor: number }[];

const barMap = new Map<number, { open: number; high: number; low: number; close: number; askVol: number; bidVol: number }>();
for (const t of allTicks) {
  const bts = Math.floor(t.ts / MIN_1) * MIN_1;
  let b = barMap.get(bts);
  if (!b) {
    b = { open: t.price, high: t.price, low: t.price, close: t.price, askVol: 0, bidVol: 0 };
    barMap.set(bts, b);
  }
  if (t.price > b.high) b.high = t.price;
  if (t.price < b.low)  b.low  = t.price;
  b.close = t.price;
  if (t.is_bid_aggressor) b.bidVol += t.size;
  else                    b.askVol += t.size;
}

const sortedBars = [...barMap.entries()]
  .sort(([a], [b]) => a - b)
  .map(([ts, b]) => ({
    ts, open: b.open, high: b.high, low: b.low, close: b.close,
    delta: b.askVol - b.bidVol,
  }));

console.log(`  ${sortedBars.length.toLocaleString()} 1-min bars`);

function barsInRange(fromTs: number, toTs: number) {
  return sortedBars.filter(b => b.ts >= fromTs && b.ts <= toTs);
}

function isRTH(tsMs: number): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const wd = get('weekday');
  const min = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  return ['Mon','Tue','Wed','Thu','Fri'].includes(wd) && min >= 570 && min < 960;
}

function etLabel(ts: number) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ts));
}

// ── Simulate CONT detection minute by minute ───────────────────────────────────
console.log('Simulating CONT detection...');

type Outcome = 'win' | 'fail' | 'open';
type ContSignal = {
  ts: number; direction: string; entry: number;
  parentTs: number; parentEntry: number; extensionPts: number; retracePct: number;
  delta15: number; deltaBar: number; score: number;
  outcome: Outcome; maxGain: number; maxDD: number; barsToTarget: number | null;
};

const signals: ContSignal[] = [];
const lastFiredMs:  Record<string, number> = { long: 0, short: 0 };
const lastParentTs: Record<string, number> = { long: 0, short: 0 };

// Walk through each RTH bar
for (let i = 20; i < sortedBars.length - 300; i++) {
  const cur = sortedBars[i]!;
  if (!isRTH(cur.ts)) continue;

  // Opening gate: no CONT before 10:00 ET
  const etMin = (() => {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = fmt.formatToParts(new Date(cur.ts));
    return parseInt(parts.find(p => p.type === 'hour')!.value, 10) * 60 +
           parseInt(parts.find(p => p.type === 'minute')!.value, 10);
  })();
  if (etMin < OPEN_GATE_MIN) continue;

  for (const direction of ['long', 'short'] as const) {
    // Cooldown check
    if (cur.ts - lastFiredMs[direction]! < COOLDOWN_MS) continue;

    // Find most recent gold parent signal in same direction within 90 min
    const sinceTs = cur.ts - PARENT_WINDOW;
    const parent = goldSignals
      .filter(g => g.direction === direction && g.ts >= sinceTs && g.ts < cur.ts)
      .at(-1);
    if (!parent) continue;

    // One CONT per parent signal
    if (lastParentTs[direction] === parent.ts) continue;

    // Bars from parent signal to current (inclusive)
    const postParentBars = sortedBars.filter(b => b.ts >= Math.floor(parent.ts / MIN_1) * MIN_1 && b.ts <= cur.ts);
    if (postParentBars.length < 3) continue;

    const isLong = direction === 'long';

    // Max favorable extension
    const peakGain = isLong
      ? Math.max(...postParentBars.map(b => b.high)) - parent.entry
      : parent.entry - Math.min(...postParentBars.map(b => b.low));
    if (peakGain < MIN_EXTENSION) continue;

    // Current gain
    const currentGain = isLong
      ? cur.close - parent.entry
      : parent.entry - cur.close;
    if (currentGain <= 0) continue;

    // Retrace
    const retracePct = (peakGain - currentGain) / peakGain;
    if (retracePct < RETRACE_MIN || retracePct > RETRACE_MAX) continue;

    // Delta re-alignment (last 15 bars)
    const last15 = sortedBars.slice(Math.max(0, i - 14), i + 1);
    const delta15 = last15.reduce((s, b) => s + b.delta, 0);
    const deltaBar = cur.delta;

    const deltaOk = isLong
      ? delta15 >= DELTA_REALIGN && deltaBar >= DELTA_BAR_MIN
      : delta15 <= -DELTA_REALIGN && deltaBar <= -DELTA_BAR_MIN;
    if (!deltaOk) continue;

    // Score
    let score = 70;
    const absDelta15 = Math.abs(delta15);
    if (absDelta15 > 1500) score += 10;
    else if (absDelta15 > 1000) score += 5;
    if (retracePct <= 0.35) score += 10;
    if (parent.strategy_version === 'H' || parent.strategy_version === 'EXPL') score += 5;
    score = Math.min(100, score);

    // Evaluate outcome: scan forward up to 4h
    const forwardBars = sortedBars.filter(b => b.ts > cur.ts && b.ts <= cur.ts + FORWARD_MS && isRTH(b.ts));
    const entry = cur.close;
    let maxGain = 0, maxDD = 0, barsToTarget: number | null = null;
    let outcome: Outcome = 'open';

    for (let j = 0; j < forwardBars.length; j++) {
      const fb = forwardBars[j]!;
      const gain = isLong ? fb.high - entry : entry - fb.low;
      const dd   = isLong ? entry - fb.low  : fb.high - entry;
      if (gain > maxGain) maxGain = gain;
      if (dd > maxDD) maxDD = dd;
      if (gain >= TARGET_PTS && outcome === 'open') {
        outcome = 'win'; barsToTarget = j + 1; break;
      }
      if (dd >= STOP_PTS && outcome === 'open') {
        outcome = 'fail'; break;
      }
    }

    lastFiredMs[direction]  = cur.ts;
    lastParentTs[direction] = parent.ts;

    signals.push({
      ts: cur.ts, direction, entry,
      parentTs: parent.ts, parentEntry: parent.entry,
      extensionPts: peakGain, retracePct, delta15, deltaBar, score,
      outcome, maxGain, maxDD, barsToTarget,
    });
  }
}

// ── Report ─────────────────────────────────────────────────────────────────────
const wins  = signals.filter(s => s.outcome === 'win');
const fails = signals.filter(s => s.outcome === 'fail');
const open  = signals.filter(s => s.outcome === 'open');
const closed = signals.filter(s => s.outcome !== 'open');

const wr = closed.length > 0 ? `${wins.length}/${closed.length} (${Math.round(wins.length/closed.length*100)}%)` : 'n/a';
const avgGain = wins.length ? (wins.reduce((s, x) => s + x.maxGain, 0) / wins.length).toFixed(1) : 'n/a';
const avgDD   = fails.length ? (fails.reduce((s, x) => s + x.maxDD, 0) / fails.length).toFixed(1) : 'n/a';
const avgBars = wins.filter(s => s.barsToTarget !== null).length
  ? (wins.reduce((s, x) => s + (x.barsToTarget ?? 0), 0) / wins.length).toFixed(1) : 'n/a';

console.log(`\n${'='.repeat(65)}`);
console.log(`STRATEGY CONT BACKFILL — NQ RTH  May 4–19`);
console.log('='.repeat(65));
console.log(`Total signals:      ${signals.length}`);
console.log(`  Long:             ${signals.filter(s => s.direction === 'long').length}`);
console.log(`  Short:            ${signals.filter(s => s.direction === 'short').length}`);
console.log(`Win rate (closed):  ${wr}`);
console.log(`  Wins:             ${wins.length}   avg max gain: ${avgGain}pts`);
console.log(`  Fails:            ${fails.length}   avg max DD on fails: ${avgDD}pts`);
console.log(`  Open:             ${open.length}`);
console.log(`Avg bars to target: ${avgBars} min`);

// By direction
for (const dir of ['long', 'short'] as const) {
  const sub = signals.filter(s => s.direction === dir);
  const sw = sub.filter(s => s.outcome === 'win');
  const sf = sub.filter(s => s.outcome === 'fail');
  const sc = sub.filter(s => s.outcome !== 'open');
  const dwr = sc.length > 0 ? `${sw.length}/${sc.length} (${Math.round(sw.length/sc.length*100)}%)` : 'n/a';
  console.log(`\n  ${dir.toUpperCase()}:  n=${sub.length}  win=${dwr}  avg_gain=${sw.length ? (sw.reduce((s,x)=>s+x.maxGain,0)/sw.length).toFixed(1) : 'n/a'}`);
}

// By score band
console.log('\n── Score bands ──');
for (const [lo, hi] of [[70,79],[80,89],[90,100]] as [number,number][]) {
  const sub = signals.filter(s => s.score >= lo && s.score <= hi);
  const sw  = sub.filter(s => s.outcome === 'win');
  const sc  = sub.filter(s => s.outcome !== 'open');
  const bwr = sc.length ? `${sw.length}/${sc.length} (${Math.round(sw.length/sc.length*100)}%)` : 'n/a';
  console.log(`  ${lo}-${hi}: n=${sub.length}  win=${bwr}`);
}

// Individual signals
console.log(`\n── All CONT signals ──`);
console.log(`${'Date/Time'.padEnd(14)} ${'Dir'.padEnd(6)} ${'Entry'.padStart(8)} ${'Parent'.padStart(7)} ${'Ext'.padStart(5)} ${'Rtrc'.padStart(5)} ${'d15'.padStart(7)} ${'Scr'.padStart(4)} ${'Outcome'.padEnd(7)} ${'MaxGain'.padStart(8)} ${'MaxDD'.padStart(6)} ${'Bars'.padStart(5)}`);
console.log('-'.repeat(105));
for (const s of signals) {
  const rtrc = (s.retracePct * 100).toFixed(0) + '%';
  console.log(
    `${etLabel(s.ts).padEnd(14)} ${s.direction.padEnd(6)} ${s.entry.toFixed(2).padStart(8)} ` +
    `${s.parentEntry.toFixed(0).padStart(7)} ${s.extensionPts.toFixed(0).padStart(5)} ${rtrc.padStart(5)} ` +
    `${s.delta15.toString().padStart(7)} ${s.score.toString().padStart(4)} ` +
    `${s.outcome.padEnd(7)} ${s.maxGain.toFixed(1).padStart(8)} ${s.maxDD.toFixed(1).padStart(6)} ` +
    `${(s.barsToTarget?.toString() ?? '—').padStart(5)}`
  );
}

db.close();
ticksDb.close();
