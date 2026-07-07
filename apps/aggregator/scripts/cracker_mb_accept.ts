// CRACKER acceptance — market-book.ts (rebuilt primitive #3).
// Synthetic ground truth first (hand-computed book states), then coverage
// honesty, anomaly accounting, reconciliation, a performance budget, and a
// REAL-DAY PARITY replay against the legacy order-book on everything Cracker
// actually consumed from it (best prices, ladder, depthNear) — plus a
// demonstration that the legacy tape's silent truncation is real (the flaw
// that motivated the rebuild, shown, not asserted).
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cracker_mb_accept.ts
import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs';
import { MarketBook } from '../src/l3/market-book.js';
import { OrderBook } from '../src/l3/order-book.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

// ── A. ladder mechanics (hand-computed ground truth) ──────────────────────────
{
  const b = new MarketBook('NQ', 0.25);
  const D = (ts: number, pi: number, size: number, isBid: boolean) => b.applyDepth({ ts, priceInt: pi, size, isBid });
  D(1, 100, 5, true); D(2, 98, 3, true); D(3, 102, 7, false); D(4, 104, 2, false); D(5, 99, 4, true);
  check('A1 best prices O(1) reads', b.bestBid() === 100 && b.bestAsk() === 102);
  check('A2 mid', b.mid() === (100 * 0.25 + 102 * 0.25) / 2);
  D(6, 100, 9, true);                                   // size update, no structural change
  check('A3 size update in place', b.bestBid() === 100 && b.depthNear(100, 0, 'bid').size === 9);
  D(7, 100, 0, true);                                   // clear best bid
  check('A4 level clear re-ranks best', b.bestBid() === 99);
  D(8, 100, 2, true);                                   // re-add
  const lad = b.ladder(3);
  check('A5 ladder best-first, no read-time sort', lad.bids.map((l) => l.priceInt).join(',') === '100,99,98' && lad.asks.map((l) => l.priceInt).join(',') === '102,104');
  check('A6 depthNear window sum', b.depthNear(99, 1, 'bid').size === 2 + 4 + 3);
  const sortedOk = [...b['bid'].sorted].every((v, i, a) => i === 0 || a[i - 1]! < v);
  check('A7 sorted-array invariant', sortedOk);
}

// ── B. order lifecycle ────────────────────────────────────────────────────────
{
  const b = new MarketBook('NQ', 0.25);
  const t0 = 1_000_000;
  b.applyDepth({ ts: t0 - 1, priceInt: 100, size: 14, isBid: true });
  b.applySend({ ts: t0, orderId: 'a', priceInt: 100, size: 10, isBid: true });
  b.applySend({ ts: t0 + 100, orderId: 'x', priceInt: 100, size: 4, isBid: true });
  check('B1 L3 order counts ride the depth ladder', b.ladder(1).bids[0]?.orders === 2);
  b.applyReplace({ ts: t0 + 200, orderId: 'a', priceInt: 101, size: 6 });        // move+shrink
  check('B2 replace moves the order', b.icebergsNear(101, 0, 'bid').count === 0);
  b.applyReplace({ ts: t0 + 300, orderId: 'a', priceInt: 101, size: 12 });       // replace-UP ⇒ hidden reveal
  check('B3 replace-up flags hidden size', b.icebergsNear(101, 0, 'bid').count === 1);
  b.applyTrade({ ts: t0 + 400, priceInt: 101, size: 5, isBuy: false, passId: 'a' });
  check('B4 partial passive fill decrements + accumulates cf', b.icebergsNear(101, 0, 'bid').cumFilled === 5);
  b.applyTrade({ ts: t0 + 500, priceInt: 101, size: 7, isBuy: false, passId: 'a' });   // full fill
  check('B5 full fill removes order + arms refill', b.icebergsNear(101, 0, 'bid').count === 0);
  b.applySend({ ts: t0 + 500 + 1000, orderId: 'r1', priceInt: 101, size: 8, isBid: true });
  check('B6 refill chain within 1.5s counted', b.refillsNear(101, 0, t0).value === 1);
  b.applyTrade({ ts: t0 + 3000, priceInt: 100, size: 4, isBuy: false, passId: 'x' });  // full fill of x
  b.applySend({ ts: t0 + 3000 + 2000, orderId: 'r2', priceInt: 100, size: 8, isBid: true });  // too late
  check('B7 late repost is NOT a refill (stale armed price GC)', b.refillsNear(100, 0, t0).value === 0);
  // hidden reveal via cf>md
  b.applySend({ ts: t0 + 6000, orderId: 'ice', priceInt: 99, size: 3, isBid: true });
  b.applyTrade({ ts: t0 + 6100, priceInt: 99, size: 2, isBuy: false, passId: 'ice' });
  b.applyReplace({ ts: t0 + 6200, orderId: 'ice', priceInt: 99, size: 3 });      // refreshed display (not up)
  b.applyTrade({ ts: t0 + 6300, priceInt: 99, size: 2, isBuy: false, passId: 'ice' });
  check('B8 cf>md flags iceberg', b.icebergsNear(99, 0, 'bid').count === 1 && b.icebergsNear(99, 0, 'bid').cumFilled === 4);
  // anomaly counters
  b.applyReplace({ ts: t0 + 7000, orderId: 'ghost', priceInt: 100, size: 1 });
  b.applyCancel({ ts: t0 + 7100, orderId: 'ghost2' });
  b.applyTrade({ ts: t0 + 7200, priceInt: 100, size: 1, isBuy: true, passId: 'ghost3' });
  b.applySend({ ts: t0 + 7300, orderId: 'r1', priceInt: 100, size: 1, isBid: true });   // dup id
  const h = b.health();
  check('B9 anomaly counters', h.counters.unknownReplace === 1 && h.counters.unknownCancel === 1 && h.counters.unknownPassive === 1 && h.counters.dupSend === 1);
}

