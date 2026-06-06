// MBO iceberg outcome validation. For each confirmed cluster, walk forward
// in mbo_trades from lastRefreshTs and measure realized WIN/LOSS at fixed
// TP/SL targets in the iceberg-defended direction.
//
// Direction logic:
//   ASK iceberg (sellers refilling)  → defends a price ceiling → SHORT bias
//                                       Stop = price + buffer, Target = entry - TPpts
//   BID iceberg (buyers refilling)   → defends a price floor → LONG bias
//                                       Stop = price - buffer, Target = entry + TPpts
//
// Entry: cluster.price (the level being defended), at lastRefreshTs.
// We assume a trader recognizes the iceberg signal at its last refresh and
// enters market at the defended price.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRefreshes, clusterRefreshes, type IcebergCluster } from './lib/mbo-iceberg-detector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const MBO_DB = path.resolve(__dirname, '../../../data/mbo.db');

const db = new Database(MBO_DB, { readonly: true });

const SYMBOLS = ['MNQM', 'MESM'];
const REFRESH_WINDOW = 100;   // ms — calibrated from smoke test
const CLUSTER_WINDOW = 30_000;
const MIN_REFRESHES = 2;

// TP/SL grids — user-requested 20/30/40 max gains paired with structural stop
interface GridEntry { tp: number; sl: number; label: string; }
const GRIDS: GridEntry[] = [
  { tp: 20, sl: 5,  label: 'TP20/SL5  (4:1)' },
  { tp: 30, sl: 5,  label: 'TP30/SL5  (6:1)' },
  { tp: 40, sl: 5,  label: 'TP40/SL5  (8:1)' },
  { tp: 20, sl: 10, label: 'TP20/SL10 (2:1)' },
  { tp: 30, sl: 10, label: 'TP30/SL10 (3:1)' },
  { tp: 40, sl: 10, label: 'TP40/SL10 (4:1)' },
];
const HORIZON_MS = 60 * 60_000; // 1 hour max — beyond that, OPEN

type Outcome = 'WIN' | 'LOSS' | 'OPEN' | 'NO_DATA';

interface SimResult {
  win: number; loss: number; open: number; noData: number;
  netPts: number;     // realized pt P&L assuming closed trades go for ±TP/±SL exactly
  detail: Array<{
    cluster: IcebergCluster;
    outcome: Outcome;
    timeToExitMs?: number;
  }>;
}

function simulate(symbol: string, clusters: IcebergCluster[], tp: number, sl: number): SimResult {
  const stmt = db.prepare(`
    SELECT ts_ms, price FROM mbo_trades
    WHERE symbol = ? AND ts_ms > ? AND ts_ms <= ? AND size > 0
    ORDER BY ts_ms ASC
  `);

  let win = 0, loss = 0, open = 0, noData = 0, netPts = 0;
  const detail: SimResult['detail'] = [];

  for (const c of clusters) {
    const entry = c.price;
    const direction = c.side === 'ASK' ? -1 : 1; // ASK iceberg → short → down is favorable
    const stopPrice = entry + (-direction) * sl;
    const targetPrice = entry + direction * tp;
    const fromTs = c.lastRefreshTs;
    const toTs = fromTs + HORIZON_MS;

    const trades = stmt.all(symbol, fromTs, toTs) as Array<{ ts_ms: number; price: number }>;
    if (trades.length === 0) { noData++; detail.push({ cluster: c, outcome: 'NO_DATA' }); continue; }

    let outcome: Outcome = 'OPEN';
    let exitTs = toTs;
    for (const t of trades) {
      const hitTarget = direction === 1 ? t.price >= targetPrice : t.price <= targetPrice;
      const hitStop   = direction === 1 ? t.price <= stopPrice  : t.price >= stopPrice;
      if (hitTarget) { outcome = 'WIN';  exitTs = t.ts_ms; break; }
      if (hitStop)   { outcome = 'LOSS'; exitTs = t.ts_ms; break; }
    }
    if (outcome === 'WIN')  { win++; netPts += tp; }
    if (outcome === 'LOSS') { loss++; netPts -= sl; }
    if (outcome === 'OPEN') open++;
    detail.push({ cluster: c, outcome, timeToExitMs: outcome === 'OPEN' ? undefined : exitTs - fromTs });
  }
  return { win, loss, open, noData, netPts, detail };
}

function ratioBucket(c: IcebergCluster): 'maker' | 'mild' | 'defender' | 'heavy' {
  const ratio = c.totalVisibleVolume > 0 ? c.totalTradedThrough / c.totalVisibleVolume : 0;
  if (ratio < 1)   return 'maker';
  if (ratio < 2)   return 'mild';
  if (ratio < 4)   return 'defender';
  return 'heavy';
}

