// Band sensitivity sweep — replay 06-24 NQ L3 ONCE, drive N EpisodeTrackers in parallel (one per τ),
// and report how the band width, retest-counting, and signal formation respond to τ. The point is to
// SEE the tradeoff curve (small τ → every wiggle is a retest = correlated churn; large τ → band
// engulfs zones = retests vanish) and pick τ on the stable middle — NOT to make any one move light up.
// Generic grid of levels, generic window. Run: pnpm --filter @trading/aggregator exec tsx scripts/sweep_band_tau.ts
import { DuckDBInstance } from '@duckdb/node-api';
import { OrderBook } from '../src/l3/order-book.js';
import { EpisodeTracker, type EpisodeSetup } from '../src/l3/episode-tracker.js';
import { median } from '../src/l3/divergence.js';

const P = '/Users/ravikumarbasker/trading-cockpit/data/mbo-parquet';
const SYM = 'NQ';
const gp = (t: string) => `read_parquet('${P}/${t}/symbol=${SYM}/date=2026-06-24/*.parquet')`;
const LO = Date.parse('2026-06-24T11:00:00-04:00');
const HI = Date.parse('2026-06-24T15:00:00-04:00');
const OK = `price BETWEEN 25000 AND 35000 AND ts_ms BETWEEN ${LO} AND ${HI}`;
const THROTTLE = 200;

const TAUS = [2, 5, 10, 20, 30, 45, 60, 90, 120, 240, 480];   // touch timescales (s); extremes included to expose the curve edges
const levels = [];
for (let p = 29350; p <= 29850; p += 25) levels.push({ price: p, label: `L${p}`, kind: 'structural' });

const num = (v: any) => v == null ? null : Number(v);
const book = new OrderBook(SYM, 0.25);
const trackers = TAUS.map(t => new EpisodeTracker({ TAU_SEC: t }));
const setupsByTau: EpisodeSetup[][] = TAUS.map(() => []);
const reach3: Set<string>[] = TAUS.map(() => new Set());
const retestPeak: Map<string, number>[] = TAUS.map(() => new Map());   // peak retest count per level → churn
const bands: number[][] = TAUS.map(() => []);
let lastObs = 0, lastSnap = 0;

const inst = await DuckDBInstance.create();
const con = await inst.connect();
const SQL = `
SELECT ts_ms,'D' src, CAST(NULL AS VARCHAR) act, CAST(NULL AS VARCHAR) oid, price_int, price, size, is_bid, CAST(NULL AS BOOLEAN) iba, CAST(NULL AS VARCHAR) aoid, CAST(NULL AS VARCHAR) poid FROM ${gp('depth')} WHERE ${OK}
UNION ALL SELECT ts_ms,'M', action, order_id, price_int, price, size, is_bid, CAST(NULL AS BOOLEAN), CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR) FROM ${gp('mbo')} WHERE ${OK}
UNION ALL SELECT ts_ms,'T', CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR), price_int, price, size, CAST(NULL AS BOOLEAN), is_bid_aggressor, aggressor_order_id, passive_order_id FROM ${gp('trades')} WHERE size>0 AND ${OK}
ORDER BY ts_ms`;

process.stderr.write(`streaming 06-24 ${SYM} 11:00-15:00 ET × ${TAUS.length} trackers (~few min)...\n`);
const stream = await con.stream(SQL);
let n = 0, chunk;
while ((chunk = await stream.fetchChunk()) && chunk.rowCount > 0) {
  for (const row of chunk.getRows() as any[]) {
    const ts = Number(row[0]), src = row[1];
    book.lastTs = ts;
    if (src === 'D') { const sz = num(row[6]); if (sz != null) book.applyDepth({ is_bid: !!row[7], size: sz, price_int: num(row[4])! }); }
    else if (src === 'M') {
      const act = row[2], oid = row[3];
      if (act === 'send') book.applySend({ order_id: oid, price_int: num(row[4])!, size: num(row[6]) ?? 0, is_bid: !!row[7] });
      else if (act === 'replace') book.applyReplace({ order_id: oid, price_int: num(row[4])!, size: num(row[6]) ?? 0 });
      else if (act === 'cancel') book.applyCancel({ order_id: oid });
    } else book.applyTrade({ price_int: num(row[4])!, price: num(row[5])!, size: num(row[6])!, is_bid_aggressor: !!row[8], aggressor_order_id: row[9], passive_order_id: row[10] });

    if (ts - lastObs >= THROTTLE) {
      lastObs = ts;
      for (let i = 0; i < trackers.length; i++) for (const s of trackers[i]!.observe(SYM, book, levels, ts)) setupsByTau[i]!.push(s);
    }
    if (ts - lastSnap >= 60_000) {   // sample band + capture episodes reaching ≥3 retests (reaped later)
      lastSnap = ts;
      for (let i = 0; i < trackers.length; i++) {
        bands[i]!.push(trackers[i]!.lastBand(SYM));
        for (const ep of trackers[i]!.snapshot(SYM)) {
          if (ep.retests.length >= 3) reach3[i]!.add(ep.key);
          retestPeak[i]!.set(ep.key, Math.max(retestPeak[i]!.get(ep.key) ?? 0, ep.retests.length));
        }
      }
    }
    n++;
  }
}
process.stderr.write(`processed ${n} events\n\n`);

const cnt = (ss: EpisodeSetup[], st: string) => ss.filter(s => s.state === st).length;
const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
const peak = (m: Map<string, number>) => Math.max(0, ...m.values());
console.log('τ(s)  medBand(pt)  eps≥3  totRetests  peakRetests   DIST  ACC  BREAK   setups');
for (let i = 0; i < TAUS.length; i++) {
  const ss = setupsByTau[i]!;
  console.log(
    `${String(TAUS[i]).padStart(4)}  ${median(bands[i]!).toFixed(2).padStart(10)}  ${String(reach3[i]!.size).padStart(5)}  `
    + `${String(sum(retestPeak[i]!)).padStart(10)}  ${String(peak(retestPeak[i]!)).padStart(11)}   `
    + `${String(cnt(ss, 'DISTRIBUTION')).padStart(4)} ${String(cnt(ss, 'ACCUMULATION')).padStart(4)} ${String(cnt(ss, 'BREAKING')).padStart(5)}   ${String(ss.length).padStart(6)}`);
}
console.log('\nread: totRetests/peakRetests expose the churn — small τ (tight band) → price wiggles in/out');
console.log('→ retests inflate (correlated samples); large τ → band engulfs zones → retests collapse.');
console.log('Pick τ where retest counts are stable + signals consistent, then forward-validate. No move-fitting.');
process.exit(0);
