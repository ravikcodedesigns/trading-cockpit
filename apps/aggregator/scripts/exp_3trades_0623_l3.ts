// Replay the 06-23 NQ L2+L3 book through the PRODUCTION OrderBook and run the REAL
// confirm() at each of the 3 live auto-trader entries (1 TP, 2 SL). All longs → defend
// bid. The RS framework gate is neutralized (these aren't RS trades) so the verdict is
// driven purely by the L3 microstructure. Question: does it take the winner, skip the losers?
import { DuckDBInstance } from '@duckdb/node-api';
import { OrderBook } from '../src/l3/order-book.js';
import { confirm, type L3Read, type CtxRead } from '../src/l3/decision-engine.js';
import type { Thesis } from '../src/l3/engine-thesis.js';

const PROOT = '/Users/ravikumarbasker/trading-cockpit/data/mbo-parquet';
const gp = (t: string) => `read_parquet('${PROOT}/${t}/symbol=NQ/date=2026-06-23/*.parquet')`;
const WALL_TICKS = 4, NEAR_TICKS = 16, TAPE_MS = 30000;

interface Trade { tag: string; readTs: number; entry: number; bounce: boolean; tp: number; sl: number; outcome: string; }
const TRADES: Trade[] = [
  { tag: '11:26 FLIP long', readTs: 1782228360000, entry: 29742.0,  bounce: true,  tp: 80, sl: 55, outcome: 'WIN (TP +80)' },
  { tag: '12:19 CONT long', readTs: 1782231540000, entry: 29855.0,  bounce: false, tp: 80, sl: 70, outcome: 'LOSS (SL -59.75)' },
  { tag: '14:08 FLIP long', readTs: 1782238080000, entry: 29722.75, bounce: true,  tp: 80, sl: 55, outcome: 'LOSS (scratch -0.25)' },
];
const MAXTS = Math.max(...TRADES.map(t => t.readTs)) + 120000;

const num = (v: any) => v == null ? null : Number(v);
const book = new OrderBook('NQ', 0.25);
const cvdHist: Array<[number, number]> = [];
let lastSample = 0;
const pending = [...TRADES].sort((a, b) => a.readTs - b.readTs);
const results: any[] = [];

function snapshot(t: Trade): void {
  const lvInt = book.intFromPrice(t.entry);
  const since = t.readTs - TAPE_MS;
  const w = book.depthNear(lvInt, WALL_TICKS, 'bid');
  const l3 = book.l3Near(lvInt, WALL_TICKS, 'bid');
  const ice = book.icebergsNear(lvInt, WALL_TICKS, 'bid').count;
  const synth = book.syntheticRefillsNear(lvInt, WALL_TICKS, since);
  const pull = book.pullNear(lvInt, WALL_TICKS, 'bid', since);
  const adds = book.addsNear(lvInt, WALL_TICKS, 'bid', since);
  let aggrBuy = 0, aggrSell = 0, executedNear = 0;
  for (const p of book.tapeNear(lvInt, NEAR_TICKS, since)) { executedNear += p.size; if (p.buy) aggrBuy += p.size; else aggrSell += p.size; }
  const sweep = book.sweepNear(lvInt, NEAR_TICKS, since);
  const cluster = book.aggressorClusterNear(lvInt, NEAR_TICKS, since);
  const then = cvdHist.find(([ts]) => ts >= t.readTs - 60000);
  const cvd60 = then ? book.cvd - then[1] : 0;
  const bbI = book.bestBid(), baI = book.bestAsk();
  const mid = bbI != null && baI != null ? book.priceFromInt((bbI + baI) / 2) : null;

  const sweepWith = sweep.swept && sweep.dir === 'buy';      // long + buy sweep = with
  const sweepAgainst = sweep.swept && sweep.dir === 'sell';
  const l3read: L3Read = {
    defendSide: 'bid', wall: w.size, l3Size: l3, impliedGap: Math.max(0, w.size - l3),
    nativeIce: ice, synthRefills: synth, executedNear, cvd: book.cvd, cvd60: Math.round(cvd60),
    aggrBuy, aggrSell, pull, adds, sweepWith, sweepAgainst, clusterDominance: cluster.dominance,
  };
  const thesis = {
    direction: 'long', bounceVsBreak: t.bounce ? 'bounce' : 'break', level: t.entry,
    confluence: 1, engines: [t.bounce ? 'LIVE-FLIP' : 'LIVE-CONT'], conflict: [], lmAgrees: null,
    sizeBase: 'M', baseProb: 0.5, entry: t.entry, stop: t.entry - t.sl, targets: [t.entry + t.tp],
  } as unknown as Thesis;
  // neutral ctx — isolate the L3 microstructure (RS gate doesn't apply to these trades)
  const ctx: CtxRead = { isRational: true, vxVolState: null, gateMode: 'normal', gateLongOnly: false, gateSizeDown: false, price: t.entry, ddUpper: null, ddLower: null };
  const r = confirm(thesis, l3read, ctx);
  results.push({ t, mid, l3read, r });
}

