// CRACKER Phase 0.3 — aggressor calibration: inferred vs true (CRACKER_PLAN.md §0.3).
//
// Every L2 flow feature (delta, imbalance, absorption) rests on a GUESS: we
// classify each trade's aggressor from where it printed against the book
// (>= ask = buy, <= bid = sell). Bookmap L3 records the TRUTH (is_bid_aggressor).
// Two parts:
//
//   PART 1 — method error, pure L3 (no cross-feed matching, no clock issues):
//   replay L3 depth+trades for 5 evenly-spaced usable days, classify each trade
//   book-relatively from the L3 book, compare to the true flag. Split by trade
//   size and hour. The flag's sign convention is PINNED empirically on the first
//   day (whichever interpretation agrees with the book) and reported.
//
//   PART 2 — end-to-end certification, all usable overlap days: per-minute signed
//   delta from the ACTUAL L2 pipeline (ticks-parquet replay, book-relative) vs
//   the true per-minute delta from L3 flags. Pearson r per day. Also grades
//   CQG's own is_bid_aggressor flag against truth (the "~3.5x off" claim).
//
// Frozen acceptance (CRACKER_PLAN §0.3): trade-level agreement >= 90% AND
// per-minute delta r >= 0.95  →  L2 flow features certified (with error bars).
// Below → flow features route to L3-only.
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cracker_p03_aggressor.ts
import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs';
import { OrderBook } from '../src/l3/order-book.js';

