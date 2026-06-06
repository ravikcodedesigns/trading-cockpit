// Regime-switch backtest for native iceberg setups.
//
// Theory: B (break-continuation) wins in trending markets; C (break-fade) wins
// in chop. Compute a TrendScore from the 30 min preceding each iceberg, then
// pick B or C accordingly. Compare PnL vs A-only and vs naive baselines.
//
// TrendScore = |last_price - first_price| / (max_price - min_price)   in 30-min window
//   > 0.5  = trending day (net move = most of range)        → use B (break-continuation)
//   ≤ 0.5  = chopping (net move = small fraction of range)  → use C (break-fade)
//
// Same grid (TP=20, SL=10) for all setups for clean comparison.

import Database from 'better-sqlite3';

const mboDb   = new Database('/Users/ravikumarbasker/trading-cockpit/data/mbo.db',   { readonly: true });
const ticksDb = new Database('/Users/ravikumarbasker/trading-cockpit/data/ticks.db', { readonly: true });

const SYMBOL_MBO   = 'MNQM';
const SYMBOL_TICKS = 'NQ';
const TP = 20, SL = 10;
const FWD = 120 * 60_000;
const REGIME_WINDOW_MS = 30 * 60_000;
const TREND_THRESHOLD = 0.5;
const MIN_REPLACES = 3, MIN_FILL = 50, MIN_RATIO = 2;
const POINT_VALUE = 2;

function etDate(d: string, hh: number, mm: number): number {
  const [y, mo, day] = d.split('-').map(Number);
  return Date.UTC(y!, mo! - 1, day!, hh + 4, mm);
}
function isRTH(ts: number): boolean {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ts));
  const min = parseInt(p.find(x => x.type === 'hour')?.value ?? '0', 10) * 60 + parseInt(p.find(x => x.type === 'minute')?.value ?? '0', 10);
  return min >= 570 && min < 960;
}

const fwdQ = ticksDb.prepare(`SELECT price FROM trades WHERE symbol=? AND ts > ? AND ts <= ? ORDER BY ts ASC`);
const priceAt = ticksDb.prepare(`SELECT price FROM trades WHERE symbol=? AND ts<=? ORDER BY ts DESC LIMIT 1`);
const regimeHiLo = ticksDb.prepare(`SELECT MIN(price) AS lo, MAX(price) AS hi FROM trades WHERE symbol=? AND ts>=? AND ts<?`);
const regimeFirst = ticksDb.prepare(`SELECT price FROM trades WHERE symbol=? AND ts>=? AND ts<? ORDER BY ts ASC  LIMIT 1`);
const regimeLast  = ticksDb.prepare(`SELECT price FROM trades WHERE symbol=? AND ts>=? AND ts<? ORDER BY ts DESC LIMIT 1`);

function trendScore(beforeTs: number): number | null {
  const start = beforeTs - REGIME_WINDOW_MS;
  const hl = regimeHiLo.get(SYMBOL_TICKS, start, beforeTs) as any;
  if (!hl || hl.lo == null || hl.hi == null) return null;
  const f = regimeFirst.get(SYMBOL_TICKS, start, beforeTs) as any;
  const l = regimeLast.get(SYMBOL_TICKS, start, beforeTs) as any;
  if (!f || !l) return null;
  const range = hl.hi - hl.lo;
  if (range <= 0) return null;
  return Math.abs(l.price - f.price) / range;
}

function simulate(entry: number, ts: number, direction: 'long'|'short'): { outcome: 'W'|'L'|'O'; pts: number } {
  const ticks = fwdQ.all(SYMBOL_TICKS, ts, ts + FWD) as Array<{ price: number }>;
  for (const k of ticks) {
    const m = direction === 'long' ? k.price - entry : entry - k.price;
    if (m >=  TP) return { outcome: 'W', pts:  TP };
    if (m <= -SL) return { outcome: 'L', pts: -SL };
  }
  if (!ticks.length) return { outcome: 'O', pts: 0 };
  const last = ticks[ticks.length-1]!.price;
  const m = direction === 'long' ? last - entry : entry - last;
  return { outcome: m > 0 ? 'W' : m < 0 ? 'L' : 'O', pts: m };
}

interface Ice { is_bid: number; price: number; send_size: number; fill_size: number; num_replaces: number; num_fills: number; send_ts_ms: number; last_ts_ms: number; }

function findIcebergs(startMs: number, endMs: number): Ice[] {
  const all = mboDb.prepare(`
    SELECT is_bid, last_price AS price, send_size, fill_size, num_replaces, num_fills, send_ts_ms, last_ts_ms
    FROM mbo_orders
    WHERE symbol=? AND num_replaces>=? AND fill_size>=?
      AND CAST(fill_size AS REAL)/NULLIF(send_size,0) >= ?
      AND send_ts_ms>=? AND send_ts_ms<?
      AND status IN ('filled','cancelled','partial')
    ORDER BY send_ts_ms ASC
  `).all(SYMBOL_MBO, MIN_REPLACES, MIN_FILL, MIN_RATIO, startMs, endMs) as Ice[];
  return all.filter(i => isRTH(i.send_ts_ms));
}