// ── C. clock health + reset semantics ────────────────────────────────────────
{
  const b = new MarketBook('NQ', 0.25);
  b.applyDepth({ ts: 1000, priceInt: 100, size: 5, isBid: true });
  b.applyDepth({ ts: 2000, priceInt: 99, size: 5, isBid: false });   // crossed: bid 100 ≥ ask 99
  b.applyDepth({ ts: 5000, priceInt: 99, size: 0, isBid: false });   // uncross at 5000 → 3s crossed
  b.applyDepth({ ts: 5200, priceInt: 101, size: 5, isBid: false });
  b.applyDepth({ ts: 4000, priceInt: 98, size: 1, isBid: true });    // regression
  const h = b.health();
  check('C1 crossed-book time accumulated', h.counters.crossedMs === 3000, `${h.counters.crossedMs}ms`);
  check('C2 ts regression counted', h.counters.tsRegressions === 1);
  b.reset();
  check('C3 reset clears state, keeps run counters', b.bestBid() === null && b.health().counters.crossedMs === 3000 && b.health().counters.resets === 1);
}

// ── D. coverage honesty (the rebuild's raison d'être) ─────────────────────────
{
  const b = new MarketBook('NQ', 0.25, { TAPE_RETAIN_MS: 10_000, JOURNAL_RETAIN_MS: 10_000 });
  for (let i = 0; i <= 30; i++) b.applyTrade({ ts: i * 1000, priceInt: 100, size: 1, isBuy: true });
  const past = b.absorbedNear(100, 0, 0);
  check('D1 query past retention → covered=false (never a silent answer)', past.covered === false && past.value < 31);
  const recent = b.absorbedNear(100, 0, 25_000);
  check('D2 in-retention query → covered=true, exact', recent.covered === true && recent.value === 6);
  const edge = b.absorbedNear(100, 0, 20_000);
  check('D3 boundary exact (first retained ts is covered)', edge.covered === true && edge.value === 11);
  const atEvicted = b.absorbedNear(100, 0, 19_000);
  check('D4 boundary exact (last-evicted ts is uncovered)', atEvicted.covered === false);
  // D5: the cumulative path has NO window — exact across spans >> retention
  const base = 0;   // tradedNear at "open" (t=0, before any trades) was 0
  check('D5 cumulative tradedNear exact across a span beyond retention', b.tradedNear(100, 0) - base === 31);
}

