// Structural-level proximity — feeds the confluence `atStruct` annotation (F5b: flow-following
// REVERSES at real structure, so a confluence star at a daily level means something different
// from the same star mid-range; the falsifiable split accrues via the outcome labeler).
//
// Reads the same daily_levels.json / daily_levels_es.json the cockpit chart draws (repo root,
// written by rs-levels at 09:32 + structural pre-RTH job). PASSIVE read-only consumer: picks the
// latest day ≤ today, extracts every price-like field, reloads on file mtime every minute.
// Missing file / malformed day → empty set → nearestStructTicks returns Infinity (annotation
// simply absent — never blocks an emit).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Symbol as Sym } from '@trading/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../..');
const FILE: Record<Sym, string> = {
  NQ: path.join(ROOT, 'daily_levels.json'),
  ES: path.join(ROOT, 'daily_levels_es.json'),
};
const RELOAD_MS = 60_000;

interface Cache { prices: number[]; mtime: number; checkedAt: number; day: string; }
const _cache = new Map<Sym, Cache>();

// Pull every price-like number out of one day's levels entry. Tolerant by design — the levels
// files carry heterogeneous shapes (zones, bands, additionalLevels) that evolve; a structural
// read must not break when a field is added.
function extractPrices(entry: any, out: number[]): void {
  if (entry == null) return;
  if (typeof entry === 'number' && Number.isFinite(entry) && entry > 0) { out.push(entry); return; }
  if (Array.isArray(entry)) { for (const v of entry) extractPrices(v, out); return; }
  if (typeof entry === 'object') {
    for (const [k, v] of Object.entries(entry)) {
      // price-carrying keys across the known shapes: price, low, high, upper, lower,
      // hedgePressure, mhp, value; skip obvious non-prices (colors, labels, styles, widths)
      if (typeof v === 'number') {
        if (/^(price|low|high|upper|lower|hedgePressure|mhp|value)$/.test(k)) extractPrices(v, out);
      } else extractPrices(v, out);
    }
  }
}

function loadSym(sym: Sym, nowMs: number): number[] {
  const c = _cache.get(sym);
  if (c && nowMs - c.checkedAt < RELOAD_MS) return c.prices;
  let mtime = 0;
  try { mtime = fs.statSync(FILE[sym]).mtimeMs; } catch { _cache.set(sym, { prices: [], mtime: 0, checkedAt: nowMs, day: '' }); return []; }
  if (c && c.mtime === mtime) { c.checkedAt = nowMs; return c.prices; }
  try {
    const doc = JSON.parse(fs.readFileSync(FILE[sym], 'utf8'));
    const days: Record<string, any> = doc?.days ?? {};
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(nowMs));
    // latest day ≤ today (pre-9:32 the freshest entry is the prior session — still the live structure)
    const day = Object.keys(days).filter((d) => d <= today).sort().pop() ?? '';
    const prices: number[] = [];
    if (day) for (const lvl of days[day]?.levels ?? []) if (lvl?.symbol === sym || lvl?.symbol == null) extractPrices(lvl, prices);
    prices.sort((a, b) => a - b);
    _cache.set(sym, { prices, mtime, checkedAt: nowMs, day });
    return prices;
  } catch {
    _cache.set(sym, { prices: [], mtime, checkedAt: nowMs, day: '' });
    return [];
  }
}

/** Distance (ticks) from `price` to the nearest structural level for `sym`; Infinity when none. */
export function nearestStructTicks(sym: Sym, price: number, tick: number, nowMs: number): number {
  const prices = loadSym(sym, nowMs);
  if (!prices.length) return Infinity;
  // binary search the sorted list
  let lo = 0, hi = prices.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (prices[m]! < price) lo = m + 1; else hi = m; }
  let best = Math.abs(prices[lo]! - price);
  if (lo > 0) best = Math.min(best, Math.abs(prices[lo - 1]! - price));
  return best / tick;
}

/** Highest structural level in (loPx, hiPx] for `sym`, or null — a stop-run breach test. */
export function structLevelBetween(sym: Sym, loPx: number, hiPx: number, nowMs: number): number | null {
  const prices = loadSym(sym, nowMs);
  if (!prices.length || hiPx <= loPx) return null;
  // rightmost level ≤ hiPx
  let lo = 0, hi = prices.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (prices[m]! <= hiPx) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 && prices[ans]! > loPx ? prices[ans]! : null;
}

/** Test hook: clear the cache. */
export function _resetStructCache(): void { _cache.clear(); }
