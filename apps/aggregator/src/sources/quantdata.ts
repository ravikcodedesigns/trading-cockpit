// Thin Quant Data (quantdata.us) REST client.
//
// Purpose: reproducible, scriptable pulls of options-regime data (per-strike GEX
// and the intraday Interval Map) so we can compute our own regime vector
// (net GEX / gamma-flip / call+put walls / distance-to-flip) and validate it
// against RS levels + actual price. See HANDOFF §25.4 and memory
// `project_quant_data_phase0` for the locked grading vector.
//
// NOT a poller — this is the request layer used by backtest/backfill scripts.
// The live poller (Phase 5, mirroring the RS-feed pattern) comes later, only
// after an edge is shown.
//
// Auth: Bearer from process.env.QUANTDATA_API_KEY (in apps/aggregator/.env,
// gitignored). Base: process.env.QUANTDATA_BASE_URL (default v1).
// Every endpoint is POST + JSON body. Quota: 240 req/min (no other cap).
//
// Response shape (raw /v1, NOT the MCP CSV shaping):
//   exposure-by-strike → { data: { <TICKER>: { stockPrice, exposureMap:
//                          { <expiry>: { <strike>: { callExposure, putExposure } } } } } }
// We sum every expiration at each strike ourselves.

import 'dotenv/config';

const BASE_URL = process.env.QUANTDATA_BASE_URL ?? 'https://api.quantdata.us/v1';
const API_KEY = process.env.QUANTDATA_API_KEY ?? '';

export type GreekMode = 'GAMMA' | 'DELTA' | 'VANNA' | 'CHARM';
export type RepresentationMode = 'PER_ONE_DOLLAR_MOVE' | 'PER_ONE_PERCENT_MOVE' | 'RAW';
export type AggregationPeriod =
  | 'ONE_MINUTE' | 'FIVE_MINUTE' | 'FIFTEEN_MINUTE' | 'THIRTY_MINUTE'
  | 'ONE_HOUR' | 'ONE_DAY' | 'ONE_WEEK';