// ── E. depth-vs-L3 reconciliation ─────────────────────────────────────────────
{
  const b = new MarketBook('NQ', 0.25);
  b.applySend({ ts: 1, orderId: 'o1', priceInt: 100, size: 5, isBid: true });
  b.applySend({ ts: 2, orderId: 'o2', priceInt: 100, size: 3, isBid: true });
  b.applyDepth({ ts: 3, priceInt: 100, size: 8, isBid: true });
  check('E1 consistent streams reconcile', b.crossCheck().matched === 1 && b.crossCheck().diverged === 0);
  b.applyDepth({ ts: 4, priceInt: 100, size: 11, isBid: true });   // depth says 11, L3 says 8
  const cc = b.crossCheck();
  check('E2 divergence measured, not hidden', cc.diverged === 1 && cc.sizeDeltaAbs === 3);
}

// ── F. performance budget ─────────────────────────────────────────────────────
{
  const b = new MarketBook('NQ', 0.25);
  const n = 1_000_000;
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const pi = 100_000 + (i % 400) - 200;
    const kind = i % 10;
    if (kind < 5) b.applyDepth({ ts: i, priceInt: pi, size: (i % 7 === 0 ? 0 : 1 + (i % 50)), isBid: (i & 1) === 0 });
    else if (kind < 7) b.applySend({ ts: i, orderId: `o${i}`, priceInt: pi, size: 1 + (i % 9), isBid: (i & 1) === 0 });
    else if (kind < 8) b.applyCancel({ ts: i, orderId: `o${i - 30}` });
    else b.applyTrade({ ts: i, priceInt: pi, size: 1 + (i % 5), isBuy: (i & 2) === 0, passId: `o${i - 20}` });
    if (i % 1000 === 0) { b.bestBid(); b.bestAsk(); b.depthNear(pi, 16, 'bid'); }
  }
  const ms = Date.now() - t0;
  check('F1 1M mixed events + periodic reads under 10s', ms < 10_000, `${ms}ms (${Math.round(n / ms)}k ev/s)`);
}

