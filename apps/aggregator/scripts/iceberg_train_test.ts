// Iceberg train/test backtest — Phase 0+1 condensed.
//
// TRAIN: 2026-06-02 + 2026-06-03 RTH (NQ)
// TEST:  2026-06-04 RTH
//
// Detector: scripts/lib/mbo-iceberg-detector.ts (MBO-deterministic, refresh-cluster)
// Symbol: MNQM in mbo.db ↔ 'NQ' in ticks.db
//
// 4 setups:
//   A. BOUNCE         — enter ON the iceberg side when price tests the level
//   B. BREAK-CONT     — enter THROUGH iceberg when consumed (no refresh in next 30s)
//   C. BREAK-FADE     — enter AGAINST the breakout (matches stacked-zone-fade WIN)
//   D. PRESENCE       — enter IMMEDIATELY on detection (iceberg side = direction)
//
// 5 TP/SL grids (NQ pts): [10/5, 15/10, 20/10, 30/15, 60/30]
//
// Outcome scored over 120-min forward window using ticks.db trades.

import Database from 'better-sqlite3';
import { findRefreshes, clusterRefreshes, type IcebergCluster } from './lib/mbo-iceberg-detector.js';

const mboDb   = new Database('/Users/ravikumarbasker/trading-cockpit/data/mbo.db', { readonly: true });
const ticksDb = new Database('/Users/ravikumarbasker/trading-cockpit/data/ticks.db', { readonly: true });

// ── Config ──
const SYMBOL_MBO   = 'MNQM';
const SYMBOL_TICKS = 'NQ';
const REFRESH_WINDOW_MS = 100;
const CLUSTER_WINDOW_MS = 30_000;
const MIN_REFRESHES = 2;
const MIN_ORDER_SIZE = 0;  // start permissive; we'll filter later

// Setups
type Setup = 'A_BOUNCE' | 'B_BREAK_CONT' | 'C_BREAK_FADE' | 'D_PRESENCE';
const SETUPS: Setup[] = ['A_BOUNCE', 'B_BREAK_CONT', 'C_BREAK_FADE', 'D_PRESENCE'];

// TP/SL grid (NQ pts)
const GRIDS: Array<{tp: number; sl: number}> = [
  { tp: 10, sl: 5 },
  { tp: 15, sl: 10 },
  { tp: 20, sl: 10 },
  { tp: 30, sl: 15 },
  { tp: 60, sl: 30 },
];

const POINT_VALUE_USD = 2; // MNQ
const FWD_WINDOW_MS = 120 * 60_000;

// ── Date helpers ──
function etDateTimeToMs(dateStr: string, hh: number, mm: number): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!, hh + 4, mm); // EDT
}

function isInRTH(tsMs: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(tsMs));
  const h = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  const m = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  const min = h * 60 + m;
  return min >= 570 && min < 960; // 09:30-16:00 ET
}

// ── Detect icebergs in a time window ──
function detectIcebergs(startMs: number, endMs: number): IcebergCluster[] {
  // The library queries the entire mbo_orders table for this symbol. We can't easily
  // pass a time window into findRefreshes, so we filter the result.
  const refreshes = findRefreshes(mboDb, {
    symbol: SYMBOL_MBO,
    refreshWindowMs: REFRESH_WINDOW_MS,
    clusterWindowMs: CLUSTER_WINDOW_MS,
    minRefreshes: MIN_REFRESHES,
    minOrderSize: MIN_ORDER_SIZE,
  });
  const inWindow = refreshes.filter(r => r.fillTs >= startMs && r.fillTs < endMs);
  const clusters = clusterRefreshes(inWindow, {
    symbol: SYMBOL_MBO,
    clusterWindowMs: CLUSTER_WINDOW_MS,
    minRefreshes: MIN_REFRESHES,
  });
  // RTH only
  return clusters.filter(c => isInRTH(c.firstRefreshTs));
}

// ── Walk forward through ticks for outcome ──
const fwdQuery = ticksDb.prepare(
  `SELECT price, ts FROM trades WHERE symbol=? AND ts > ? AND ts <= ? ORDER BY ts ASC`
);

interface Trade { entry: number; ts: number; direction: 'long' | 'short'; }