// Setup-specific entry+direction
function entryA(ice: Ice) {
  const ts = Math.floor((ice.send_ts_ms + ice.last_ts_ms) / 2);
  return { ts, entry: ice.price, direction: (ice.is_bid === 1 ? 'long' : 'short') as 'long'|'short' };
}
function entryBC(ice: Ice, mode: 'B'|'C') {
  const ts = ice.last_ts_ms + 5000;
  const px = (priceAt.get(SYMBOL_TICKS, ts) as any)?.price ?? ice.price;
  const through = (ice.is_bid === 1 ? 'short' : 'long') as 'long'|'short';
  return { ts, entry: px, direction: mode === 'B' ? through : (through === 'long' ? 'short' : 'long') };
}

interface Stat { n: number; w: number; l: number; o: number; pts: number; }
const blank = (): Stat => ({ n: 0, w: 0, l: 0, o: 0, pts: 0 });
function add(s: Stat, o: ReturnType<typeof simulate>) {
  s.n++; s.pts += o.pts;
  if (o.outcome === 'W') s.w++; else if (o.outcome === 'L') s.l++; else s.o++;
}
function fmt(s: Stat, label: string): string {
  const denom = s.w + s.l;
  const wr = denom ? (s.w/denom*100).toFixed(0) : '--';
  const ev = s.n ? (s.pts/s.n).toFixed(2) : '0';
  const $ = (s.pts * POINT_VALUE).toFixed(0);
  return `${label.padEnd(28)}  n=${String(s.n).padStart(3)}  W=${String(s.w).padStart(3)}  L=${String(s.l).padStart(3)}  WR=${String(wr).padStart(4)}%  EV=${String(ev).padStart(6)}pts  net=${String(s.pts.toFixed(0)).padStart(6)}pts  $@MNQ=${parseFloat($)>=0?'+$':'-$'}${Math.abs(parseFloat($))}`;
}

// ── Backtest a set of icebergs ──
function backtest(ices: Ice[], label: string) {
  const aOnly = blank();
  const bOnly = blank();
  const cOnly = blank();
  const regimeSwitch = blank();
  const trendingOnly = blank();
  const chopOnly = blank();
  let nTrending = 0, nChop = 0, nUnknown = 0;
  const scores: number[] = [];

  for (const ice of ices) {
    // Setup A always runs
    const a = entryA(ice);
    add(aOnly, simulate(a.entry, a.ts, a.direction));

    // Setup B always
    const b = entryBC(ice, 'B');
    const bOut = simulate(b.entry, b.ts, b.direction);
    add(bOnly, bOut);

    // Setup C always
    const c = entryBC(ice, 'C');
    const cOut = simulate(c.entry, c.ts, c.direction);
    add(cOnly, cOut);

    // Regime: compute score from 30 min before iceberg starts
    const score = trendScore(ice.send_ts_ms);
    if (score == null) { nUnknown++; continue; }
    scores.push(score);

    if (score > TREND_THRESHOLD) {
      nTrending++;
      add(regimeSwitch, bOut);  // use B
      add(trendingOnly, bOut);
    } else {
      nChop++;
      add(regimeSwitch, cOut);  // use C
      add(chopOnly, cOut);
    }
  }

  console.log(`\n══ ${label} (n=${ices.length}, trend=${nTrending}, chop=${nChop}, unknown=${nUnknown}) ══`);
  console.log(fmt(aOnly,         'A only (BOUNCE)'));
  console.log(fmt(bOnly,         'B only (BREAK-CONT)'));
  console.log(fmt(cOnly,         'C only (BREAK-FADE)'));
  console.log(fmt(regimeSwitch,  'REGIME-SWITCH (B if trend, C if chop)'));
  console.log(fmt(trendingOnly,  '  → trending-only B subset'));
  console.log(fmt(chopOnly,      '  → chop-only C subset'));
  scores.sort((a,b) => a-b);
  console.log(`  trend-score percentiles: p10=${scores[Math.floor(scores.length*0.1)]?.toFixed(2)} p50=${scores[Math.floor(scores.length*0.5)]?.toFixed(2)} p90=${scores[Math.floor(scores.length*0.9)]?.toFixed(2)}`);
}

const tStart = etDate('2026-06-02', 0, 0);
const tEnd   = etDate('2026-06-04', 0, 0);
const sStart = etDate('2026-06-04', 0, 0);
const sEnd   = etDate('2026-06-05', 0, 0);

console.log(`Native iceberg regime-switch backtest`);
console.log(`Filter: replaces≥${MIN_REPLACES} fill≥${MIN_FILL} ratio≥${MIN_RATIO}`);
console.log(`Trend score: |Δ| / range over ${REGIME_WINDOW_MS/60_000}min lookback`);
console.log(`Threshold: > ${TREND_THRESHOLD} = trending → B   ≤ ${TREND_THRESHOLD} = chop → C`);
console.log(`TP=${TP}, SL=${SL}, fwd window=${FWD/60_000}min`);

console.time('train');
backtest(findIcebergs(tStart, tEnd), 'TRAIN (06-02 + 06-03 RTH)');
console.timeEnd('train');

console.time('test');
backtest(findIcebergs(sStart, sEnd), 'TEST (06-04 RTH)');
console.timeEnd('test');
