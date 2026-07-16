// Calibration loader — the read side of data/tape-calibration.json (written by
// scripts/calibrate_tape.ts from the full parquet replay). Gives the live engine:
//
//   • percentile lookups per symbol + metric, optionally per TIME-OF-DAY bucket — intraday
//     volume/impact is U-shaped, so one whole-RTH distribution over-fires the open and
//     under-fires lunch. Buckets: open 09:30–10:15 ET · mid · late 15:00–16:00 ET.
//   • tierMult() — the magnitude→multiplier mapping for confluence scoring (<p20 tiny ×0.4 …
//     ≥p95 huge ×2.5). Data-driven: the breakpoints come from what actually occurs per symbol.
//   • calFloor() — calibrated floors for thresholds that were guesses (flow 80 / imb 150).
//
// EVERY lookup degrades gracefully: missing file / missing metric / missing ToD block → the
// caller's fallback (tier ×1, legacy floor), so the engine never depends on a calibration run.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Symbol as Sym } from '@trading/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAL_PATH = process.env.TAPE_CAL_PATH ?? path.resolve(__dirname, '../../../../data/tape-calibration.json');
const RELOAD_MS = 5 * 60_000;   // pick up nightly recalibrations without a restart

export interface Pctls { n: number; p20: number; p50: number; p80: number; p95: number; p99: number; }
// 'overnight' = outside RTH. No overnight distributions exist yet (the harness replays RTH only),
// so overnight lookups fall through to whole-RTH percentiles — deliberately CONSERVATIVE: thin
// overnight prints tier low against RTH magnitudes, suppressing rather than inflating scores.
export type TodBucket = 'open' | 'mid' | 'late' | 'overnight';

interface CalFile {
  [sym: string]: {
    [metric: string]: Pctls | undefined;
  } & { tod?: Partial<Record<TodBucket, Record<string, Pctls>>> };
}

let _cal: CalFile | null = null;
let _loadedAt = 0;
let _mtime = 0;

function load(): CalFile | null {
  const now = Date.now();
  if (_cal && now - _loadedAt < RELOAD_MS) return _cal;
  _loadedAt = now;
  try {
    const st = fs.statSync(CAL_PATH);
    if (_cal && st.mtimeMs === _mtime) return _cal;
    _cal = JSON.parse(fs.readFileSync(CAL_PATH, 'utf8')) as CalFile;
    _mtime = st.mtimeMs;
  } catch { _cal = null; }
  return _cal;
}

// ── Time-of-day bucketing ─────────────────────────────────────────────────────
// ET boundaries computed once per day (Intl is too slow for per-event calls) and cached.
let _dayKey = '';
let _rthOpen = 0;   // 09:30 ET as UTC ms
let _openEnd = 0;   // 10:15 ET as UTC ms
let _lateStart = 0; // 15:00 ET as UTC ms
let _rthClose = 0;  // 16:00 ET as UTC ms

function refreshDay(tsMs: number): void {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(tsMs));
  if (date === _dayKey) return;
  _dayKey = date;
  const [y, m, d] = date.split('-').map(Number);
  // EDT = UTC-4. The capture + every consumer of these buckets runs in the summer session;
  // rthBoundsFor in flow-engine.ts makes the same simplification.
  _rthOpen = Date.UTC(y!, m! - 1, d!, 13, 30, 0);   // 09:30 ET
  _openEnd = Date.UTC(y!, m! - 1, d!, 14, 15, 0);   // 10:15 ET
  _lateStart = Date.UTC(y!, m! - 1, d!, 19, 0, 0);  // 15:00 ET
  _rthClose = Date.UTC(y!, m! - 1, d!, 20, 0, 0);   // 16:00 ET
}

/** ToD bucket: open 09:30–10:15 ET · late 15:00–16:00 ET · mid between · overnight outside RTH. */
export function todBucket(tsMs: number): TodBucket {
  if (_dayKey === '' || tsMs >= _openEnd + 12 * 3600_000 || tsMs < _openEnd - 12 * 3600_000) refreshDay(tsMs);
  if (tsMs < _rthOpen || tsMs >= _rthClose) return 'overnight';
  return tsMs < _openEnd ? 'open' : tsMs >= _lateStart ? 'late' : 'mid';
}

/** Percentiles for symbol+metric. Prefers the ToD bucket when present; falls back to whole-RTH. */
export function calGet(sym: Sym, metric: string, tsMs?: number): Pctls | null {
  const cal = load();
  const s = cal?.[sym];
  if (!s) return null;
  if (tsMs != null) {
    const p = s.tod?.[todBucket(tsMs)]?.[metric];
    if (p && p.n >= 50) return p;   // thin bucket → whole-RTH is the better estimate
  }
  const p = s[metric];
  return p && typeof p === 'object' && 'p50' in p ? (p as Pctls) : null;
}

// Magnitude tiers: where a value sits in its own empirical distribution scales its confluence
// contribution. Breakpoints are the calibrated percentiles; multipliers are the design constants.
export const TIER_MULT = { tiny: 0.4, small: 0.7, normal: 1.0, large: 1.5, huge: 2.5 } as const;

/** Multiplier for `value` of `metric` on `sym` (ToD-aware). No calibration → ×1 (flat legacy). */
export function tierMult(sym: Sym, metric: string, value: number, tsMs?: number): number {
  const p = calGet(sym, metric, tsMs);
  if (!p || p.n < 100) return 1;
  if (value < p.p20) return TIER_MULT.tiny;
  if (value < p.p50) return TIER_MULT.small;
  if (value < p.p80) return TIER_MULT.normal;
  if (value < p.p95) return TIER_MULT.large;
  return TIER_MULT.huge;
}

/** Calibrated floor: the given percentile of the observed distribution, or `fallback` when absent. */
export function calFloor(sym: Sym, metric: string, pct: 'p50' | 'p80' | 'p95', fallback: number, tsMs?: number): number {
  const p = calGet(sym, metric, tsMs);
  return p && p.n >= 100 ? p[pct] : fallback;
}

/** Test hook: drop the cache so the next lookup re-reads the file. */
export function _resetCalCache(): void { _cal = null; _loadedAt = 0; _mtime = 0; _dayKey = ''; }
