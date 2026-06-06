// Strategy WBF (Wall Broken Fade) — passive wall fade detector.
//
// MECHANIC (validated against 16 days of NQ RTH, n=139,672 events):
//   When a stacked wall (≥30 displayed contracts, held ≥10s as 'persistent')
//   gets fully consumed and the level drops to 0, the aggressive flow that
//   ate it has typically EXHAUSTED itself. Price tends to retrace BACK
//   through the wall — not continue away from it.
//
// EDGE (backtest results, TP20/SL10 grid):
//   peak ≥ 30  → 63.8% WR (too noisy for live)
//   peak ≥ 100 → 69.9% WR (~10-20 trades/day after cooldown)
//   peak ≥ 200 → 78.1% WR (~8 trades/day after cooldown)
//
// DIRECTION:
//   ASK wall broken → SHORT fade (sellers gave up trying to defend ceiling;
//                                  buyers exhausted themselves through them)
//   BID wall broken → LONG  fade (buyers gave up defending floor; sellers
//                                  exhausted themselves through them)
//
// COOLDOWN: 60s per (symbol, side, price_bucket). One structural break can
//   trigger many WALL_BROKEN events at adjacent prices (a wall cluster).
//   We collapse adjacent breaks within 60s into a single signal.
//
// STATUS: Phase A shadow-mode rule. Quality gate in quality.ts forces
//   'silenced' tier until calibrated. Signals still hit signals table for
//   validation; they do NOT broadcast to cockpit / Discord / trader.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';
import { StackedZoneDetector, type WallEvent } from './stacked-zone-detector.js';
import type { ConfluenceSignal, Symbol } from '@trading/contracts';

// ── Tunables ──────────────────────────────────────────────────────────────
const MIN_PEAK_SIZE     = 100;       // start at 100 (~10-20/day after cooldown, 70% WR)
const COOLDOWN_MS       = 60_000;    // 60s same-bucket cooldown
const PRICE_BUCKET_PTS  = 0.50;      // ±2 NQ ticks; treats walls within 0.50pt as same level
const RTH_ONLY          = true;      // backtest was RTH-only; expand later if desired
const WARMUP_MS         = 60_000;    // on first call, look back 60s to warm the book

// Detector thresholds — kept loose because we filter on peakSize after the fact.
// minWallSize=30 mirrors backtest detector config; everything below 100 peak is
// dropped at the rule layer.
const DETECTOR_MIN_WALL_SIZE    = 30;
const DETECTOR_MIN_PERSIST_MS   = 10_000;
const DETECTOR_ERODE_FRACTION   = 0.5;
const DETECTOR_HOLD_INTERVAL_MS = 30_000;

// ── Module state ──────────────────────────────────────────────────────────
const detectors      = new Map<Symbol, StackedZoneDetector>();
const brokenBuf      = new Map<Symbol, WallEvent[]>();
const cooldown       = new Map<string, number>();
const lastPolledTs   = new Map<Symbol, number>();
let ticksDb: Database.Database | null = null;

function openTicksDb(): Database.Database {
  if (ticksDb) return ticksDb;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ticksDbPath = path.resolve(here, '../../../../data/ticks.db');
  ticksDb = new Database(ticksDbPath, { readonly: true });
  return ticksDb;
}

function bucketPrice(price: number): number {
  return Math.round(price / PRICE_BUCKET_PTS) * PRICE_BUCKET_PTS;
}

function getOrCreateDetector(symbol: Symbol): StackedZoneDetector {
  let d = detectors.get(symbol);
  if (!d) {
    const buf: WallEvent[] = [];
    brokenBuf.set(symbol, buf);
    d = new StackedZoneDetector({
      minWallSize:        DETECTOR_MIN_WALL_SIZE,
      minPersistMs:       DETECTOR_MIN_PERSIST_MS,
      erodeFraction:      DETECTOR_ERODE_FRACTION,
      holdEmitIntervalMs: DETECTOR_HOLD_INTERVAL_MS,
      onWallEvent: (e) => { if (e.type === 'WALL_BROKEN') buf.push(e); },
    });
    detectors.set(symbol, d);
    logger.info({ symbol }, 'wall-broken-fade: detector initialized');
  }
  return d;
}

