// Persistent Quant Data store — pull once, own it forever.
//
// Endpoint-agnostic design (see HANDOFF §26): a UNIVERSAL raw cache (`api_responses`)
// that works for all 23 endpoints, plus materialized "shape-family" tables built FROM
// the cache. Everything routes through `qdCached` → we never pull the same
// (endpoint, body) twice, and cached data keeps working offline / past rate limits.
//
// Built now: api_responses (raw cache, gzipped) + chain_snapshots (per-strike/expiry
// grids, opaque cells_json) + price_bars (underlying OHLC) + coverage + regime_vector.
// Other shape families (series_points, option_tape, oi_change, ticker_stats) slot in
// later — one table each, materialized from the same raw cache, zero re-pull.
//
// DB: data/quantdata.db (gitignored). Window we persist: Jan-1-2025 → today.

import 'dotenv/config';
import Database from 'better-sqlite3';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { qdPost, parseExposureResponse, type ExposureSnapshot } from './quantdata.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../..');
const DB_PATH = path.join(ROOT, 'data', 'quantdata.db');

let _db: Database.Database | null = null;
export function store(): Database.Database {
  if (_db) return _db;
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  _db = db;
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_responses (
  id           INTEGER PRIMARY KEY,
  endpoint     TEXT NOT NULL,
  body_hash    TEXT NOT NULL,
  body_json    TEXT NOT NULL,
  ticker       TEXT, greek TEXT, session_date TEXT, as_of_iso TEXT, cursor TEXT,
  response     BLOB NOT NULL,        -- gzipped JSON
  encoding     TEXT NOT NULL DEFAULT 'gzip+json',
  n_bytes      INTEGER,
  pulled_at    INTEGER NOT NULL,
  UNIQUE(endpoint, body_hash)
);
CREATE INDEX IF NOT EXISTS idx_api_lookup ON api_responses(endpoint, ticker, session_date);

CREATE TABLE IF NOT EXISTS chain_snapshots (
  id            INTEGER PRIMARY KEY,
  ticker        TEXT NOT NULL,
  metric        TEXT NOT NULL,       -- 'GAMMA_EXPOSURE' | 'OI' | 'MAX_PAIN' | 'IV' …
  axes          TEXT NOT NULL,       -- 'strike' | 'expiration' | 'expiration×strike×type'
  representation TEXT,
  snapshot_iso  TEXT NOT NULL, session_date TEXT NOT NULL, epoch_ms INTEGER NOT NULL,
  spot          REAL,
  net_value     REAL,
  n_cells       INTEGER,
  cells_json    TEXT NOT NULL,       -- opaque projected rows (cell shape varies by metric)
  api_id        INTEGER REFERENCES api_responses(id),
  UNIQUE(ticker, metric, axes, representation, snapshot_iso)
);
CREATE INDEX IF NOT EXISTS idx_chain ON chain_snapshots(ticker, metric, session_date, epoch_ms);

CREATE TABLE IF NOT EXISTS price_bars (
  ticker TEXT NOT NULL, epoch_ms INTEGER NOT NULL,
  o REAL, h REAL, l REAL, c REAL,
  UNIQUE(ticker, epoch_ms)
);

CREATE TABLE IF NOT EXISTS coverage (
  endpoint TEXT, ticker TEXT, session_date TEXT, cadence_sec INTEGER,
  n_rows INTEGER, status TEXT, updated_at INTEGER,
  PRIMARY KEY(endpoint, ticker, session_date, cadence_sec)
);

CREATE TABLE IF NOT EXISTS regime_vector (
  chain_id INTEGER PRIMARY KEY REFERENCES chain_snapshots(id),
  calc_version TEXT NOT NULL,
  call_wall REAL, put_wall REAL, gamma_flip REAL, dist_to_flip REAL,
  regime_sign INTEGER, local_gex REAL, computed_at INTEGER
);
`;

// ── universal raw cache ──────────────────────────────────────────────────────
function canonical(body: Record<string, unknown>): string {
  // stable stringify: sort keys so equal requests hash equal
  const sort = (v: any): any =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]))
      : Array.isArray(v) ? v.map(sort) : v;
  return JSON.stringify(sort(body));
}

/** Read-through cache for ANY endpoint. Returns parsed JSON. Pulls + persists on miss. */
export async function qdCached(
  endpoint: string,
  body: Record<string, unknown>,
  tags: { ticker?: string; greek?: string; session_date?: string; as_of_iso?: string; cursor?: string } = {},
): Promise<{ json: unknown; apiId: number; hit: boolean }> {
  const db = store();
  const bodyJson = canonical(body);
  const hash = createHash('sha256').update(endpoint + '\n' + bodyJson).digest('hex');
  const row = db.prepare('SELECT id, response FROM api_responses WHERE endpoint=? AND body_hash=?').get(endpoint, hash) as any;
  if (row) {
    return { json: JSON.parse(gunzipSync(row.response as Buffer).toString('utf8')), apiId: row.id, hit: true };
  }
  const json = await qdPost<unknown>(endpoint, body);
  const text = JSON.stringify(json);
  const gz = gzipSync(text);
  const info = db.prepare(
    `INSERT OR IGNORE INTO api_responses (endpoint,body_hash,body_json,ticker,greek,session_date,as_of_iso,cursor,response,encoding,n_bytes,pulled_at)
     VALUES (?,?,?,?,?,?,?,?,?,'gzip+json',?,?)`,
  ).run(endpoint, hash, bodyJson, tags.ticker ?? null, tags.greek ?? null, tags.session_date ?? null,
    tags.as_of_iso ?? null, tags.cursor ?? null, gz, text.length, isoNow());
  // re-read the id (INSERT OR IGNORE may have raced/ignored)
  const id = info.lastInsertRowid
    ? Number(info.lastInsertRowid)
    : (db.prepare('SELECT id FROM api_responses WHERE endpoint=? AND body_hash=?').get(endpoint, hash) as any).id;
  return { json, apiId: id, hit: false };
}

// timestamps are passed in (Date.now avoided in workflow contexts; here it's fine in a script)
function isoNow(): number { return Date.now(); }

// ── materialized: gamma snapshot (chain grid) ────────────────────────────────
const EXPOSURE_PATH = '/options/tool/exposure-by-strike';

/** Per-strike GAMMA snapshot at an instant, via the read-through cache.
 *  Persists both the raw payload (api_responses) and the materialized grid
 *  (chain_snapshots). Returns the parsed ExposureSnapshot. */
export async function getGammaSnapshot(
  ticker: string, snapshotISO: string,
  representation = 'PER_ONE_PERCENT_MOVE',
): Promise<ExposureSnapshot> {
  const body = { greekMode: 'GAMMA', representationMode: representation, filter: { ticker }, snapshotTime: snapshotISO };
  const { json, apiId } = await qdCached(EXPOSURE_PATH, body, {
    ticker, greek: 'GAMMA', as_of_iso: snapshotISO, session_date: snapshotISO.slice(0, 10),
  });
  const snap = parseExposureResponse(json, ticker);
  const netValue = snap.strikes.reduce((a, s) => a + s.call + s.put, 0);
  store().prepare(
    `INSERT OR IGNORE INTO chain_snapshots
       (ticker,metric,axes,representation,snapshot_iso,session_date,epoch_ms,spot,net_value,n_cells,cells_json,api_id)
     VALUES (?, 'GAMMA_EXPOSURE','strike',?,?,?,?,?,?,?,?,?)`,
  ).run(ticker, representation, snapshotISO, snapshotISO.slice(0, 10), Date.parse(snapshotISO),
    snap.stockPrice, netValue, snap.strikes.length, JSON.stringify(snap.strikes), apiId);
  return snap;
}

// ── materialized: underlying price bars ──────────────────────────────────────
const PRICE_PATH = '/equities/tool/stock-price-over-time';

interface PriceBar { epoch_ms: number; o: number; h: number; l: number; c: number }

/** Underlying 1-min OHLC for a session, via the read-through cache. Persists to price_bars. */
export async function getPriceBars(
  ticker: string, sessionDate: string, aggregationPeriod = 'ONE_MINUTE',
): Promise<PriceBar[]> {
  const body = { filter: { ticker }, sessionDate, aggregationPeriod };
  const { json } = await qdCached(PRICE_PATH, body, { ticker, session_date: sessionDate });
  const bars = parsePriceBars(json);
  const ins = store().prepare('INSERT OR IGNORE INTO price_bars (ticker,epoch_ms,o,h,l,c) VALUES (?,?,?,?,?,?)');
  const tx = store().transaction((rows: PriceBar[]) => rows.forEach((b) => ins.run(ticker, b.epoch_ms, b.o, b.h, b.l, b.c)));
  tx(bars);
  return bars;
}

// ── materialized: net drift (aggressor call/put premium over time + spot) ─────
const NET_DRIFT_PATH = '/options/tool/net-drift';

export interface DriftBucket { epoch_ms: number; netCall: number; netPut: number; stock: number }

/** Per-bucket net (ask-aggressor minus bid-aggressor) call/put premium + underlying
 *  spot, via the cache. The series carries aligned flow + price → clean lead-lag tests. */
export async function getNetDrift(
  ticker: string, sessionDate: string, aggregationPeriod = 'FIVE_MINUTE',
): Promise<DriftBucket[]> {
  const body = { filter: { ticker }, sessionDate, aggregationPeriod };
  const { json } = await qdCached(NET_DRIFT_PATH, body, { ticker, session_date: sessionDate });
  const env = json as any;
  const data = env?.data ?? env;
  const out: DriftBucket[] = [];
  const push = (ts: any, r: any) => {
    const e = Number(ts);
    if (Number.isFinite(e)) out.push({
      epoch_ms: e,
      netCall: +(r.netCallPremium ?? r.netCall ?? 0),
      netPut: +(r.netPutPremium ?? r.netPut ?? 0),
      stock: +(r.stockPrice ?? r.stock ?? NaN),
    });
  };
  if (Array.isArray(data)) for (const r of data) push(r.timestamp ?? r.time, r);
  else if (data && typeof data === 'object') for (const [ts, r] of Object.entries<any>(data)) push(ts, r);
  return out.sort((a, b) => a.epoch_ms - b.epoch_ms);
}

// ── materialized: volatility drift (per-min IV vs realized ARV + spot) ───────
const VOL_DRIFT_PATH = '/options/tool/volatility-drift';

export interface VolBucket { epoch_ms: number; iv: number; arv: number; stock: number }

/** Per-minute IV (ATM avg) vs Adjusted Realized Vol + spot, via the cache.
 *  IV≫ARV ⇒ market pricing more vol than realized so far (expansion expected). */
export async function getVolDrift(ticker: string, sessionDate: string): Promise<VolBucket[]> {
  const body = { filter: { ticker }, sessionDate };
  const { json } = await qdCached(VOL_DRIFT_PATH, body, { ticker, session_date: sessionDate });
  const env = json as any;
  const data = env?.data ?? env;
  const out: VolBucket[] = [];
  const push = (ts: any, r: any) => {
    const e = Number(ts);
    if (Number.isFinite(e)) out.push({ epoch_ms: e, iv: +(r.iv ?? NaN), arv: +(r.arv ?? NaN), stock: +(r.stockPrice ?? r.stock ?? NaN) });
  };
  if (Array.isArray(data)) for (const r of data) push(r.timestamp ?? r.time, r);
  else if (data && typeof data === 'object') for (const [ts, r] of Object.entries<any>(data)) push(ts, r);
  return out.sort((a, b) => a.epoch_ms - b.epoch_ms);
}

// ── materialized: dark-pool notional flow (QQQ/SPY → NQ/ES institutional footprint) ──
export interface DarkBucket { epoch_ms: number; notional: number; size: number; stock: number; trades: number }
export async function getDarkFlow(ticker: string, sessionDate: string, aggregationPeriod = 'THIRTY_MINUTE'): Promise<DarkBucket[]> {
  const { json } = await qdCached('/equities/tool/dark-flow', { filter: { ticker }, sessionDate, aggregationPeriod }, { ticker, session_date: sessionDate });
  const data = (json as any)?.data ?? json;
  const out: DarkBucket[] = [];
  const push = (ts: any, r: any) => { const e = Number(ts); if (Number.isFinite(e)) out.push({ epoch_ms: e, notional: +(r.notionalValue ?? 0), size: +(r.size ?? 0), stock: +(r.stockPrice ?? NaN), trades: +(r.tradeCount ?? 0) }); };
  if (Array.isArray(data)) for (const r of data) push(r.timestamp ?? r.time, r);
  else if (data && typeof data === 'object') for (const [ts, r] of Object.entries<any>(data)) push(ts, r);
  return out.sort((a, b) => a.epoch_ms - b.epoch_ms);
}

// ── materialized: volatility skew (per expiry×strike×type IV) → ATM put-call skew ──
export interface SkewCell { date: string; strike: number; type: 'CALL' | 'PUT'; iv: number }
export async function getVolSkew(ticker: string, sessionDate: string): Promise<{ spot: number; cells: SkewCell[] }> {
  const { json } = await qdCached('/options/tool/volatility-skew', { filter: { ticker }, sessionDate }, { ticker, session_date: sessionDate });
  const env = json as any;
  const spot = +(env?.stockPrice ?? NaN);
  const data = env?.data ?? {};
  const cells: SkewCell[] = [];
  for (const [date, byStrike] of Object.entries<any>(data))
    for (const [k, byType] of Object.entries<any>(byStrike))
      for (const [type, iv] of Object.entries<any>(byType)) cells.push({ date, strike: +k, type: type as any, iv: +iv });
  return { spot, cells };
}

// ── materialized: overnight OI change → net call-vs-put positioning build ──
export interface OIChange { contractType: 'CALL' | 'PUT'; strike: number; expiration: string; change: number }
export async function getOIChange(ticker: string, sessionDate: string): Promise<OIChange[]> {
  const { json } = await qdCached('/options/tool/open-interest-change',
    { filter: { ticker }, sessionDate, size: 100, sortField: 'CHANGE_IN_OPEN_INTEREST', sortDirection: 'DESCENDING' },
    { ticker, session_date: sessionDate });
  const data = (json as any)?.data ?? [];
  return (Array.isArray(data) ? data : []).map((r: any) => ({
    contractType: r.contractType, strike: +r.strikePrice, expiration: r.expirationDate, change: +r.changeInOpenInterest,
  }));
}

// ── materialized: single-contract option OHLC (for the premium backtest) ──
export interface OptBar { epoch_ms: number; o: number; h: number; l: number; c: number; v: number }
export async function getOptionBars(
  ticker: string, sessionDate: string, strike: number, type: 'CALL' | 'PUT', expiration: string, aggregationPeriod = 'FIVE_MINUTE',
): Promise<OptBar[]> {
  const body = { filter: { ticker, expirationDate: expiration, strikePrice: strike, contractType: type }, sessionDate, aggregationPeriod };
  const { json } = await qdCached('/options/tool/option-price-over-time', body, { ticker, session_date: sessionDate });
  const data = (json as any)?.data ?? json;
  const out: OptBar[] = [];
  const push = (ts: any, r: any) => { const e = Number(ts); if (Number.isFinite(e)) out.push({ epoch_ms: e, o: +(r.openPrice ?? r.open), h: +(r.highPrice ?? r.high), l: +(r.lowPrice ?? r.low), c: +(r.closePrice ?? r.close), v: +(r.volume ?? 0) }); };
  if (Array.isArray(data)) for (const r of data) push(r.timestamp ?? r.time, r);
  else if (data && typeof data === 'object') for (const [ts, r] of Object.entries<any>(data)) push(ts, r);
  return out.sort((a, b) => a.epoch_ms - b.epoch_ms);
}

/** Defensive parser — raw /v1 shape not yet confirmed; handles array or ts-keyed object. */
export function parsePriceBars(raw: unknown): PriceBar[] {
  const env = raw as any;
  const data = env?.data ?? env;
  const out: PriceBar[] = [];
  const push = (ts: any, o: any, h: any, l: any, c: any) => {
    const e = Number(ts);
    if (Number.isFinite(e)) out.push({ epoch_ms: e, o: +o, h: +h, l: +l, c: +c });
  };
  if (Array.isArray(data)) {
    for (const r of data) push(r.timestamp ?? r.epochMs ?? r.time, r.openPrice ?? r.open ?? r.o, r.highPrice ?? r.high ?? r.h, r.lowPrice ?? r.low ?? r.l, r.closePrice ?? r.close ?? r.c);
  } else if (data && typeof data === 'object') {
    for (const [ts, r] of Object.entries<any>(data)) push(ts, r.openPrice ?? r.open ?? r.o, r.highPrice ?? r.high ?? r.h, r.lowPrice ?? r.low ?? r.l, r.closePrice ?? r.close ?? r.c);
  }
  return out.sort((a, b) => a.epoch_ms - b.epoch_ms);
}