function simulate(t: Trade, tp: number, sl: number): { outcome: 'W' | 'L' | 'O'; pnlPts: number } {
  const ticks = fwdQuery.all(SYMBOL_TICKS, t.ts, t.ts + FWD_WINDOW_MS) as Array<{ price: number; ts: number }>;
  let pnl = 0;
  let outcome: 'W' | 'L' | 'O' = 'O';
  for (const tk of ticks) {
    const move = t.direction === 'long' ? tk.price - t.entry : t.entry - tk.price;
    if (move >=  tp) { outcome = 'W'; pnl =  tp; break; }
    if (move <= -sl) { outcome = 'L'; pnl = -sl; break; }
  }
  if (outcome === 'O' && ticks.length) {
    const last = ticks[ticks.length - 1]!.price;
    const closeMove = t.direction === 'long' ? last - t.entry : t.entry - last;
    pnl = closeMove;
    outcome = closeMove > 0 ? 'W' : closeMove < 0 ? 'L' : 'O';
  }
  return { outcome, pnlPts: pnl };
}

// ── For each setup, derive entry trigger from iceberg cluster ──
function defineEntry(ice: IcebergCluster, setup: Setup): Trade | null {
  // For setup A (bounce): entry when price comes back to test iceberg after departing.
  //   For simplicity, use refresh midpoint as the "bounce" entry — when iceberg has
  //   already shown it can absorb 2+ refreshes, take a position WITH the iceberg side.
  //   side='BID' = support → long; side='ASK' = resistance → short.
  if (setup === 'A_BOUNCE') {
    return {
      ts: ice.lastRefreshTs,  // enter at last refresh ts (most "confirmed")
      entry: ice.price,
      direction: ice.side === 'BID' ? 'long' : 'short',
    };
  }

  // For setup B/C: entry on iceberg "consumed" — last refresh was followed by no
  //   more refresh in cluster window. Use lastRefreshTs + clusterWindowMs as the
  //   "break" timestamp (when we'd know the iceberg is consumed/dropped).
  //   B = continuation (long if ASK broken upward, short if BID broken downward)
  //   C = fade (short if ASK broken, long if BID broken)
  if (setup === 'B_BREAK_CONT' || setup === 'C_BREAK_FADE') {
    const breakTs = ice.lastRefreshTs + CLUSTER_WINDOW_MS;
    // Use price at break time
    const tk = (ticksDb.prepare(`SELECT price FROM trades WHERE symbol=? AND ts<=? ORDER BY ts DESC LIMIT 1`).get(SYMBOL_TICKS, breakTs) as any);
    if (!tk) return null;
    const breakPrice = tk.price;
    if (setup === 'B_BREAK_CONT') {
      return { ts: breakTs, entry: breakPrice, direction: ice.side === 'BID' ? 'short' : 'long' };
    } else {
      return { ts: breakTs, entry: breakPrice, direction: ice.side === 'BID' ? 'long' : 'short' };
    }
  }

  // For setup D (presence): enter immediately on detection (after Nth refresh).
  //   Same direction as A (with iceberg side).
  if (setup === 'D_PRESENCE') {
    // Use price at firstRefreshTs (earliest detection moment)
    const tk = (ticksDb.prepare(`SELECT price FROM trades WHERE symbol=? AND ts<=? ORDER BY ts DESC LIMIT 1`).get(SYMBOL_TICKS, ice.firstRefreshTs) as any);
    if (!tk) return null;
    return {
      ts: ice.firstRefreshTs,
      entry: tk.price,
      direction: ice.side === 'BID' ? 'long' : 'short',
    };
  }
  return null;
}

// ── Backtest a set of icebergs for all setups + grids ──
interface Result { setup: Setup; tp: number; sl: number; n: number; w: number; l: number; o: number; netPts: number; }
function backtest(icebergs: IcebergCluster[]): Result[] {
  const out: Result[] = [];
  for (const setup of SETUPS) {
    for (const g of GRIDS) {
      let w = 0, l = 0, o = 0, pts = 0, n = 0;
      for (const ice of icebergs) {
        const entry = defineEntry(ice, setup);
        if (!entry) continue;
        const r = simulate(entry, g.tp, g.sl);
        n++;
        if (r.outcome === 'W') w++;
        else if (r.outcome === 'L') l++;
        else o++;
        pts += r.pnlPts;
      }
      out.push({ setup, tp: g.tp, sl: g.sl, n, w, l, o, netPts: pts });
    }
  }
  return out;
}

// ── Run ──
console.log('Detecting icebergs (this may take a minute on the large mbo.db)...');

const trainStart = etDateTimeToMs('2026-06-02', 0, 0);
const trainEnd   = etDateTimeToMs('2026-06-04', 0, 0);
const testStart  = etDateTimeToMs('2026-06-04', 0, 0);
const testEnd    = etDateTimeToMs('2026-06-05', 0, 0);

