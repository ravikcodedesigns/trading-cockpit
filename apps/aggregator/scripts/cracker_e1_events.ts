// CRACKER Phase E1 — the EVENT TRACE: one row per tape event, over both stores.
//
// Replays each day through MarketBook + TapeEventEngine (rebuilt primitives
// #3/#4) and persists every emitted event with intensity, direction, context,
// structure-zone distance, and deferred outcomes → data/cracker-events.db.
//
// E0 CAPABILITY AMENDMENT (recorded before any outcome scan; data availability,
// not results): the L2 store (CQG) carries no order ids / lifecycle events →
//   L2 detectors: absorption, imbalance (full 44/40-day power)
//   L3-only detectors: sweep, replenishment, wall-pull (12–13 days + forward)
// The engine degrades gracefully on L2 (empty journals never trigger; no
// aggressor ids ⇒ no sweep grouping).
//
// STRUCTURE-ZONE FLAG (frozen): dist_level_pts = distance from the event price
// to the nearest registry level of the SAME store/symbol with
// first_seen_ts ≤ event ts (causal); the E2 conditioning flag is
// near = dist ≤ σ_1m at the event (the visit-band definition — consistency
// with the whole program; σ recorded per event). Never used as a filter.
//
// OUTCOMES — TWO RULERS (E2b amendment, pre-registered 2026-07-08 before any
// sub-minute outcome was computed):
//   minute-scale: raw mid markouts {1,5,15,30}m from 1-min bars + day drift
//     (the original frozen Phase-E grading).
//   MS-SCALE: mid-price markouts {250ms, 1s, 5s, 10s, 30s} resolved from the
//     full mid-price series recorded during the replay (mid = the honest
//     sub-minute price; trade prints are sparse/bouncy at these horizons).
//     Declared primary horizons 1s & 10s; no drift adjustment (negligible
//     sub-minute; documented). spread_ticks + top-of-book queue imbalance
//     qi = (bidSz−askSz)/(bidSz+askSz) recorded at emission — costs and the
//     book state are part of the row, not an afterthought.
// QI REPLICATION (registered, one-sided POSITIVE per Cont–Stoikov order-book
// imbalance/microprice literature): qi sampled every second all session →
// qi_samples table with forward mid moves at 1s/10s.
// Clustering handled by the frozen day-block bootstrap throughout.
//
// Run: [STORE=l3|l2] [TRACE_SYM=NQ|ES] [TRACE_DAYS=…] pnpm --filter @trading/aggregator exec tsx scripts/cracker_e1_events.ts
import { DuckDBInstance } from '@duckdb/node-api';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { MarketBook } from '../src/l3/market-book.js';
import { TapeEventEngine, TE_CFG, type TapeEvent } from '../src/l3/tape-events.js';
import { SigmaEv } from '../src/l3/sigma-ev.js';

const ROOT = '/Users/ravikumarbasker/trading-cockpit/data';
const STORE = (process.env.STORE ?? 'l3') as 'l3' | 'l2';
const SYM = process.env.TRACE_SYM ?? 'NQ';
const TICK = 0.25;
const DB = process.env.EVENTS_DB ?? `${ROOT}/cracker-events.db`;
const TRACE_DB = STORE === 'l3' ? `${ROOT}/cracker-trace.db` : `${ROOT}/cracker-trace-l2.db`;
const TE = { ...TE_CFG, NEAR_TICKS: SYM === 'ES' ? 4 : 16 };
const SG = SYM === 'ES' ? { CAP_PT: 15 } : {};
const SANE = SYM === 'ES' ? 'price BETWEEN 4000 AND 9000' : 'price BETWEEN 20000 AND 40000';
const et = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-04:00`);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  store TEXT, symbol TEXT, trading_day TEXT, ts INTEGER, type TEXT, dir INTEGER,
  intensity REAL, price_int INTEGER, sigma_ev REAL, dist_level_pts REAL, meta TEXT,
  mo_1m REAL, mo_5m REAL, mo_15m REAL, mo_30m REAL, drift_pt_min REAL,
  spread_ticks INTEGER, qi REAL,
  ms_250 REAL, ms_1s REAL, ms_5s REAL, ms_10s REAL, ms_30s REAL
);
CREATE INDEX IF NOT EXISTS idx_ev_day ON events(store, symbol, trading_day);
CREATE TABLE IF NOT EXISTS qi_samples (
  store TEXT, symbol TEXT, trading_day TEXT, ts INTEGER, qi REAL, spread_ticks INTEGER,
  dmid_1s REAL, dmid_10s REAL
);
CREATE INDEX IF NOT EXISTS idx_qi_day ON qi_samples(store, symbol, trading_day);`;