console.log(`\n══ MBO iceberg outcome validation ══`);
console.log(`Refresh window: ${REFRESH_WINDOW}ms | Cluster window: ${CLUSTER_WINDOW/1000}s | Min refreshes: ${MIN_REFRESHES}`);
console.log(`Horizon: ${HORIZON_MS/60_000}min max | Entry: cluster.price at lastRefreshTs\n`);

for (const symbol of SYMBOLS) {
  const refreshes = findRefreshes(db, { symbol, refreshWindowMs: REFRESH_WINDOW });
  const clusters = clusterRefreshes(refreshes, {
    symbol, refreshWindowMs: REFRESH_WINDOW,
    clusterWindowMs: CLUSTER_WINDOW, minRefreshes: MIN_REFRESHES,
  });
  if (clusters.length === 0) { console.log(`${symbol}: no clusters`); continue; }

  console.log(`\n── ${symbol}: ${clusters.length} confirmed clusters ──`);

  // Breakdown by ratio bucket
  const buckets = { maker: 0, mild: 0, defender: 0, heavy: 0 };
  for (const c of clusters) buckets[ratioBucket(c)]++;
  console.log(`  Ratio buckets (traded/visible):`);
  console.log(`    maker (<1×):     ${buckets.maker} (${(buckets.maker/clusters.length*100).toFixed(1)}%)  — visible > traded`);
  console.log(`    mild  (1-2×):    ${buckets.mild} (${(buckets.mild/clusters.length*100).toFixed(1)}%)`);
  console.log(`    defender (2-4×): ${buckets.defender} (${(buckets.defender/clusters.length*100).toFixed(1)}%)  — likely real institutional defense`);
  console.log(`    heavy (≥4×):     ${buckets.heavy} (${(buckets.heavy/clusters.length*100).toFixed(1)}%)  — strong absorption`);

  console.log(`\n  Side: ${clusters.filter(c => c.side==='BID').length} BID, ${clusters.filter(c => c.side==='ASK').length} ASK\n`);

  // Run all TP/SL grids on ALL clusters
  console.log(`  ── All clusters (n=${clusters.length}) ──`);
  console.log(`    ${'grid'.padEnd(20)}  W      L      OPEN   NO_DATA  WR(closed)  netPts`);
  for (const g of GRIDS) {
    const r = simulate(symbol, clusters, g.tp, g.sl);
    const closed = r.win + r.loss;
    const wr = closed > 0 ? r.win/closed*100 : 0;
    console.log(`    ${g.label.padEnd(20)}  ${String(r.win).padStart(4)}   ${String(r.loss).padStart(4)}   ${String(r.open).padStart(4)}   ${String(r.noData).padStart(5)}    ${wr.toFixed(1).padStart(5)}%      ${r.netPts > 0 ? '+' : ''}${r.netPts}`);
  }

  // Also run on DEFENDER+HEAVY only (the trading signal candidates)
  const defenders = clusters.filter(c => {
    const b = ratioBucket(c);
    return b === 'defender' || b === 'heavy';
  });
  console.log(`\n  ── Defender + Heavy only (n=${defenders.length}) ──`);
  console.log(`    ${'grid'.padEnd(20)}  W      L      OPEN   NO_DATA  WR(closed)  netPts`);
  for (const g of GRIDS) {
    const r = simulate(symbol, defenders, g.tp, g.sl);
    const closed = r.win + r.loss;
    const wr = closed > 0 ? r.win/closed*100 : 0;
    console.log(`    ${g.label.padEnd(20)}  ${String(r.win).padStart(4)}   ${String(r.loss).padStart(4)}   ${String(r.open).padStart(4)}   ${String(r.noData).padStart(5)}    ${wr.toFixed(1).padStart(5)}%      ${r.netPts > 0 ? '+' : ''}${r.netPts}`);
  }

  // Side asymmetry on defender+heavy at the best grid (TP20/SL5)
  const ddside = defenders.filter(c => c.side === 'BID');
  const aaside = defenders.filter(c => c.side === 'ASK');
  console.log(`\n  ── Defender+Heavy by side (TP20/SL5) ──`);
  if (ddside.length > 0) {
    const r = simulate(symbol, ddside, 20, 5);
    const closed = r.win + r.loss;
    console.log(`    BID-side  n=${ddside.length}: W=${r.win} L=${r.loss} OPEN=${r.open} WR=${closed>0?(r.win/closed*100).toFixed(1):'0.0'}% net=${r.netPts > 0 ? '+' : ''}${r.netPts}pt`);
  }
  if (aaside.length > 0) {
    const r = simulate(symbol, aaside, 20, 5);
    const closed = r.win + r.loss;
    console.log(`    ASK-side  n=${aaside.length}: W=${r.win} L=${r.loss} OPEN=${r.open} WR=${closed>0?(r.win/closed*100).toFixed(1):'0.0'}% net=${r.netPts > 0 ? '+' : ''}${r.netPts}pt`);
  }
}

db.close();