// ── rate limiter: CONCURRENCY-SAFE serialized gate (keeps < 240 req/min even
//    when callers fire many requests via Promise.all). A single shared counter
//    is NOT safe — parallel awaits read the same timestamp and burst together,
//    tripping 429s. Serialize every throttle() through a promise chain so calls
//    are spaced MIN_SPACING apart no matter how many are launched at once.
let lastCallMs = 0;
let gate: Promise<void> = Promise.resolve();
const MIN_SPACING_MS = 300; // ≈200 req/min — safety margin under the 240 cap
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function throttle(): Promise<void> {
  const next = gate.then(async () => {
    const wait = Math.max(0, lastCallMs + MIN_SPACING_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastCallMs = Date.now();
  });
  gate = next.catch(() => {}); // a failure must not break the chain
  return next;
}

export function quantdataConfigured(): boolean {
  return API_KEY.startsWith('qd_');
}

export async function qdPost<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
  if (!quantdataConfigured()) {
    throw new Error('QUANTDATA_API_KEY missing/invalid (expected qd_… in apps/aggregator/.env)');
  }
  for (let attempt = 0; ; attempt++) {
    await throttle();
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    // 429 (rate limit) / 503 → back off and retry so throttling never silently
    // drops a data point (which would bias samples). Up to 5 tries.
    if ((res.status === 429 || res.status === 503) && attempt < 5) {
      const retryAfter = Number(res.headers.get('retry-after')) * 1000 || (500 * 2 ** attempt);
      await sleep(retryAfter);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`quantdata ${path} → ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    }
    return res.json() as Promise<T>;
  }
}

// ── Exposure By Strike ──────────────────────────────────────────────────────
export interface StrikeExposure {
  strike: number;
  call: number; // summed across expirations
  put: number;  // summed across expirations (typically ≤ 0 in dealer-signed convention)
}
export interface ExposureSnapshot {
  ticker: string;
  stockPrice: number;
  strikes: StrikeExposure[]; // ascending by strike
}

interface ExposureCell { callExposure?: number; putExposure?: number }
interface TickerData { stockPrice?: number; exposureMap?: Record<string, Record<string, ExposureCell>> }

/** Snapshot of per-strike gamma (or other greek) exposure, summed across all expirations. */
export async function exposureByStrike(opts: {
  ticker: string;
  greekMode: GreekMode;
  representationMode: RepresentationMode;
  sessionDate?: string;   // YYYY-MM-DD (NY) — latest snapshot of that session
  snapshotTime?: string;  // ISO-8601 instant — latest known trade per cell as of then
}): Promise<ExposureSnapshot> {
  const { ticker, greekMode, representationMode, sessionDate, snapshotTime } = opts;
  const body: Record<string, unknown> = { greekMode, representationMode, filter: { ticker } };
  if (sessionDate) body.sessionDate = sessionDate;
  if (snapshotTime) body.snapshotTime = snapshotTime;

  const raw = await qdPost<unknown>('/options/tool/exposure-by-strike', body);
  return parseExposureResponse(raw, ticker);
}

/** Parse a raw exposure-by-strike /v1 JSON response into an ExposureSnapshot
 *  (per-strike call/put summed across expirations). Exported so the persistent
 *  store can reuse it on cached raw payloads without re-fetching. */
export function parseExposureResponse(raw: unknown, ticker: string): ExposureSnapshot {
  const env = raw as ({ data?: Record<string, TickerData> } & Record<string, TickerData>);
  const byTicker = (env.data ?? env) as Record<string, TickerData>;
  const td = byTicker[ticker] ?? Object.values(byTicker)[0];
  if (!td || !td.exposureMap) {
    throw new Error(`quantdata exposure-by-strike: no exposureMap for ${ticker}`);
  }
  const acc = new Map<number, { call: number; put: number }>();
  for (const byStrike of Object.values(td.exposureMap)) {
    for (const [strikeStr, cell] of Object.entries(byStrike)) {
      const strike = Number(strikeStr);
      const cur = acc.get(strike) ?? { call: 0, put: 0 };
      cur.call += cell.callExposure ?? 0;
      cur.put += cell.putExposure ?? 0;
      acc.set(strike, cur);
    }
  }
  const strikes = [...acc.entries()]
    .map(([strike, v]) => ({ strike, call: v.call, put: v.put }))
    .sort((a, b) => a.strike - b.strike);
  return { ticker, stockPrice: td.stockPrice ?? NaN, strikes };
}

// ── Interval Map (intraday time-series of per-strike exposure) ──────────────
// NOTE (Phase 1 finding): the MCP-shaped Interval Map appears INCREMENTAL
// (per-minute trades), not a running cumulative snapshot — verify before using
// it to reconstruct per-minute net GEX for the backfill.
export interface IntervalBucket {
  ts: number; // epoch ms
  strikes: StrikeExposure[];
}
export async function intervalMap(opts: {
  ticker: string;
  greekMode: GreekMode;
  sessionDate?: string;
  startTime?: string;
  endTime?: string;
  aggregationPeriod?: AggregationPeriod;
  minStrikePrice?: number;
  maxStrikePrice?: number;
}): Promise<{ ticker: string; buckets: IntervalBucket[] }> {
  const { ticker, greekMode, sessionDate, startTime, endTime, aggregationPeriod,
    minStrikePrice, maxStrikePrice } = opts;
  const filter: Record<string, unknown> = { ticker };
  if (minStrikePrice !== undefined) filter.minStrikePrice = minStrikePrice;
  if (maxStrikePrice !== undefined) filter.maxStrikePrice = maxStrikePrice;
  const body: Record<string, unknown> = { greekMode, filter };
  if (sessionDate) body.sessionDate = sessionDate;
  if (startTime && endTime) { body.startTime = startTime; body.endTime = endTime; }
  if (aggregationPeriod) body.aggregationPeriod = aggregationPeriod;

  // Raw shape: { data: { <epochMs>: { <expiry>: { <strike>: {CALL,PUT} } } } }  (per §25.4)
  const raw = await qdPost<{ data?: Record<string, unknown> } & Record<string, unknown>>(
    '/options/tool/interval-map',
    body,
  );
  const byTime = (raw.data ?? raw) as Record<string, Record<string, Record<string, { CALL?: number; PUT?: number }>>>;
  const buckets: IntervalBucket[] = [];
  for (const [tsStr, byExpiry] of Object.entries(byTime)) {
    const acc = new Map<number, { call: number; put: number }>();
    for (const byStrike of Object.values(byExpiry)) {
      for (const [strikeStr, cell] of Object.entries(byStrike)) {
        const strike = Number(strikeStr);
        const cur = acc.get(strike) ?? { call: 0, put: 0 };
        cur.call += cell.CALL ?? 0;
        cur.put += cell.PUT ?? 0;
        acc.set(strike, cur);
      }
    }
    buckets.push({
      ts: Number(tsStr),
      strikes: [...acc.entries()].map(([strike, v]) => ({ strike, call: v.call, put: v.put }))
        .sort((a, b) => a.strike - b.strike),
    });
  }
  buckets.sort((a, b) => a.ts - b.ts);
  return { ticker, buckets };
}

// ── Regime vector (the locked Phase-0 grading vector) ───────────────────────
export interface RegimeVector {
  ticker: string;
  stockPrice: number;
  netGEX: number;         // Σ (call + put) across strikes
  gammaFlip: number;      // strike where cumulative net GEX crosses zero (v1 proxy)
  callWall: number;       // strike of max net-positive gamma above spot
  callWallGEX: number;
  putWall: number;        // strike of most net-negative gamma below spot
  putWallGEX: number;
  distToFlip: number;     // stockPrice − gammaFlip (points)
  distToFlipPct: number;  // as % of stockPrice
  regimeSign: 1 | -1;     // sign(netGEX): +1 positive-gamma (fade), -1 negative (break)
}

/** Compute the locked regime vector from a per-strike gamma snapshot. */
export function computeRegimeVector(snap: ExposureSnapshot): RegimeVector {
  const { ticker, stockPrice, strikes } = snap;
  const net = strikes.map((s) => ({ strike: s.strike, gex: s.call + s.put }));
  const netGEX = net.reduce((a, s) => a + s.gex, 0);

  // Gamma-flip proxy: running cumulative net GEX (low→high strike); the flip is
  // the strike at the sign change closest to spot. Dealers net-short gamma below
  // (cumulative negative), net-long above (cumulative positive) → the crossing.
  let cum = 0;
  const cumByStrike = net.map((s) => ({ strike: s.strike, cum: (cum += s.gex) }));
  let gammaFlip = stockPrice;
  let bestDist = Infinity;
  for (let i = 1; i < cumByStrike.length; i++) {
    const prev = cumByStrike[i - 1], cur = cumByStrike[i];
    if (!prev || !cur) continue;
    if ((prev.cum <= 0 && cur.cum > 0) || (prev.cum >= 0 && cur.cum < 0)) {
      // linear-interpolate the zero-cross between the two strikes
      const frac = prev.cum === cur.cum ? 0 : -prev.cum / (cur.cum - prev.cum);
      const cross = prev.strike + frac * (cur.strike - prev.strike);
      const d = Math.abs(cross - stockPrice);
      if (d < bestDist) { bestDist = d; gammaFlip = cross; }
    }
  }

  // Walls: net-positive gamma above spot (call wall), net-negative below (put wall).
  let callWall = NaN, callWallGEX = -Infinity;
  let putWall = NaN, putWallGEX = Infinity;
  for (const s of net) {
    if (s.strike >= stockPrice && s.gex > callWallGEX) { callWallGEX = s.gex; callWall = s.strike; }
    if (s.strike <= stockPrice && s.gex < putWallGEX) { putWallGEX = s.gex; putWall = s.strike; }
  }

  return {
    ticker, stockPrice, netGEX, gammaFlip,
    callWall, callWallGEX, putWall, putWallGEX,
    distToFlip: stockPrice - gammaFlip,
    distToFlipPct: ((stockPrice - gammaFlip) / stockPrice) * 100,
    regimeSign: netGEX >= 0 ? 1 : -1,
  };
}
