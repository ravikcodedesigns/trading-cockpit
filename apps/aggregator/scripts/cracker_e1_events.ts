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
// OUTCOMES (deferred pass, 1-min bars): raw mid markouts at {1,5,15,30}m +
// day drift — E2 signs them by event direction. Clustering handled by the
// frozen day-block bootstrap (events are bursts already collapsed by the
// 30s refractory; day blocks absorb the rest).
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
  mo_1m REAL, mo_5m REAL, mo_15m REAL, mo_30m REAL, drift_pt_min REAL
);
CREATE INDEX IF NOT EXISTS idx_ev_day ON events(store, symbol, trading_day);`;

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
  const evCtx: { sigma: number; dist: number | null }[] = [];
  let lastRv = 0, nEmitted = 0;

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
    evCtx.push({ sigma, dist });
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
      if (ts - lastRv >= 1000) { const m = book.mid(); if (m != null) sv.update(m, ts); lastRv = ts; }
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

  db.prepare(`DELETE FROM events WHERE store=? AND symbol=? AND trading_day=?`).run(STORE, SYM, day);
  const ins = db.prepare(`INSERT INTO events (store,symbol,trading_day,ts,type,dir,intensity,price_int,sigma_ev,dist_level_pts,meta,mo_1m,mo_5m,mo_15m,mo_30m,drift_pt_min)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const tx = db.transaction(() => {
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!, c = evCtx[i]!;
      const m0 = Math.floor(e.ts / 60_000) * 60_000;
      const base = idx.get(m0);
      const mo = (h: number) => { const a = idx.get(m0 + h * 60_000); return base != null && a != null ? a - base : null; };
      ins.run(STORE, SYM, day, e.ts, e.type, e.dir, e.intensity, e.priceInt, c.sigma, c.dist, JSON.stringify(e.meta), mo(1), mo(5), mo(15), mo(30), drift);
      nEmitted++;
    }
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
