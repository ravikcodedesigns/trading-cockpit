import { db } from '../db.js';
import { logger } from '../logger.js';

const DROP_THRESHOLD_PTS = 80;
const LOOKBACK_BARS      = 35;  // minutes back to search for the peak
const APPROACH_BARS      = 10;  // bars before peak to capture for features
const COMPRESSION_BARS   = 3;   // bars ending at peak for compression read
const POLL_MS            = 60_000;

// In-memory de-dup — prevents re-logging the same peak across poll cycles.
const loggedPeaks = new Set<number>();

interface Bar {
  ts: number; open: number; high: number; low: number; close: number;
  volume: number; buyVolume: number; sellVolume: number;
}

function isRTH(ts: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ts));
  const wd = parts.find(p => p.type === 'weekday')?.value ?? '';
  const h  = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0');
  const m  = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0');
  return ['Mon','Tue','Wed','Thu','Fri'].includes(wd) && (h*60+m) >= 570 && (h*60+m) < 960;
}

function poll(symbol: string): void {
  if (!isRTH(Date.now())) return;

  const sinceMs = Date.now() - LOOKBACK_BARS * 60_000;
  const bars = db.recentBars(symbol, sinceMs) as Bar[];
  if (bars.length < APPROACH_BARS + 2) return;

  // Find the bar with the highest high in the window
  const peakBar = bars.reduce((best, b) => b.high > best.high ? b : best, bars[0]!);
  const peakIdx = bars.indexOf(peakBar);

  // Find the lowest low in bars AFTER the peak
  const afterPeak = bars.slice(peakIdx + 1);
  if (afterPeak.length === 0) return;
  const troughBar = afterPeak.reduce((min, b) => b.low < min.low ? b : min, afterPeak[0]!);

  const drop = peakBar.high - troughBar.low;
  if (drop < DROP_THRESHOLD_PTS) return;
  if (loggedPeaks.has(peakBar.ts)) return;
  loggedPeaks.add(peakBar.ts);

  // ── Approach features: APPROACH_BARS bars ending at peak ─────────────────
  const approach = bars.slice(Math.max(0, peakIdx - APPROACH_BARS), peakIdx + 1);
  const upBars     = approach.filter(b => b.close >= b.open).length;
  const netPts     = approach[approach.length - 1]!.close - approach[0]!.open;
  const rangeH     = Math.max(...approach.map(b => b.high));
  const rangeL     = Math.min(...approach.map(b => b.low));
  const rangePts   = rangeH - rangeL;
  const vol        = approach.reduce((s, b) => s + (b.volume    ?? 0), 0);
  const buyVol     = approach.reduce((s, b) => s + (b.buyVolume  ?? 0), 0);
  const sellVol    = approach.reduce((s, b) => s + (b.sellVolume ?? 0), 0);
  const delta      = buyVol - sellVol;

  // ── Compression features: last COMPRESSION_BARS bars at peak ─────────────
  const comp       = bars.slice(Math.max(0, peakIdx - COMPRESSION_BARS + 1), peakIdx + 1);
  const compH      = Math.max(...comp.map(b => b.high));
  const compL      = Math.min(...comp.map(b => b.low));
  const compRange  = compH - compL;
  const compBuy    = comp.reduce((s, b) => s + (b.buyVolume  ?? 0), 0);
  const compSell   = comp.reduce((s, b) => s + (b.sellVolume ?? 0), 0);
  const compDelta  = compBuy - compSell;

  const minsToTrough = Math.round((troughBar.ts - peakBar.ts) / 60_000);

  db.logExplShortObs({
    detectedTs:       Date.now(),
    peakTs:           peakBar.ts,
    peakPrice:        peakBar.high,
    troughPrice:      troughBar.low,
    dropPts:          Math.round(drop * 4) / 4,
    minsToTrough,
    symbol,
    approachUpBars:   upBars,
    approachNetPts:   Math.round(netPts * 4) / 4,
    approachRangePts: Math.round(rangePts * 4) / 4,
    approachVol:      vol,
    approachBuyVol:   buyVol,
    approachSellVol:  sellVol,
    approachDelta:    delta,
    compressionRange: Math.round(compRange * 4) / 4,
    compressionDelta: compDelta,
  });

  logger.info({
    symbol, peakTs: peakBar.ts, peakPrice: peakBar.high,
    drop: Math.round(drop), minsToTrough,
    approachUpBars: upBars, approachNetPts: Math.round(netPts),
    approachDelta: delta, compressionRange: Math.round(compRange), compressionDelta: compDelta,
  }, 'expl-short-obs: 80pt+ down move logged');
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startExplShortObserver(): void {
  // Pre-populate from DB so a restart doesn't re-log historical peaks
  const existing = db.query<{ peak_ts: number }>(
    'SELECT peak_ts FROM expl_short_observations'
  );
  for (const r of existing) loggedPeaks.add(r.peak_ts);
  logger.info({ historicalObs: loggedPeaks.size }, 'expl-short-observer started');

  poll('NQ');
  timer = setInterval(() => poll('NQ'), POLL_MS);
}

export function stopExplShortObserver(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