function availableDays(): string[] {
  const dir = STORE === 'l3' ? `${ROOT}/mbo-parquet/trades/symbol=${SYM}` : `${ROOT}/ticks-parquet/trades/symbol=${SYM}`;
  let days = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.startsWith('date=')).map((x) => x.slice(5)).sort() : [];
  if (STORE === 'l3') days = days.filter((d) => d !== '2026-06-29');
  const todayEt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  days = days.filter((d) => d < todayEt);
  const sel = process.env.TRACE_DAYS;
  if (sel) days = /^\d+$/.test(sel) ? days.slice(0, Number(sel)) : days.filter((d) => sel.split(',').includes(d));
  return days;
}

async function runDay(con: any, db: Database.Database, day: string): Promise<number> {
  const [warm, lo, hi] = [et(day, '09:00'), et(day, '09:30'), et(day, '16:00')];
  // causal level set for the structure flag (same store's registry)
  const lvls = fs.existsSync(TRACE_DB)
    ? (new Database(TRACE_DB, { readonly: true }).prepare(`SELECT price, first_seen_ts fs FROM levels WHERE symbol = ? AND source IN ('swing','hvn','lvn','round') AND first_seen_ts <= ?`).all(SYM, hi) as any[])
    : [];
  const book = new MarketBook(SYM, TICK);
  const eng = new TapeEventEngine(TE);
  const sv = new SigmaEv(SG);
  const events: TapeEvent[] = [];
  const evCtx: { sigma: number; dist: number | null; spread: number | null; qi: number | null }[] = [];
  let lastRv = 0, nEmitted = 0;
  // ms-precision mid series (append on change) + 1s QI samples
  const midTs: number[] = [], midPx: number[] = [];
  let lastMid = NaN, lastQiTs = 0;
  const qiRows: { ts: number; qi: number; spread: number }[] = [];
  const topState = (): { mid: number; spread: number; qi: number } | null => {
    const bb = book.bestBid(), ba = book.bestAsk();
    if (bb == null || ba == null || ba <= bb) return null;
    const bs = book.depthNear(bb, 0, 'bid').size, as = book.depthNear(ba, 0, 'ask').size;
    return { mid: (bb + ba) / 2 * TICK, spread: ba - bb, qi: bs + as > 0 ? (bs - as) / (bs + as) : 0 };
  };

  let SQL: string;
  if (STORE === 'l3') {
    const dom = `(SELECT contract FROM read_parquet('${ROOT}/mbo-parquet/trades/symbol=${SYM}/date=${day}/*.parquet') WHERE ts_ms >= ${lo} AND ts_ms < ${hi} GROUP BY contract ORDER BY SUM(size) DESC LIMIT 1)`;
    const g = (t: string) => `read_parquet('${ROOT}/mbo-parquet/${t}/symbol=${SYM}/date=${day}/*.parquet', filename=true, file_row_number=true)`;
    SQL = `
      SELECT ts_ms,'D' s, price_int, size, is_bid, CAST(NULL AS VARCHAR) a, CAST(NULL AS VARCHAR) o, CAST(NULL AS VARCHAR) p, CAST(NULL AS BOOLEAN) x1, CAST(NULL AS BOOLEAN) x2, filename fn, file_row_number frn
        FROM ${g('depth')} WHERE contract = ${dom} AND ts_ms BETWEEN ${warm} AND ${hi}
      UNION ALL SELECT ts_ms,'M', price_int, size, is_bid, action, order_id, CAST(NULL AS VARCHAR), CAST(NULL AS BOOLEAN), CAST(NULL AS BOOLEAN), filename, file_row_number
        FROM ${g('mbo')} WHERE contract = ${dom} AND ts_ms BETWEEN ${warm} AND ${hi}
      UNION ALL SELECT ts_ms,'T', price_int, size, is_bid_aggressor, CAST(NULL AS VARCHAR), aggressor_order_id, passive_order_id, is_execution_start, is_execution_end, filename, file_row_number
        FROM ${g('trades')} WHERE contract = ${dom} AND size > 0 AND NOT is_otc AND ts_ms BETWEEN ${warm} AND ${hi}
      ORDER BY ts_ms, s, fn, frn`;
  } else {
    const g = (t: string) => `read_parquet('${ROOT}/ticks-parquet/${t}/symbol=${SYM}/date=${day}/*.parquet', filename=true, file_row_number=true)`;
    SQL = `
      SELECT ts,'D' s, CAST(ROUND(price/0.25) AS INTEGER), size, (side = 0), CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR), CAST(NULL AS BOOLEAN), CAST(NULL AS BOOLEAN), filename fn, file_row_number frn
        FROM ${g('depth')} WHERE ${SANE} AND ts BETWEEN ${warm} AND ${hi}
      UNION ALL SELECT ts,'T', CAST(ROUND(price/0.25) AS INTEGER), size, is_bid_aggressor, CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR), CAST(NULL AS BOOLEAN), CAST(NULL AS BOOLEAN), filename, file_row_number
        FROM ${g('trades')} WHERE size > 0 AND ${SANE} AND ts BETWEEN ${warm} AND ${hi}
      ORDER BY ts, s, fn, frn`;
  }

  const flag = (e: TapeEvent) => {
    const sigma = sv.sigma1m();
    let dist: number | null = null;
    const px = e.priceInt * TICK;
    for (const l of lvls) {
      if (l.fs > e.ts) continue;
      const d = Math.abs(l.price - px);
      if (dist == null || d < dist) dist = d;
    }
    const t = topState();
    evCtx.push({ sigma, dist, spread: t ? t.spread : null, qi: t ? t.qi : null });
  };

  const stream = await con.stream(SQL);
  let chunk;
  while ((chunk = await stream.fetchChunk()) && chunk.rowCount > 0) {
    for (const row of chunk.getRows() as any[]) {
      const ts = Number(row[0]), pi = Number(row[2]), sz = Number(row[3]);
      const typ = row[1] as string;
      const before = events.length;
      if (typ === 'D') book.applyDepth({ ts, priceInt: pi, size: sz, isBid: !!row[4] });
      else if (typ === 'M') {
        const action = row[5] as string, oid = row[6] as string;
        if (action === 'send') book.applySend({ ts, orderId: oid, priceInt: pi, size: sz, isBid: !!row[4] });
        else if (action === 'replace') book.applyReplace({ ts, orderId: oid, priceInt: pi, size: sz });
        else if (action === 'cancel') book.applyCancel({ ts, orderId: oid });
      } else {
        book.applyTrade({ ts, priceInt: pi, size: sz, isBuy: !!row[4], aggId: row[6], passId: row[7], execStart: !!row[8], execEnd: !!row[9] });
        if (ts >= lo) eng.onTrade({ ts, priceInt: pi, size: sz, buy: !!row[4], aggId: STORE === 'l3' ? row[6] : null, execStart: !!row[8], execEnd: !!row[9] }, events);
      }
      // ms mid series (append on change; O(1) best reads)
      if (typ === 'D') {
        const t = topState();
        if (t && t.mid !== lastMid) { lastMid = t.mid; midTs.push(ts); midPx.push(t.mid); }
      }
      if (ts - lastRv >= 1000) { const m = book.mid(); if (m != null) sv.update(m, ts); lastRv = ts; }
      if (ts >= lo && ts - lastQiTs >= 1000) {
        const t = topState();
        if (t && t.spread <= TE.NEAR_TICKS) { qiRows.push({ ts, qi: t.qi, spread: t.spread }); lastQiTs = ts; }
      }
      if (ts >= lo) eng.tick(book, ts, events);
      for (let i = before; i < events.length; i++) flag(events[i]!);
    }
  }

  // deferred outcomes from 1-min bars
  const src = STORE === 'l3'
    ? `read_parquet('${ROOT}/mbo-parquet/trades/symbol=${SYM}/date=${day}/*.parquet') WHERE contract = (SELECT contract FROM read_parquet('${ROOT}/mbo-parquet/trades/symbol=${SYM}/date=${day}/*.parquet') WHERE ts_ms >= ${lo} AND ts_ms < ${hi} GROUP BY contract ORDER BY SUM(size) DESC LIMIT 1) AND size > 0 AND NOT is_otc AND ts_ms >= ${lo} AND ts_ms < ${hi + 35 * 60_000}`
    : `read_parquet('${ROOT}/ticks-parquet/trades/symbol=${SYM}/date=${day}/*.parquet') WHERE size > 0 AND ${SANE} AND ts >= ${lo} AND ts < ${hi + 35 * 60_000}`;
  const tsCol = STORE === 'l3' ? 'ts_ms' : 'ts';
  const bars = (await con.streamAndReadAll(`SELECT CAST(FLOOR(${tsCol}/60000) AS BIGINT)*60000 t, FIRST(price ORDER BY ${tsCol}) o, LAST(price ORDER BY ${tsCol}) c FROM ${src} GROUP BY 1 ORDER BY 1`)).getRows()
    .map((r: any) => ({ t: Number(r[0]), o: Number(r[1]), c: Number(r[2]) }));
  const idx = new Map(bars.map((b) => [b.t, b.c]));
  const first = bars[0], last = bars[bars.length - 1];
  const drift = first && last && last.t > first.t ? (last.c - first.o) / ((last.t - first.t) / 60_000) : 0;

  // ms-precision mid lookup: last known mid at or before t (binary search)
  const midAt = (t: number): number | null => {
    let loI = 0, hiI = midTs.length;
    while (loI < hiI) { const m = (loI + hiI) >> 1; if (midTs[m]! <= t) loI = m + 1; else hiI = m; }
    return loI > 0 ? midPx[loI - 1]! : null;
  };
  const msMo = (t0: number, hMs: number): number | null => {
    const a = midAt(t0), b = midAt(t0 + hMs);
    return a != null && b != null ? b - a : null;
  };
  db.prepare(`DELETE FROM events WHERE store=? AND symbol=? AND trading_day=?`).run(STORE, SYM, day);
  db.prepare(`DELETE FROM qi_samples WHERE store=? AND symbol=? AND trading_day=?`).run(STORE, SYM, day);
  const ins = db.prepare(`INSERT INTO events (store,symbol,trading_day,ts,type,dir,intensity,price_int,sigma_ev,dist_level_pts,meta,mo_1m,mo_5m,mo_15m,mo_30m,drift_pt_min,spread_ticks,qi,ms_250,ms_1s,ms_5s,ms_10s,ms_30s)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insQi = db.prepare(`INSERT INTO qi_samples (store,symbol,trading_day,ts,qi,spread_ticks,dmid_1s,dmid_10s) VALUES (?,?,?,?,?,?,?,?)`);
  const tx = db.transaction(() => {
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!, c = evCtx[i]!;
      const m0 = Math.floor(e.ts / 60_000) * 60_000;
      const base = idx.get(m0);
      const mo = (h: number) => { const a = idx.get(m0 + h * 60_000); return base != null && a != null ? a - base : null; };
      ins.run(STORE, SYM, day, e.ts, e.type, e.dir, e.intensity, e.priceInt, c.sigma, c.dist, JSON.stringify(e.meta),
        mo(1), mo(5), mo(15), mo(30), drift, c.spread, c.qi,
        msMo(e.ts, 250), msMo(e.ts, 1_000), msMo(e.ts, 5_000), msMo(e.ts, 10_000), msMo(e.ts, 30_000));
      nEmitted++;
    }
    for (const r of qiRows) insQi.run(STORE, SYM, day, r.ts, r.qi, r.spread, msMo(r.ts, 1_000), msMo(r.ts, 10_000));
  });
  tx();
  return nEmitted;
}

async function main() {
  const days = availableDays();
  const db = new Database(DB);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  process.stderr.write(`E1 scan: ${STORE}-${SYM}, ${days.length} days\n`);
  const inst = await DuckDBInstance.create();
  const con = await inst.connect();
  for (const day of days) {
    try { const n = await runDay(con, db, day); process.stderr.write(`  ${day} → ${n} events\n`); }
    catch (e: any) { process.stderr.write(`  ${day} ERR ${String(e.message).slice(0, 90)}\n`); }
  }
  const q = db.prepare(`SELECT type, COUNT(*) n, ROUND(AVG(dist_level_pts),1) d FROM events WHERE store=? AND symbol=? GROUP BY type ORDER BY n DESC`).all(STORE, SYM) as any[];
  console.log(`=== E1 ${STORE}-${SYM} ===`);
  for (const r of q) console.log(`  ${String(r.type).padEnd(14)} ${String(r.n).padStart(6)}  avg dist-to-level ${r.d}pt`);
  db.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
