// Thin HTTP client for querying the tick-store API.
// Strategy B rules use this to fetch recent trades and depth for analysis.
// Keeps a persistent fetch with retry logic and local caching for performance.

import { config } from '../config.js';
import { logger } from '../logger.js';
import type { TickTrade, TickDepth } from '@trading/contracts';

const BASE = config.tickStore.baseUrl;

// In-memory cache: keyed by "symbol:from:to" to avoid redundant fetches
// within the same polling cycle. Cache TTL matches poll interval.
const _cache = new Map<string, { ts: number; data: TickTrade[] | TickDepth[] }>();
const CACHE_TTL_MS = config.tickStore.pollMs;

function cacheKey(endpoint: string, symbol: string, fromMs: number, toMs: number): string {
  return `${endpoint}:${symbol}:${fromMs}:${toMs}`;
}

async function fetchWithRetry(url: string, retries = 2): Promise<unknown> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
    }
  }
}

export async function getRecentTrades(
  symbol: string,
  windowMs: number
): Promise<TickTrade[]> {
  const toMs = Date.now();
  const fromMs = toMs - windowMs;
  const key = cacheKey('trades', symbol, Math.floor(fromMs / 500) * 500, 0);

  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data as TickTrade[];
  }

  try {
    const url = `${BASE}/trades?symbol=${symbol}&from=${fromMs}&to=${toMs}`;
    const body = await fetchWithRetry(url) as { trades: TickTrade[] };
    const data = body.trades ?? [];
    _cache.set(key, { ts: Date.now(), data });
    return data;
  } catch (err) {
    logger.warn({ err, symbol, windowMs }, 'tick-store trade fetch failed');
    return [];
  }
}

export async function getRecentDepth(
  symbol: string,
  windowMs: number
): Promise<TickDepth[]> {
  const toMs = Date.now();
  const fromMs = toMs - windowMs;
  const key = cacheKey('depth', symbol, Math.floor(fromMs / 500) * 500, 0);

  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data as TickDepth[];
  }

  try {
    const url = `${BASE}/depth?symbol=${symbol}&from=${fromMs}&to=${toMs}`;
    const body = await fetchWithRetry(url) as { events: TickDepth[] };
    const data = body.events ?? [];
    _cache.set(key, { ts: Date.now(), data });
    return data;
  } catch (err) {
    logger.warn({ err, symbol, windowMs }, 'tick-store depth fetch failed');
    return [];
  }
}

// Evict stale cache entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _cache.entries()) {
    if (now - v.ts > CACHE_TTL_MS * 3) _cache.delete(k);
  }
}, 10_000);
