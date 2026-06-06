// MBO iceberg detector — smoke test on the ingested data in mbo.db.
// Sweeps refresh-window thresholds to see how many icebergs are detected.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRefreshes, clusterRefreshes } from './lib/mbo-iceberg-detector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const MBO_DB = path.resolve(__dirname, '../../../data/mbo.db');

const db = new Database(MBO_DB, { readonly: true });

const SYMBOLS = ['MNQM', 'MESM'];
const REFRESH_WINDOWS = [10, 50, 100, 200, 500]; // milliseconds
const CLUSTER_WINDOW = 30_000;                    // 30 sec
const MIN_REFRESHES = 2;

console.log(`\n══ MBO iceberg detector — smoke test ══`);

for (const sym of SYMBOLS) {
  const totalFilled = (db.prepare(`SELECT COUNT(*) as n FROM mbo_orders WHERE symbol=? AND status='filled'`).get(sym) as {n:number}).n;
  console.log(`\n── ${sym} (${totalFilled.toLocaleString()} filled orders) ──`);
  console.log(`\n  refresh_window  |  refreshes  |  clusters≥2  |  detection_rate  |  sample`);

  for (const win of REFRESH_WINDOWS) {
    const refreshes = findRefreshes(db, {
      symbol: sym,
      refreshWindowMs: win,
      clusterWindowMs: CLUSTER_WINDOW,
      minRefreshes: MIN_REFRESHES,
    });
    const clusters = clusterRefreshes(refreshes, {
      symbol: sym,
      refreshWindowMs: win,
      clusterWindowMs: CLUSTER_WINDOW,
      minRefreshes: MIN_REFRESHES,
    });

    // Find the strongest cluster (most refreshes) for sampling
    const sorted = [...clusters].sort((a, b) => b.refreshCount - a.refreshCount);
    const strongest = sorted[0];
    let sample = '';
    if (strongest) {
      const et = new Date(strongest.firstRefreshTs - 4*60*60_000).toISOString().substring(11, 19);
      sample = `${et} ${strongest.side} @${strongest.price} ×${strongest.refreshCount}`;
    }

    console.log(
      `  ${(win+'ms').padStart(13)}    | ` +
      `${refreshes.length.toString().padStart(9)}  | ` +
      `${clusters.length.toString().padStart(10)}  | ` +
      `${(refreshes.length/totalFilled*100).toFixed(2).padStart(7)}%        | ` +
      `${sample}`
    );
  }

  // Detail: top 10 clusters at 100ms refresh window
  console.log(`\n  Top 10 iceberg clusters (refresh_window=100ms):`);
  const refreshes = findRefreshes(db, { symbol: sym, refreshWindowMs: 100 });
  const clusters = clusterRefreshes(refreshes, { symbol: sym, refreshWindowMs: 100, clusterWindowMs: CLUSTER_WINDOW, minRefreshes: MIN_REFRESHES });
  console.log(`\n    ts (ET)    side  price       refreshes   total_traded   total_visible   avg_latency_ms`);
  for (const c of clusters.sort((a, b) => b.totalTradedThrough - a.totalTradedThrough).slice(0, 10)) {
    const et = new Date(c.firstRefreshTs - 4*60*60_000).toISOString().substring(11, 19);
    console.log(
      `    ${et}    ${c.side}   ${c.price.toFixed(2).padStart(8)}      ` +
      `${c.refreshCount.toString().padStart(4)}        ` +
      `${c.totalTradedThrough.toString().padStart(5)}            ` +
      `${c.totalVisibleVolume.toString().padStart(5)}            ` +
      `${c.avgRefreshLatencyMs.toFixed(1)}`
    );
  }
}

db.close();