const inst = await DuckDBInstance.create();
const con = await inst.connect();
const SQL = `
SELECT ts_ms,'D' src, CAST(NULL AS VARCHAR) act, CAST(NULL AS VARCHAR) oid, price_int, price, size, is_bid, CAST(NULL AS BOOLEAN) iba, CAST(NULL AS VARCHAR) aoid, CAST(NULL AS VARCHAR) poid FROM ${gp('depth')} WHERE ts_ms<=${MAXTS}
UNION ALL SELECT ts_ms,'M', action, order_id, price_int, price, size, is_bid, CAST(NULL AS BOOLEAN), CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR) FROM ${gp('mbo')} WHERE ts_ms<=${MAXTS}
UNION ALL SELECT ts_ms,'T', CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR), price_int, price, size, CAST(NULL AS BOOLEAN), is_bid_aggressor, aggressor_order_id, passive_order_id FROM ${gp('trades')} WHERE size>0 AND ts_ms<=${MAXTS}
ORDER BY ts_ms`;

process.stderr.write('streaming 06-23 NQ events (this takes ~1-2 min)...\n');
const stream = await con.stream(SQL);
let n = 0;
let chunk;
while ((chunk = await stream.fetchChunk()) && chunk.rowCount > 0) {
  for (const row of chunk.getRows() as any[]) {
    const ts = Number(row[0]), src = row[1];
    book.lastTs = ts;
    // fire any snapshots whose readTs we've reached
    while (pending.length && ts >= pending[0].readTs) snapshot(pending.shift()!);
    if (src === 'D') {
      const sz = num(row[6]); if (sz != null) book.applyDepth({ is_bid: !!row[7], size: sz, price_int: num(row[4])! });
    } else if (src === 'M') {
      const act = row[2], oid = row[3];
      if (act === 'send') book.applySend({ order_id: oid, price_int: num(row[4])!, size: num(row[6]) ?? 0, is_bid: !!row[7] });
      else if (act === 'replace') book.applyReplace({ order_id: oid, price_int: num(row[4])!, size: num(row[6]) ?? 0 });
      else if (act === 'cancel') book.applyCancel({ order_id: oid });
    } else { // T
      book.applyTrade({ price_int: num(row[4])!, price: num(row[5])!, size: num(row[6])!, is_bid_aggressor: !!row[8], aggressor_order_id: row[9], passive_order_id: row[10] });
    }
    // sample cvd ~1/s of book time for the cvd60 slope
    if (ts - lastSample >= 1000) { cvdHist.push([ts, book.cvd]); lastSample = ts; if (cvdHist.length > 200) cvdHist.shift(); }
    n++;
  }
}
while (pending.length) snapshot(pending.shift()!); // safety

process.stderr.write(`processed ${n} events\n\n`);
for (const { t, mid, l3read, r } of results) {
  const supported = r.verdict === 'take';
  const correct = (t.outcome.startsWith('WIN') && supported) || (!t.outcome.startsWith('WIN') && !supported);
  console.log(`━━ ${t.tag}  entry ${t.entry}  ACTUAL ${t.outcome} ━━`);
  console.log(`   book mid@read ${mid?.toFixed(2)}  defend BID`);
  console.log(`   wall ${l3read.wall} | l3 ${l3read.l3Size} | gap ${l3read.impliedGap} | nativeIce ${l3read.nativeIce} | synthRefills ${l3read.synthRefills}`);
  console.log(`   traded ${l3read.executedNear} (buy ${l3read.aggrBuy}/sell ${l3read.aggrSell}) | pull ${l3read.pull} | adds ${l3read.adds}`);
  console.log(`   CVD ${l3read.cvd} | CVD60 ${l3read.cvd60} | sweep ${l3read.sweepWith ? 'WITH' : l3read.sweepAgainst ? 'AGAINST' : 'none'} | cluster ${Math.round(l3read.clusterDominance * 100)}%`);
  console.log(`   → DECIDER: ${r.verdict.toUpperCase()}${r.size ? ' ' + r.size : ''}  score ${r.confirmationScore}/4   ${correct ? '✅ MATCHES outcome' : '❌ disagrees'}`);
  console.log(`   confirms: ${r.confirms.join(' | ') || '—'}`);
  console.log(`   vetoes:   ${r.invalidations.join(' | ') || '—'}`);
  if (r.breakForming) console.log(`   ⚠ ${r.breakForming.note}`);
  console.log('');
}
process.exit(0);
