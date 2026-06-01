/**
 * bzb_brzt_touch_analysis.ts — same approach as mhp_hp_touch_analysis.ts but
 * for BZB (Bull Zone Bottom) and BrZT (Bear Zone Top). LONG-only via BOUNCE
 * and RECLAIM classifications (per user direction — no shorts at these
 * hedging-support levels).
 *
 * Definitions:
 *   BOUNCE  — close > level AND low ∈ [level − 0.5, level + 1.5]
 *             (low briefly touched / approached level, didn't significantly
 *              break, close above — support held)
 *   RECLAIM — close > level AND low < level − 1.0
 *             (low went below level by ≥1pt, close above — failed breakdown)
 *
 * Outcome: 40pt up within 30 min, ≤10pt max DD against the long.
 *
 * Conventions: is_bid_aggressor=1 → BUY aggressor (verified empirically).
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');
const LEVELS_JSON= path.resolve(__dirname, '../../../daily_levels.json');

const TARGET_PTS = 40;
const MAX_DD_PTS = 10;
const HORIZON_MS = 30 * 60_000;

const BOUNCE_LOW_BELOW_TOL = 0.5;
const BOUNCE_LOW_ABOVE_TOL = 1.5;
const RECLAIM_BREACH_MIN   = 1.0;
const RANGE_MIN_BOUNCE     = 4;
const RANGE_MIN_RECLAIM    = 6;
const VOL_MIN              = 1500;

type Trade = { ts: number; price: number; size: number; isBidAgg: 0|1 };
type Bar = {
  minStartTs: number;
  open: number; high: number; low: number; close: number;
  vol: number; delta: number; numTrades: number;
  maxTradeSize: number; largePrints1: number; largePrints2: number;
};

type LevelName = 'BZB' | 'BrZT';
type Scenario  = 'BOUNCE' | 'RECLAIM';

function etMin(tsMs: number): number {
  const d = new Date(tsMs - 4 * 60 * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function etHHMMSS(tsMs: number): string {
  const d = new Date(tsMs - 4 * 60 * 60_000);
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`;
}

function loadTrades(db: Database.Database, dateStr: string): Trade[] {
  const startTs = Date.parse(`${dateStr}T08:00:00-04:00`);
  const endTs   = Date.parse(`${dateStr}T16:30:00-04:00`);
  return db.prepare(
    `SELECT ts, price, size, is_bid_aggressor AS isBidAgg
     FROM trades WHERE symbol='NQ' AND ts >= ? AND ts < ?
     ORDER BY ts ASC, id ASC`
  ).all(startTs, endTs) as Trade[];
}

function buildBars(trades: Trade[]): Bar[] {
  const bars: Bar[] = [];
  let cur: Bar | null = null;
  for (const t of trades) {
    const bk = Math.floor(t.ts / 60_000) * 60_000;
    if (!cur || cur.minStartTs !== bk) {
      if (cur) bars.push(cur);
      cur = {
        minStartTs: bk, open: t.price, high: t.price, low: t.price, close: t.price,
        vol: 0, delta: 0, numTrades: 0, maxTradeSize: 0, largePrints1: 0, largePrints2: 0,
      };
    }
    if (t.price > cur.high) cur.high = t.price;
    if (t.price < cur.low)  cur.low  = t.price;
    cur.close = t.price;
    cur.vol += t.size;
    cur.numTrades++;
    if (t.size > cur.maxTradeSize) cur.maxTradeSize = t.size;
    if (t.size >= 10) cur.largePrints1++;
    if (t.size >= 25) cur.largePrints2++;
    if (t.isBidAgg === 1) cur.delta += t.size;
    else                  cur.delta -= t.size;
  }
  if (cur) bars.push(cur);
  return bars;
}

interface DayLevels { bzb: number | null; brzt: number | null; }
function loadLevels(): Record<string, DayLevels> {
  const raw = JSON.parse(fs.readFileSync(LEVELS_JSON, 'utf-8'));
  const days = raw.days ?? {};
  const out: Record<string, DayLevels> = {};
  for (const [date, entry] of Object.entries(days)) {
    const lv = (entry as any).levels?.[0] ?? {};
    out[date] = {
      bzb:  lv.bullZone?.low ?? null,
      brzt: lv.bearZone?.high ?? null,
    };
  }
  return out;
}

// ─── Classify a bar at a level ───────────────────────────────────────────────

function classify(bar: Bar, level: number): Scenario | null {
  // Both scenarios require close > level
  if (bar.close <= level) return null;
  const range = bar.high - bar.low;
  if (bar.vol < VOL_MIN) return null;
  // BOUNCE: low in [level - 0.5, level + 1.5]
  if (bar.low >= level - BOUNCE_LOW_BELOW_TOL && bar.low <= level + BOUNCE_LOW_ABOVE_TOL) {
    if (range < RANGE_MIN_BOUNCE) return null;
    return 'BOUNCE';
  }
  // RECLAIM: low < level - 1.0
  if (level - bar.low >= RECLAIM_BREACH_MIN) {
    if (range < RANGE_MIN_RECLAIM) return null;
    return 'RECLAIM';
  }
  return null;
}

// ─── Forward outcome ────────────────────────────────────────────────────────

interface Outcome { result: 'WIN'|'LOSS'|'TIMEOUT'; maxUp: number; maxDn: number; resolveMs: number; }
function forwardOutcome(barCloseTs: number, barClose: number, trades: Trade[]): Outcome {
  let lo = 0, hi = trades.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (trades[m].ts <= barCloseTs) lo = m + 1; else hi = m; }
  const endTs = barCloseTs + HORIZON_MS;
  let maxUp = 0, maxDn = 0;
  for (let i = lo; i < trades.length && trades[i].ts <= endTs; i++) {
    const px = trades[i].price;
    const up = px - barClose, dn = barClose - px;
    if (up > maxUp) maxUp = up;
    if (dn > maxDn) maxDn = dn;
    if (maxDn >= MAX_DD_PTS) return { result: 'LOSS', maxUp, maxDn, resolveMs: trades[i].ts - barCloseTs };
    if (maxUp >= TARGET_PTS) return { result: 'WIN',  maxUp, maxDn, resolveMs: trades[i].ts - barCloseTs };
  }
  return { result: 'TIMEOUT', maxUp, maxDn, resolveMs: HORIZON_MS };
}

// ─── Signal record ──────────────────────────────────────────────────────────

interface Signal {
  date: string; barTs: number;
  level: LevelName; levelPrice: number;
  scenario: Scenario;
  open: number; high: number; low: number; close: number;
  range: number; bodyPct: number; closeInRange: number;
  upperWick: number; lowerWick: number;
  vol: number; delta: number; deltaPct: number;
  numTrades: number; maxTradeSize: number; largePrints1: number; largePrints2: number;
  prev5Delta: number; prev15Delta: number;
  prev5Net: number; prev15Net: number;
  cvdSession: number;        // cumulative delta from RTH open through this bar
  breach: number;
  outcome: Outcome['result'];
  maxUp: number; maxDn: number; resolveMs: number;
}

function buildSignal(
  bars: Bar[], bi: number, level: number, levelName: LevelName, scenario: Scenario,
  date: string, trades: Trade[],
): Signal {
  const b = bars[bi]!;
  const range = b.high - b.low;
  const body = b.close - b.open;
  const bodyPct = range > 0 ? Math.abs(body) / range : 0;
  const upperWick = b.high - Math.max(b.open, b.close);
  const lowerWick = Math.min(b.open, b.close) - b.low;
  const closeInRange = range > 0 ? (b.close - b.low) / range : 0.5;
  const deltaPct = b.vol > 0 ? Math.abs(b.delta) / b.vol : 0;
  let prev5Delta = 0, prev15Delta = 0;
  for (let k = Math.max(0, bi - 5); k < bi; k++)  prev5Delta  += bars[k]!.delta;
  for (let k = Math.max(0, bi - 15); k < bi; k++) prev15Delta += bars[k]!.delta;
  // CVD anchored at RTH open (09:30 ET) — cumulative delta of all RTH bars
  // up to and including this one.
  let cvdSession = 0;
  for (let k = 0; k <= bi; k++) {
    const x = bars[k]!;
    const m = etMin(x.minStartTs);
    if (m < 9*60+30 || m >= 16*60) continue;
    cvdSession += x.delta;
  }
  const first5  = bars[Math.max(0, bi - 5)]!;
  const first15 = bars[Math.max(0, bi - 15)]!;
  const out = forwardOutcome(b.minStartTs + 60_000, b.close, trades);
  return {
    date, barTs: b.minStartTs,
    level: levelName, levelPrice: level, scenario,
    open: b.open, high: b.high, low: b.low, close: b.close,
    range, bodyPct, closeInRange, upperWick, lowerWick,
    vol: b.vol, delta: b.delta, deltaPct,
    numTrades: b.numTrades, maxTradeSize: b.maxTradeSize,
    largePrints1: b.largePrints1, largePrints2: b.largePrints2,
    prev5Delta, prev15Delta,
    prev5Net: b.close - first5.open,
    prev15Net: b.close - first15.open,
    cvdSession,
    breach: Math.max(0, level - b.low),
    outcome: out.result, maxUp: out.maxUp, maxDn: out.maxDn, resolveMs: out.resolveMs,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('BZB / BrZT bounce + reclaim analysis');
  console.log(`Target=${TARGET_PTS}pt up / Max DD=${MAX_DD_PTS}pt / 30-min horizon\n`);
  const allLevels = loadLevels();
  const db = new Database(TICKS_DB, { readonly: true });
  db.pragma('journal_mode = WAL');

  const signals: Signal[] = [];
  const dates = Object.keys(allLevels).sort();

  for (const date of dates) {
    const lv = allLevels[date];
    if (!lv || (lv.bzb == null && lv.brzt == null)) continue;
    const trades = loadTrades(db, date);
    if (trades.length < 1000) { console.log(`${date}: insufficient ticks — skipping`); continue; }
    const bars = buildBars(trades);
    if (bars.length < 20) continue;

    const candidates: [LevelName, number|null][] = [
      ['BZB',  lv.bzb],
      ['BrZT', lv.brzt],
    ];
    for (const [lvName, lvPrice] of candidates) {
      if (lvPrice == null) continue;
      for (let bi = 15; bi < bars.length; bi++) {
        const b = bars[bi]!;
        const m = etMin(b.minStartTs);
        if (m < 9*60+30 || m > 15*60+55) continue;
        const sc = classify(b, lvPrice);
        if (!sc) continue;
        signals.push(buildSignal(bars, bi, lvPrice, lvName, sc, date, trades));
      }
    }
  }
  db.close();

  console.log(`\nTotal signals: ${signals.length}`);
  console.log('\n── Per (level, scenario) breakdown ──');
  console.log('level   scenario   n    W   L   T   WR');
  for (const lvName of ['BZB','BrZT'] as const) {
    for (const sc of ['BOUNCE','RECLAIM'] as const) {
      const sub = signals.filter(s => s.level === lvName && s.scenario === sc);
      const w = sub.filter(s => s.outcome === 'WIN').length;
      const l = sub.filter(s => s.outcome === 'LOSS').length;
      const t = sub.filter(s => s.outcome === 'TIMEOUT').length;
      const wr = (w + l) ? (w / (w + l)) * 100 : 0;
      console.log(`${lvName.padEnd(5)}   ${sc.padEnd(8)}   ${String(sub.length).padStart(3)}  ${String(w).padStart(2)}  ${String(l).padStart(2)}  ${String(t).padStart(2)}  ${wr.toFixed(1).padStart(5)}%`);
    }
  }
  // Overall by scenario
  console.log('\n── Overall by scenario ──');
  for (const sc of ['BOUNCE','RECLAIM'] as const) {
    const sub = signals.filter(s => s.scenario === sc);
    const w = sub.filter(s => s.outcome === 'WIN').length;
    const l = sub.filter(s => s.outcome === 'LOSS').length;
    const t = sub.filter(s => s.outcome === 'TIMEOUT').length;
    const wr = (w + l) ? (w / (w + l)) * 100 : 0;
    console.log(`${sc.padEnd(8)}: n=${sub.length}  W=${w}  L=${l}  T=${t}  WR=${wr.toFixed(1)}%`);
  }
  // Overall combined
  const w = signals.filter(s => s.outcome === 'WIN').length;
  const l = signals.filter(s => s.outcome === 'LOSS').length;
  const wr = (w + l) ? (w / (w + l)) * 100 : 0;
  console.log(`ALL     : n=${signals.length}  W=${w}  L=${l}  WR=${wr.toFixed(1)}%`);

  // Winners detail
  console.log('\n── WINNERS detail ──');
  console.log('date       et       lvl   scen     lvlPrice  bar(O/H/L/C)                  range body closeR upperW lowerW delta deltaPct vol  bP1 bP2 maxTr  prev5N prev15N prev5D prev15D  breach  maxUp  resolveS');
  const winners = signals.filter(s => s.outcome === 'WIN');
  for (const s of winners) {
    console.log(
      `${s.date}  ${etHHMMSS(s.barTs)}  ${s.level.padEnd(4)} ${s.scenario.padEnd(8)} ${s.levelPrice.toFixed(2).padStart(8)}  ` +
      `${s.open.toFixed(2)}/${s.high.toFixed(2)}/${s.low.toFixed(2)}/${s.close.toFixed(2)}  ` +
      `${s.range.toFixed(1).padStart(4)} ${(s.bodyPct*100).toFixed(0).padStart(3)} ${(s.closeInRange*100).toFixed(0).padStart(3)} ${s.upperWick.toFixed(1).padStart(4)} ${s.lowerWick.toFixed(1).padStart(4)} ` +
      `${s.delta.toString().padStart(6)} ${(s.deltaPct*100).toFixed(0).padStart(3)} ${String(s.vol).padStart(5)} ` +
      `${String(s.largePrints1).padStart(3)} ${String(s.largePrints2).padStart(3)} ${String(s.maxTradeSize).padStart(4)}  ` +
      `${s.prev5Net.toFixed(1).padStart(5)} ${s.prev15Net.toFixed(1).padStart(6)} ${s.prev5Delta.toString().padStart(6)} ${s.prev15Delta.toString().padStart(6)}  ` +
      `${s.breach.toFixed(2).padStart(5)}  ${s.maxUp.toFixed(1).padStart(4)}  ${(s.resolveMs/1000).toFixed(0)}s`
    );
  }

  // ─── closeInRange filter sensitivity sweep (RECLAIM only) ───
  console.log('\n── closeInRange filter sweep (RECLAIM only) ──');
  console.log('threshold   level   n    W   L   WR    EV@4:1');
  for (const minClose of [0.50, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90]) {
    for (const lvName of ['BZB', 'BrZT', 'BOTH'] as const) {
      const sub = signals.filter(s =>
        s.scenario === 'RECLAIM' &&
        (lvName === 'BOTH' || s.level === lvName) &&
        s.closeInRange >= minClose,
      );
      const w = sub.filter(s => s.outcome === 'WIN').length;
      const l = sub.filter(s => s.outcome === 'LOSS').length;
      const wr = (w + l) ? (w / (w + l)) * 100 : 0;
      // 4:1 RR EV: WR fraction × 4 − (1 − WR fraction) × 1
      const wrFrac = (w + l) ? w / (w + l) : 0;
      const ev = wrFrac * 4 - (1 - wrFrac) * 1;
      console.log(`≥${minClose.toFixed(2)}        ${lvName.padEnd(5)}   ${String(sub.length).padStart(3)}  ${String(w).padStart(2)}  ${String(l).padStart(2)}  ${wr.toFixed(1).padStart(5)}%  ${ev.toFixed(2).padStart(6)}`);
    }
    console.log('');
  }

  // ─── CVD threshold sweep — RECLAIM + closeR ≥ 0.90 ──
  console.log('\n── CVD threshold sweep (RECLAIM + closeR ≥ 0.90) ──');
  console.log('cvdMin     n    W   L   WR    EV@4:1');
  for (const cvdMin of [-Infinity, 0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000]) {
    const sub = signals.filter(s =>
      s.scenario === 'RECLAIM' &&
      s.closeInRange >= 0.90 &&
      s.cvdSession >= cvdMin,
    );
    const w = sub.filter(s => s.outcome === 'WIN').length;
    const l = sub.filter(s => s.outcome === 'LOSS').length;
    const wr = (w + l) ? (w / (w + l)) * 100 : 0;
    const wrFrac = (w + l) ? w / (w + l) : 0;
    const ev = wrFrac * 4 - (1 - wrFrac) * 1;
    const label = cvdMin === -Infinity ? '(all)' : `≥${cvdMin}`;
    console.log(`${label.padEnd(10)}  ${String(sub.length).padStart(3)}  ${String(w).padStart(2)}  ${String(l).padStart(2)}  ${wr.toFixed(1).padStart(5)}%  ${ev.toFixed(2).padStart(6)}`);
  }

  // Also: CVD sweep on RECLAIM only (no closeR filter) to see if CVD alone is enough
  console.log('\n── CVD threshold sweep (RECLAIM only, no closeR filter) ──');
  console.log('cvdMin     n    W   L   WR    EV@4:1');
  for (const cvdMin of [-Infinity, 0, 2000, 4000, 5000, 6000, 7000, 8000]) {
    const sub = signals.filter(s =>
      s.scenario === 'RECLAIM' &&
      s.cvdSession >= cvdMin,
    );
    const w = sub.filter(s => s.outcome === 'WIN').length;
    const l = sub.filter(s => s.outcome === 'LOSS').length;
    const wr = (w + l) ? (w / (w + l)) * 100 : 0;
    const wrFrac = (w + l) ? w / (w + l) : 0;
    const ev = wrFrac * 4 - (1 - wrFrac) * 1;
    const label = cvdMin === -Infinity ? '(all)' : `≥${cvdMin}`;
    console.log(`${label.padEnd(10)}  ${String(sub.length).padStart(3)}  ${String(w).padStart(2)}  ${String(l).padStart(2)}  ${wr.toFixed(1).padStart(5)}%  ${ev.toFixed(2).padStart(6)}`);
  }

  // ─── Order-flow detail for the high-EV subset: RECLAIM + closeR ≥ 0.90 ──
  const elite = signals.filter(s => s.scenario === 'RECLAIM' && s.closeInRange >= 0.90);
  const eliteWins = elite.filter(s => s.outcome === 'WIN');
  const eliteLosses = elite.filter(s => s.outcome === 'LOSS');

  console.log(`\n── Order-flow detail: RECLAIM + closeR≥0.90 (n=${elite.length}, ${eliteWins.length}W/${eliteLosses.length}L) ──`);
  console.log('  date       et       lvl   bar(O/H/L/C)                  closeR  delta dPct  cvd     prev5D prev15D  vol   bP1 bP2 maxTr  outcome');
  for (const s of elite) {
    console.log(
      `  ${s.date}  ${etHHMMSS(s.barTs)}  ${s.level.padEnd(4)} ` +
      `${s.open.toFixed(2)}/${s.high.toFixed(2)}/${s.low.toFixed(2)}/${s.close.toFixed(2)}  ` +
      `${(s.closeInRange*100).toFixed(0).padStart(3)}%  ${s.delta.toString().padStart(5)} ${(s.deltaPct*100).toFixed(0).padStart(3)}% ${s.cvdSession.toString().padStart(7)}  ` +
      `${s.prev5Delta.toString().padStart(6)} ${s.prev15Delta.toString().padStart(7)}  ${String(s.vol).padStart(5)} ${String(s.largePrints1).padStart(3)} ${String(s.largePrints2).padStart(3)} ${String(s.maxTradeSize).padStart(4)}   ${s.outcome}`
    );
  }

  // Feature comparison
  function avg(a: number[]): number { return a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0; }
  function med(a: number[]): number { if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]!; }
  const features: Array<[string, (s: Signal) => number]> = [
    ['range',         s => s.range],
    ['bodyPct',       s => s.bodyPct * 100],
    ['closeInRange%', s => s.closeInRange * 100],
    ['upperWick',     s => s.upperWick],
    ['lowerWick',     s => s.lowerWick],
    ['delta',         s => s.delta],
    ['deltaPct',      s => s.deltaPct * 100],
    ['cvdSession',    s => s.cvdSession],
    ['prev5Delta',    s => s.prev5Delta],
    ['prev15Delta',   s => s.prev15Delta],
    ['vol',           s => s.vol],
    ['largePr≥10',    s => s.largePrints1],
    ['largePr≥25',    s => s.largePrints2],
    ['breach',        s => s.breach],
    ['prev5Net',      s => s.prev5Net],
    ['prev15Net',     s => s.prev15Net],
  ];

  // Overall (all signals)
  const wins = signals.filter(s => s.outcome === 'WIN');
  const losses = signals.filter(s => s.outcome === 'LOSS');
  if (wins.length && losses.length) {
    console.log('\n── Feature comparison — ALL signals (winners vs losers) ──');
    console.log('feature           win_avg  loss_avg   win_med  loss_med   delta(w-l)');
    for (const [name, fn] of features) {
      const wA = avg(wins.map(fn)), lA = avg(losses.map(fn));
      const wM = med(wins.map(fn)), lM = med(losses.map(fn));
      console.log(`${name.padEnd(16)}  ${wA.toFixed(1).padStart(7)}  ${lA.toFixed(1).padStart(8)}   ${wM.toFixed(1).padStart(7)}  ${lM.toFixed(1).padStart(8)}   ${(wA - lA).toFixed(1).padStart(8)}`);
    }
  }

  // RECLAIM-only
  const rclWins = signals.filter(s => s.scenario === 'RECLAIM' && s.outcome === 'WIN');
  const rclLosses = signals.filter(s => s.scenario === 'RECLAIM' && s.outcome === 'LOSS');
  if (rclWins.length && rclLosses.length) {
    console.log(`\n── Feature comparison — RECLAIM only (W=${rclWins.length} L=${rclLosses.length}) ──`);
    console.log('feature           win_avg  loss_avg   win_med  loss_med   delta(w-l)');
    for (const [name, fn] of features) {
      const wA = avg(rclWins.map(fn)), lA = avg(rclLosses.map(fn));
      const wM = med(rclWins.map(fn)), lM = med(rclLosses.map(fn));
      console.log(`${name.padEnd(16)}  ${wA.toFixed(1).padStart(7)}  ${lA.toFixed(1).padStart(8)}   ${wM.toFixed(1).padStart(7)}  ${lM.toFixed(1).padStart(8)}   ${(wA - lA).toFixed(1).padStart(8)}`);
    }
  }

  // Elite (RECLAIM + closeR ≥ 0.90)
  if (eliteWins.length && eliteLosses.length) {
    console.log(`\n── Feature comparison — RECLAIM + closeR≥0.90 (W=${eliteWins.length} L=${eliteLosses.length}) ──`);
    console.log('feature           win_avg  loss_avg   win_med  loss_med   delta(w-l)');
    for (const [name, fn] of features) {
      const wA = avg(eliteWins.map(fn)), lA = avg(eliteLosses.map(fn));
      const wM = med(eliteWins.map(fn)), lM = med(eliteLosses.map(fn));
      console.log(`${name.padEnd(16)}  ${wA.toFixed(1).padStart(7)}  ${lA.toFixed(1).padStart(8)}   ${wM.toFixed(1).padStart(7)}  ${lM.toFixed(1).padStart(8)}   ${(wA - lA).toFixed(1).padStart(8)}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