console.time('detect train');
const trainIce = detectIcebergs(trainStart, trainEnd);
console.timeEnd('detect train');
console.log(`Train icebergs (06-02..06-03 RTH): ${trainIce.length}`);

console.time('detect test');
const testIce = detectIcebergs(testStart, testEnd);
console.timeEnd('detect test');
console.log(`Test icebergs (06-04 RTH): ${testIce.length}\n`);

if (trainIce.length === 0 || testIce.length === 0) {
  console.error('Insufficient data — aborting.');
  process.exit(1);
}

console.log('Train sample (first 5):');
for (const ice of trainIce.slice(0, 5)) {
  console.log(`  side=${ice.side}  price=${ice.price}  refreshes=${ice.refreshCount}  vol=${ice.totalVisibleVolume}  lifetimeMs=${ice.lastRefreshTs - ice.firstRefreshTs}`);
}
console.log();

console.time('backtest train');
const trainResults = backtest(trainIce);
console.timeEnd('backtest train');

console.time('backtest test');
const testResults = backtest(testIce);
console.timeEnd('backtest test');

// Report
function fmtRow(r: Result, dollarMultiplier = POINT_VALUE_USD): string {
  const denom = r.w + r.l;
  const wr = denom ? (r.w / denom * 100).toFixed(0) : '--';
  const ev = r.n ? (r.netPts / r.n).toFixed(2) : '0';
  const dollars = (r.netPts * dollarMultiplier).toFixed(0);
  return `${r.setup.padEnd(14)}  TP${String(r.tp).padStart(2)}/SL${String(r.sl).padStart(2)}  n=${String(r.n).padStart(4)}  W=${String(r.w).padStart(4)}  L=${String(r.l).padStart(4)}  O=${String(r.o).padStart(3)}  WR=${String(wr).padStart(4)}%  EV=${String(ev).padStart(6)}pts  net=${String(r.netPts.toFixed(0)).padStart(6)}pts  $@MNQ=${dollars >= '0' ? '+$' : '-$'}${dollars.replace('-','')}`;
}

console.log('\n═══ TRAIN RESULTS (06-02 + 06-03 RTH) ═══');
trainResults.sort((a, b) => (b.netPts / Math.max(b.n,1)) - (a.netPts / Math.max(a.n,1)));
for (const r of trainResults) console.log(fmtRow(r));

console.log('\n═══ TEST RESULTS (06-04 RTH) ═══');
testResults.sort((a, b) => (b.netPts / Math.max(b.n,1)) - (a.netPts / Math.max(a.n,1)));
for (const r of testResults) console.log(fmtRow(r));

// ── Verdict — top 3 train EVs, compare to test ──
console.log('\n═══ TRAIN/TEST COMPARISON (top 5 by train EV) ═══');
const trainByKey = new Map<string, Result>();
for (const r of trainResults) trainByKey.set(`${r.setup}|${r.tp}|${r.sl}`, r);
const testByKey = new Map<string, Result>();
for (const r of testResults) testByKey.set(`${r.setup}|${r.tp}|${r.sl}`, r);

const trainSorted = [...trainResults].sort((a, b) => (b.netPts / Math.max(b.n,1)) - (a.netPts / Math.max(a.n,1)));
console.log(`${'setup'.padEnd(14)}  ${'tp/sl'.padEnd(9)}  ${'TRAIN'.padEnd(28)}  ${'TEST'.padEnd(28)}  verdict`);
for (const tr of trainSorted.slice(0, 8)) {
  const te = testByKey.get(`${tr.setup}|${tr.tp}|${tr.sl}`)!;
  const trEv = tr.n ? tr.netPts / tr.n : 0;
  const teEv = te.n ? te.netPts / te.n : 0;
  const holdRatio = trEv !== 0 ? teEv / trEv : 0;
  const verdict = teEv > 0 && holdRatio > 0.6 ? '✅ holds'
                : teEv > 0 && holdRatio > 0.3 ? '⚠️  weak'
                : '❌ overfit';
  const trStr = `n=${tr.n} WR=${tr.w + tr.l ? (tr.w/(tr.w+tr.l)*100).toFixed(0) : '-'}% EV=${trEv.toFixed(1)}`;
  const teStr = `n=${te.n} WR=${te.w + te.l ? (te.w/(te.w+te.l)*100).toFixed(0) : '-'}% EV=${teEv.toFixed(1)}`;
  console.log(`${tr.setup.padEnd(14)}  TP${String(tr.tp).padStart(2)}/SL${String(tr.sl).padStart(2)}  ${trStr.padEnd(28)}  ${teStr.padEnd(28)}  ${verdict}`);
}