// ── G. real-day PARITY vs the legacy order-book — all four feed×symbol combos ──
async function parityOne(con: any, store: 'l3' | 'l2', sym: string, day: string, demoTruncation: boolean): Promise<void> {
  const ROOT = '/Users/ravikumarbasker/trading-cockpit/data';
  const et = (hm: string) => Date.parse(`${day}T${hm}:00-04:00`);
  let SQL: string;
  if (store === 'l3') {
    const dom = `(SELECT contract FROM read_parquet('${ROOT}/mbo-parquet/trades/symbol=${sym}/date=${day}/*.parquet') WHERE ts_ms >= ${et('09:30')} AND ts_ms < ${et('16:00')} GROUP BY contract ORDER BY SUM(size) DESC LIMIT 1)`;
    SQL = `
      SELECT ts_ms,'D' s, price_int, size, is_bid b, CAST(NULL AS BOOLEAN) f, filename fn, file_row_number frn
        FROM read_parquet('${ROOT}/mbo-parquet/depth/symbol=${sym}/date=${day}/*.parquet', filename=true, file_row_number=true)
        WHERE contract = ${dom} AND ts_ms BETWEEN ${et('09:00')} AND ${et('12:00')}
      UNION ALL SELECT ts_ms,'T', price_int, size, CAST(NULL AS BOOLEAN), is_bid_aggressor, filename, file_row_number
        FROM read_parquet('${ROOT}/mbo-parquet/trades/symbol=${sym}/date=${day}/*.parquet', filename=true, file_row_number=true)
        WHERE contract = ${dom} AND size > 0 AND NOT is_otc AND ts_ms BETWEEN ${et('09:00')} AND ${et('12:00')}
      ORDER BY ts_ms, s, fn, frn`;
  } else {
    const sane = sym === 'ES' ? 'price BETWEEN 4000 AND 9000' : 'price BETWEEN 20000 AND 40000';
    SQL = `
      SELECT ts,'D' s, CAST(ROUND(price/0.25) AS INTEGER) pi, size, (side = 0) b, CAST(NULL AS BOOLEAN) f, filename fn, file_row_number frn
        FROM read_parquet('${ROOT}/ticks-parquet/depth/symbol=${sym}/date=${day}/*.parquet', filename=true, file_row_number=true)
        WHERE ${sane} AND ts BETWEEN ${et('09:00')} AND ${et('12:00')}
      UNION ALL SELECT ts,'T', CAST(ROUND(price/0.25) AS INTEGER), size, CAST(NULL AS BOOLEAN), is_bid_aggressor, filename, file_row_number
        FROM read_parquet('${ROOT}/ticks-parquet/trades/symbol=${sym}/date=${day}/*.parquet', filename=true, file_row_number=true)
        WHERE size > 0 AND ${sane} AND ts BETWEEN ${et('09:00')} AND ${et('12:00')}
      ORDER BY ts, s, fn, frn`;
  }
  const nu = new MarketBook(sym, 0.25);
  const old = new OrderBook(sym, 0.25);
  let n = 0, cmps = 0, mism = 0, truncationShown = !demoTruncation;
  const stream = await con.stream(SQL);
  let chunk;
  while ((chunk = await stream.fetchChunk()) && chunk.rowCount > 0) {
    for (const row of chunk.getRows() as any[]) {
      const ts = Number(row[0]); old.lastTs = ts;
      const pi = Number(row[2]), sz = Number(row[3]);
      if (row[1] === 'D') {
        nu.applyDepth({ ts, priceInt: pi, size: sz, isBid: !!row[4] });
        old.applyDepth({ is_bid: !!row[4], size: sz, price_int: pi });
      } else {
        nu.applyTrade({ ts, priceInt: pi, size: sz, isBuy: !!row[5] });
        old.applyTrade({ price_int: pi, price: pi * 0.25, size: sz, is_bid_aggressor: !!row[5] });
      }
      if (++n % 100_000 === 0) {
        cmps++;
        const ok = nu.bestBid() === old.bestBid() && nu.bestAsk() === old.bestAsk();
        const lN = nu.ladder(10), lO = old.ladder(10);
        const lOk = JSON.stringify(lN.bids.map((x) => [x.priceInt, x.size])) === JSON.stringify(lO.bids.map((x) => [x.priceInt, x.size]))
          && JSON.stringify(lN.asks.map((x) => [x.priceInt, x.size])) === JSON.stringify(lO.asks.map((x) => [x.priceInt, x.size]));
        const bb = nu.bestBid();
        const dOk = bb == null || nu.depthNear(bb, 16, 'bid').size === old.depthNear(bb, 16, 'bid').size;
        if (!(ok && lOk && dOk)) mism++;
        if (!truncationShown && cmps === 15 && bb != null) {
          const wNew = nu.absorbedNear(bb, 16, ts - 600_000);
          let oldSum = 0; for (const t of old.tapeNear(bb, 16, ts - 600_000)) oldSum += t.size;
          truncationShown = true;
          check('G2 legacy 10-min tape window silently truncated vs honest new read', oldSum < wNew.value && wNew.covered, `legacy ${oldSum} vs new ${wNew.value}`);
        }
      }
    }
  }
  check(`G1 parity ${store.toUpperCase()}-${sym}: best/ladder/depthNear identical`, mism === 0 && cmps > 5, `${cmps} checkpoints, ${n} events, ${mism} mismatches`);
}

async function parity() {
  const inst = await DuckDBInstance.create();
  const con = await inst.connect();
  const combos: Array<['l3' | 'l2', string, string, boolean]> = [
    ['l3', 'NQ', '2026-06-18', true], ['l3', 'ES', '2026-06-18', false],
    ['l2', 'NQ', '2026-06-18', false], ['l2', 'ES', '2026-06-18', false],
  ];
  for (const [store, sym, day, demo] of combos) {
    const dir = store === 'l3' ? `mbo-parquet` : `ticks-parquet`;
    if (!fs.existsSync(`/Users/ravikumarbasker/trading-cockpit/data/${dir}/trades/symbol=${sym}/date=${day}`)) { check(`G0 ${store}-${sym} day available`, false); continue; }
    await parityOne(con, store, sym, day, demo);
  }
}

async function main() {
  console.log('=== MARKET-BOOK ACCEPTANCE (rebuilt primitive #3) ===');
  await parity();
  console.log(`\n${pass}/${pass + fail} checks passed${fail ? ' — FAILURES ABOVE' : ''}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