function scoreForPeak(peak: number): number {
  // Maps peak size → 0-100 score reflecting backtest WR.
  // peak 100-149 → 70 (silver), 150-199 → 80 (gold approach),
  // 200-299 → 90 (gold), 300+ → 100 (platinum).
  if (peak >= 300) return 100;
  if (peak >= 200) return 90;
  if (peak >= 150) return 80;
  if (peak >= 100) return 70;
  return 50;
}

function isRTH(tsMs: number): boolean {
  // Same RTH definition used elsewhere: 09:30–16:00 ET Mon-Fri.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const min = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  return ['Mon','Tue','Wed','Thu','Fri'].includes(get('weekday')) && min >= 570 && min < 960;
}

// ── Detector entry-point ──────────────────────────────────────────────────
export async function detectWallBrokenFade(
  symbol: Symbol,
  nowMs: number,
): Promise<{ signal: ConfluenceSignal } | null> {
  if (RTH_ONLY && !isRTH(nowMs)) return null;

  const db = openTicksDb();
  const detector = getOrCreateDetector(symbol);

  // Pull depth events since last poll (incremental)
  const since = lastPolledTs.get(symbol) ?? (nowMs - WARMUP_MS);
  const rows = db.prepare(`
    SELECT id, ts, symbol, side, price, size
    FROM depth WHERE symbol = ? AND ts > ? AND ts <= ?
    ORDER BY ts ASC, id ASC
  `).all(symbol, since, nowMs) as Array<{
    id: number; ts: number; symbol: string; side: number; price: number; size: number;
  }>;
  for (const r of rows) {
    detector.ingest({
      id: r.id, ts: r.ts, symbol: r.symbol,
      side: r.side as 0 | 1, price: r.price, size: r.size,
    });
  }
  lastPolledTs.set(symbol, nowMs);

  // Drain the broken buffer; return first event that passes filters
  const buf = brokenBuf.get(symbol);
  if (!buf || buf.length === 0) return null;

  while (buf.length > 0) {
    const e = buf.shift()!;

    // Peak-size filter
    if (e.peakSize < MIN_PEAK_SIZE) continue;

    // Cooldown filter (per symbol, side, price-bucket)
    const bucket = bucketPrice(e.price);
    const cdKey = `${symbol}|${e.side}|${bucket}`;
    const lastFired = cooldown.get(cdKey) ?? 0;
    if (e.ts - lastFired < COOLDOWN_MS) continue;
    cooldown.set(cdKey, e.ts);

    // Build signal
    const direction = e.side === 1 ? 'short' : 'long';
    const score = scoreForPeak(e.peakSize);
    const sideName = e.side === 1 ? 'ASK' : 'BID';

    logger.info({
      symbol,
      direction,
      price: e.price,
      peakSize: e.peakSize,
      persistMs: e.persistentDurationMs,
      score,
    }, 'wall-broken-fade: signal');

    return {
      signal: {
        ts: e.ts,
        source: 'rules-v2',
        type: 'confluence',
        symbol,
        ruleId: 'wall-broken-fade',
        score,
        direction,
        rationale:
          `WALL_BROKEN ${sideName} @${e.price.toFixed(2)} ` +
          `(peak=${e.peakSize}, persist=${Math.round((e.persistentDurationMs ?? 0) / 1000)}s) ` +
          `→ FADE ${direction.toUpperCase()}. ` +
          `Backtest: peak≥${MIN_PEAK_SIZE} → ~70% WR at TP20/SL10.`,
        strategyVersion: 'WBF',
        ruleVersion: 'wbf-v1',
        // Entry = wall price. Trader applies TP/SL per SIGNAL_PARAMS.
        entry: e.price,
        // Stop: structural — beyond the broken wall + buffer
        stopLevel: e.side === 1 ? e.price + 10 : e.price - 10,
        stopDist: 10,
        // Pattern hint for downstream consumers
        pattern: 'WBF',
        // WBF-specific metadata (chart uses peakSize for label, trader for sizing)
        peakSize: e.peakSize,
        persistMs: e.persistentDurationMs,
        wallSide: e.side,                // 0=BID broken, 1=ASK broken
        wallPrice: e.price,
      } as any,
    };
  }
  return null;
}

// ── Diagnostics ───────────────────────────────────────────────────────────
export function wbfSnapshot(): {
  detectors: number;
  cooldownEntries: number;
  buffered: Record<string, number>;
} {
  const buffered: Record<string, number> = {};
  for (const [sym, buf] of brokenBuf) buffered[sym] = buf.length;
  return {
    detectors: detectors.size,
    cooldownEntries: cooldown.size,
    buffered,
  };
}