const ROOT = '/Users/ravikumarbasker/trading-cockpit/data';
const OFFSETS = JSON.parse(fs.readFileSync('/Users/ravikumarbasker/trading-cockpit/docs/cracker-clock-offsets.json', 'utf8'));
const SYM_L2 = 'NQ', SYM_L3 = 'MNQ', TICK = 0.25;
const et = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-04:00`);
const num = (v: any) => v == null ? null : Number(v);
const SIZE_BUCKETS: [string, (s: number) => boolean][] = [
  ['1', (s) => s === 1], ['2-4', (s) => s >= 2 && s <= 4], ['5-9', (s) => s >= 5 && s <= 9], ['10+', (s) => s >= 10]];

const usableDays: string[] = Object.entries(OFFSETS.symbols[SYM_L3] as Record<string, any>)
  .filter(([, v]) => v.usable).map(([d]) => d).sort();
const offMs = (d: string) => (OFFSETS.symbols[SYM_L3][d]?.offset_ms ?? 0) as number;
// Part-1 sample: 5 evenly-spaced usable days (pre-registered rule)
const p1days = [0, 1, 2, 3, 4].map((i) => usableDays[Math.floor((i * (usableDays.length - 1)) / 4)]!);

const gpL3 = (t: string, d: string) => `read_parquet('${ROOT}/mbo-parquet/${t}/symbol=${SYM_L3}/date=${d}/*.parquet', filename=true, file_row_number=true)`;
const gpL2 = (t: string, d: string) => `read_parquet('${ROOT}/ticks-parquet/${t}/symbol=${SYM_L2}/date=${d}/*.parquet', filename=true, file_row_number=true)`;
const domSQL = (d: string) => `(SELECT contract FROM read_parquet('${ROOT}/mbo-parquet/trades/symbol=${SYM_L3}/date=${d}/*.parquet')
  WHERE ts_ms >= ${et(d, '09:30')} AND ts_ms < ${et(d, '16:00')} GROUP BY contract ORDER BY SUM(size) DESC LIMIT 1)`;

function pearson(a: number[], b: number[]): number {
  const n = a.length; if (n < 10) return NaN;
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < n; i++) { sa += a[i]!; sb += b[i]!; saa += a[i]! * a[i]!; sbb += b[i]! * b[i]!; sab += a[i]! * b[i]!; }
  const cov = sab - sa * sb / n, va = saa - sa * sa / n, vb = sbb - sb * sb / n;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : NaN;
}

// ── PART 1: replay L3 book, classify trades, compare to the true flag ────────
async function part1Day(con: any, day: string) {
  const [warm, lo, hi] = [et(day, '09:15'), et(day, '09:30'), et(day, '16:00')];
  const book = new OrderBook(SYM_L3, TICK);
  const SQL = `
    SELECT ts_ms,'D' s, price, size, is_bid, CAST(NULL AS BOOLEAN) f, filename fn, file_row_number frn FROM ${gpL3('depth', day)}
      WHERE contract = ${domSQL(day)} AND ts_ms BETWEEN ${warm} AND ${hi}
    UNION ALL SELECT ts_ms,'T', price, size, CAST(NULL AS BOOLEAN), is_bid_aggressor, filename, file_row_number FROM ${gpL3('trades', day)}
      WHERE contract = ${domSQL(day)} AND size > 0 AND NOT is_otc AND ts_ms BETWEEN ${warm} AND ${hi}
    ORDER BY ts_ms, s, fn, frn`;
  const st = await con.stream(SQL);
  const tally = { n: 0, agreeA: 0, mid: 0, volN: 0, volAgreeA: 0 } as any;
  const bySize = new Map(SIZE_BUCKETS.map(([k]) => [k, { n: 0, agree: 0 }]));
  const byHour = new Map<number, { n: number; agree: number }>();
  let chunk;
  while ((chunk = await st.fetchChunk()) && chunk.rowCount > 0) {
    for (const row of chunk.getRows() as any[]) {
      const ts = Number(row[0]); book.lastTs = ts;
      const price = num(row[2])!, size = num(row[3])!;
      if (row[1] === 'D') { book.applyDepth({ is_bid: !!row[4], size, price_int: book.intFromPrice(price) }); continue; }
      if (ts < lo) continue;
      const bb = book.bestBid(), ba = book.bestAsk();
      if (bb == null || ba == null || bb >= ba) continue;
      const bidPx = book.priceFromInt(bb), askPx = book.priceFromInt(ba);
      let inferredSell: boolean | null = null;               // book-relative guess
      if (price >= askPx) inferredSell = false; else if (price <= bidPx) inferredSell = true;
      if (inferredSell == null) { tally.mid++; continue; }   // inside spread: unclassifiable
      const flag = !!row[5];                                 // convention A: flag=true ⇔ aggressive SELL (hit the bid)
      const agree = inferredSell === flag;
      tally.n++; tally.volN += size;
      if (agree) { tally.agreeA++; tally.volAgreeA += size; }
      for (const [k, fn] of SIZE_BUCKETS) if (fn(size)) { const b = bySize.get(k)!; b.n++; if (agree) b.agree++; }
      const hr = new Date(ts).getUTCHours();                 // UTC hour is fine as a bucket key
      const h = byHour.get(hr) ?? { n: 0, agree: 0 }; h.n++; if (agree) h.agree++; byHour.set(hr, h);
    }
  }
  return { tally, bySize, byHour };
}

// ── PART 2: per-minute inferred delta (L2 replay) vs true delta (L3 SQL) ─────
async function part2Day(con: any, day: string, flagIsSell: boolean) {
  const [lo, hi] = [et(day, '09:30'), et(day, '16:00')];
  const nMin = Math.ceil((hi - lo) / 60_000);
  // true delta per minute from L3 flags (clock offset applied: L3 late by offset → shift back)
  const off = Math.round(offMs(day));
  const sgn = flagIsSell ? '-1' : '1';
  const tr = await con.streamAndReadAll(`
    SELECT CAST(FLOOR((ts_ms - ${off} - ${lo}) / 60000) AS BIGINT) m,
           SUM(size * CASE WHEN is_bid_aggressor THEN ${sgn} ELSE ${flagIsSell ? '1' : '-1'} END) d
    FROM read_parquet('${ROOT}/mbo-parquet/trades/symbol=${SYM_L3}/date=${day}/*.parquet')
    WHERE contract = ${domSQL(day)} AND size > 0 AND NOT is_otc AND ts_ms - ${off} >= ${lo} AND ts_ms - ${off} < ${hi} GROUP BY 1`);
  const trueD = new Float64Array(nMin);
  for (const r of tr.getRows() as any[]) { const m = Number(r[0]); if (m >= 0 && m < nMin) trueD[m] = Number(r[1]); }

  // inferred delta per minute: replay the ACTUAL L2 pipeline (book-relative);
  // also tally CQG's own flag for the bonus comparison.
  const book = new OrderBook(SYM_L2, TICK);
  const warm = et(day, '09:15');
  const SQL = `
    SELECT ts,'D' s, price, size, side, CAST(NULL AS BOOLEAN) f, filename fn, file_row_number frn FROM ${gpL2('depth', day)}
      WHERE price BETWEEN 20000 AND 40000 AND ts BETWEEN ${warm} AND ${hi}
    UNION ALL SELECT ts,'T', price, size, CAST(NULL AS BIGINT), is_bid_aggressor, filename, file_row_number FROM ${gpL2('trades', day)}
      WHERE size > 0 AND price BETWEEN 20000 AND 40000 AND ts BETWEEN ${warm} AND ${hi}
    ORDER BY ts, s, fn, frn`;
  const infD = new Float64Array(nMin), cqgD = new Float64Array(nMin);
  const st = await con.stream(SQL);
  let chunk;
  while ((chunk = await st.fetchChunk()) && chunk.rowCount > 0) {
    for (const row of chunk.getRows() as any[]) {
      const ts = Number(row[0]); book.lastTs = ts;
      const price = num(row[2])!, size = num(row[3])!;
      if (row[1] === 'D') { book.applyDepth({ is_bid: Number(row[4]) === 0, size, price_int: book.intFromPrice(price) }); continue; }
      if (ts < lo || ts >= hi) continue;
      const m = Math.floor((ts - lo) / 60_000); if (m < 0 || m >= nMin) continue;
      // CQG's own flag (grade it too): is_bid_aggressor=true treated as sell
      cqgD[m] += row[5] ? -size : size;
      const bb = book.bestBid(), ba = book.bestAsk();
      if (bb == null || ba == null || bb >= ba) continue;
      const bidPx = book.priceFromInt(bb), askPx = book.priceFromInt(ba);
      if (price >= askPx) infD[m] += size; else if (price <= bidPx) infD[m] -= size;  // mid: skip
    }
  }
  const t = Array.from(trueD), i = Array.from(infD), c = Array.from(cqgD);
  return { rInf: pearson(i, t), rCqg: pearson(c, t), volRatio: i.reduce((s, v) => s + Math.abs(v), 0) / Math.max(1, t.reduce((s, v) => s + Math.abs(v), 0)) };
}

async function main() {
  const inst = await DuckDBInstance.create();
  const con = await inst.connect();
  console.log(`usable overlap days: ${usableDays.length}  |  Part-1 sample: ${p1days.join(', ')}`);

  // ── Part 1
  console.log(`\n═══ PART 1 — method error on L3 (book-relative guess vs true flag) ═══`);
  let flagIsSell = true;   // convention A; pinned on first day below
  const agg = { n: 0, agree: 0, vol: 0, volAgree: 0, mid: 0 };
  const aggSize = new Map(SIZE_BUCKETS.map(([k]) => [k, { n: 0, agree: 0 }]));
  for (const [di, day] of p1days.entries()) {
    const { tally, bySize } = await part1Day(con, day);
    let a = tally.agreeA / Math.max(1, tally.n);
    if (di === 0) {
      flagIsSell = a >= 0.5;   // pin the convention empirically
      console.log(`convention pinned: is_bid_aggressor=true ⇔ ${flagIsSell ? 'aggressive SELL (hit the bid)' : 'aggressive BUY'}  (day-1 raw agreement ${(100 * Math.max(a, 1 - a)).toFixed(2)}%)`);
    }
    if (!flagIsSell) { tally.agreeA = tally.n - tally.agreeA; tally.volAgreeA = tally.volN - tally.volAgreeA; for (const [k, b] of bySize) { b.agree = b.n - b.agree; } a = tally.agreeA / Math.max(1, tally.n); }
    const midPct = 100 * tally.mid / Math.max(1, tally.mid + tally.n);
    console.log(`${day}: agree ${(100 * a).toFixed(2)}% of ${tally.n} classified (vol-weighted ${(100 * tally.volAgreeA / Math.max(1, tally.volN)).toFixed(2)}%; inside-spread unclassifiable ${midPct.toFixed(1)}%)`);
    agg.n += tally.n; agg.agree += tally.agreeA; agg.vol += tally.volN; agg.volAgree += tally.volAgreeA; agg.mid += tally.mid;
    for (const [k, b] of bySize) { const g = aggSize.get(k)!; g.n += b.n; g.agree += b.agree; }
  }
  const p1 = 100 * agg.agree / Math.max(1, agg.n);
  console.log(`--- Part 1 overall: ${p1.toFixed(2)}% trade-level agreement (vol-weighted ${(100 * agg.volAgree / Math.max(1, agg.vol)).toFixed(2)}%), unclassifiable ${(100 * agg.mid / Math.max(1, agg.mid + agg.n)).toFixed(1)}%`);
  console.log(`    by size: ${[...aggSize].map(([k, b]) => `${k}: ${(100 * b.agree / Math.max(1, b.n)).toFixed(1)}%`).join('   ')}`);

  // ── Part 2
  console.log(`\n═══ PART 2 — per-minute delta: L2 pipeline vs L3 truth (all usable days) ═══`);
  console.log(`day          r(inferred)   r(CQG flag)   |vol| ratio L2/L3`);
  const rs: number[] = [], rc: number[] = [];
  for (const day of usableDays) {
    try {
      const { rInf, rCqg, volRatio } = await part2Day(con, day, flagIsSell);
      if (!isNaN(rInf)) rs.push(rInf); if (!isNaN(rCqg)) rc.push(rCqg);
      console.log(`${day}      ${rInf.toFixed(3)}         ${rCqg.toFixed(3)}         ${volRatio.toFixed(2)}`);
    } catch (e: any) { console.log(`${day}      ERR ${e.message.slice(0, 60)}`); }
  }
  const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / Math.max(1, x.length);
  const p2 = mean(rs);
  console.log(`--- Part 2: mean r(inferred)=${p2.toFixed(3)} (min ${Math.min(...rs).toFixed(3)}), mean r(CQG flag)=${mean(rc).toFixed(3)}  [n=${rs.length} days]`);

  console.log(`\nVERDICT (frozen bar: agreement ≥90% AND per-minute r ≥0.95):`);
  console.log(p1 >= 90 && p2 >= 0.95
    ? `  PASS — L2 flow features CERTIFIED for the 54-day set (method err ${(100 - p1).toFixed(1)}%, delta r ${p2.toFixed(3)}).`
    : `  FAIL — route flow features to L3-only (agreement ${p1.toFixed(1)}%, r ${p2.toFixed(3)}); L2 stays for price/structure.`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
