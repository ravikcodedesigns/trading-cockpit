import { useEffect, useRef, useState } from 'react';
import { OpeningBias } from './OpeningBias';
import { RegimePanel } from './RegimePanel';
import type { CheckpointData, FactorDir, RegimeLabel } from './RegimePanel';
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
  ColorType,
  LineStyle,
  CrosshairMode,
} from 'lightweight-charts';
import { useStore } from '../lib/ws';
import { tradingDayFor, lookupLevelStyle, isStructuralLevel, flipLongFcVeto, contShortRetraceVeto, cvdLongFloorOffTag, dangerFlagEmoji } from '@trading/contracts';
import type { ConfluenceSignal, LevelStyle } from '@trading/contracts';
import { ZoneBandsPrimitive } from './zoneBands';
import { HeatmapPrimitive } from './heatmapPrimitive';
import { HeatmapFeed } from '../lib/heatmap-feed';
import { FlowHud } from './FlowHud';
import { DriftHud } from './DriftHud';
import { TapePrimitive } from './tapePrimitive';
import { TapeFeed, ALL_KINDS, floorMinSize, floorMinLevels, type CalDoc } from '../lib/tape-feed';

// kinds with a calibrated size distribution — eligible for percentile display dials
const PCT_KINDS = new Set<TapeKind>(['block', 'sweep', 'stacked', 'trapped', 'iceberg', 'wall', 'stoprun']);

// Persisted TAPE-bar settings (localStorage). Parsed once per page load and cached — several
// useState initializers read it.
const TAPE_PREFS_KEY = 'cockpit.tapePrefs.v1';
interface TapePrefs {
  kinds?: string[];
  minSizes?: Partial<Record<TapeKind, number>>;
  minLevels?: Partial<Record<TapeKind, number>>;
  pctMode?: boolean;
  minPct?: Partial<Record<TapeKind, number>>;
  iceBucketTicks?: number;
  confTopN?: number;
  confMinTier?: number;
}
let _tapePrefsCache: TapePrefs | null | undefined;
function loadTapePrefs(): TapePrefs | null {
  if (_tapePrefsCache !== undefined) return _tapePrefsCache;
  try { _tapePrefsCache = JSON.parse(localStorage.getItem(TAPE_PREFS_KEY) ?? 'null'); }
  catch { _tapePrefsCache = null; }
  return _tapePrefsCache;
}
import { TAPE_FLOORS, type TapeKind, type TapeEvent } from '@trading/contracts';
import { SignalChartCard } from './SignalFeed';

// ── Range arithmetic for the dynamic bar-fetch loader ──────────────────────
// Each entry is [fromMs, toMs] inclusive-exclusive. Arrays are kept sorted+merged.
type Range = [number, number];

function mergeRange(ranges: Range[], from: number, to: number): Range[] {
  if (from >= to) return ranges;
  const all: Range[] = [...ranges, [from, to]].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const [a, b] of all) {
    if (out.length && a <= out[out.length - 1]![1]) {
      out[out.length - 1]![1] = Math.max(out[out.length - 1]![1], b);
    } else {
      out.push([a, b]);
    }
  }
  return out;
}

function gapsToFetch(ranges: Range[], from: number, to: number): Range[] {
  if (from >= to) return [];
  const gaps: Range[] = [];
  let cursor = from;
  for (const [a, b] of ranges) {
    if (b <= cursor) continue;
    if (a >= to) break;
    if (a > cursor) gaps.push([cursor, Math.min(a, to)]);
    cursor = Math.max(cursor, b);
    if (cursor >= to) break;
  }
  if (cursor < to) gaps.push([cursor, to]);
  return gaps;
}

// Record a fetched window as "loaded", but NEVER claim the live edge (the last
// ~2 min). Bars there may not have formed yet, and marking them covered would
// let the dedupe in gapsToFetch suppress a backfill after a feed reconnect — the
// exact freeze seen 2026-07-01 (feed down mid-session; ranges recorded up to
// `now` during the outage, so the resumed bars were treated as already-loaded).
// Historical windows (well in the past) are still recorded in full, so genuinely
// empty gaps aren't re-fetched on every scroll. The trailing live-tail poll owns
// the guarded live edge.
const LIVE_EDGE_GUARD_MS = 2 * 60_000;
function recordLoadedRange(ranges: Range[], from: number, to: number, nowMs: number): Range[] {
  const clampedTo = Math.min(to, nowMs - LIVE_EDGE_GUARD_MS);
  if (clampedTo <= from) return ranges;  // whole window is inside the live-edge guard — record nothing
  return mergeRange(ranges, from, clampedTo);
}

// ── Bar-cache persistence (localStorage) ───────────────────────────────────
// Keeps the last-fetched bar window across page reloads so a refresh, or a
// cold-boot on /es, doesn't wait on a full /history/bars round-trip before
// the chart paints. On hit, the in-session symbol toggle (NQ↔ES) and the
// browser refresh both skip the bulk fetch and only backfill the gap
// [lastCachedTs → now]. One key per (symbol, timeframe); stored as a
// compact tuple array so a week of 1-min bars (~10k rows) fits comfortably
// in localStorage's 5–10 MB origin quota.
type CachedBarRow = [t: number, o: number, h: number, l: number, c: number, v: number];
type BarsCachePayload = { storedAtMs: number; bars: CachedBarRow[] };
const BARS_CACHE_PREFIX = 'cockpit:bars:v1:';
const BARS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

function barsCacheKey(symbol: string, tf: number): string {
  return `${BARS_CACHE_PREFIX}${symbol}:${tf}`;
}

function loadBarsCache(
  symbol: string,
  tf: number,
): Map<number, { open: number; high: number; low: number; close: number; volume: number }> | null {
  try {
    const raw = localStorage.getItem(barsCacheKey(symbol, tf));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BarsCachePayload;
    if (!parsed?.storedAtMs || Date.now() - parsed.storedAtMs > BARS_CACHE_TTL_MS) return null;
    const m = new Map<number, { open: number; high: number; low: number; close: number; volume: number }>();
    for (const [t, o, h, l, c, v] of parsed.bars) {
      m.set(t, { open: o, high: h, low: l, close: c, volume: v });
    }
    return m.size > 0 ? m : null;
  } catch {
    return null;
  }
}

function saveBarsCache(
  symbol: string,
  tf: number,
  cache: Map<number, { open: number; high: number; low: number; close: number; volume: number }>,
): void {
  if (cache.size === 0) return;
  try {
    const bars: CachedBarRow[] = [];
    for (const [t, b] of cache) bars.push([t, b.open, b.high, b.low, b.close, b.volume]);
    bars.sort((a, b) => a[0] - b[0]);
    const payload: BarsCachePayload = { storedAtMs: Date.now(), bars };
    localStorage.setItem(barsCacheKey(symbol, tf), JSON.stringify(payload));
  } catch {
    // Quota / serialisation errors — cache write is best-effort.
  }
}

// ── Drawing tool types ─────────────────────────────────────────────────────
type DrawMode = 'line' | 'text' | 'measure' | null;
type Drawing =
  | { id: string; kind: 'line';    p1: { time: number; price: number }; p2: { time: number; price: number } }
  | { id: string; kind: 'measure'; p1: { time: number; price: number }; p2: { time: number; price: number } }
  | { id: string; kind: 'text';    point: { time: number; price: number }; text: string };

// Each absorption signal instance gets a unique color so back-to-back signals
// and their 30s/2m follow-up markers are visually grouped and don't blur together.
const ABSORPTION_PALETTE = [
  '#e879f9', // fuchsia
  '#38bdf8', // sky blue
  '#fb923c', // orange
  '#a78bfa', // violet
  '#22d3ee', // cyan
  '#a78bfa', // violet
  '#818cf8', // indigo
  '#fde047', // yellow
];

function getSignalPaletteColor(ts: number): string {
  return ABSORPTION_PALETTE[Math.abs(ts) % ABSORPTION_PALETTE.length]!;
}

// Synthesised signal alert sounds via Web Audio API (no audio files needed).
// Each signal type gets a distinct tonal pattern so you can recognise them
// without looking at the screen.
// Takes a persistent AudioContext so it survives tab switches (browsers suspend
// a per-call context when the tab is hidden; a shared one can be resumed).
// Fire-engine "wail" siren, ~3 seconds. The frequency sweeps up and down
// repeatedly (sawtooth + detuned square for a fuller engine timbre). Direction
// only shifts the pitch band slightly (short = lower) so long/short differ.
function playSignalSound(ac: AudioContext, direction: string, _ruleId: string): void {
  try {
    const t0 = ac.currentTime;
    const DUR = 3;            // seconds
    const HALF = 0.65;        // seconds per up- or down-sweep

    const master = ac.createGain();
    master.connect(ac.destination);
    master.gain.setValueAtTime(0.0001, t0);
    master.gain.linearRampToValueAtTime(0.3, t0 + 0.05);        // attack
    master.gain.setValueAtTime(0.3, t0 + DUR - 0.25);
    master.gain.linearRampToValueAtTime(0.0001, t0 + DUR);      // release

    const [lo, hi] = direction === 'short' ? [500, 1150] : [650, 1400];

    const wail = (type: OscillatorType, detune: number, gain: number) => {
      const osc = ac.createOscillator();
      const g = ac.createGain();
      g.gain.value = gain;
      osc.type = type;
      osc.detune.value = detune;
      osc.frequency.setValueAtTime(lo, t0);
      let t = t0, up = true;
      while (t < t0 + DUR) {
        const next = Math.min(t + HALF, t0 + DUR);
        osc.frequency.linearRampToValueAtTime(up ? hi : lo, next);
        up = !up;
        t = next;
      }
      osc.connect(g);
      g.connect(master);
      osc.start(t0);
      osc.stop(t0 + DUR + 0.05);
    };

    wail('sawtooth', 0, 0.8);   // main siren
    wail('square', 7, 0.25);    // detuned layer for a fuller "engine" timbre
  } catch {
    // Fail silently if audio is blocked
  }
}

function isRTHBar(tsMs: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(tsMs));
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  const weekday = get('weekday');
  const min = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday) && min >= 570 && min < 960;
}

// ── Regime computation ─────────────────────────────────────────────────────

function getRthOpenMs(): number {
  const now = Date.now();
  const datePart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now));
  const [mm, dd, yyyy] = datePart.split('/');
  const probeHour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', hour12: false,
    }).format(new Date(now)), 10,
  );
  const utcHour = new Date(now).getUTCHours();
  const offsetH = ((utcHour - probeHour) + 24) % 24;
  const offset = offsetH === 4 ? '-04:00' : '-05:00';
  return Date.parse(`${yyyy}-${mm}-${dd}T09:30:00${offset}`);
}

type RawBar = { ts: number; open: number; high: number; low: number; close: number; buyVolume: number; sellVolume: number };
type RegimeLevels = {
  bullZone: { high: number; low: number };
  bearZone: { high: number; low: number };
  ddBands: { upper: number; lower: number };
  hedgePressure: number;
  additionalLevels?: { label: string; price: number }[];
};

function computeRegime(
  bars: RawBar[],       // 1-min intraday (600 min)
  h4Bars: RawBar[],     // 4H bars (fetched at interval=240)
  dailyBars: RawBar[],  // daily bars (fetched at interval=1440)
  levels: RegimeLevels,
  rthOpenMs: number,
): CheckpointData[] {
  const rthBars = bars.filter(b => b.ts >= rthOpenMs).sort((a, b) => a.ts - b.ts);

  // ── Multi-timeframe structure ────────────────────────────────────────────
  // Returns bull/bear/null for a given sorted bar array at a given timeframe.
  // A bar is "complete" when its bucket end (ts + intervalMs) <= beforeMs.
  // Both close position within range AND direction vs prior close must agree.
  const structDir = (sortedBars: RawBar[], intervalMs: number, beforeMs: number): FactorDir => {
    const done  = sortedBars.filter(b => b.ts + intervalMs <= beforeMs);
    const last  = done.at(-1) ?? null;
    const prior = done.at(-2) ?? null;
    if (!last) return null;
    const range = last.high - last.low;
    const pos   = range > 0 ? (last.close - last.low) / range : 0.5;
    const trend = prior === null ? 0
      : last.close > prior.close ?  1
      : last.close < prior.close ? -1 : 0;
    if (pos >= 0.5 && trend >= 0) return 'bull';
    if (pos <  0.5 && trend <= 0) return 'bear';
    return null;
  };

  const D1_MS = 1440 * 60_000;
  const H4_MS =  240 * 60_000;
  const H1_MS =   60 * 60_000;

  // H1 bars computed from the 1-min intraday fetch — meaningful at 12:00 and 13:30
  // where the last complete H1 is an actual RTH bar (11:00-11:59 and 12:00-12:59).
  const h1Map = new Map<number, RawBar>();
  for (const b of bars) {
    const bucket = Math.floor(b.ts / H1_MS) * H1_MS;
    const h = h1Map.get(bucket);
    if (!h) {
      h1Map.set(bucket, { ...b, ts: bucket });
    } else {
      if (b.high > h.high) h.high = b.high;
      if (b.low  < h.low)  h.low  = b.low;
      h.close       = b.close;
      h.buyVolume  += b.buyVolume;
      h.sellVolume += b.sellVolume;
    }
  }
  const h1Bars = Array.from(h1Map.values()).sort((a, b) => a.ts - b.ts);

  // Close of the bar starting at etMin (bar covers etMin → etMin+1)
  const closeOf = (etMin: number): number | null => {
    const targetMs = rthOpenMs + (etMin - 570) * 60_000;
    const b = rthBars.find(b => Math.floor(b.ts / 60_000) === Math.floor(targetMs / 60_000));
    return b?.close ?? null;
  };

  // Session VWAP using all bars with ts < toEtMin's start
  const vwapUpTo = (toEtMin: number): number | null => {
    const toMs = rthOpenMs + (toEtMin - 570) * 60_000;
    let sumPV = 0, sumV = 0;
    for (const b of rthBars) {
      if (b.ts >= toMs) break;
      const vol = b.buyVolume + b.sellVolume;
      sumPV += ((b.high + b.low + b.close) / 3) * vol;
      sumV  += vol;
    }
    return sumV > 0 ? sumPV / sumV : null;
  };

  const deltaRange = (fromEtMin: number, toEtMin: number): number => {
    const fromMs = rthOpenMs + (fromEtMin - 570) * 60_000;
    const toMs   = rthOpenMs + (toEtMin   - 570) * 60_000;
    return rthBars
      .filter(b => b.ts >= fromMs && b.ts < toMs)
      .reduce((s, b) => s + b.buyVolume - b.sellVolume, 0);
  };

  const cmp = (price: number | null, level: number | null): FactorDir => {
    if (price === null || level === null) return null;
    return price > level ? 'bull' : price < level ? 'bear' : null;
  };

  const ddDir = (price: number | null): FactorDir => {
    if (price === null || !levels.ddBands) return null;
    const { upper, lower } = levels.ddBands;
    if (upper === lower) return null;
    return ((price - lower) / (upper - lower)) > 0.5 ? 'bull' : 'bear';
  };

  const greaterMkt = (price: number | null): FactorDir => {
    if (price === null) return null;
    if (levels.bullZone && price > levels.bullZone.high) return 'bull';
    if (levels.bearZone && price < levels.bearZone.low)  return 'bear';
    return null;
  };

  const deltaDir = (d: number): FactorDir => d > 0 ? 'bull' : d < 0 ? 'bear' : null;

  const getAL = (part: string): number | null =>
    levels.additionalLevels?.find(l => l.label.toUpperCase().includes(part.toUpperCase()))?.price ?? null;

  const toLabel = (factors: CheckpointData['factors']): RegimeLabel | null => {
    const nonNull = factors.filter(f => f.dir !== null);
    if (nonNull.length === 0) return null;
    const bulls = nonNull.filter(f => f.dir === 'bull').length;
    const r = bulls / nonNull.length;
    if (r >= 2 / 3) return 'BULL STRONG';
    if (r > 0.5)    return 'BULL WEAK';
    if (r <= 1 / 3) return 'BEAR STRONG';
    if (r < 0.5)    return 'BEAR WEAK';
    return 'NEUTRAL';
  };

  // ── 9:31: structural levels ───────────────────────────────────────────────
  // Daily bias is always yesterday's complete bar (today's hasn't closed yet).
  // 4H: at 9:31 the last complete 4H bar is the 4:00-8:00 AM ET pre-market bar.
  const cp931 = rthOpenMs + 60_000;
  const p931 = closeOf(571);
  const f931: CheckpointData['factors'] = [
    { name: 'Daily',       dir: structDir(dailyBars, D1_MS, cp931) },
    { name: '4H',          dir: structDir(h4Bars,    H4_MS, cp931) },
    { name: 'Greater mkt', dir: greaterMkt(p931) },
    { name: 'DD ratio',    dir: ddDir(p931) },
    { name: 'HP',          dir: cmp(p931, levels.hedgePressure ?? null) },
    { name: 'ON HP',       dir: cmp(p931, getAL('ON HP')) },
    { name: 'ON MHP',      dir: cmp(p931, getAL('ON MHP')) },
    { name: 'HG',          dir: cmp(p931, getAL('HG')) },
  ];

  // ── 10:00: OR confirmation ────────────────────────────────────────────────
  // 4H: same pre-market bar (the 8AM-12PM ET 4H is still forming until noon).
  const cp1000 = rthOpenMs + 30 * 60_000;
  const p1000  = closeOf(599);
  const vwap10 = vwapUpTo(600);
  const delta30 = deltaRange(570, 600);
  const orBars  = rthBars.filter(b => b.ts >= rthOpenMs && b.ts < rthOpenMs + 15 * 60_000);
  const orHigh  = orBars.length > 0 ? orBars.reduce((m, b) => Math.max(m, b.high), -Infinity) : null;
  const orLow   = orBars.length > 0 ? orBars.reduce((m, b) => Math.min(m, b.low),  +Infinity) : null;
  const orBreak: FactorDir = p1000 === null ? null
    : orHigh !== null && p1000 > orHigh ? 'bull'
    : orLow  !== null && p1000 < orLow  ? 'bear'
    : null;
  const f1000: CheckpointData['factors'] = [
    { name: 'Daily',     dir: structDir(dailyBars, D1_MS, cp1000) },
    { name: '4H',        dir: structDir(h4Bars,    H4_MS, cp1000) },
    { name: 'VWAP',      dir: cmp(p1000, vwap10) },
    { name: 'OR break',  dir: orBreak },
    { name: '30m delta', dir: deltaDir(delta30) },
  ];

  // ── 12:00: midday reset ───────────────────────────────────────────────────
  // 4H: the 8AM-12PM ET 4H bar completes exactly at 12:00, so it's now available.
  const cp1200 = rthOpenMs + 150 * 60_000;
  const p1200  = closeOf(719);
  const vwap12 = vwapUpTo(720);
  const f1200: CheckpointData['factors'] = [
    { name: 'Daily',      dir: structDir(dailyBars, D1_MS, cp1200) },
    { name: '4H',         dir: structDir(h4Bars,    H4_MS, cp1200) },
    { name: 'H1',         dir: structDir(h1Bars,    H1_MS, cp1200) },
    { name: 'VWAP',       dir: cmp(p1200, vwap12) },
    { name: 'Sess delta', dir: deltaDir(deltaRange(570, 720)) },
  ];

  // ── 13:30: afternoon ──────────────────────────────────────────────────────
  // 4H: same 8AM-12PM 4H bar (the 12PM-4PM bar isn't complete until market close).
  const cp1330 = rthOpenMs + 240 * 60_000;
  const p1330  = closeOf(809);
  const vwap1330 = vwapUpTo(810);
  const mornBars = rthBars.filter(b => b.ts >= rthOpenMs && b.ts < rthOpenMs + 150 * 60_000);
  const mornHigh = mornBars.length > 0 ? mornBars.reduce((m, b) => Math.max(m, b.high), -Infinity) : null;
  const mornLow  = mornBars.length > 0 ? mornBars.reduce((m, b) => Math.min(m, b.low),  +Infinity) : null;
  const vsMorn: FactorDir = p1330 === null ? null
    : mornHigh !== null && p1330 > mornHigh ? 'bull'
    : mornLow  !== null && p1330 < mornLow  ? 'bear'
    : null;
  const f1330: CheckpointData['factors'] = [
    { name: 'Daily',   dir: structDir(dailyBars, D1_MS, cp1330) },
    { name: '4H',      dir: structDir(h4Bars,    H4_MS, cp1330) },
    { name: 'H1',      dir: structDir(h1Bars,    H1_MS, cp1330) },
    { name: 'VWAP',    dir: cmp(p1330, vwap1330) },
    { name: 'vs morn', dir: vsMorn },
  ];

  return [
    { time: '09:31', etMin: 571, label: p931  !== null ? toLabel(f931)  : null, factors: f931  },
    { time: '10:00', etMin: 600, label: p1000 !== null ? toLabel(f1000) : null, factors: f1000 },
    { time: '12:00', etMin: 720, label: p1200 !== null ? toLabel(f1200) : null, factors: f1200 },
    { time: '13:30', etMin: 810, label: p1330 !== null ? toLabel(f1330) : null, factors: f1330 },
  ];
}

function sigEtMin(tsMs: number): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(tsMs));
  const g = (t: string) => p.find(x => x.type === t)?.value ?? '0';
  return parseInt(g('hour'), 10) * 60 + parseInt(g('minute'), 10);
}

function regimeAlignment(
  ruleId: string,
  direction: string | undefined,
  tsMs: number,
  checkpoints: CheckpointData[],
): 'against' | 'ok' {
  const etMin = sigEtMin(tsMs);
  const active = [...checkpoints]
    .filter(c => c.label !== null && c.etMin <= etMin)
    .sort((a, b) => b.etMin - a.etMin)[0];
  if (!active?.label) return 'ok';

  const label = active.label;
  const isLong = direction?.toLowerCase() === 'long';

  if (ruleId === 'clean-impulse') {
    const bearish = label === 'BEAR STRONG' || label === 'BEAR WEAK';
    const bullish = label === 'BULL STRONG' || label === 'BULL WEAK';
    return (isLong ? bearish : bullish) ? 'against' : 'ok';
  }
  if (ruleId === 'expl') {
    return label === 'BEAR STRONG' ? 'against' : 'ok';
  }
  if (ruleId === 'absorption') {
    if (etMin >= 780 && etMin < 870) return 'against'; // skip 13:00–14:29 (all realized losses cluster here)
    return label === 'BEAR STRONG' ? 'against' : 'ok';
  }
  return 'ok';
}

// ──────────────────────────────────────────────────────────────────────────────

export function Chart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  // Line-series objects representing per-day RS levels. Each level on each
  // day is its own short line series confined to that day's bar range.
  // We track them so we can clean up on level updates / symbol switches.
  const levelLinesRef = useRef<ISeriesApi<'Line'>[]>([]);
  // Shaded bull/bear zone bands (today's RS liquidity-map zones), drawn behind candles.
  const zoneBandsRef = useRef<ZoneBandsPrimitive | null>(null);
  // Live Bookmap-style order-book heatmap + volume dots (behind/over candles).
  const heatmapFeedRef = useRef<HeatmapFeed | null>(null);
  const heatmapRef = useRef<HeatmapPrimitive | null>(null);
  // Live L3 TAPE event markers (sweep/block/spoof/iceberg) at exact price/time.
  const tapeFeedRef = useRef<TapeFeed | null>(null);
  const tapeRef = useRef<TapePrimitive | null>(null);
  const tapeOnRef = useRef(false);                                  // TAPE state, readable from the scroll sub
  const tapeLoadedRef = useRef<{ from: number; to: number }>({ from: Infinity, to: 0 });  // loaded history window (sec)
  const [tapeTip, setTapeTip] = useState<{ evs: TapeEvent[]; x: number; y: number } | null>(null);  // hover tooltip — ALL markers at the spot
  const tapeTipEvRef = useRef<TapeEvent | null>(null);              // guards tooltip setState churn (nearest ev identity)
  const [topIce, setTopIce] = useState<TapeEvent[]>([]);           // ranked "top icebergs in view" readout
  const [priceScaleW, setPriceScaleW] = useState(64);             // right price-axis width → panel offset
  // Per-level label entries for today's levels, drawn as SVG text in the
  // drawing overlay (positioned at top-right of each line) so we can control
  // font-size and placement beyond what lightweight-charts' price-axis chip
  // allows.
  // Per-level badge tracking. startTs/endTs span the level's line segment
  // (prior-day 18:00 ET → trading-day 16:00 ET). The badge prefers to anchor
  // to endTs (segment-end), but clamps to the right edge of the visible pane
  // when endTs scrolls off-screen — so it sticks to the end of the line
  // wherever the line is still visible. Skipped entirely when the segment
  // is fully off-screen.
  const levelLabelsRef = useRef<Array<{ price: number; label: string; color: string; startTs: number; endTs: number }>>([]);
  // Signal markers — replaces lightweight-charts series.setMarkers() so we can
  // control font-weight and font-size per badge (the LWC marker plugin uses
  // canvas with a hardcoded regular weight). Rendered as SVG in the existing
  // overlay so font-weight=800 + font-size=14 actually applies.
  const signalMarkersRef = useRef<Array<{
    ts: number;
    price: number;
    text: string;
    color: string;
    shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
    position: 'aboveBar' | 'belowBar' | 'inBar';
  }>>([]);
  const flashAlphaLinesRef = useRef<ISeriesApi<'Line'>[]>([]);
  // TP/DD price lines drawn per signal — rebuilt whenever the markers effect runs.
  // Using IPriceLine (attached to the candlestick series) instead of separate
  // LineSeries so that add/remove doesn't trigger chart view recalculation.
  const signalLinesRef = useRef<IPriceLine[]>([]);

  // Session VWAP line series (resets at RTH open 09:30 ET each day).
  const vwapSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  // Per-session accumulators: key = YYYY-MM-DD trading day string.
  // lastBucket = last 1-min bucket (seconds) that was appended to the VWAP series.
  const vwapSessionsRef = useRef<Map<string, {
    sumPV: number; sumV: number; lastBucket: number;
  }>>(new Map());

  // Per-symbol bar history kept in a ref so it survives re-renders.
  const barHistoryRef = useRef<Record<string, Map<number, {
    open: number; high: number; low: number; close: number; volume: number;
  }>>>({ NQ: new Map(), ES: new Map() });

  // Tracks already-fetched time ranges so we don't re-request data we have.
  // Keyed by `${symbol}:${timeframe}` → sorted, merged [fromMs, toMs] intervals.
  const loadedRangesRef = useRef<Record<string, Range[]>>({});
  // True once the initial bulk-history fetch has populated the series for a
  // given symbol. Live-bar updates accumulate into barHistoryRef before this
  // flips, but they don't call setData — that way the very first setData seen
  // by lightweight-charts is the bulk one with the full window, and the
  // visible-range anchor right after it lands in one shot (no autofit flash).
  const historyLoadedRef = useRef<Record<string, boolean>>({});
  // Last bar timestamp (sec) pushed to the candle series per symbol. Lets live
  // updates use series.update() (which preserves pan/zoom) instead of a full
  // series.setData() on every bar event (which interrupts user interaction).
  const lastLiveSecRef = useRef<Record<string, number>>({});
  // Symbols currently mid-fetch (prevents redundant requests).
  const fetchInFlightRef = useRef<Set<string>>(new Set());
  // Debounce timer for the scroll-driven dynamic loader.
  const dynamicLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest dynamic-load callback, populated by an effect so the chart's
  // visible-range subscription always reaches the most recent closure.
  const dynamicLoadRef = useRef<(fromMs: number, toMs: number) => void>(() => {});
  // Earliest timestamp (ms) for which qualified/V3 marks have been fetched.
  // Pan-scroll past this and the marks-loader extends the window back to cover.
  // Starts at "now" so the first initial fetch always pulls something.
  const marksLoadedFromMsRef = useRef<number>(Date.now());
  // Per-symbol callback that extends the loaded marks range back to `sinceMs`.
  // Populated by an effect so the chart's visible-range subscription can call
  // it with the most recent symbol/state closure.
  const loadMarksRef = useRef<(sinceMs: number) => void>(() => {});

  // Incremented after historical bars finish loading so the markers effect
  // re-runs with a populated barHistoryRef (post-entry markers arrive via a
  // separate fast fetch that often completes before the bar history).
  const [barsVersion, setBarsVersion] = useState(0);
  // Flips once per symbol after the bulk-history setData lands. The levels
  // effect uses this to defer its first render until the chart has candles —
  // without piggy-backing on barsVersion, which bumps every new-bar bucket
  // and every dynamic-loader fetch and would otherwise re-render every
  // level line on each bump.
  const [historyReady, setHistoryReady] = useState<Record<string, boolean>>({});

  const [activePanel, setActivePanel] = useState<'regime' | 'bias' | null>(null);
  const panelWrapRef = useRef<HTMLDivElement>(null);

  // ── Drawing tool refs/state ──────────────────────────────────────────────
  const svgRef = useRef<SVGSVGElement>(null);
  const drawingsRef = useRef<Drawing[]>([]);
  const drawModeRef = useRef<DrawMode>(null);
  const pendingLineRef = useRef<{ time: number; price: number } | null>(null);
  const previewMouseRef = useRef<{ x: number; y: number } | null>(null);
  const renderDrawingsRef = useRef<() => void>(() => {});
  const [drawMode, setDrawModeState] = useState<DrawMode>(null);
  const [textInput, setTextInput] = useState<{ x: number; y: number; time: number; price: number } | null>(null);
  const [textValue, setTextValue] = useState('');
  const [regimeCheckpoints, setRegimeCheckpoints] = useState<CheckpointData[]>([]);
  // QUALIFIED and TRADABLE are mutually exclusive — exactly one of them is
  // active at any time. EXPERIMENTAL is an independent toggle that can layer
  // on top of either (it shows force-shadow rule markers — expl, etc).
  //
  // Default: QUALIFIED + TRADABLE + FLOW + TAPE on; EXPERIMENTAL / HEAT / DRIFT off.
  const [showQualified,    setShowQualified]    = useState(true);
  const [showTradable,     setShowTradable]     = useState(true);
  const [showExperimental, setShowExperimental] = useState(false);
  const [heatOn, setHeatOn] = useState(false);
  const [flowOn, setFlowOn] = useState(true);
  const [driftOn, setDriftOn] = useState(false);
  const [tapeOn, setTapeOn] = useState(true);
  // Live TAPE display filter — which event kinds to draw + a min-size floor (dial density here).
  // All bar settings PERSIST to localStorage (user 2026-07-21: no resets on refresh); floors and
  // enums are re-validated on load so a stale blob can never wedge the controls illegal.
  const [tapeKinds, setTapeKinds] = useState<Set<TapeKind>>(() => {
    const p = loadTapePrefs();
    return p?.kinds ? new Set(p.kinds.filter((k): k is TapeKind => (ALL_KINDS as string[]).includes(k))) : new Set(ALL_KINDS);
  });
  const [tapeMinSizes, setTapeMinSizes] = useState<Record<TapeKind, number>>(() => {
    const base = floorMinSize(); const p = loadTapePrefs();
    if (p?.minSizes) for (const k of ALL_KINDS) if (typeof p.minSizes[k] === 'number') base[k] = Math.max(TAPE_FLOORS[k].size, p.minSizes[k]!);
    return base;
  });
  const [tapeMinLevels, setTapeMinLevels] = useState<Record<TapeKind, number>>(() => {
    const base = floorMinLevels(); const p = loadTapePrefs();
    if (p?.minLevels) for (const k of ALL_KINDS) if (typeof p.minLevels[k] === 'number') base[k] = Math.max(base[k], p.minLevels[k]!);
    return base;
  });
  // percentile display mode: dials become session-aware percentiles (RTH vs overnight per event)
  const [tapePctMode, setTapePctMode] = useState(() => loadTapePrefs()?.pctMode ?? false);
  const [tapeMinPct, setTapeMinPct] = useState<Partial<Record<TapeKind, 0 | 50 | 80 | 95>>>(() => {
    const p = loadTapePrefs();
    const out: Partial<Record<TapeKind, 0 | 50 | 80 | 95>> = { sweep: 80, block: 80, stacked: 80 };
    if (p?.minPct) for (const k of ALL_KINDS) { const v = p.minPct[k]; if (v === 0 || v === 50 || v === 80 || v === 95) out[k] = v; }
    return out;
  });
  const [tapeCal, setTapeCal] = useState<CalDoc | null>(null);   // /tape/calibration payload (nightly-refreshed)
  const [iceBucketTicks, setIceBucketTicks] = useState(() => Math.max(1, loadTapePrefs()?.iceBucketTicks ?? 4));
  const [confTopN, setConfTopN] = useState(() => Math.max(1, loadTapePrefs()?.confTopN ?? 8));
  const [confMinTier, setConfMinTier] = useState(() => { const v = loadTapePrefs()?.confMinTier; return v === 1 || v === 2 || v === 3 ? v : 2; });

  // persist on any change (tiny blob, no debounce needed)
  useEffect(() => {
    try {
      localStorage.setItem(TAPE_PREFS_KEY, JSON.stringify({
        kinds: [...tapeKinds], minSizes: tapeMinSizes, minLevels: tapeMinLevels,
        pctMode: tapePctMode, minPct: tapeMinPct,
        iceBucketTicks, confTopN, confMinTier,
      }));
    } catch { /* storage full/blocked — settings just won't persist */ }
  }, [tapeKinds, tapeMinSizes, tapeMinLevels, tapePctMode, tapeMinPct, iceBucketTicks, confTopN, confMinTier]);
  const qualifiedTsRef    = useRef<Set<number>>(new Set());
  const tradableTsRef     = useRef<Set<number>>(new Set());
  const experimentalTsRef = useRef<Set<number>>(new Set());
  // Full signal payloads keyed by minute-bucket so the markers code can render
  // the SAME rich markers (FLIP↑/↓+score, CONT, etc.) for historical signals
  // that it does for live ones in `recentSignals`. Populated by the
  // /signals/marks fetch — server returns full ConfluenceSignal objects now,
  // not just timestamps, so old signals render as proper arrows instead of dots.
  const qualifiedSignalsRef    = useRef<Map<number, ConfluenceSignal>>(new Map());
  const tradableSignalsRef     = useRef<Map<number, ConfluenceSignal>>(new Map());
  const experimentalSignalsRef = useRef<Map<number, ConfluenceSignal>>(new Map());
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarDate, setCalendarDate] = useState<string>(() => {
    // Default to today (ET-naive YYYY-MM-DD) — matches the offset used elsewhere
    const ET_OFFSET_MS = 4 * 60 * 60_000;
    const d = new Date(Date.now() - ET_OFFSET_MS);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  });
  const soundOn    = useStore((s) => s.soundOn);
  const setSoundOn = useStore((s) => s.setSoundOn);
  // Tracks signal timestamps already alerted so we don't re-fire on re-renders
  // or on the initial snapshot load (signals older than 5 min are pre-seeded silently).
  const seenSignalsRef = useRef<Set<number>>(new Set());
  // Single shared AudioContext — created on first interaction, reused thereafter.
  // Browsers suspend it when the tab is hidden; we resume it on visibilitychange
  // so sounds work reliably after switching tabs.
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Resume the AudioContext whenever this tab comes back into focus.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && audioCtxRef.current?.state === 'suspended') {
        audioCtxRef.current.resume();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Close the active panel on click outside the three-button group
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelWrapRef.current && !panelWrapRef.current.contains(e.target as Node)) {
        setActivePanel(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const setDrawMode = (mode: DrawMode) => {
    drawModeRef.current = mode;
    setDrawModeState(mode);
    if (mode !== 'line') pendingLineRef.current = null;
    previewMouseRef.current = null;
    renderDrawingsRef.current();
  };

  // ESC cancels current draw operation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        drawModeRef.current = null;
        setDrawModeState(null);
        pendingLineRef.current = null;
        previewMouseRef.current = null;
        renderDrawingsRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [cardPositions, setCardPositions] = useState<
    { sig: ConfluenceSignal; x: number; y: number; id: string }[]
  >([]);
  // Stable ref so the chart's subscribeVisibleLogicalRangeChange subscription
  // always calls the latest closure without needing to re-subscribe.
  const computeCardsRef = useRef<() => void>(() => {});

  const selectedSymbol    = useStore((s) => s.selectedSymbol);
  const selectedTimeframe = useStore((s) => s.selectedTimeframe);

  // Live heatmap lifecycle: when ON, open the per-symbol feed and attach the primitive
  // to the (possibly recreated) candle series; when OFF, disable drawing and close the
  // feed to stop the stream. barsVersion re-runs this after a symbol-switch series rebuild.
  useEffect(() => {
    if (!heatOn) {
      heatmapRef.current?.setEnabled(false);
      heatmapRef.current = null;
      heatmapFeedRef.current?.close();
      heatmapFeedRef.current = null;
      return;
    }
    const s = seriesRef.current;
    if (!s) return;
    if (!heatmapFeedRef.current) heatmapFeedRef.current = new HeatmapFeed(selectedSymbol);
    else heatmapFeedRef.current.setSymbol(selectedSymbol);
    if (!heatmapRef.current || heatmapRef.current.series !== s) {
      heatmapRef.current = new HeatmapPrimitive(heatmapFeedRef.current);
      try { (s as unknown as { attachPrimitive: (p: unknown) => void }).attachPrimitive(heatmapRef.current); } catch { /* older LWC */ }
    }
    heatmapRef.current.setBarSeconds(selectedTimeframe * 60);   // px-per-second anchor for the heatmap's live time→x mapping
    heatmapRef.current.setEnabled(true);
  }, [heatOn, selectedSymbol, barsVersion, selectedTimeframe]);

  // Close the live feed on unmount so the WS doesn't leak.
  useEffect(() => () => { heatmapFeedRef.current?.close(); heatmapFeedRef.current = null; }, []);

  // Live TAPE marker lifecycle — mirrors the heatmap: open the per-symbol event feed and attach
  // the marker primitive when ON; disable + close when OFF.
  useEffect(() => {
    if (!tapeOn) {
      tapeOnRef.current = false;
      tapeLoadedRef.current = { from: Infinity, to: 0 };
      tapeRef.current?.setEnabled(false);
      tapeRef.current = null;
      tapeFeedRef.current?.close();
      tapeFeedRef.current = null;
      return;
    }
    const s = seriesRef.current;
    if (!s) return;
    if (!tapeFeedRef.current) tapeFeedRef.current = new TapeFeed(selectedSymbol);
    else tapeFeedRef.current.setSymbol(selectedSymbol);
    if (!tapeRef.current || tapeRef.current.series !== s) {
      tapeRef.current = new TapePrimitive(tapeFeedRef.current);
      try { (s as unknown as { attachPrimitive: (p: unknown) => void }).attachPrimitive(tapeRef.current); } catch { /* older LWC */ }
    }
    tapeRef.current.setBarSeconds(selectedTimeframe * 60);
    tapeRef.current.setIceBucketTicks(iceBucketTicks);
    tapeRef.current.setConfTopN(confTopN);
    tapeRef.current.setConfMinTier(confMinTier);
    tapeRef.current.setEnabled(true);
    tapeFeedRef.current.setFilter({ kinds: tapeKinds, minSize: tapeMinSizes, minLevels: tapeMinLevels, pctMode: tapePctMode, minPct: tapeMinPct, cal: tapeCal, symbol: selectedSymbol });

    // Durable backfill: load persisted markers for the currently-visible range so they persist
    // across reload/scroll/toggle. Scrolling into older history refetches via the sub below.
    tapeOnRef.current = true;
    tapeLoadedRef.current = { from: Infinity, to: 0 };
    const vr = chartRef.current?.timeScale().getVisibleRange();
    if (vr && typeof vr.from === 'number' && typeof vr.to === 'number') {
      const fromSec = vr.from as number, toSec = vr.to as number;
      const padSec = (toSec - fromSec) || 3600;
      tapeLoadedRef.current = { from: fromSec - padSec, to: toSec + padSec };
      void tapeFeedRef.current.loadRange(fromSec - padSec, toSec + padSec);
    }
  }, [tapeOn, selectedSymbol, barsVersion, selectedTimeframe]);

  // Push filter changes to the live feed (redraws with the new density) without reconnecting.
  useEffect(() => {
    tapeFeedRef.current?.setFilter({ kinds: tapeKinds, minSize: tapeMinSizes, minLevels: tapeMinLevels, pctMode: tapePctMode, minPct: tapeMinPct, cal: tapeCal, symbol: selectedSymbol });
  }, [tapeKinds, tapeMinSizes, tapeMinLevels, tapePctMode, tapeMinPct, tapeCal, selectedSymbol]);

  // calibration tables for percentile mode — fetch on mount, refresh every 30 min (the nightly
  // recalibration rewrites the file; the aggregator caches it 5 min)
  useEffect(() => {
    let dead = false;
    const load = () => fetch('/tape/calibration').then((r) => r.json()).then((j) => { if (!dead && j && typeof j === 'object') setTapeCal(j as CalDoc); }).catch(() => { /* keep last */ });
    load();
    const id = setInterval(load, 30 * 60_000);
    return () => { dead = true; clearInterval(id); };
  }, []);

  // Push the iceberg roll-up bucket size + confluence top-N live.
  useEffect(() => { tapeRef.current?.setIceBucketTicks(iceBucketTicks); }, [iceBucketTicks]);
  useEffect(() => { tapeRef.current?.setConfTopN(confTopN); }, [confTopN]);
  useEffect(() => { tapeRef.current?.setConfMinTier(confMinTier); }, [confMinTier]);

  useEffect(() => () => { tapeFeedRef.current?.close(); tapeFeedRef.current = null; }, []);

  // Ranked "TOP ICEBERGS in view" readout — mirrors the primitive's ON-SCREEN top set (same dedup +
  // ranking that drives the in-place labels), so panel + labels always agree and both track the
  // viewport as you pan. Polled; skips re-render when the set is unchanged (stable event refs).
  useEffect(() => {
    if (!tapeOn) { setTopIce([]); return; }
    const compute = () => {
      const t = tapeRef.current?.topIce ?? [];
      // compare by VALUE — the primitive rebuilds these objects on every canvas draw, and episodic
      // icebergs redraw constantly (active-episode updates), so reference-compare re-rendered the
      // whole cockpit every poll tick (2Hz flashing)
      const same = (p: TapeEvent, q: TapeEvent): boolean =>
        p.t === q.t && p.price === q.price && p.size === q.size && p.side === q.side &&
        p.refills === q.refills && p.native === q.native && p.state === q.state &&
        p.exec === q.exec && p.queueCt === q.queueCt;
      setTopIce((prev) => (prev.length === t.length && prev.every((p, i) => same(p, t[i]!)) ? prev : [...t]));
      // keep the on-chart liveness gauges aging during quiet tape — the primitive draws
      // RELOAD/LIVE/COOLING/STALE from wall-clock reload age, so nudge a repaint each poll
      tapeRef.current?.refresh();
      try { const w = chartRef.current?.priceScale('right').width(); if (typeof w === 'number' && w > 0) setPriceScaleW((pw) => (Math.abs(pw - w) < 1 ? pw : w)); } catch { /* noop */ }
    };
    compute();
    const id = setInterval(compute, 500);
    return () => clearInterval(id);
  }, [tapeOn]);
  const levelsByDay    = useStore((s) => s.levelsByDay);
  const flashAlpha     = useStore((s) => s.flashAlpha[s.selectedSymbol]);
  const recentEvents   = useStore((s) => s.recentEvents);
  const recentSignals  = useStore((s) => s.recentSignals);

  // Fetch the set of "qualified" and "V3-OPEN" signal-timestamp buckets so
  // the chart can render only the relevant markers when those toggles are on.
  //
  // Two behaviours wired here:
  //   1. On symbol change: reset the loaded ranges and fetch the last 30 days.
  //      Polls every 60s for new live decisions arriving since the last fetch.
  //   2. On chart pan past the earliest loaded timestamp: the chart's
  //      subscribeVisibleTimeRangeChange (further below) calls
  //      loadMarksRef.current(sinceMs) — this effect's fetcher extends the
  //      window back to cover the new range and merges into the existing
  //      Sets, so existing markers don't blink off during the fetch.
  useEffect(() => {
    let cancelled = false;

    const fetchSince = async (sinceMs: number) => {
      try {
        const res = await fetch(`/signals/marks?symbol=${selectedSymbol}&sinceMs=${sinceMs}`);
        if (!res.ok) return;
        const data = await res.json() as {
          qualifiedTs:    number[];
          tradableTs?:    number[];
          experimentalTs?: number[];
          qualifiedSignals?:    ConfluenceSignal[];
          tradableSignals?:     ConfluenceSignal[];
          experimentalSignals?: ConfluenceSignal[];
        };
        // Refs are mutable state shared across effect closures, so a fetch
        // initiated by an already-cancelled closure (React StrictMode dev
        // double-mount) still carries valid data the new closure would have
        // fetched anyway — merge unconditionally. Only state updates respect
        // `cancelled` to avoid spurious re-renders on a stale closure.
        for (const ts of data.qualifiedTs)         qualifiedTsRef.current.add(ts);
        for (const ts of data.tradableTs ?? [])    tradableTsRef.current.add(ts);
        for (const ts of data.experimentalTs ?? []) experimentalTsRef.current.add(ts);
        // Store the full payloads keyed by minute-bucket so markers can
        // render rich rule-specific arrows for historical signals.
        for (const sig of data.qualifiedSignals ?? []) {
          qualifiedSignalsRef.current.set(Math.floor(sig.ts / 60000) * 60, sig);
        }
        for (const sig of data.tradableSignals ?? []) {
          tradableSignalsRef.current.set(Math.floor(sig.ts / 60000) * 60, sig);
        }
        for (const sig of data.experimentalSignals ?? []) {
          experimentalSignalsRef.current.set(Math.floor(sig.ts / 60000) * 60, sig);
        }
        marksLoadedFromMsRef.current = Math.min(marksLoadedFromMsRef.current, sinceMs);
        if (!cancelled) setBarsVersion(v => v + 1);
      } catch { /* best-effort */ }
    };

    // Reset for the new symbol.
    qualifiedTsRef.current    = new Set();
    tradableTsRef.current     = new Set();
    experimentalTsRef.current = new Set();
    qualifiedSignalsRef.current    = new Map();
    tradableSignalsRef.current     = new Map();
    experimentalSignalsRef.current = new Map();
    marksLoadedFromMsRef.current = Date.now();

    // Initial fetch — last 30 days covers the typical scroll-back window.
    const initialSince = Date.now() - 30 * 24 * 60 * 60 * 1000;
    fetchSince(initialSince);

    // Expose the fetcher to the visible-time-range subscriber. Re-arm on
    // every symbol change so the closure stays current.
    loadMarksRef.current = (sinceMs: number) => { void fetchSince(sinceMs); };

    // 60s poll for new decisions. We just re-pull the same window — the
    // server-side query is sub-10ms even over 30 days at the current
    // qualified_signals size (~12k rows total).
    const id = setInterval(() => {
      void fetchSince(marksLoadedFromMsRef.current);
    }, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [selectedSymbol]);

  // Clear bar history when timeframe changes so historical bars re-fetch
  useEffect(() => {
    barHistoryRef.current[selectedSymbol] = new Map();
    // Loaded ranges are per (symbol, timeframe) — clear only the active key
    // so a timeframe change forces a re-fetch but other (symbol, tf) caches stay.
    loadedRangesRef.current[`${selectedSymbol}:${selectedTimeframe}`] = [];
    // Re-gate live-bar setData calls until the new history fetch lands.
    historyLoadedRef.current[selectedSymbol] = false;
    setHistoryReady((prev) => prev[selectedSymbol] === false ? prev : { ...prev, [selectedSymbol]: false });
  }, [selectedTimeframe]); // eslint-disable-line react-hooks/exhaustive-deps

  // Dynamic-load callback: when the user scrolls the chart, fetch any
  // uncovered portion of the visible range. Re-bound each time symbol or
  // timeframe changes so it always closes over the active selection.
  useEffect(() => {
    dynamicLoadRef.current = async (visibleFromMs: number, visibleToMs: number) => {
      const series = seriesRef.current;
      if (!series) return;

      // Pad by 25% of visible width on each side so adjacent scrolls don't
      // need another fetch immediately — but never more than 7 days at once.
      const span = visibleToMs - visibleFromMs;
      const PAD = Math.min(span * 0.25, 7 * 24 * 60 * 60_000);
      let fromMs = visibleFromMs - PAD;
      let toMs   = visibleToMs   + PAD;
      // Don't try to fetch the future
      const nowMs = Date.now();
      if (toMs > nowMs) toMs = nowMs;
      if (fromMs >= toMs) return;

      const rk = `${selectedSymbol}:${selectedTimeframe}`;
      const gaps = gapsToFetch(loadedRangesRef.current[rk] ?? [], fromMs, toMs);
      if (gaps.length === 0) return;

      // Bail if any fetch for this key is already in flight — we'll catch the
      // missing range on the next scroll event.
      if (fetchInFlightRef.current.has(rk)) return;
      fetchInFlightRef.current.add(rk);

      try {
        for (const [gFrom, gTo] of gaps) {
          const url = `/history/bars?symbol=${selectedSymbol}&from=${gFrom}&to=${gTo}&interval=${selectedTimeframe}`;
          const res = await fetch(url);
          if (!res.ok) continue;
          const data = await res.json() as {
            bars: { ts: number; open: number; high: number; low: number; close: number; buyVolume: number; sellVolume: number }[];
          };
          const history = barHistoryRef.current[selectedSymbol] ?? new Map();
          barHistoryRef.current[selectedSymbol] = history;
          for (const bar of data.bars) {
            const t = Math.floor(bar.ts / 1000);
            if (!history.has(t)) {
              history.set(t, {
                open: bar.open, high: bar.high, low: bar.low, close: bar.close,
                volume: (bar.buyVolume ?? 0) + (bar.sellVolume ?? 0),
              });
            }
          }
          loadedRangesRef.current[rk] = recordLoadedRange(loadedRangesRef.current[rk] ?? [], gFrom, gTo, Date.now());
        }

        // Single setData() after all gaps loaded to avoid mid-scroll flicker.
        const history = barHistoryRef.current[selectedSymbol];
        if (history && history.size > 0) {
          const seriesData = Array.from(history.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([t, b]) => ({
              time: t as UTCTimestamp,
              open: b.open, high: b.high, low: b.low, close: b.close,
            }));
          series.setData(seriesData);
          lastLiveSecRef.current[selectedSymbol] = seriesData[seriesData.length - 1]!.time as number;
        }
        setBarsVersion(v => v + 1);
      } finally {
        fetchInFlightRef.current.delete(rk);
      }
    };
  }, [selectedSymbol, selectedTimeframe]);

  // Init chart once
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#0a0a0b' },
        textColor: '#a8a8b0',
        fontFamily: 'Geist Mono, monospace',
        fontSize: 13,  // bumped 11 → 13 for marker readability
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      timeScale: {
        borderColor: '#28282f',
        visible: true,
        timeVisible: true,
        secondsVisible: true,
        // Don't auto-shift the visible range when new bars arrive — user
        // owns the view position. Without this, every new live bar yanks
        // the chart right and re-centers, breaking your scroll position.
        shiftVisibleRangeOnNewBar: false,
        // Reserve a fixed strip of space for the time axis at the bottom.
        // Without this, the row can compress into nothing on tight layouts.
        rightOffset: 5,
        // Floor on candle width. Without this, narrow chart widths can
        // over-compress bars to where no tick-mark anchor lands in view
        // and the time axis row appears empty after resize.
        minBarSpacing: 4,
        // Fixed candle width - prevents stretched rectangles when the chart
        // has few bars. Default is 6 (extremely tight); 12 gives breathing room.
        barSpacing: 12,
        // Display all chart times in America/New_York timezone (handles EST/EDT auto)
        tickMarkFormatter: (time: number) => {
          const date = new Date(time * 1000);
          return date.toLocaleTimeString('en-US', {
            timeZone: 'America/New_York',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });
        },
      },
      localization: {
        // Crosshair tooltip on hover also uses NY time
        timeFormatter: (time: number) => {
          const date = new Date(time * 1000);
          return date.toLocaleString('en-US', {
            timeZone: 'America/New_York',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          });
        },
      },
      rightPriceScale: {
        borderColor: '#28282f',
        // Keep tight margins so price action fills the chart vertically.
        scaleMargins: { top: 0.05, bottom: 0.05 },
      },
      crosshair: { mode: CrosshairMode.Normal },
    });
    chartRef.current = chart;
    (window as any).__cockpitChart = chart;  // CDP navigation hook

    // Hover tooltip for TAPE markers — hit-test the crosshair against drawn marker positions.
    chart.subscribeCrosshairMove((param) => {
      const pt = param.point;
      const evs = (tapeOnRef.current && tapeRef.current && pt)
        ? tapeRef.current.hitTestAll(pt.x as number, pt.y as number)
        : [];
      if (!evs.length) { if (tapeTipEvRef.current) { tapeTipEvRef.current = null; setTapeTip(null); } return; }
      tapeTipEvRef.current = evs[0]!;
      setTapeTip({ evs, x: pt!.x as number, y: pt!.y as number });
    });

    // Canvas + webfont race: lightweight-charts paints the axis/labels before
    // the Google webfont (Geist Mono) finishes downloading, so it falls back to
    // system mono and never redraws on its own. Force the font to load, then
    // re-apply the layout font to trigger a repaint with Geist Mono.
    if (typeof document !== 'undefined' && (document as any).fonts) {
      const fonts = (document as any).fonts;
      Promise.all([
        fonts.load('400 13px "Geist Mono"'),
        fonts.load('700 13px "Geist Mono"'),
      ]).catch(() => {});
      fonts.ready.then(() => {
        try { chart.applyOptions({ layout: { fontFamily: 'Geist Mono, monospace' } }); } catch { /* chart disposed */ }
      }).catch(() => {});
    }

    // Suppress lightweight-charts' default fitContent autoscale. Without this,
    // every series.setData() call (level lines, FlashAlpha lines, VWAP, the
    // bulk history) triggers an auto-fit pass against ALL series' time ranges,
    // so the chart visibly settles 2-3 times in the first few seconds as
    // different sources land (FlashAlpha spans 31 days, level lines 24 hours,
    // candles ~7 days). Pinning a logical range up front makes every subsequent
    // setData a no-op for the visible window — the history-fetch handler is
    // the only place that gets to move it.
    chart.timeScale().setVisibleLogicalRange({ from: 0, to: 100 });

    seriesRef.current = chart.addCandlestickSeries({
      upColor: '#2bb673',
      downColor: '#d64545',
      borderUpColor: '#2bb673',
      borderDownColor: '#d64545',
      wickUpColor: '#2bb673',
      wickDownColor: '#d64545',
      // Pad the candle's natural price range symmetrically so the candles
      // sit in the middle ~20% of the vertical space (with room above/below
      // for nearby level lines like MHP / POC / VAL / ON HP). Without this,
      // lightweight-charts fits candles to fill 90% of the chart vertically —
      // and combined with the level-line exclusion below, that would zoom
      // tight on candles only and clip every level out of view.
      autoscaleInfoProvider: (orig) => {
        const base = orig();
        if (!base || !base.priceRange) return base;
        const { minValue, maxValue } = base.priceRange;
        const range = maxValue - minValue;
        if (range <= 0) return base;
        const pad = range * 2;
        return {
          ...base,
          priceRange: { minValue: minValue - pad, maxValue: maxValue + pad },
        };
      },
    });

    vwapSeriesRef.current = chart.addLineSeries({
      color: '#f59e0b',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
      title: 'VWAP',
    });

    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      computeCardsRef.current();
      renderDrawingsRef.current();
    });

    // Dynamic loader: when the visible time window changes, queue a debounced
    // fetch for any uncovered range. The loader itself bails out fast if the
    // range is already loaded, so we can poll generously on every event.
    //
    // Also extends the qualified/V3 marks window if the user scrolled past
    // the earliest already-fetched timestamp. Marks fire immediately on the
    // range-change event (no debounce) since the server-side query is ~4ms
    // and the user is actively scrolling — they want to see the new markers
    // as fast as possible. The marks-fetcher itself dedupes in-flight calls.
    chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
      if (!range) return;
      const fromMs = (range.from as number) * 1000;
      const toMs   = (range.to   as number) * 1000;

      // Marks: extend the loaded window if visible 'from' is older than what
      // we've fetched. Pad by 15 days so the next small pan doesn't re-trigger.
      if (fromMs < marksLoadedFromMsRef.current) {
        const padMs   = 15 * 24 * 60 * 60 * 1000;
        const newFrom = fromMs - padMs;
        loadMarksRef.current(newFrom);
      }

      // Bars: debounced 250ms — heavier query, and the user is usually
      // mid-scroll so deferring avoids dozens of partial fetches.
      if (dynamicLoadTimerRef.current) clearTimeout(dynamicLoadTimerRef.current);
      dynamicLoadTimerRef.current = setTimeout(() => {
        dynamicLoadRef.current(fromMs, toMs);
      }, 250);

      // Tape markers: refetch persisted events when the view moves outside the loaded window
      // (fast indexed range query). Pad by a viewport so small pans don't re-trigger.
      if (tapeOnRef.current && tapeFeedRef.current) {
        const fromSec = fromMs / 1000, toSec = toMs / 1000;
        const L = tapeLoadedRef.current;
        if (fromSec < L.from || toSec > L.to) {
          const padSec = (toSec - fromSec) || 3600;
          const nf = fromSec - padSec, nt = toSec + padSec;
          tapeLoadedRef.current = { from: nf, to: nt };
          void tapeFeedRef.current.loadRange(nf, nt);
        }
      }
    });

    // Shared scroll-restore logic — call after chart.applyOptions() has run.
    // atRightEdge: true  → snap to real time (live data visible)
    //              false → restore exact logical range (scrolled back in history)
    const restoreScroll = (ts: ReturnType<typeof chart.timeScale>, atRightEdge: boolean, visibleRange: ReturnType<typeof ts.getVisibleLogicalRange>) => {
      try {
        if (atRightEdge) ts.scrollToRealTime();
        else if (visibleRange) ts.setVisibleLogicalRange(visibleRange);
      } catch { /* chart disposed */ }
    };

    // Window resize — queueMicrotask is fast enough; window events are
    // already debounced by the browser so there's no rapid-fire risk.
    const onWindowResize = () => {
      if (!containerRef.current || !chart) return;
      const ts = chart.timeScale();
      const visibleRange = ts.getVisibleLogicalRange();
      const atRightEdge = ts.scrollPosition() >= 0;
      chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
      queueMicrotask(() => restoreScroll(ts, atRightEdge, visibleRange));
    };

    onWindowResize();
    window.addEventListener('resize', onWindowResize);

    // Container resize (signal panel open/close) — lightweight-charts does
    // internal async processing after applyOptions(); a plain microtask fires
    // before that settles, so our scrollToRealTime() gets overwritten.
    // setTimeout(0) runs after all pending microtasks, giving lwc time to
    // finish its own layout pass before we correct the scroll position.
    let roTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (!containerRef.current || !chart) return;
      const ts = chart.timeScale();
      const visibleRange = ts.getVisibleLogicalRange();
      const atRightEdge = ts.scrollPosition() >= 0;
      chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
      if (roTimer !== null) clearTimeout(roTimer);
      roTimer = setTimeout(() => restoreScroll(ts, atRightEdge, visibleRange), 0);
    });
    ro.observe(containerRef.current);

    // Mousewheel zoom on the price axis. Lightweight-charts' default
    // axis-drag is a pan (shifts the visible range without resizing it),
    // not a zoom. To get TradingView-style "drag/scroll on axis to zoom
    // price" behavior, we intercept wheel events over the price-axis area
    // and adjust scaleMargins.
    //
    // scaleMargins.top + scaleMargins.bottom must stay < 1.0 (sum of
    // margins). Increasing them shrinks the data area, making candles
    // smaller (more price range visible). Decreasing zooms in.
    const priceAxisMargins = { top: 0.05, bottom: 0.05 };
    const onWheelOverAxis = (e: WheelEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      // Price axis is on the right side; assume rightmost ~64px is axis area.
      // Lightweight-charts default right-axis width is ~64px depending on font.
      const axisStartX = rect.right - 80;
      if (e.clientX < axisStartX) return; // not over the axis
      e.preventDefault();

      const delta = e.deltaY;
      // Scroll down = expand range (candles smaller), scroll up = compress
      // range (candles bigger). Step size is 0.02 per wheel notch.
      const step = delta > 0 ? 0.02 : -0.02;
      let nextTop = priceAxisMargins.top + step;
      let nextBottom = priceAxisMargins.bottom + step;
      // Clamp so the data area never disappears or inverts.
      nextTop = Math.max(0.0, Math.min(0.45, nextTop));
      nextBottom = Math.max(0.0, Math.min(0.45, nextBottom));
      priceAxisMargins.top = nextTop;
      priceAxisMargins.bottom = nextBottom;
      chart.priceScale('right').applyOptions({
        scaleMargins: { top: nextTop, bottom: nextBottom },
      });
    };
    containerRef.current.addEventListener('wheel', onWheelOverAxis, { passive: false });

    return () => {
      window.removeEventListener('resize', onWindowResize);
      ro.disconnect();
      if (roTimer !== null) clearTimeout(roTimer);
      if (containerRef.current) {
        containerRef.current.removeEventListener('wheel', onWheelOverAxis);
      }
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      vwapSeriesRef.current = null;
      vwapSessionsRef.current.clear();
      levelLinesRef.current = [];
      flashAlphaLinesRef.current = [];
    };
  }, []);

  // Fetch historical bars from the aggregator on mount or symbol change.
  //
  // Fast-path: if barHistoryRef has data for (selectedSymbol, selectedTimeframe)
  // — either left over from an in-session toggle to/from this symbol, or just
  // hydrated from localStorage on cold-boot — we render from cache instantly
  // and only fetch the gap [lastCachedTs → now] to backfill bars the WS feed
  // missed while the other symbol was active or the tab was closed.
  //
  // Slow-path (cold cache, no localStorage hit): existing bulk fetch of the
  // last week, then setData + VWAP from the fetch response.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    let cancelled = false;

    // Helper: render the chart from a bar map (sorted entries → setData,
    // visible-range anchor, VWAP recompute). Shared by the fast and slow paths
    // — and called twice on the fast path (once from cache, once after backfill).
    const renderFromCache = (
      cache: Map<number, { open: number; high: number; low: number; close: number; volume: number }>,
      anchorVisible: boolean,
    ) => {
      const entries = Array.from(cache.entries()).sort((a, b) => a[0] - b[0]);
      if (entries.length === 0) return;
      const seriesData = entries.map(([t, b]) => ({
        time: t as UTCTimestamp,
        open: b.open, high: b.high, low: b.low, close: b.close,
      }));
      // Anchor the visible range BEFORE setData so lightweight-charts skips
      // its autofit pass (otherwise ~1.5s flicker). Skip on backfill renders
      // so we don't jump the user's current pan/zoom.
      if (anchorVisible) {
        const chart = chartRef.current;
        if (chart) {
          const targetBars = Math.min(seriesData.length, Math.floor(240 / selectedTimeframe));
          const lastLogical = seriesData.length - 1;
          chart.timeScale().setVisibleLogicalRange({
            from: lastLogical - targetBars,
            to:   lastLogical + 5,
          });
        }
      }
      series.setData(seriesData);
      // Remember the last bar so live updates can append via series.update()
      // instead of replacing the whole dataset (which fights the user's pan).
      lastLiveSecRef.current[selectedSymbol] = seriesData[seriesData.length - 1]!.time as number;

      // Session VWAP — recompute from the cache so it matches what's on screen.
      // RTH only, volume-weighted (HLC/3), resets per trading day.
      vwapSessionsRef.current.clear();
      const sessAcc = new Map<string, { sumPV: number; sumV: number }>();
      const vwapPoints: { time: UTCTimestamp; value: number }[] = [];
      for (const [t, b] of entries) {
        const tsMs = t * 1000;
        if (!isRTHBar(tsMs)) continue;
        const vol = b.volume ?? 0;
        if (vol === 0) continue;
        const day = tradingDayFor(tsMs);
        let s = sessAcc.get(day);
        if (!s) { s = { sumPV: 0, sumV: 0 }; sessAcc.set(day, s); }
        s.sumPV += ((b.high + b.low + b.close) / 3) * vol;
        s.sumV  += vol;
        vwapPoints.push({ time: t as UTCTimestamp, value: s.sumPV / s.sumV });
        vwapSessionsRef.current.set(day, { sumPV: s.sumPV, sumV: s.sumV, lastBucket: t });
      }
      if (vwapSeriesRef.current && vwapPoints.length > 0) {
        vwapSeriesRef.current.setData(vwapPoints);
      }
    };

    (async () => {
      try {
        // ── Fast-path: in-memory cache or localStorage hydration ──────────
        let cache = barHistoryRef.current[selectedSymbol];
        let loaded = historyLoadedRef.current[selectedSymbol] === true;

        if (!loaded || !cache || cache.size === 0) {
          const hydrated = loadBarsCache(selectedSymbol, selectedTimeframe);
          if (hydrated) {
            cache = hydrated;
            barHistoryRef.current[selectedSymbol] = cache;
            historyLoadedRef.current[selectedSymbol] = true;
            loaded = true;
            // Mark the cached range as covered so the dynamic-scroll loader
            // doesn't re-request it on pan.
            const ks = Array.from(cache.keys()).sort((a, b) => a - b);
            const firstMs = ks[0]! * 1000;
            const lastMs  = ks[ks.length - 1]! * 1000;
            const rk = `${selectedSymbol}:${selectedTimeframe}`;
            loadedRangesRef.current[rk] = mergeRange(
              loadedRangesRef.current[rk] ?? [],
              firstMs,
              lastMs,
            );
          }
        }

        if (loaded && cache && cache.size > 0) {
          renderFromCache(cache, /* anchorVisible= */ true);
          setHistoryReady((prev) =>
            prev[selectedSymbol] ? prev : { ...prev, [selectedSymbol]: true },
          );
          setBarsVersion(v => v + 1);

          // ── Heal INTERIOR holes in the cached range ──────────────────────
          // A WS drop (feed reconnect, dev-server restart, tab throttle) can
          // leave a short run of missing buckets INSIDE the cached range. The
          // forward-only backfill below never re-fetches those — the cache is
          // trusted on reload, so the hole persists across refreshes until the
          // cache is manually cleared (observed 2026-07-06: NQ 09:33–09:37
          // blank after a Vite restart even though /history/bars had the bars).
          // Scan for gaps bounded on BOTH sides by present bars and short
          // enough to be a dropout — not a legitimate overnight/weekend gap —
          // then refetch just that span and merge. Refetching a genuinely-empty
          // minute (no trades) returns nothing, so this is safe if over-eager.
          const bucketMs = selectedTimeframe * 60_000;
          const MAX_HOLE_MS = 90 * 60_000;   // ignore gaps > 90m (overnight/weekend)
          const ksAll = Array.from(cache.keys()).sort((a, b) => a - b);
          let holeFrom = Infinity, holeTo = -Infinity;
          for (let i = 1; i < ksAll.length; i++) {
            const prevMs = ksAll[i - 1]! * 1000, curMs = ksAll[i]! * 1000;
            const gap = curMs - prevMs;
            if (gap > bucketMs && gap <= MAX_HOLE_MS) {
              holeFrom = Math.min(holeFrom, prevMs + bucketMs);
              holeTo   = Math.max(holeTo,   curMs - bucketMs);
            }
          }
          if (holeTo >= holeFrom) {
            const url = `/history/bars?symbol=${selectedSymbol}&from=${holeFrom}&to=${holeTo + bucketMs}&interval=${selectedTimeframe}`;
            const res = await fetch(url);
            if (!cancelled && res.ok) {
              const data = (await res.json()) as {
                bars: { ts: number; open: number; high: number; low: number; close: number; buyVolume: number; sellVolume: number }[];
              };
              let added = false;
              for (const bar of data.bars) {
                const t = Math.floor(bar.ts / 1000);
                if (!cache.has(t)) {
                  cache.set(t, {
                    open: bar.open, high: bar.high, low: bar.low, close: bar.close,
                    volume: (bar.buyVolume ?? 0) + (bar.sellVolume ?? 0),
                  });
                  added = true;
                }
              }
              if (added && !cancelled) { renderFromCache(cache, /* anchorVisible= */ false); setBarsVersion(v => v + 1); }
            }
          }

          // Backfill the gap between last cached bar and now. Skip if the
          // gap is smaller than one TF bucket (cache is already current).
          const ks = Array.from(cache.keys()).sort((a, b) => a - b);
          const lastMs = ks[ks.length - 1]! * 1000;
          const nowMs = Date.now();
          if (nowMs - lastMs > selectedTimeframe * 60_000) {
            const url = `/history/bars?symbol=${selectedSymbol}&from=${lastMs}&to=${nowMs}&interval=${selectedTimeframe}`;
            const res = await fetch(url);
            if (!cancelled && res.ok) {
              const data = (await res.json()) as {
                bars: { ts: number; open: number; high: number; low: number; close: number; buyVolume: number; sellVolume: number }[];
              };
              let added = false;
              for (const bar of data.bars) {
                const t = Math.floor(bar.ts / 1000);
                if (!cache.has(t)) {
                  cache.set(t, {
                    open: bar.open, high: bar.high, low: bar.low, close: bar.close,
                    volume: (bar.buyVolume ?? 0) + (bar.sellVolume ?? 0),
                  });
                  added = true;
                }
              }
              if (added && !cancelled) {
                renderFromCache(cache, /* anchorVisible= */ false);
                const rk = `${selectedSymbol}:${selectedTimeframe}`;
                loadedRangesRef.current[rk] = recordLoadedRange(
                  loadedRangesRef.current[rk] ?? [],
                  lastMs,
                  nowMs,
                  Date.now(),
                );
                setBarsVersion(v => v + 1);
              }
            }
          }
          return;
        }

        // ── Slow-path: cold cache, do the bulk fetch ──────────────────────
        // Chart history: 1 week (10080 minutes). Reduced from 1 month
        // (43200) on 2026-06-04 — month-of-1m-bars was making the cockpit slow.
        // The dynamic-load effect below fills in older windows on demand when
        // the user scrolls left.
        const INITIAL_WINDOW_MIN = 10080;
        const fetchToMs   = Date.now();
        const fetchFromMs = fetchToMs - INITIAL_WINDOW_MIN * 60_000;
        const url = `/history/bars?symbol=${selectedSymbol}&minutes=${INITIAL_WINDOW_MIN}&interval=${selectedTimeframe}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const data = (await res.json()) as {
          bars: { ts: number; open: number; high: number; low: number; close: number; buyVolume: number; sellVolume: number }[];
        };
        if (cancelled) return;

        const history = barHistoryRef.current[selectedSymbol] ?? new Map();
        barHistoryRef.current[selectedSymbol] = history;

        for (const bar of data.bars) {
          const t = Math.floor(bar.ts / 1000);
          // Only set if not already present, so we don't clobber more-recent
          // live bars that may have arrived between mount and fetch return.
          if (!history.has(t)) {
            history.set(t, {
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              volume: (bar.buyVolume ?? 0) + (bar.sellVolume ?? 0),
            });
          }
        }

        renderFromCache(history, /* anchorVisible= */ true);

        // History is now in the series — let live-bar updates start calling
        // setData. (Live bars that arrived during the fetch were buffered into
        // barHistoryRef without rendering, so nothing was dropped.)
        historyLoadedRef.current[selectedSymbol] = true;
        // One-time signal to the levels effect that it can render. State so
        // React re-runs the effect; not piggy-backed on barsVersion because
        // that bumps on every new bar / dynamic fetch and would cause the
        // levels (~100 line series) to tear down and re-add on every bump.
        setHistoryReady((prev) => prev[selectedSymbol] ? prev : { ...prev, [selectedSymbol]: true });
        // Mark this initial window as covered so the dynamic loader skips it.
        const rk = `${selectedSymbol}:${selectedTimeframe}`;
        loadedRangesRef.current[rk] = recordLoadedRange(
          loadedRangesRef.current[rk] ?? [],
          fetchFromMs,
          fetchToMs,
          Date.now(),
        );

        // Signal that bar history is populated so post-entry markers
        // re-evaluate their history.has() check with a full barHistoryRef.
        setBarsVersion(v => v + 1);
      } catch {
        // History fetch is best-effort; live WS updates will still work.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedSymbol, selectedTimeframe]);

  // Persist the active (symbol, timeframe) bar cache to localStorage so a
  // page refresh hits the fast-path on next mount. Saves on a 30s cadence
  // and on tab hide / unload — best-effort, swallows quota errors.
  useEffect(() => {
    const save = () => {
      const cache = barHistoryRef.current[selectedSymbol];
      if (cache && cache.size > 0 && historyLoadedRef.current[selectedSymbol]) {
        saveBarsCache(selectedSymbol, selectedTimeframe, cache);
      }
    };
    const interval = window.setInterval(save, 30_000);
    const onVis = () => { if (document.visibilityState === 'hidden') save(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('beforeunload', save);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('beforeunload', save);
      save();
    };
  }, [selectedSymbol, selectedTimeframe]);

  // ── FAST live-price path (2026-07-20): the addon 'bar' events lag 30-45s behind the market —
  // unusable for managing a position. The flow worker tails the BMD log sub-second and snapshots
  // 1/s; its `last` trade price drives the live candle here, so the chart is ≤~1.5s behind the
  // exchange. The slow bar events still arrive behind it and reconcile OHLC/volume; any stale
  // close they write is re-corrected by the next flow tick within a second. Independent of the
  // FLOW HUD toggle — this connection exists purely to keep the price fresh.
  useEffect(() => {
    let sock: WebSocket | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let dead = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const connect = () => {
      if (dead) return;
      try { sock = new WebSocket(`${proto}://${location.host}/ws/flow?symbol=${selectedSymbol}`); } catch { retry = setTimeout(connect, 3000); return; }
      sock.onopen = () => { ping = setInterval(() => { try { sock && sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify({ type: 'ping' })); } catch { /* noop */ } }, 15000); };
      sock.onclose = () => { if (ping) { clearInterval(ping); ping = null; } if (!dead) retry = setTimeout(connect, 3000); };
      sock.onmessage = (m) => {
        let snap: import('@trading/contracts').FlowSnapshot;
        try { snap = JSON.parse(m.data as string); } catch { return; }
        if (snap.type !== 'flow' || snap.symbol !== selectedSymbol || !snap.last || !snap.lastT) return;
        applyLivePx(snap.last, snap.lastT * 1000);
      };
    };
    // shared live-candle updater — fed by BOTH price sources (tick-store px = primary,
    // flow snapshots = fallback); last write wins, both are the same instrument
    const applyLivePx = (px: number, tsMs: number): void => {
      const series = seriesRef.current;
      if (!series || !historyLoadedRef.current[selectedSymbol]) return;
      const intervalMs = selectedTimeframe * 60_000;
      const t = Math.floor(tsMs / intervalMs) * (intervalMs / 1000);
      const history = barHistoryRef.current[selectedSymbol] ?? new Map();
      barHistoryRef.current[selectedSymbol] = history;
      const ex = history.get(t);
      const bar = ex
        ? { open: ex.open, high: Math.max(ex.high, px), low: Math.min(ex.low, px), close: px, volume: ex.volume }
        : { open: px, high: px, low: px, close: px, volume: 0 };
      history.set(t, bar);
      const prevMax = lastLiveSecRef.current[selectedSymbol];
      if (prevMax === undefined || t < prevMax) return;   // pre-history or stale — the bulk path owns it
      try {
        // series.update() NEVER moves the view — no capture/restore here (the 2026-07-20 bug).
        series.update({ time: t as UTCTimestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
        if (t > prevMax) { lastLiveSecRef.current[selectedSymbol] = t; setBarsVersion((v) => v + 1); }
      } catch { /* out-of-order vs series state — the bulk path will reconcile */ }
    };
    // ── REAL-TIME px lane (2026-07-21): the tick-store gets every trade the instant the addon
    // relays it (no Bookmap log-flush buffering — that path measured p80 2s+ delivery in quiet
    // tape). ≤80ms server throttle + this socket ≈ sub-150ms chart latency.
    let pxSock: WebSocket | null = null;
    let pxRetry: ReturnType<typeof setTimeout> | null = null;
    const pxConnect = () => {
      if (dead) return;
      try { pxSock = new WebSocket(`${proto}://${location.host}/tickstream?symbol=${selectedSymbol}`); } catch { pxRetry = setTimeout(pxConnect, 3000); return; }
      pxSock.onclose = () => { if (!dead) pxRetry = setTimeout(pxConnect, 3000); };
      pxSock.onmessage = (m) => {
        let msg: { type?: string; symbol?: string; ts?: number; price?: number };
        try { msg = JSON.parse(m.data as string); } catch { return; }
        if (msg.type !== 'px' || msg.symbol !== selectedSymbol || !msg.price || !msg.ts) return;
        applyLivePx(msg.price, msg.ts);
      };
    };
    connect();
    pxConnect();
    return () => {
      dead = true;
      if (ping) clearInterval(ping); if (retry) clearTimeout(retry); if (pxRetry) clearTimeout(pxRetry);
      try { sock?.close(); } catch { /* noop */ }
      try { pxSock?.close(); } catch { /* noop */ }
    };
  }, [selectedSymbol, selectedTimeframe]);

  // When recentEvents updates, push new bar events for the selected symbol into the chart.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    const history = barHistoryRef.current[selectedSymbol] ?? new Map();
    barHistoryRef.current[selectedSymbol] = history;

    let updated = false;
    let newBucketCreated = false;
    for (const ev of recentEvents) {
      if ((ev.source !== 'bookmap' && ev.source !== 'bookmap-es') || ev.type !== 'bar') continue;
      if (ev.symbol !== selectedSymbol) continue;

      // Aggregate into selected timeframe
      const intervalMs = selectedTimeframe * 60 * 1000;
      const bucket = Math.floor(ev.ts / intervalMs) * intervalMs;
      const t = Math.floor(bucket / 1000);

      const existing = history.get(t);
      if (!existing) {
        history.set(t, { open: ev.open, high: ev.high, low: ev.low, close: ev.close, volume: ev.volume ?? 0 });
        newBucketCreated = true;
      } else {
        history.set(t, {
          open:   existing.open,
          high:   Math.max(existing.high, ev.high),
          low:    Math.min(existing.low,  ev.low),
          close:  ev.close,
          volume: ev.volume ?? existing.volume,
        });
      }

      // Incrementally update VWAP: only when a new 1-min bucket starts.
      if (vwapSeriesRef.current && isRTHBar(ev.ts)) {
        const vwapBucket = Math.floor(ev.ts / 60_000) * 60;  // 1-min bucket in seconds
        const day = tradingDayFor(ev.ts);
        let sess = vwapSessionsRef.current.get(day);
        if (!sess) { sess = { sumPV: 0, sumV: 0, lastBucket: 0 }; vwapSessionsRef.current.set(day, sess); }
        if (vwapBucket > sess.lastBucket) {
          const vol = ev.volume ?? 0;
          if (vol > 0) {
            sess.sumPV += ((ev.high + ev.low + ev.close) / 3) * vol;
            sess.sumV  += vol;
            sess.lastBucket = vwapBucket;
            vwapSeriesRef.current.update({ time: vwapBucket as UTCTimestamp, value: sess.sumPV / sess.sumV });
          }
        }
      }

      updated = true;
    }
    if (!updated) return;

    // Wait for the bulk-history fetch to land before letting live bars trigger
    // their own setData. Otherwise the first live bar arrives with a tiny
    // history (a handful of buckets), triggers lightweight-charts' default
    // autofit on that range, and the visible window flickers ~1.5s later when
    // the bulk fetch finally lands. Bars themselves are not lost — they're
    // merged into barHistoryRef above and will appear in the bulk setData.
    if (!historyLoadedRef.current[selectedSymbol]) return;

    const data = Array.from(history.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([t, b]) => ({
        time: t as UTCTimestamp,
        open: b.open, high: b.high, low: b.low, close: b.close,
      }));

    // Live updates: use series.update() for the live bar + any newly-formed
    // buckets, which leaves the user's pan/zoom untouched. Only fall back to a
    // full setData() if we have no anchor yet or update() rejects an out-of-order
    // bar. (Previously this called setData() on EVERY bar event, which rebuilt
    // the whole series and made the chart impossible to drag during active tape.)
    const prevMax = lastLiveSecRef.current[selectedSymbol];
    if (prevMax === undefined) {
      series.setData(data);
      lastLiveSecRef.current[selectedSymbol] = data.length ? (data[data.length - 1]!.time as number) : 0;
    } else {
      // series.update() never moves the view, so the update loop needs NO capture/restore.
      // (The old restore-after-every-batch snapped the chart to a stale range while the user was
      // dragging — the 2026-07-20 auto-scroll bug.) Only the rare setData fallback rebuilds the
      // series, so only IT preserves the range, and only when the user isn't at the live edge.
      try {
        let curMax = prevMax;
        for (const bar of data) {
          const t = bar.time as number;
          if (t < prevMax) continue;        // already finalized & older than live bar
          series.update(bar);               // t === prevMax refreshes live bar; t > prevMax appends
          if (t > curMax) curMax = t;
        }
        lastLiveSecRef.current[selectedSymbol] = curMax;
      } catch {
        const ts = chartRef.current?.timeScale();
        const pinnedToLive = ts ? (ts.scrollPosition() ?? 5) >= 4.5 : true; // 5 = chart rightOffset
        const keepRange = pinnedToLive || !ts ? null : ts.getVisibleLogicalRange();
        series.setData(data);               // defensive: out-of-order bar → full redraw
        lastLiveSecRef.current[selectedSymbol] = data.length ? (data[data.length - 1]!.time as number) : prevMax;
        if (keepRange && ts) { try { ts.setVisibleLogicalRange(keepRange); } catch { /* disposed */ } }
      }
    }

    // 2026-06-04 fix: when a new minute bucket appears, bump barsVersion so
    // the markers useEffect re-evaluates. Without this, a signal that
    // arrives BEFORE its bar exists in history is silently dropped (the
    // history.has(bucket) check returns false) and never re-attached when
    // the bar appears moments later. This caused the 09:59 FLIP marker to
    // vanish from the chart on 2026-06-04.
    if (newBucketCreated) setBarsVersion(v => v + 1);

    // No auto-fit. With fixed barSpacing the chart naturally shows the most
    // recent bars at a sensible width and the user can scroll/zoom freely.
  }, [recentEvents, selectedSymbol, selectedTimeframe]);

  // ── Self-healing live-tail poll ────────────────────────────────────────────
  // Live bars normally arrive over the WS (recentEvents → series.update, above).
  // But if that stream stalls — e.g. the upstream data connection drops for a
  // stretch and reconnects mid-session — the WS can miss the resumed bars, and
  // the one-shot gap-backfill in the history effect already ran at mount, so the
  // chart freezes until a manual page refresh (observed 2026-07-01: feed down
  // ~21:35→12:25 ET; candles didn't reappear without a reload even though the
  // backend was serving them).
  // This poll re-fetches the trailing [lastBar → now] window every 20s straight
  // from /history/bars, INDEPENDENT of the WS and of loadedRangesRef, so any
  // reconnect self-heals within one interval. It only touches bars at/after the
  // live edge (series.update semantics), so it can't disturb pan/zoom or clobber
  // history the WS/init paths already rendered.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const pollTail = async () => {
      if (inFlight || cancelled) return;
      const series = seriesRef.current;
      if (!series) return;
      // Cold start is owned by the initial history effect; only tail once it's loaded.
      if (!historyLoadedRef.current[selectedSymbol]) return;
      const prevMax = lastLiveSecRef.current[selectedSymbol];
      if (prevMax === undefined) return;
      const fromMs = prevMax * 1000;
      const nowMs = Date.now();
      if (nowMs - fromMs < 5_000) return;  // nothing new could have formed yet

      inFlight = true;
      try {
        const url = `/history/bars?symbol=${selectedSymbol}&from=${fromMs}&to=${nowMs}&interval=${selectedTimeframe}`;
        const res = await fetch(url);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          bars: { ts: number; open: number; high: number; low: number; close: number; buyVolume: number; sellVolume: number }[];
        };
        if (cancelled || !data.bars?.length) return;

        const history = barHistoryRef.current[selectedSymbol] ?? new Map();
        barHistoryRef.current[selectedSymbol] = history;
        // update()-only path — no view capture/restore (restore-after-update was the auto-scroll
        // bug: it yanked the chart to a stale range on every 20s poll while the user dragged).

        let curMax = prevMax;
        let appended = false;
        try {
          for (const bar of data.bars.slice().sort((a, b) => a.ts - b.ts)) {
            const t = Math.floor(bar.ts / 1000);
            if (t < curMax) continue;  // older than the live edge — update() needs non-decreasing time
            history.set(t, {
              open: bar.open, high: bar.high, low: bar.low, close: bar.close,
              volume: (bar.buyVolume ?? 0) + (bar.sellVolume ?? 0),
            });
            series.update({ time: t as UTCTimestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
            if (t > curMax) { curMax = t; appended = true; }  // t === prevMax just refreshes the live bar
          }
          lastLiveSecRef.current[selectedSymbol] = curMax;
        } catch {
          // Out-of-order rejection — leave recovery to the WS/init paths.
        }
        if (appended && !cancelled) setBarsVersion(v => v + 1);
      } catch {
        // Best-effort — the WS path is still the primary live source.
      } finally {
        inFlight = false;
      }
    };

    const id = setInterval(() => { void pollTail(); }, 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [selectedSymbol, selectedTimeframe]);

  // Compute regime checkpoints from today's bars + levels.
  // Refreshes every 60s during RTH so checkpoints auto-populate as each time arrives.
  useEffect(() => {
    const today = tradingDayFor(Date.now());
    const levels = (levelsByDay as any)[today]?.[selectedSymbol] as RegimeLevels | undefined;
    if (!levels) return;

    let cancelled = false;

    const run = async () => {
      if (cancelled) return;
      try {
        const sym = selectedSymbol;
        const [r1, r2, r3] = await Promise.all([
          fetch(`/history/bars?symbol=${sym}&minutes=600&interval=1`),    // intraday 1-min
          fetch(`/history/bars?symbol=${sym}&minutes=7200&interval=240`),  // 4H  — 5 days
          fetch(`/history/bars?symbol=${sym}&minutes=14400&interval=1440`),// daily — 10 days
        ]);
        if (!r1.ok || !r2.ok || !r3.ok || cancelled) return;
        const [d1, d4h, dD] = await Promise.all([
          r1.json() as Promise<{ bars: RawBar[] }>,
          r2.json() as Promise<{ bars: RawBar[] }>,
          r3.json() as Promise<{ bars: RawBar[] }>,
        ]);
        if (cancelled) return;
        setRegimeCheckpoints(computeRegime(d1.bars, d4h.bars, dD.bars, levels, getRthOpenMs()));
      } catch { /* silent */ }
    };

    run();

    // Poll every 60s during RTH so each checkpoint activates as its time passes
    const etMin = (() => {
      const p = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(new Date());
      const g = (t: string) => p.find(x => x.type === t)?.value ?? '0';
      return parseInt(g('hour'), 10) * 60 + parseInt(g('minute'), 10);
    })();
    let interval: ReturnType<typeof setInterval> | undefined;
    if (etMin >= 569 && etMin < 960) {
      interval = setInterval(run, 60_000);
    }

    return () => { cancelled = true; clearInterval(interval); };
  }, [selectedSymbol, levelsByDay]);

  // Sync per-day level lines when levelsByDay or FA changes.
  // Each level on each day is rendered as a tiny LineSeries with two data
  // points (start = trading-day 09:30 ET, end = next trading-day 09:30 ET).
  // This gives us line segments that only span their own day's bars.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    // Wait for the bulk history setData + visible-range pin before adding any
    // level / FlashAlpha line series. Each of those is a LineSeries with its
    // own time range (24h per level, ~31d for FA) and triggers lightweight-
    // charts' auto-fit pass on setData. If they land before the candle
    // history, the chart settles to their time spans first and then snaps to
    // the candle range a second or two later — visible as a load-time flicker.
    if (!historyLoadedRef.current[selectedSymbol]) return;

    // Tear down all existing level lines + flashAlpha lines
    for (const ls of levelLinesRef.current) {
      try { chart.removeSeries(ls); } catch { /* may already be gone */ }
    }
    levelLinesRef.current = [];
    levelLabelsRef.current = [];
    for (const ls of flashAlphaLinesRef.current) {
      try { chart.removeSeries(ls); } catch { /* may already be gone */ }
    }
    flashAlphaLinesRef.current = [];

    // ── Shaded zone bands (today's RS liquidity-map zones) ──────────────────
    // Full bull/bear bands (top+bottom) shaded behind the candles, colors
    // matching the RS platform (bull #4a4f61, bear #c5b1ab). Attach the
    // primitive once to the candle series, then just refresh its bands.
    {
      const s = seriesRef.current;
      if (s) {
        // Re-attach if the candle series was recreated (symbol switch / HMR),
        // otherwise the primitive is bound to a dead series and nothing draws.
        if (!zoneBandsRef.current || zoneBandsRef.current.series !== s) {
          zoneBandsRef.current = new ZoneBandsPrimitive();
          try { (s as unknown as { attachPrimitive: (p: unknown) => void }).attachPrimitive(zoneBandsRef.current); } catch { /* older LWC */ }
        }
        // Shade EVERY loaded day's zones, each confined to that day's RTH window
        // (09:30→16:00 ET) — so today's bands persist after the close and prior
        // days stay shaded in their own session as you scroll back. DST-aware ET:
        // anchor at UTC = etHour+4 (EDT) then correct if NY came back in EST.
        const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
        const etMs = (y: number, m: number, d: number, h: number) => {
          const naive = new Date(Date.UTC(y, m - 1, d, h + 4, 0, 0));
          return naive.getTime() + (h - parseInt(hourFmt.format(naive), 10)) * 3600_000;
        };
        const bull: { low: number; high: number; from: number; to: number }[] = [];
        const bear: typeof bull = [];
        for (const day of Object.keys(levelsByDay)) {
          const z = levelsByDay[day]?.[selectedSymbol]?.zones;
          if (!z) continue;
          const p = day.split('-').map(Number);
          if (p.length !== 3 || p.some(Number.isNaN)) continue;
          const from = Math.floor((etMs(p[0]!, p[1]!, p[2]!, 9) + 30 * 60_000) / 1000); // 09:30 ET
          const to   = Math.floor(etMs(p[0]!, p[1]!, p[2]!, 16) / 1000);                 // 16:00 ET
          for (const b of (z.bull ?? [])) bull.push({ low: b.low, high: b.high, from, to });
          for (const b of (z.bear ?? [])) bear.push({ low: b.low, high: b.high, from, to });
        }
        zoneBandsRef.current.setBands(bull, bear);
      }
    }

    // Helper: compute the [start, end] timestamps for a trading session in
    // seconds since epoch, suitable for lightweight-charts UTCTimestamp.
    //
    // Session boundaries (matches tradingDayFor() in contracts):
    //   Mon's session: Sun 18:00 → Mon 16:00 ET (special weekend reopen)
    //   Tue–Fri:       prior-day 16:00 → named-day 16:00 ET
    //
    // For Sat/Sun dates (shouldn't appear in practice with new tradingDayFor,
    // but defensive): treat as Mon's-style range.
    const dayBoundsSeconds = (tradingDay: string): { start: number; end: number } => {
      const parts = tradingDay.split('-').map(Number);
      const y = parts[0]!, m = parts[1]!, d = parts[2]!;

      // Determine weekday of this date in ET
      const probeNoon = new Date(Date.UTC(y, m - 1, d, 16, 0, 0)); // ~noon ET
      const dayFmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', weekday: 'short',
      });
      const weekday = dayFmt.format(probeNoon);

      // DST-aware helper: epoch ms for a given ET wall-clock hour on (yy,mm,dd).
      const hourFmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: '2-digit', hour12: false,
      });
      const tsForEt = (yy: number, mm: number, dd: number, etHour: number): number => {
        // Anchor at UTC = etHour+4 (EDT default); if NY hour comes back wrong (EST),
        // correct by the drift.
        const naive = new Date(Date.UTC(yy, mm - 1, dd, etHour + 4, 0, 0));
        const nyHour = parseInt(hourFmt.format(naive), 10);
        return naive.getTime() + (etHour - nyHour) * 60 * 60 * 1000;
      };

      // End = 16:00 ET on tradingDay
      const end = tsForEt(y, m, d, 16);

      // Start = prior calendar day's 16:00 ET, except Mon/Sat/Sun (defensive) → Sun 18:00 ET
      const isMonLike = (weekday === 'Mon' || weekday === 'Sat' || weekday === 'Sun');
      const startHour = isMonLike ? 18 : 16;
      const priorDay = new Date(Date.UTC(y, m - 1, d - 1, 12, 0, 0));
      const start = tsForEt(priorDay.getUTCFullYear(), priorDay.getUTCMonth() + 1, priorDay.getUTCDate(), startHour);

      return { start: Math.floor(start / 1000), end: Math.floor(end / 1000) };
    };

    const styleMap: Record<string, LineStyle> = {
      solid: LineStyle.Solid,
      dashed: LineStyle.Dashed,
      dotted: LineStyle.Dotted,
      'large-dashed': LineStyle.LargeDashed,
      'sparse-dotted': LineStyle.SparseDotted,
    };

    // Tier-1 filter: only the canonical 6 (matches phase1/days.ts TIER1).
    // Everything else (Bull/Bear zones, DD, HP, MHP, IBH/IBL, ON*, VWAPs,
    // pivots, weekly H/L, etc.) is kept in the data + plotting code but
    // hidden from the chart. Flip HIDE_NON_TIER1_LEVELS to false to show
    // everything again.
    const HIDE_NON_TIER1_LEVELS = false;
    const TIER1_LABELS = new Set(['PDH', 'PDL', 'PDC', 'POC', 'VAH', 'VAL']);
    const isTier1 = (label: string) => TIER1_LABELS.has(label);

    // Labels explicitly hidden from the chart (declutter) — case/space-insensitive.
    // (ES Close included as the ES-side equivalent of NQ Close.)
    const HIDE_LABELS = new Set([
      'onval', 'onvah', 'onpoc', 'r1', 's1', 'pivot', 'halfback', 'nq close', 'es close',
      'onl', 'onh', 'pmh', 'pml', 'ono', 'pdc',
    ]);
    const isHidden = (label: string) => HIDE_LABELS.has((label || '').trim().toLowerCase());

    // For each day, render all of that day's levels as line segments.
    // Today's levels show clean labels on the price axis (no date suffix).
    // Past days' levels are visible on the chart but their labels are
    // hidden, so the right-side price axis stays clean.
    const today = tradingDayFor(Date.now());

    for (const [tradingDay, bySymbol] of Object.entries(levelsByDay)) {
      const dayLevels = bySymbol[selectedSymbol];
      if (!dayLevels) continue;
      const { start, end } = dayBoundsSeconds(tradingDay);
      const isToday = tradingDay === today;

      // 2026-06-11: every level (every day, every label) now gets a custom
      // SVG badge anchored to the segment END timestamp (16:00 ET of the
      // level's trading day). The built-in price-axis chip and inline title
      // are both disabled — badges are the single source of label rendering.
      // This way badges scroll with their day's line segment instead of
      // floating at a fixed pane offset, and past-day labels are visible
      // when the user scrolls into history.

      // addLevelLine consults the standardized LEVEL_STYLES palette
      // (packages/contracts/src/level-styles.ts) before falling back to the
      // caller's args. This means daily_levels.json entries with stale
      // colors get auto-canonicalized to the current spec.
      const addLevelLine = (price: number, color: string, title: string, style: LineStyle, width: 1 | 2 | 3 | 4) => {
        if (isHidden(title)) return;
        if (HIDE_NON_TIER1_LEVELS && !isTier1(title)) return;
        const canonical = lookupLevelStyle(title);
        const finalColor = canonical?.color ?? color;
        const finalWidth = canonical?.width ?? width;
        const finalStyle = canonical
          ? (styleMap[canonical.style] ?? style)
          : style;
        const ls = chart.addLineSeries({
          color: finalColor,
          lineWidth: finalWidth,
          lineStyle: finalStyle,
          priceLineVisible: false,
          // SVG badge is the only label — disable both price-axis chip and inline title.
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          title: '',
          // Exclude level lines from the price scale's autoscale calc. With
          // levels like DD↑ at 30650 and ON MHP at 28713 alongside candles at
          // ~29100, default autoscale stretches the price scale across 2000+
          // points and squeezes the candles to the bottom of the chart.
          // Returning null from the provider tells lightweight-charts not to
          // include this series in the price-scale fit. Levels still render
          // wherever they fall within the candle-driven range.
          autoscaleInfoProvider: () => null,
        });
        ls.setData([
          { time: start as UTCTimestamp, value: price },
          { time: end as UTCTimestamp, value: price },
        ]);
        levelLinesRef.current.push(ls);
        levelLabelsRef.current.push({ price, label: title, color: finalColor, startTs: start, endTs: end });
      };

      // Pass clean labels (no date suffix). RS structural lines (Bull/Bear/DD/HP)
      // are optional — skip if the field is absent so instruments without RS
      // framework data (e.g., ES Step 1) render only their additionalLevels.
      // NOTE: the color/style/width args below are now fallbacks — LEVEL_STYLES
      // overrides them when the label matches a known entry.
      // Bull/Bear zones: when only ONE side of the zone is real (the JSON
      // stores low === high to signal "single edge, the other side is not
      // a thing"), draw a SINGLE line labelled with the meaningful side
      // — Bull = bottom edge, Bear = top edge per Ravi's RS convention.
      // When low ≠ high, the zone has width and both edges render as before.
      // Full liquidity-map zone bands: label EVERY bull-zone bottom (BZB) and
      // EVERY bear-zone top (BrZT), matching the shaded bands the zone primitive
      // draws. The `zones` array supersedes the single primary bullZone/bearZone
      // lines below (kept as a fallback for non-RS days without a `zones` field).
      const zb = dayLevels.zones;
      if (zb && (zb.bull.length || zb.bear.length)) {
        for (const z of zb.bull) addLevelLine(z.low,  '#2bb673', 'BZB',  LineStyle.Solid, 1);
        for (const z of zb.bear) addLevelLine(z.high, '#d64545', 'BrZT', LineStyle.Solid, 1);
      } else {
        if (dayLevels.bullZone) {
          if (dayLevels.bullZone.high === dayLevels.bullZone.low) {
            addLevelLine(dayLevels.bullZone.low, '#2bb673', 'Bull Zone Bottom', LineStyle.Solid, 2);
          } else {
            addLevelLine(dayLevels.bullZone.high, '#2bb673', 'Bull H', LineStyle.Solid, 2);
            addLevelLine(dayLevels.bullZone.low,  '#2bb673', 'Bull L', LineStyle.Solid, 2);
          }
        }
        if (dayLevels.bearZone) {
          if (dayLevels.bearZone.high === dayLevels.bearZone.low) {
            addLevelLine(dayLevels.bearZone.high, '#d64545', 'Bear Zone Top', LineStyle.Solid, 2);
          } else {
            addLevelLine(dayLevels.bearZone.high, '#d64545', 'Bear H', LineStyle.Solid, 2);
            addLevelLine(dayLevels.bearZone.low,  '#d64545', 'Bear L', LineStyle.Solid, 2);
          }
        }
      }
      if (dayLevels.ddBands) {
        addLevelLine(dayLevels.ddBands.upper, '#9ee04a', 'DD↑', LineStyle.Solid, 2);
        addLevelLine(dayLevels.ddBands.lower, '#9ee04a', 'DD↓', LineStyle.Solid, 2);
      }
      if (dayLevels.hedgePressure !== undefined) {
        addLevelLine(dayLevels.hedgePressure, '#4a8fdc', 'HP', LineStyle.Solid, 2);
      }
      if (dayLevels.mhp !== undefined) {
        addLevelLine(dayLevels.mhp, '#f2a633', 'MHP', LineStyle.Solid, 2);
      }

      if (dayLevels.additionalLevels) {
        for (const al of dayLevels.additionalLevels) {
          if (isStructuralLevel(al.label)) continue;   // hidden — structural levels (RS-focus declutter)
          addLevelLine(
            al.price,
            al.color ?? '#5a9bff',
            al.label,
            styleMap[al.style ?? 'dashed'] ?? LineStyle.Dashed,
            (al as { width?: 1 | 2 | 3 | 4 }).width ?? 1,
          );
        }
      }
    }

    // FlashAlpha lines: still treated as "always live" (single-day model).
    // These are short-lived and update frequently, so chart-wide is fine.
    if (flashAlpha) {
      const series = seriesRef.current;
      if (series) {
        const addFa = (price: number, color: string, title: string) => {
          // For FA, fall back to chart-wide LineSeries spanning all bars.
          // Without a meaningful date scope, we just paint them across the
          // visible range using a zero-history series with priceLineSource.
          const ls = chart.addLineSeries({
            color,
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            title,
            // Excluded from autoscale — see addLevelLine comment above.
            autoscaleInfoProvider: () => null,
          });
          // Anchor to a wide range so the line covers most of the chart.
          const now = Math.floor(Date.now() / 1000);
          ls.setData([
            { time: (now - 30 * 24 * 60 * 60) as UTCTimestamp, value: price },
            { time: (now + 24 * 60 * 60) as UTCTimestamp, value: price },
          ]);
          flashAlphaLinesRef.current.push(ls);
        };
        addFa(flashAlpha.zeroGamma, '#4a8fdc', '0γ');
        addFa(flashAlpha.dealerFlip, '#4a8fdc', 'flip');
        flashAlpha.callWalls.slice(0, 2).forEach((p, i) => addFa(p, '#2bb67388', `CW${i + 1}`));
        flashAlpha.putWalls.slice(0, 2).forEach((p, i) => addFa(p, '#d6454588', `PW${i + 1}`));
      }
    }
    // Paint level labels now (they live in the SVG overlay, not on the chart).
    renderDrawingsRef.current();
  }, [levelsByDay, flashAlpha, selectedSymbol, historyReady]);

  // Play alert sounds for newly-arrived signals.
  // Signals present on the initial snapshot (> 5 min old) are silently pre-seeded
  // so we only alert on signals that arrive while the cockpit is open.
  useEffect(() => {
    const now = Date.now();
    const newSignals: typeof recentSignals = [];
    for (const sig of recentSignals) {
      if (seenSignalsRef.current.has(sig.ts)) continue;
      seenSignalsRef.current.add(sig.ts);
      if (now - sig.ts > 5 * 60_000) continue;  // skip startup history
      newSignals.push(sig);
    }
    if (!soundOn || newSignals.length === 0) return;

    // Lazily create the AudioContext on the first sound (requires prior user gesture).
    // Resume if the browser suspended it while the tab was hidden.
    try {
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        audioCtxRef.current = new AudioContext();
      }
      const ac = audioCtxRef.current;
      const play = () => {
        for (const sig of newSignals) {
          const ruleId = (sig as any).ruleId ?? (sig as any).rule_id ?? '';
          const pattern = (sig as any).pattern ?? null;
          // Beep ONLY on the tradable rules: FLIP (clean-impulse / pattern FLIP)
          // and CONT (cont-reentry). The high-frequency tick rules (tape-speed,
          // large-print, absorption) stay silent.
          const isFlip = ruleId === 'clean-impulse' && (pattern == null || pattern === 'FLIP');
          const isCont = ruleId === 'cont-reentry';
          if (!isFlip && !isCont) continue;
          playSignalSound(ac, sig.direction ?? '', ruleId);
        }
      };
      if (ac.state === 'suspended') {
        ac.resume().then(play).catch(() => {});
      } else {
        play();
      }
    } catch {
      // AudioContext not available
    }
  }, [recentSignals, soundOn]);

  // Render signal markers on the chart (arrows below/above candles).
  // Reactive on signals, symbol, AND the bar history we have, so markers
  // re-render when new bars come in or new signals fire.
  useEffect(() => {
    const series = seriesRef.current;

    // Always tear down previous TP/DD price lines before rebuilding (or bailing).
    for (const pl of signalLinesRef.current) {
      try { series?.removePriceLine(pl); } catch { /* already gone */ }
    }
    signalLinesRef.current = [];

    if (!series) return;

    // We must only show markers whose time matches a bar we actually have on
    // the chart, otherwise lightweight-charts places them at the leftmost edge.
    const history = barHistoryRef.current[selectedSymbol];
    if (!history || history.size === 0) {
      series.setMarkers([]);
      return;
    }

    // Bucket sig.ts (ms since epoch) -> seconds at the start of the minute.
    // Bars are stored with the same key, so a match means the marker lands on
    // that exact candle.
    const bucketSecs = (tsMs: number) => Math.floor(tsMs / 60000) * 60;

    // QUALIFIED and TRADABLE are mutually exclusive — exactly one of those two
    // primary categories is active. EXPERIMENTAL is an independent layer that
    // can show on top of either (force-shadow rule markers).
    //
    // Match by minute-bucket of sig.ts because the server keys its returned
    // timestamp lists the same way (Math.floor(ts/60000)*60).
    const filterByToggles = (sigTsMs: number): boolean => {
      const bucket = Math.floor(sigTsMs / 60000) * 60;
      const inPrimary = (showQualified && qualifiedTsRef.current.has(bucket))
                    || (showTradable  && tradableTsRef.current.has(bucket));
      const inExperimental = showExperimental && experimentalTsRef.current.has(bucket);
      return inPrimary || inExperimental;
    };

    // Source signals = live (recentSignals from WS, last ~30h) ∪ historical
    // (full payloads fetched via /signals/marks, populated into qualified /
    // tradable / experimental SignalsRef Maps). Dedup by minute-bucket — live
    // wins over historical since live has any post-fire metadata updates.
    // We merge all three historical maps so EXPERIMENTAL markers render with
    // the same rich payload data as QUALIFIED/TRADABLE.
    const histRef = showQualified ? qualifiedSignalsRef
                  : showTradable  ? tradableSignalsRef
                  : null;
    const expHistRef = showExperimental ? experimentalSignalsRef : null;
    const seenBuckets = new Set<number>();
    const sourceSignals: ConfluenceSignal[] = [];
    for (const sig of recentSignals) {
      if (sig.symbol !== selectedSymbol) continue;
      const b = bucketSecs(sig.ts);
      // Live tradable OPEN (tagged on the WS broadcast) → register its bucket in
      // tradableTsRef NOW so the TRADABLE marker renders instantly off the push,
      // instead of waiting for the next 60s /signals/marks poll. Idempotent — the
      // poll later re-adds the same bucket harmlessly (reconcile/backfill).
      if ((sig as { tradable?: boolean }).tradable) tradableTsRef.current.add(b);
      if (seenBuckets.has(b)) continue;
      seenBuckets.add(b);
      sourceSignals.push(sig);
    }
    if (histRef) {
      for (const sig of histRef.current.values()) {
        if (sig.symbol !== selectedSymbol) continue;
        const b = bucketSecs(sig.ts);
        if (seenBuckets.has(b)) continue;
        seenBuckets.add(b);
        sourceSignals.push(sig);
      }
    }
    if (expHistRef) {
      for (const sig of expHistRef.current.values()) {
        if (sig.symbol !== selectedSymbol) continue;
        const b = bucketSecs(sig.ts);
        if (seenBuckets.has(b)) continue;
        seenBuckets.add(b);
        sourceSignals.push(sig);
      }
    }

    const symbolSignals = sourceSignals
      .filter((s) => filterByToggles(s.ts))
      .filter((s) => {
        const ruleId = (s as any).ruleId ?? (s as any).rule_id ?? "";
        // EXPL → 1m chart only
        if (ruleId === 'expl') return selectedTimeframe === 1;
        // CLEAN (FLIP) shows on ALL timeframes — these are tradable signals,
        // user must see them regardless of which chart they're viewing.
        // Changed 2026-06-04 after a 09:59 FLIP fired but wasn't visible to user
        // on a non-1m view, causing an unmonitored open position.
        if (ruleId === 'clean-impulse') return true;
        // RR → 1m chart only
        if (ruleId === 'reject-resistance') return selectedTimeframe === 1;
        // ALA (BOUNCE + RECLAIM + ZONE_RECLAIM) → 1m chart only
        if (ruleId === 'ala-bounce' || ruleId === 'ala-reclaim' || ruleId === 'ala-zone-reclaim') return selectedTimeframe === 1;
        // Wall-broken-fade hidden from UI 2026-06-04 (user request — too noisy
        // during live trading session). Backend logging stays untouched.
        if (ruleId === 'wall-broken-fade') return false;
        // ABSO retired from UI 2026-06-02 (backend logging stays; no clear edge)
        if (ruleId === 'absorption') return false;
        // A/B/C signals → 1m chart only
        return selectedTimeframe === 1;
      });

    // No dedup: every signal becomes a marker. Multiple markers at the same
    // time will stack vertically on the candle automatically.
    // Visual differentiation by ruleId:
    //   - sweep -> arrow (existing behavior)
    //   - delta-divergence -> circle (different shape so they're not confused)
    const markers = symbolSignals
      .map((sig) => {
        let bucket = bucketSecs(sig.ts);
        if (!history.has(bucket)) {
          // Live-edge signal whose minute-bar hasn't landed in `history` yet — the
          // WS `type:'bar'` events and the 20s tail poll lag the signal push, so a
          // mid-candle signal used to be DROPPED here and only re-attach on the next
          // new-bucket barsVersion bump (≈a full candle late, while the beep fired on
          // time). Snap it to the newest bar on the chart so it paints on the forming
          // candle immediately; once its true bucket lands (next barsVersion bump) the
          // effect re-runs and it settles onto the correct candle. Genuinely historical
          // gaps (bucket OLDER than the live edge) still drop as before.
          const latest = lastLiveSecRef.current[selectedSymbol];
          if (latest !== undefined && bucket >= latest) bucket = latest;
          else return null;
        }
        const isLong = sig.direction?.toLowerCase() === 'long';
        const color = isLong ? '#2bb673' : '#d64545';
        const position = (isLong ? 'belowBar' : 'aboveBar') as 'belowBar' | 'aboveBar';

        // Normalize camelCase (live) vs snake_case (historical DB signals)
        const ruleId = sig.ruleId ?? (sig as any).rule_id ?? "unknown";

        let shape: 'arrowUp' | 'arrowDown' | 'circle';
        let label: string;
        if (ruleId === 'delta-divergence') {
          shape = 'circle';
          label = `DIV·${sig.score}`;
        } else if (ruleId === 'expl') {
          shape = 'arrowUp';
          const exWarning = regimeAlignment('expl', sig.direction, sig.ts, regimeCheckpoints) === 'against';
          label = `EXPL🚀·${sig.score}${exWarning ? ' !' : ''}`;
          return {
            time: bucket as UTCTimestamp,
            position,
            color: exWarning ? '#fb923c' : '#00ff88',
            shape,
            text: label,
            size: 5,
          };
        } else if (ruleId === 'clean-impulse') {
          shape = isLong ? 'arrowUp' : 'arrowDown';
          const cfWarning = regimeAlignment('clean-impulse', sig.direction, sig.ts, regimeCheckpoints) === 'against';
          const warn = cfWarning ? ' !' : '';
          // FLIP-long F_C shadow veto (frozen; @trading/contracts). SHADOW-ONLY — these
          // are NOT traded; the KEPT / VETO'd tag just renders a visual forward OOS record.
          // rsScore dropped from the label 2026-07-08 — it's inert as a W/L discriminator
          // (audit: flat across outcomes, doesn't gate flip/cont). Veto'd = gray so the
          // KEPT (amber) cohort stands out.
          // DANGER-FLAG cohort suffix (registered DANGER-FLAG-CONFIRM):
          // 🔋 violent tape at decision, 🪫 calm, none = unknown/uncovered.
          const df = dangerFlagEmoji((sig as unknown as { dflag?: number }).dflag);
          if (isLong) {
            // CVD-LONGFLOOR-OFF forward cohort (long floor disabled 2026-07-08):
            // longs the OLD cvd<=-1000 floor would have vetoed. Red so the
            // cohort is visually trackable like the FC KEPT/VETO'd record.
            const lfo = cvdLongFloorOffTag(sig as unknown as { direction?: string; cvdSession?: number });
            if (lfo.tagged) {
              return {
                time: bucket as UTCTimestamp,
                position,
                color: '#ef4444',
                shape,
                text: `FLIP ↑ CVD-LONGFLOOR-OFF` + warn + df,
                size: df ? 5 : 4,
              };
            }
            const fc = flipLongFcVeto(sig as unknown as { deltaT?: number; delta15?: number });
            label = `FLIP ↑ ${fc.veto ? "VETO'd" : 'KEPT'}` + warn + df;
            return {
              time: bucket as UTCTimestamp,
              position,
              color: fc.veto ? '#9ca3af' : (cfWarning ? '#fb923c' : '#f59e0b'),
              shape,
              text: label,
              size: df ? 5 : 4,
            };
          }
          label = 'FLIP ↓' + warn + df;
          return {
            time: bucket as UTCTimestamp,
            position,
            color: cfWarning ? '#fb923c' : '#f59e0b',
            shape,
            text: label,
            size: df ? 5 : 4,
          };
        } else if (ruleId === 'ala-bounce') {
          shape = 'arrowUp';
          const lvSource = (sig as any).levelSource ?? (sig as any).level_source ?? '';
          const lvSuffix = lvSource ? `·${lvSource}` : '';
          label = `BNC${lvSuffix}·${sig.score}`;
          return {
            time: bucket as UTCTimestamp,
            position,
            color: '#06b6d4',           // cyan — clean support bounce
            shape,
            text: label,
            size: 4,
          };
        } else if (ruleId === 'ala-reclaim') {
          shape = 'arrowUp';
          const lvSource = (sig as any).levelSource ?? (sig as any).level_source ?? '';
          const lvSuffix = lvSource ? `·${lvSource}` : '';
          label = `RCL${lvSuffix}·${sig.score}`;
          return {
            time: bucket as UTCTimestamp,
            position,
            color: '#10b981',           // emerald — failed breakdown / reclaim
            shape,
            text: label,
            size: 4,
          };
        } else if (ruleId === 'ala-zone-reclaim') {
          shape = 'arrowUp';
          const lvSource = (sig as any).levelSource ?? (sig as any).level_source ?? '';
          const lvSuffix = lvSource ? `·${lvSource}` : '';
          label = `ZRC${lvSuffix}·${sig.score}`;
          return {
            time: bucket as UTCTimestamp,
            position,
            color: '#f59e0b',           // amber — zone reclaim at BZB/BrZT
            shape,
            text: label,
            size: 4,
          };
        } else if (ruleId === 'reject-resistance') {
          shape = 'arrowDown';
          const lvSource = (sig as any).levelSource ?? (sig as any).level_source ?? '';
          const lvSuffix = lvSource ? `·${lvSource}` : '';
          label = `RR${lvSuffix}·${sig.score}`;
          return {
            time: bucket as UTCTimestamp,
            position,
            color: '#a855f7',           // purple — distinct from FLIP (amber) and EXPL (green)
            shape,
            text: label,
            size: 4,
          };
        } else if (ruleId === 'absorption') {
          shape = isLong ? 'arrowUp' : 'arrowDown';
          const conviction = (sig as any).conviction;
          const convSuffix = conviction ? ` ${conviction}` : '';
          const abWarning = regimeAlignment('absorption', sig.direction, sig.ts, regimeCheckpoints) === 'against';
          label = `ABSO·Q·${sig.score}${convSuffix}${abWarning ? ' !' : ''}`;
          return {
            time: bucket as UTCTimestamp,
            position,
            color: abWarning ? '#fb923c' : getSignalPaletteColor(sig.ts),
            shape,
            text: label,
            size: 4,
          };
        } else if (ruleId === 'cont-reentry') {
          // CONT-REENTRY shadow signal (Strategy CONT). Violet to stand apart from
          // FLIP(amber)/EXPL(green)/RR(purple)/FADE(cyan)/BNC(cyan).
          shape = isLong ? 'arrowUp' : 'arrowDown';
          // CONT-short shallow-retrace shadow tag (frozen; @trading/contracts). SHADOW-ONLY —
          // deep retrace (>0.35) = VETO'd (gray), shallow = KEPT (violet). Short only; longs
          // keep the plain violet label. See cont_short_gate_audit.ts / BACKLOG §2b.
          const contDf = dangerFlagEmoji((sig as unknown as { dflag?: number }).dflag);
          if (!isLong) {
            const csr = contShortRetraceVeto(sig as unknown as { retracePct?: number });
            label = `CONT ↓ ${csr.veto ? "VETO'd" : 'KEPT'}·${sig.score}` + contDf;
            return {
              time: bucket as UTCTimestamp,
              position,
              color: csr.veto ? '#9ca3af' : '#8b5cf6',
              shape,
              text: label,
              size: contDf ? 5 : 4,
            };
          }
          // CVD-LONGFLOOR-OFF forward cohort (long floor disabled 2026-07-08):
          // CONT longs the OLD cvd<=-1000 floor would have vetoed. Red cohort.
          const contLfo = cvdLongFloorOffTag(sig as unknown as { direction?: string; cvdSession?: number });
          if (contLfo.tagged) {
            return {
              time: bucket as UTCTimestamp,
              position,
              color: '#ef4444',
              shape,
              text: `CONT ↑ CVD-LONGFLOOR-OFF` + contDf,
              size: contDf ? 5 : 4,
            };
          }
          label = `CONT-REENTRY-SHADOW ↑·${sig.score}` + contDf;
          return {
            time: bucket as UTCTimestamp,
            position,
            color: '#8b5cf6',  // violet
            shape,
            text: label,
            size: contDf ? 5 : 4,
          };
        } else if (ruleId === 'wall-broken-fade') {
          // Wall-broken-fade: cyan-magenta to stand apart from FLIP(orange)/EXPL(green)/ABSO.
          // ASK wall broken → SHORT fade (arrowDown above bar)
          // BID wall broken → LONG fade (arrowUp below bar)
          shape = isLong ? 'arrowUp' : 'arrowDown';
          const peak = (sig as any).peakSize;
          const peakStr = peak ? ` p${peak}` : '';
          label = (isLong ? 'FADE ↑' : 'FADE ↓') + `·${sig.score}${peakStr}`;
          return {
            time: bucket as UTCTimestamp,
            position,
            color: '#22d3ee',  // cyan
            shape,
            text: label,
            size: 4,
          };
        } else if (ruleId === 'KEY-LVL-FADE') {
          // Phase 1 structural-level fade signal. Shows the level being faded
          // (PDH/PDL/PDC/POC/VAH/VAL) plus simulated outcome if backfilled.
          //   LONG  = approached from above, faded back UP    → arrowUp BELOW bar
          //   SHORT = approached from below, faded back DOWN  → arrowDown ABOVE bar
          shape = isLong ? 'arrowUp' : 'arrowDown';
          const lvl = (sig as any).levelLabel ?? '?';
          const outcome = (sig as any).outcomeResult;
          const arrow = isLong ? '↑' : '↓';
          // Color codes: green=TP win, red=SL loss, gold=neutral/no outcome yet
          let levColor = '#fcd34d'; // gold (default — no outcome)
          if (outcome === 'TP') levColor = '#22c55e'; // green
          else if (outcome === 'SL') levColor = '#ef4444'; // red
          const outStr = outcome === 'TP' ? ' ✓' : outcome === 'SL' ? ' ✗' : '';
          label = `KLV-FADE ${arrow}·${lvl}${outStr}`;
          return {
            time: bucket as UTCTimestamp,
            position,
            color: levColor,
            shape,
            text: label,
            size: 4,  // bumped from 2 → 4 for readability
          };
        } else {
          shape = isLong ? 'arrowUp' : 'arrowDown';
          const conviction = (sig as any).conviction;
          const convSuffix = conviction ? ` ${conviction}` : '';
          label = `${ruleId.toUpperCase().slice(0, 4)}·${sig.score}${convSuffix}`;
        }

        return {
          time: bucket as UTCTimestamp,
          position,
          color,
          shape,
          text: label,
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);

    // (Fallback dot markers removed — historical signals now render with
    // full rich markers via qualified / tradable / experimental SignalsRef.)

    const allMarkers = [...markers]
      .sort((a, b) => (a.time as number) - (b.time as number));

    // Hand off to the SVG overlay renderer (renderDrawingsRef). We don't call
    // series.setMarkers() because lightweight-charts renders marker text to
    // canvas at a hardcoded regular font-weight — SVG gives us font-weight=800
    // + font-size=14 control. Clear LWC-side markers so they don't double up.
    series.setMarkers([]);
    signalMarkersRef.current = allMarkers.map(m => {
      const tsSec = m.time as number;            // UTCTimestamp = seconds
      const bar = history.get(tsSec);
      const price = m.position === 'aboveBar' ? (bar?.high ?? 0)
                  : m.position === 'belowBar' ? (bar?.low ?? 0)
                  : ((bar?.high ?? 0) + (bar?.low ?? 0)) / 2;
      return {
        ts: tsSec,
        price,
        text: m.text ?? '',
        color: m.color ?? '#999',
        shape: m.shape as 'arrowUp' | 'arrowDown' | 'circle' | 'square',
        position: m.position as 'aboveBar' | 'belowBar' | 'inBar',
      };
    });
    // Trigger SVG render
    renderDrawingsRef.current?.();

    // Draw TP1/TP2/DD1/DD2 price lines only for today's signals.
    // Historical signals from previous sessions get their markers but no level lines.
    const todayRthStart = (() => {
      const now = Date.now();
      const datePart = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(now));
      const [mm, dd, yyyy] = datePart.split('/');
      return Date.parse(`${yyyy}-${mm}-${dd}T09:30:00-04:00`);
    })();

    const todaySignals = symbolSignals.filter(s => s.ts >= todayRthStart);
    const nowSec = Math.floor(Date.now() / 1000);

    // 2026-06-10: removed per-signal SL/TP/DD overlay lines. They were
    // distracting and no longer carry information not already in the
    // signal card / trade marker. signalLinesRef still teared down each
    // run via the loop at the top of this effect — leaving it empty is
    // fine.
  }, [recentSignals, recentSignals.length, recentEvents, selectedSymbol, barsVersion, regimeCheckpoints]);

  // Keep computeCardsRef up-to-date; also fire immediately when inputs change.
  // The chart's subscribeVisibleLogicalRangeChange subscription calls this ref
  // on every pan/zoom so cards track the bars they're anchored to.
  useEffect(() => {
    const BUCKET_SECS = (tsMs: number) => Math.floor(tsMs / 60000) * 60;

    computeCardsRef.current = () => {
      const chart  = chartRef.current;
      const series = seriesRef.current;
      if (!chart || !series) return;

      const history = barHistoryRef.current[selectedSymbol];

      const relevantSignals = recentSignals
        .filter((s) => s.symbol === selectedSymbol)
        .filter((s) => {
          const ruleId = (s as any).ruleId ?? (s as any).rule_id ?? '';
          if (ruleId === 'clean-impulse')      return selectedTimeframe === 1;
          if (ruleId === 'expl')               return selectedTimeframe === 1;
          return selectedTimeframe === 1;
        })
        .slice(0, 5);

      const containerWidth = containerRef.current?.clientWidth ?? 800;
      const positions: { sig: ConfluenceSignal; x: number; y: number; id: string }[] = [];
      let fallbackY = 80;

      for (const sig of relevantSignals) {
        const bucket = BUCKET_SECS(sig.ts);
        const bar    = history?.get(bucket);
        const isLong = sig.direction === 'long';
        let x: number | null = null;
        let y: number | null = null;

        if (bar) {
          const xCoord = chart.timeScale().timeToCoordinate(bucket as UTCTimestamp);
          // Anchor 50 pts below entry for longs, 50 pts above for shorts,
          // so the card sits well clear of the signal candle.
          const anchorPrice = isLong ? bar.close - 50 : bar.close + 50;
          const priceY = series.priceToCoordinate(anchorPrice);
          if (xCoord !== null && priceY !== null) {
            x = Math.min(xCoord, containerWidth - 295);
            // For shorts the card hangs above, so shift up by card height (~160px)
            y = isLong ? priceY : priceY - 160;
          }
        }

        if (x === null || y === null) {
          x = containerWidth - 295;
          y = fallbackY;
          fallbackY += 126;
        }

        positions.push({
          sig,
          x,
          y,
          id: `${sig.ts}-${(sig as any).ruleId ?? (sig as any).rule_id}`,
        });
      }

      // Resolve vertical overlaps: sort by y then push any card down that
      // would overlap a card already placed nearby on the x axis.
      const CARD_H   = 158; // estimated rendered card height in px
      const CARD_GAP = 6;
      const CARD_W   = 300; // cards are maxWidth 320, treat as ~300 for overlap test
      positions.sort((a, b) => a.y - b.y);
      for (let i = 1; i < positions.length; i++) {
        for (let j = 0; j < i; j++) {
          if (Math.abs(positions[i].x - positions[j].x) > CARD_W) continue;
          const minY = positions[j].y + CARD_H + CARD_GAP;
          if (positions[i].y < minY) positions[i].y = minY;
        }
      }

      setCardPositions(positions);
    };

    computeCardsRef.current();
  }, [recentSignals, selectedSymbol, selectedTimeframe, barsVersion, showQualified, showTradable, showExperimental]);

  // ── Drawing SVG handlers (read from stable refs, defined each render) ────
  const handleSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || !drawModeRef.current) return;
    const rect = svgRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const time = chart.timeScale().coordinateToTime(x);
    const price = series.coordinateToPrice(y);
    if (time === null || price === null) return;

    if (drawModeRef.current === 'line' || drawModeRef.current === 'measure') {
      const kind = drawModeRef.current;
      if (!pendingLineRef.current) {
        pendingLineRef.current = { time: time as number, price };
        renderDrawingsRef.current();
      } else {
        drawingsRef.current = [...drawingsRef.current, {
          id: String(Date.now()), kind,
          p1: pendingLineRef.current,
          p2: { time: time as number, price },
        } as Drawing];
        pendingLineRef.current = null;
        previewMouseRef.current = null;
        // Measure is a one-shot tool: drop back to normal cursor after placement.
        if (kind === 'measure') setDrawMode(null);
        renderDrawingsRef.current();
      }
    } else if (drawModeRef.current === 'text') {
      setTextInput({ x, y, time: time as number, price });
      setTextValue('');
    }
  };

  const handleSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const mode = drawModeRef.current;
    if ((mode !== 'line' && mode !== 'measure') || !pendingLineRef.current) return;
    const rect = svgRef.current!.getBoundingClientRect();
    previewMouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    renderDrawingsRef.current();
  };

  const confirmText = () => {
    if (textInput && textValue.trim()) {
      drawingsRef.current = [...drawingsRef.current, {
        id: String(Date.now()), kind: 'text',
        point: { time: textInput.time, price: textInput.price },
        text: textValue.trim(),
      }];
      renderDrawingsRef.current();
    }
    setTextInput(null);
    setTextValue('');
  };

  // Rebuild imperative SVG render fn every React render (reads from stable refs)
  renderDrawingsRef.current = () => {
    const svg = svgRef.current;
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!svg || !chart || !series) return;
    const ts = chart.timeScale();
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    // Overnight / ETH session shading. Paint a low-alpha tint over the entire
    // non-RTH stretch in the visible range so RTH (09:30–16:00 ET) stands out
    // as the clean window. Added FIRST so all other SVG drawings (measure
    // boxes, level badges, drawings) render on top and stay crisp.
    //
    // ONE rect per RTH day, spanning [prior session close → that day's RTH
    // open]. Anchoring on the RTH day avoids the midnight seam that a
    // per-calendar-day approach produces (where 16:00→24:00 and 00:00→09:30
    // are drawn as separate adjacent rects). For Mondays the prior close is
    // Friday 16:00 ET, which gives a single continuous gray rect across the
    // weekend.
    const visRange = ts.getVisibleRange();
    const paneH = svg.clientHeight || svg.getBoundingClientRect().height;
    if (visRange && paneH > 0) {
      const fromSec = Number(visRange.from);
      const toSec   = Number(visRange.to);
      const paneW = ts.width();
      const hourFmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: '2-digit', hour12: false,
      });
      // DST-safe ET wall-clock → epoch seconds. Only called with mid-day hours
      // (9:30 and 16:00), so the cross-midnight wrap in the hourFmt correction
      // doesn't apply here.
      const etSec = (yy: number, mm: number, dd: number, h: number, mi: number): number => {
        const naive = new Date(Date.UTC(yy, mm - 1, dd, h + 4, mi, 0));
        const nyHour = parseInt(hourFmt.format(naive), 10);
        return Math.floor((naive.getTime() + (h - nyHour) * 3_600_000) / 1000);
      };
      const dateFmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      });
      const weekdayFmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', weekday: 'short',
      });

      // First/last cached bar times for the active symbol. Used to extrapolate
      // x-coordinates for shade endpoints that fall in the "empty space"
      // regions of the visible range (right of last bar or left of first bar),
      // where timeToCoordinate returns null because no bar exists at that
      // exact time. Without this, scrolling the chart so empty space appears
      // between the last bar and the right axis caused the ON shade to vanish
      // even though we were still in the overnight session.
      const symbolCache = barHistoryRef.current[selectedSymbol];
      let lastBarTimeSec = -Infinity;
      let firstBarTimeSec = Infinity;
      if (symbolCache) {
        for (const t of symbolCache.keys()) {
          if (t > lastBarTimeSec)  lastBarTimeSec  = t;
          if (t < firstBarTimeSec) firstBarTimeSec = t;
        }
      }
      const barSpacing = (ts.options() as { barSpacing?: number }).barSpacing ?? 12;
      const intervalSec = Math.max(1, parseInt(String(selectedTimeframe), 10) || 1) * 60;

      const timeToX = (timeSec: number): number | null => {
        const x = ts.timeToCoordinate(timeSec as UTCTimestamp);
        if (x !== null) return x;
        // Past the last bar — extrapolate forward from lastBarX using uniform
        // bar spacing. Clamped to paneW so the shade naturally extends to the
        // right edge of the empty space.
        if (lastBarTimeSec > -Infinity && timeSec > lastBarTimeSec) {
          const lastBarX = ts.timeToCoordinate(lastBarTimeSec as UTCTimestamp);
          if (lastBarX === null) return null;
          const dx = (timeSec - lastBarTimeSec) / intervalSec * barSpacing;
          return Math.min(paneW, lastBarX + dx);
        }
        // Before the first bar — extrapolate backward, clamped to 0.
        if (firstBarTimeSec < Infinity && timeSec < firstBarTimeSec) {
          const firstBarX = ts.timeToCoordinate(firstBarTimeSec as UTCTimestamp);
          if (firstBarX === null) return null;
          const dx = (firstBarTimeSec - timeSec) / intervalSec * barSpacing;
          return Math.max(0, firstBarX - dx);
        }
        return null;
      };

      const shade = (a: number, b: number) => {
        const lo = Math.max(a, fromSec);
        const hi = Math.min(b, toSec);
        if (lo >= hi) return;
        const x1 = timeToX(lo);
        const x2 = timeToX(hi);
        if (x1 === null || x2 === null) return;
        const xL = Math.min(x1, x2);
        const w  = Math.abs(x2 - x1);
        if (w < 0.5) return;
        const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        r.setAttribute('x', String(xL));
        r.setAttribute('y', '0');
        r.setAttribute('width',  String(w));
        r.setAttribute('height', String(paneH));
        r.setAttribute('fill', 'rgba(255, 255, 255, 0.05)');
        r.setAttribute('pointer-events', 'none');
        svg.appendChild(r);
      };
      // Walk every calendar day touching the visible range. Start 4 days
      // before fromSec so a Friday→Monday weekend that began before the view
      // is still covered (Monday's shade goes back to Friday 16:00).
      const ONE_DAY_MS = 86_400_000;
      let cursor = (fromSec * 1000) - 4 * ONE_DAY_MS;
      const stop = (toSec * 1000) + ONE_DAY_MS;
      while (cursor < stop) {
        const probe = new Date(cursor);
        const weekday = weekdayFmt.format(probe);
        cursor += ONE_DAY_MS;
        if (weekday === 'Sat' || weekday === 'Sun') continue;
        const parts = dateFmt.formatToParts(probe);
        const y = Number(parts.find(p => p.type === 'year')!.value);
        const m = Number(parts.find(p => p.type === 'month')!.value);
        const d = Number(parts.find(p => p.type === 'day')!.value);
        const rthOpen = etSec(y, m, d, 9, 30);
        // Prior session close: previous calendar day 16:00 ET, except Monday
        // which steps back to Friday 16:00 so the whole weekend stays shaded.
        const stepBack = weekday === 'Mon' ? 3 : 1;
        const priorProbe = new Date(Date.UTC(y, m - 1, d - stepBack, 12, 0, 0));
        const priorParts = dateFmt.formatToParts(priorProbe);
        const py = Number(priorParts.find(p => p.type === 'year')!.value);
        const pm = Number(priorParts.find(p => p.type === 'month')!.value);
        const pd = Number(priorParts.find(p => p.type === 'day')!.value);
        const priorClose = etSec(py, pm, pd, 16, 0);
        shade(priorClose, rthOpen);
      }
    }

    // Timeframe (1/5/15) used to compute "bars covered" inside measure boxes.
    const tfMin = Math.max(1, parseInt(String(selectedTimeframe), 10) || 1);

    // Helper: render a measure rectangle + label between two points.
    // When `drawingId` is supplied (finalized measurements only — never previews),
    // an X close button is drawn at the top-right that removes that drawing
    // on click.
    const drawMeasureBox = (p1: { time: number; price: number }, p2: { time: number; price: number }, preview = false, drawingId?: string) => {
      const x1 = ts.timeToCoordinate(p1.time as UTCTimestamp);
      const y1 = series.priceToCoordinate(p1.price);
      const x2 = ts.timeToCoordinate(p2.time as UTCTimestamp);
      const y2 = series.priceToCoordinate(p2.price);
      if (x1 === null || y1 === null || x2 === null || y2 === null) return;

      const xL = Math.min(x1, x2);
      const xR = Math.max(x1, x2);
      const yT = Math.min(y1, y2);
      const yB = Math.max(y1, y2);

      const priceDiff = p2.price - p1.price;
      const isUp = priceDiff >= 0;
      const fill   = isUp ? 'rgba(34,197,94,0.14)'  : 'rgba(231,76,76,0.14)';
      const stroke = isUp ? 'rgba(34,197,94,0.85)'  : 'rgba(231,76,76,0.85)';

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(xL));
      rect.setAttribute('y', String(yT));
      rect.setAttribute('width',  String(xR - xL));
      rect.setAttribute('height', String(yB - yT));
      rect.setAttribute('fill',   fill);
      rect.setAttribute('stroke', stroke);
      rect.setAttribute('stroke-width', preview ? '1' : '1.2');
      if (preview) rect.setAttribute('stroke-dasharray', '4,4');
      svg.appendChild(rect);

      // Stats: points, bars, minutes
      const pts = Math.abs(priceDiff);
      const totalMin = Math.max(0, Math.round(Math.abs(p2.time - p1.time) / 60));
      const bars = Math.max(0, Math.round(totalMin / tfMin));
      const sign = isUp ? '+' : '−';
      const hh = Math.floor(totalMin / 60);
      const mm = totalMin % 60;
      const timeStr = hh > 0 ? `${hh}h ${mm}m` : `${mm}m`;
      const label = `${sign}${pts.toFixed(2)} pts  ·  ${bars} bars  ·  ${timeStr}`;

      // Label box centered horizontally above the rectangle (or below if too high).
      const FONT_PX = 12;
      const PAD = 6;
      const charW = 7.2;
      const labelW = label.length * charW + PAD * 2;
      const labelH = FONT_PX + PAD * 2 - 2;
      const labelX = (xL + xR) / 2 - labelW / 2;
      const labelY = yT - labelH - 6 < 4 ? yB + 6 : yT - labelH - 6;

      const lbg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      lbg.setAttribute('x', String(labelX));
      lbg.setAttribute('y', String(labelY));
      lbg.setAttribute('width',  String(labelW));
      lbg.setAttribute('height', String(labelH));
      lbg.setAttribute('rx', '3');
      lbg.setAttribute('fill', 'rgba(10,10,12,0.92)');
      lbg.setAttribute('stroke', stroke);
      lbg.setAttribute('stroke-width', '1');
      svg.appendChild(lbg);

      const ltxt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      ltxt.setAttribute('x', String(labelX + labelW / 2));
      ltxt.setAttribute('y', String(labelY + labelH - PAD));
      ltxt.setAttribute('text-anchor', 'middle');
      ltxt.setAttribute('fill', '#f5f5f5');
      ltxt.setAttribute('font-family', 'Geist Mono, monospace');
      ltxt.setAttribute('font-size', String(FONT_PX));
      ltxt.setAttribute('font-weight', '700');
      ltxt.textContent = label;
      svg.appendChild(ltxt);

      // Close button (X) — only on finalized boxes, not previews.
      // pointer-events: auto on the bg circle lets clicks land even when the
      // SVG itself is pointer-events: none (i.e. when no draw tool is active).
      if (!preview && drawingId) {
        const R = 8;                                  // button radius
        const cx = xR - 4 - R;                        // pinned to top-right corner of the box
        const cy = yT + 4 + R;
        const xBg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        xBg.setAttribute('cx', String(cx));
        xBg.setAttribute('cy', String(cy));
        xBg.setAttribute('r', String(R));
        xBg.setAttribute('fill', 'rgba(10,10,12,0.92)');
        xBg.setAttribute('stroke', stroke);
        xBg.setAttribute('stroke-width', '1');
        xBg.style.cursor = 'pointer';
        xBg.style.pointerEvents = 'auto';
        const onClose = (ev: Event) => {
          ev.stopPropagation();
          ev.preventDefault();
          drawingsRef.current = drawingsRef.current.filter(d => d.id !== drawingId);
          renderDrawingsRef.current();
        };
        xBg.addEventListener('click', onClose);
        xBg.addEventListener('mousedown', (ev) => ev.stopPropagation());
        svg.appendChild(xBg);

        // The two strokes of the X glyph
        const xLen = 4;
        for (const [dx, dy] of [[ -xLen,  xLen ], [ xLen,  xLen ]] as const) {
          const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          ln.setAttribute('x1', String(cx - dx)); ln.setAttribute('y1', String(cy - dy));
          ln.setAttribute('x2', String(cx + dx)); ln.setAttribute('y2', String(cy + dy));
          ln.setAttribute('stroke', '#f5f5f5');
          ln.setAttribute('stroke-width', '1.5');
          ln.setAttribute('stroke-linecap', 'round');
          ln.style.pointerEvents = 'none';
          svg.appendChild(ln);
        }
      }
    };

    for (const d of drawingsRef.current) {
      if (d.kind === 'line') {
        const x1 = ts.timeToCoordinate(d.p1.time as UTCTimestamp);
        const y1 = series.priceToCoordinate(d.p1.price);
        const x2 = ts.timeToCoordinate(d.p2.time as UTCTimestamp);
        const y2 = series.priceToCoordinate(d.p2.price);
        if (x1 === null || y1 === null || x2 === null || y2 === null) continue;
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        el.setAttribute('x1', String(x1)); el.setAttribute('y1', String(y1));
        el.setAttribute('x2', String(x2)); el.setAttribute('y2', String(y2));
        el.setAttribute('stroke', '#5a9bff'); el.setAttribute('stroke-width', '1.5');
        svg.appendChild(el);
      } else if (d.kind === 'measure') {
        drawMeasureBox(d.p1, d.p2, false, d.id);
      } else if (d.kind === 'text') {
        const x = ts.timeToCoordinate(d.point.time as UTCTimestamp);
        const y = series.priceToCoordinate(d.point.price);
        if (x === null || y === null) continue;
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        el.setAttribute('x', String(x)); el.setAttribute('y', String(y));
        el.setAttribute('fill', '#fde047');
        el.setAttribute('font-family', 'Geist Mono, monospace');
        el.setAttribute('font-size', '12'); el.setAttribute('font-weight', '600');
        el.textContent = d.text;
        svg.appendChild(el);
      }
    }

    // Level badges: one pill per level per day. Anchored to the segment END
    // (16:00 ET of that day) when visible, but CLAMPED to the right edge of
    // the pane when segment-end has scrolled off-screen to the right — so
    // the badge stays "stuck" to the visible portion of its line wherever
    // that line is still on-screen. Skipped only when the full segment is
    // off-screen (entirely left or entirely right of the pane).
    //
    // Collision avoidance: when two badges would overlap (either because the
    // levels share a close price, or because the chart is zoomed out and many
    // segments converge near the right edge), the colliding badge is shifted
    // LEFT along its own line by one badge-width + gap. The badge stays on
    // its price (y position fixed), so the level it labels is unambiguous;
    // only x moves. Processed right-to-left, so the rightmost badge keeps
    // the prime real estate.
    const paneWidth = ts.width();
    if (paneWidth > 0 && levelLabelsRef.current.length > 0) {
      const FONT_PX = 16;
      const CHAR_W = 9.6;
      const PAD_X = 8;
      const PAD_Y = 4;
      const PILL_H = FONT_PX + PAD_Y * 2;
      const LINE_GAP = 5;
      const COLLIDE_GAP = 4;

      type Badge = { label: string; color: string; pillW: number; pillX: number; pillY: number };
      const candidates: Badge[] = [];
      for (const lbl of levelLabelsRef.current) {
        const xStart = ts.timeToCoordinate(lbl.startTs as UTCTimestamp);
        const xEnd = ts.timeToCoordinate(lbl.endTs as UTCTimestamp);
        if (xEnd === null) continue;
        // Skip when the entire segment is off-screen.
        if (xStart !== null && xStart >= paneWidth) continue;
        if (xEnd <= 0) continue;
        const yLine = series.priceToCoordinate(lbl.price);
        if (yLine === null) continue;
        const textW = lbl.label.length * CHAR_W;
        const pillW = textW + PAD_X * 2;
        // Sticky anchor: prefer the segment-end x, but clamp to paneWidth
        // when the end has scrolled past the right edge.
        const xAnchor = Math.min(xEnd, paneWidth);
        let pillX = xAnchor - pillW;
        if (pillX < 0) pillX = 0;
        // Sit the label snug just above its level line (small LINE_GAP), rather
        // than a full pill-height above it — the box is gone, so hug the line.
        const pillY = yLine - PILL_H + PAD_Y - LINE_GAP;
        candidates.push({ label: lbl.label, color: lbl.color, pillW, pillX, pillY });
      }

      // Place right-to-left. The first badge at any given y wins the
      // segment-end spot; subsequent badges at the same y shift further left.
      candidates.sort((a, b) => b.pillX - a.pillX);
      const placed: Badge[] = [];
      for (const b of candidates) {
        // Shift left until no collision, or we run out of left-space.
        for (let tries = 0; tries < 50; tries++) {
          const hit = placed.find(p =>
            b.pillX < p.pillX + p.pillW + COLLIDE_GAP &&
            b.pillX + b.pillW + COLLIDE_GAP > p.pillX &&
            b.pillY < p.pillY + PILL_H + COLLIDE_GAP &&
            b.pillY + PILL_H + COLLIDE_GAP > p.pillY,
          );
          if (!hit) break;
          b.pillX = hit.pillX - b.pillW - COLLIDE_GAP;
          if (b.pillX < 0) { b.pillX = 0; break; }
        }
        placed.push(b);
      }

      for (const b of placed) {
        // Box-free labels (per Ravi 2026-06-18): no pill background — just the
        // text in the level's own color, with a dark outline (paint-order:stroke)
        // so it stays readable over candles/zone shading.
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        el.setAttribute('x', String(b.pillX + b.pillW - PAD_X));
        el.setAttribute('y', String(b.pillY + PILL_H - PAD_Y - 2));
        el.setAttribute('text-anchor', 'end');
        el.setAttribute('fill', b.color);
        el.setAttribute('stroke', '#0a0a0b');
        el.setAttribute('stroke-width', '2.5');
        el.setAttribute('paint-order', 'stroke');
        el.setAttribute('font-family', 'Geist Mono, monospace');
        el.setAttribute('font-size', String(FONT_PX));
        el.setAttribute('font-weight', '800');
        el.textContent = b.label;
        svg.appendChild(el);
      }
    }

    // ── Signal markers (SVG overlay, text-only) ─────────────────────────────
    // Text-only style: colored bold label anchored above/below the bar.
    // No pill background, no arrow shape — the ↑/↓ glyph in the label text is
    // the directional indicator. A thin dark stroke on the text provides
    // readability against the dark chart background.
    if (signalMarkersRef.current.length > 0) {
      const M_FONT = 16;                  // bumped 14 → 16 (per user)
      const M_LINE_H = M_FONT + 4;
      const M_CHAR_W = 9;
      const M_GAP = 8;                    // padding between arrow base and text
      const M_ARROW_H = 18;               // arrow height (tip → base) — substantial
      const M_ARROW_W = 14;               // arrow base width
      const M_STEM_H  = 8;                // small connecting stem from arrow base toward text
      // Per-bar vertical stacking to avoid overlap when multiple markers share a bar
      const placedAbove = new Map<number, number[]>();
      const placedBelow = new Map<number, number[]>();
      const visRangeForMarkers = ts.getVisibleRange();
      const visFromSec = visRangeForMarkers ? Number(visRangeForMarkers.from) : -Infinity;
      const visToSec   = visRangeForMarkers ? Number(visRangeForMarkers.to)   : Infinity;
      // Single color per direction (overrides per-rule color).
      // LONG  = lime  (entered expecting price up)
      // SHORT = red   (entered expecting price down)
      const COLOR_LONG  = '#a3e635';
      const COLOR_SHORT = '#ef4444';
      for (const m of signalMarkersRef.current) {
        if (m.ts < visFromSec || m.ts > visToSec) continue;
        const x = ts.timeToCoordinate(m.ts as UTCTimestamp);
        const y = series.priceToCoordinate(m.price);
        if (x === null || y === null) continue;
        if (x < 0 || x > paneWidth) continue;

        // Direction → color
        const isLong = m.shape === 'arrowUp';
        const color = isLong ? COLOR_LONG : COLOR_SHORT;

        const textW = m.text.length * M_CHAR_W;
        let txtX = x;
        if (txtX - textW / 2 < 2) txtX = textW / 2 + 2;
        if (txtX + textW / 2 > paneWidth - 2) txtX = paneWidth - textW / 2 - 2;

        // Vertical layout (from candle outward): arrow tip → arrow base → stem → text
        let txtY: number;
        let arrowTipY: number, arrowBaseY: number, stemEndY: number;
        if (m.position === 'aboveBar') {
          arrowTipY  = y;
          arrowBaseY = y - M_ARROW_H;
          stemEndY   = arrowBaseY - M_STEM_H;
          let candidate = stemEndY - M_GAP;
          const rowsKey = Math.round(x);
          const rows = placedAbove.get(rowsKey) ?? [];
          while (rows.some(r => Math.abs(r - candidate) < M_LINE_H)) candidate -= M_LINE_H;
          rows.push(candidate);
          placedAbove.set(rowsKey, rows);
          txtY = candidate;
        } else if (m.position === 'belowBar') {
          arrowTipY  = y;
          arrowBaseY = y + M_ARROW_H;
          stemEndY   = arrowBaseY + M_STEM_H;
          let candidate = stemEndY + M_GAP + M_FONT;
          const rowsKey = Math.round(x);
          const rows = placedBelow.get(rowsKey) ?? [];
          while (rows.some(r => Math.abs(r - candidate) < M_LINE_H)) candidate += M_LINE_H;
          rows.push(candidate);
          placedBelow.set(rowsKey, rows);
          txtY = candidate;
        } else {
          txtY = y + M_FONT / 2;
          arrowTipY = y;
          arrowBaseY = y;
          stemEndY = y;
        }

        // Arrow + stem assembly pointing at the candle the signal triggered on.
        // Drawn FIRST so the text stroke overlays it cleanly when they touch.
        if (m.position !== 'inBar') {
          // Filled triangle (the actual arrow head)
          const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
          arrow.setAttribute(
            'points',
            `${x - M_ARROW_W / 2},${arrowBaseY} ${x + M_ARROW_W / 2},${arrowBaseY} ${x},${arrowTipY}`,
          );
          arrow.setAttribute('fill', color);
          arrow.setAttribute('stroke', '#0a0a0b');
          arrow.setAttribute('stroke-width', '1.5');
          arrow.setAttribute('stroke-linejoin', 'round');
          svg.appendChild(arrow);
          // Stem connecting arrow base to text — gives the marker a clear visual
          // axis without crowding the candle wick.
          const stem = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          stem.setAttribute('x1', String(x));
          stem.setAttribute('y1', String(arrowBaseY));
          stem.setAttribute('x2', String(x));
          stem.setAttribute('y2', String(stemEndY));
          stem.setAttribute('stroke', color);
          stem.setAttribute('stroke-width', '3');
          stem.setAttribute('stroke-linecap', 'round');
          svg.appendChild(stem);
        }

        // Label text — bold, large, dark stroke for legibility
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', String(txtX));
        text.setAttribute('y', String(txtY));
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('fill', color);
        text.setAttribute('stroke', '#0a0a0b');
        text.setAttribute('stroke-width', '3');
        text.setAttribute('stroke-linejoin', 'round');
        text.setAttribute('paint-order', 'stroke fill');
        text.setAttribute('font-family', 'Geist Mono, monospace');
        text.setAttribute('font-size', String(M_FONT));
        text.setAttribute('font-weight', '800');
        text.textContent = m.text;
        svg.appendChild(text);
      }
    }

    // First-click marker — drawn immediately for both line and measure tools,
    // so the user gets feedback before the mouse moves.
    if (pendingLineRef.current && (drawModeRef.current === 'line' || drawModeRef.current === 'measure')) {
      const x1 = ts.timeToCoordinate(pendingLineRef.current.time as UTCTimestamp);
      const y1 = series.priceToCoordinate(pendingLineRef.current.price);
      if (x1 !== null && y1 !== null) {
        const color = drawModeRef.current === 'measure' ? '#5a9bff' : '#5a9bff';
        // Outer ring (more visible against varied backgrounds)
        const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        ring.setAttribute('cx', String(x1)); ring.setAttribute('cy', String(y1));
        ring.setAttribute('r', '6');
        ring.setAttribute('fill', 'rgba(10,10,12,0.85)');
        ring.setAttribute('stroke', color);
        ring.setAttribute('stroke-width', '1.5');
        svg.appendChild(ring);
        // Inner dot
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', String(x1)); dot.setAttribute('cy', String(y1));
        dot.setAttribute('r', '3'); dot.setAttribute('fill', color);
        svg.appendChild(dot);
      }
    }

    // Preview dashed line from first click to mouse (line tool only)
    if (pendingLineRef.current && previewMouseRef.current && drawModeRef.current === 'line') {
      const x1 = ts.timeToCoordinate(pendingLineRef.current.time as UTCTimestamp);
      const y1 = series.priceToCoordinate(pendingLineRef.current.price);
      if (x1 !== null && y1 !== null) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        el.setAttribute('x1', String(x1)); el.setAttribute('y1', String(y1));
        el.setAttribute('x2', String(previewMouseRef.current.x));
        el.setAttribute('y2', String(previewMouseRef.current.y));
        el.setAttribute('stroke', '#5a9bff'); el.setAttribute('stroke-width', '1');
        el.setAttribute('stroke-dasharray', '4,4');
        svg.appendChild(el);
      }
    }

    // Preview measure rectangle while placing second point
    if (pendingLineRef.current && previewMouseRef.current && drawModeRef.current === 'measure') {
      const previewTime  = ts.coordinateToTime(previewMouseRef.current.x);
      const previewPrice = series.coordinateToPrice(previewMouseRef.current.y);
      if (previewTime !== null && previewPrice !== null) {
        drawMeasureBox(
          pendingLineRef.current,
          { time: previewTime as number, price: previewPrice },
          true,
        );
      }
    }
  };

  const fmtTipRows = (ev: TapeEvent): [string, string][] => {
    const rows: [string, string][] = [];
    if (ev.kind === 'confluence') {
      const sigs = ev.signals ?? [];
      const defExh = sigs.some((s) => s === 'iceberg' || s === 'wall' || s === 'absorption') && sigs.some((s) => s === 'trapped' || s === 'stoprun');
      const famN = ev.levels ?? 0;
      rows.push(['tier', defExh && famN >= 5 ? 'PRIME — defense + trapped opponents + broad agreement'
        : (defExh && famN >= 4) || ev.flip ? 'KEY — defense+exhaustion cluster / zone flip' : 'standard']);
      rows.push(['score', String(ev.size)]);
      if (ev.families?.length) rows.push(['families', ev.families.join(', ')]);
      else if (ev.levels != null) rows.push(['# signals', String(ev.levels)]);
      if (ev.signals?.length) rows.push(['aligned', ev.signals.join(', ')]);
      // Color = evidence direction (user's informed pick 2026-07-15); trade meaning still measured.
      rows.push(['evidence', ev.side === 'buy' ? 'LONG — buy-side dominance' : 'SHORT — sell-side dominance']);
      rows.push(['note', 'color = evidence · follow-vs-fade resolves 2026-07-29']);
      if (ev.flip) rows.push(['FLIP', 'reverses the zone\'s previous star — freshest read wins']);
      if (ev.durMs) rows.push(['confirmed', `held ${(ev.durMs / 1000).toFixed(1)}s before firing`]);
      if (ev.atStruct) rows.push(['context', 'AT STRUCTURE ⚠ (F5b: flow reverses at levels)']);
    } else if (ev.kind === 'iceberg') {
      // side = the DEFENDER, always: buy = hidden buyer on the bid (support), sell = hidden
      // seller on the ask (resistance). Direction of a break follows from that.
      const bidIce = ev.side === 'buy';
      rows.push(['iceberg', `${bidIce ? 'BID' : 'ASK'} — hidden ${bidIce ? 'BUYER defending (support)' : 'SELLER defending (resistance)'}${ev.native ? ' · NATIVE (one order, exchange-proven)' : ''}`]);
      rows.push(['hidden', `${ev.size} ct filled that were NEVER displayed`]);
      if (ev.exec) rows.push(['executed', `${ev.exec} ct total traded at the level`]);
      if (ev.state === 'active') rows.push(['queued', `${ev.queueCt ?? 0} ct re-posted, waiting to fill`]);
      if (ev.lastFillT) {
        const age = Math.max(0, Date.now() / 1000 - ev.lastFillT);
        rows.push(['last reload', age < 60 ? age.toFixed(0) + 's ago' : (age / 60).toFixed(1) + 'm ago']);
      }
      if (ev.refills != null) rows.push(['reloads', `${ev.refills}× machine re-posts that then traded`]);
      if (ev.durMs) rows.push(['duration', (ev.durMs / 1000).toFixed(1) + 's']);
      if (ev.state) rows.push(['episode', ev.state === 'active' ? 'ACTIVE — defending right now'
        : ev.state === 'held' ? `HELD — attackers gave up, price rejected ${bidIce ? 'UP off the bid ▲' : 'DOWN off the ask ▼'}`
        : bidIce ? 'BROKE — sellers punched through, price broke DOWN ▼' : 'BROKE — buyers punched through, price broke UP ▲']);
    } else if (ev.kind === 'stoprun') {
      const up = ev.side === 'buy';
      rows.push(['stop run', up ? 'UPWARD cascade — buy stops above the level fired' : 'DOWNWARD cascade — sell stops below the level fired']);
      rows.push(['cascade', `${ev.size} ct from ${ev.levels ?? '?'} DIFFERENT traders (independent stops, not one player)`]);
      if (ev.lamRatio != null) rows.push(['burst', `arrivals ${ev.lamRatio}× the normal rate — self-feeding`]);
      if (ev.signals?.length) rows.push(['swept ref', ev.signals[0] === 'session' ? 'session high/low' : ev.signals[0] === 'struct' ? 'daily level' : ev.signals[0] === 'round' ? 'round number' : 'recent swing extreme']);
      rows.push(['state', ev.state === 'active' ? 'RUNNING — still unresolved, wait'
        : ev.state === 'reclaimed' ? `RECLAIMED — price snapped back ${up ? 'BELOW' : 'ABOVE'} the level: the breakout FAILED, chasers trapped`
        : `ACCEPTED — price held ${up ? 'ABOVE' : 'BELOW'} the level: genuine breakout`]);
      if (ev.durMs) rows.push(['resolved in', (ev.durMs / 1000).toFixed(1) + 's']);
    } else if (ev.kind === 'trapped') {
      const longs = ev.side === 'sell';   // side = the puke direction
      rows.push(['trapped', longs ? 'LONGS — bought the high, price reversed DOWN on them' : 'SHORTS — sold the low, price reversed UP on them']);
      rows.push(['burst', `${ev.size} ct chased the extreme${ev.levels != null ? ` (${ev.levels} different traders)` : ''}`]);
      if (ev.signals?.length) rows.push(['at ref', ev.signals[0] === 'session' ? 'session high/low' : ev.signals[0] === 'struct' ? 'daily level' : 'round number']);
      rows.push(['state', ev.state === 'active' ? `UNDERWATER NOW — their ${longs ? 'selling' : 'buying'} exits are pending fuel`
        : ev.state === 'flushed' ? `FLUSHED — they capitulated, move extended ${longs ? 'DOWN ▼' : 'UP ▲'}`
        : ev.state === 'recovered' ? 'RECOVERED — price returned to their entries, trap died' : '—']);
      if (ev.durMs) rows.push(['resolved in', (ev.durMs / 1000).toFixed(0) + 's']);
    } else if (ev.kind === 'wall') {
      // side flips meaning by state (defender while standing/held, winner once broken/pulled) —
      // spell BOTH out so the tooltip never needs decoding
      const brokenLike = ev.state === 'break' || ev.state === 'pulled';
      const bidWall = brokenLike ? ev.side === 'sell' : ev.side === 'buy';
      rows.push(['wall', bidWall ? `BID wall — ${ev.size} ct resting to BUY (support)` : `ASK wall — ${ev.size} ct resting to SELL (resistance)`]);
      if (ev.state === 'active' && ev.levels != null) rows.push(['remaining', String(ev.levels)]);
      if (ev.exec) rows.push(['absorbed', `${ev.exec} ct traded into it`]);
      rows.push(['state', ev.state === 'active' ? 'STANDING NOW — being defended' : ev.state === 'hold' ? 'HELD — rejected the test'
        : ev.state === 'break' ? (bidWall ? 'BROKE — sellers ate it, price broke DOWN ▼' : 'BROKE — buyers ate it, price broke UP ▲') : 'PULLED — owner walked it, not eaten']);
      if (ev.durMs) rows.push(['standing for', (ev.durMs / 1000).toFixed(0) + 's']);
    } else if (ev.kind === 'sweep') {
      rows.push(['sweep', ev.side === 'buy'
        ? `aggressive BUYERS took ${ev.levels ?? '?'} price levels going UP ▲`
        : `aggressive SELLERS took ${ev.levels ?? '?'} price levels going DOWN ▼`]);
      rows.push(['size', `${ev.size} ct in one burst (one taker, or one chain within 100ms)`]);
    } else if (ev.kind === 'block') {
      rows.push(['block', ev.side === 'buy'
        ? `one large aggressive BUY order — ${ev.size} ct hit the asks`
        : `one large aggressive SELL order — ${ev.size} ct hit the bids`]);
    } else if (ev.kind === 'spoof') {
      const bidSpoof = ev.side === 'buy';
      rows.push(['spoof', bidSpoof
        ? `FAKE BID — big buy order flashed near the touch, pulled unfilled`
        : `FAKE ASK — big sell order flashed near the touch, pulled unfilled`]);
      rows.push(['size', `${ev.size} ct of advertised size that was never real`]);
      if (ev.lifeMs != null) rows.push(['lived', (ev.lifeMs / 1000).toFixed(1) + 's before the pull']);
      if (ev.repeats != null) rows.push(['repeats', `${ev.repeats} pulls in this zone / 60s — layering pattern`]);
      rows.push(['read', `distrust displayed ${bidSpoof ? 'bid' : 'ask'} size here; they likely want the OTHER side filled`]);
    } else if (ev.kind === 'absorption') {
      const buyDef = ev.side === 'buy';   // side = the DEFENDER winning the fight
      rows.push(['absorption', buyDef
        ? 'BUYERS soaking up aggressive selling — price refuses to fall (support forming)'
        : 'SELLERS soaking up aggressive buying — price refuses to rise (resistance forming)']);
      rows.push(['flow eaten', `${ev.size} ct of net ${buyDef ? 'sell' : 'buy'} pressure, no price progress`]);
      if (ev.lamRatio != null) rows.push(['price impact', `collapsed to ${ev.lamRatio.toFixed(2)}× normal (statistically confirmed)`]);
    } else if (ev.kind === 'stacked') {
      rows.push(['stacked', ev.side === 'buy'
        ? `${ev.levels ?? '?'} consecutive levels of one-sided BUYING (footprint ladder up)`
        : `${ev.levels ?? '?'} consecutive levels of one-sided SELLING (footprint ladder down)`]);
      rows.push(['volume', `${ev.size} ct on the dominant side`]);
      rows.push(['note', 'measured weak standalone — context only, low weight in stars']);
    } else if (ev.kind === 'unfinished') {
      rows.push(['unfinished', ev.side === 'buy'
        ? 'HIGH made with no opposing prints — untested level above (possible revisit magnet)'
        : 'LOW made with no opposing prints — untested level below (possible revisit magnet)']);
      rows.push(['volume', `${ev.size} ct one-sided at the extreme`]);
      rows.push(['note', 'settled NULL in backtests — visual context only, never scored']);
    } else {
      rows.push(['size', String(ev.size)]);
      if (ev.levels != null) rows.push(['levels', String(ev.levels)]);
      if (ev.state) rows.push(['state', String(ev.state)]);
    }
    if (ev.kind !== 'confluence' && ev.atStruct) rows.push(['context', 'at a daily structural level']);
    return rows;
  };

  // Tooltip HEADER in market terms — the one-line read before any rows.
  const tipTitle = (ev: TapeEvent): string => {
    const p = ev.price.toFixed(2);
    switch (ev.kind) {
      case 'confluence': return `ACTION AREA · ${ev.side === 'buy' ? 'LONG evidence' : 'SHORT evidence'} @ ${p}`;
      case 'wall': {
        const bid = ev.state === 'break' || ev.state === 'pulled' ? ev.side === 'sell' : ev.side === 'buy';
        return `${bid ? 'BID' : 'ASK'} WALL${ev.state === 'break' ? (ev.side === 'buy' ? ' · BROKE ▲' : ' · BROKE ▼') : ev.state === 'pulled' ? ' · PULLED' : ev.state === 'hold' ? ' · HELD' : ''} @ ${p}`;
      }
      case 'iceberg': {
        const bid = ev.side === 'buy';
        const st = ev.state === 'broke' ? (bid ? ' · BROKE ▼' : ' · BROKE ▲') : ev.state === 'held' ? ' · HELD' : ev.state === 'active' ? ' · LIVE' : '';
        return `${bid ? 'BID' : 'ASK'} ICEBERG${ev.native ? ' ★' : ''}${st} @ ${p}`;
      }
      case 'stoprun': return `STOP RUN ${ev.side === 'buy' ? '▲' : '▼'}${ev.state === 'reclaimed' ? ' · FAILED' : ev.state === 'accepted' ? ' · HELD' : ''} @ ${p}`;
      case 'trapped': return `TRAPPED ${ev.side === 'sell' ? 'LONGS' : 'SHORTS'} @ ${p}`;
      case 'sweep': return `${ev.side === 'buy' ? 'BUY SWEEP ▲' : 'SELL SWEEP ▼'} @ ${p}`;
      case 'block': return `${ev.side === 'buy' ? 'BUY' : 'SELL'} BLOCK @ ${p}`;
      case 'spoof': return `${ev.side === 'buy' ? 'FAKE BID' : 'FAKE ASK'} @ ${p}`;
      case 'absorption': return `${ev.side === 'buy' ? 'BUY ABSORPTION (support)' : 'SELL ABSORPTION (resistance)'} @ ${p}`;
      case 'stacked': return `STACKED ${ev.side === 'buy' ? 'BUYING' : 'SELLING'} @ ${p}`;
      case 'unfinished': return `UNFINISHED ${ev.side === 'buy' ? 'HIGH' : 'LOW'} @ ${p}`;
      default: return `${(ev.kind as string).toUpperCase()} · ${ev.side} @ ${p}`;
    }
  };

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%', background: 'var(--bg-0)' }} />

      {/* Ranked TOP ICEBERGS in view — dominant resting hidden size at a glance (contracts + rate). */}
      {tapeOn && topIce.length > 0 && (
        <div style={{
          position: 'absolute', top: 8, right: priceScaleW + 2, zIndex: 20, pointerEvents: 'none',
          background: 'rgba(10,10,15,0.94)', border: '1px solid #3a3a44', borderRadius: 4,
          padding: '7px 11px', fontFamily: 'Geist Mono, monospace', fontSize: 13, fontWeight: 700,
        }}>
          <div style={{ color: '#7dd3fc', fontSize: 12, letterSpacing: 0.5, marginBottom: 5 }}>TOP ICEBERGS · in view · H hidden E executed Q queued</div>
          {topIce.map((ev, i) => {
            const col = ev.side === 'buy' ? '#22d3ee' : '#a78bfa';
            const live = ev.state === 'active';
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, lineHeight: 1.6, opacity: live || !ev.state ? 1 : 0.65 }}>
                <span style={{ color: '#e2e8f0', width: 12 }}>{i + 1}</span>
                <span style={{ color: col, width: 70 }}>{ev.price.toFixed(2)}</span>
                <span style={{ color: '#ffffff', width: 52, textAlign: 'right' }}>H{ev.size}</span>
                <span style={{ color: '#e2e8f0', width: 52, textAlign: 'right' }}>{ev.exec ? `E${ev.exec}` : '—'}</span>
                <span style={{ color: live && (ev.queueCt ?? 0) > 0 ? '#4ade80' : '#e2e8f0', width: 46, textAlign: 'right' }}>{live ? `Q${ev.queueCt ?? 0}` : ev.state === 'held' ? 'HELD' : ev.state === 'broke' ? 'BRK' : '—'}</span>
                <span style={{ color: '#e2e8f0', width: 40, textAlign: 'right' }}>×{ev.refills ?? '—'}</span>
                <span style={{ color: ev.native ? '#fde047' : col, width: 14, textAlign: 'center' }}>{ev.native ? '★' : '◆'}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* TAPE marker hover tooltip — details for the marker under the crosshair (iceberg: contracts,
          refills, duration, contracts/time rate — so persistent icebergs can be compared). */}
      {tapeTip && (() => {
        // STACKED tooltip: every marker under the cursor gets its own section (nearest first,
        // capped at 4) — overlapping markers were previously one-at-a-time and unreachable.
        const shown = tapeTip.evs.slice(0, 4);
        const extra = tapeTip.evs.length - shown.length;
        const cw = containerRef.current?.clientWidth ?? 9999;
        const flipX = tapeTip.x > cw - 560;
        const first = shown[0]!;
        const firstCol = first.side === 'buy' ? '#22d3ee' : '#a78bfa';
        const borderCol = first.kind === 'iceberg' && first.native ? '#fde047' : firstCol;
        return (
          <div style={{
            // width: max-content + nowrap = box grows to fit the LONGEST row, so every label/value
            // pair renders on exactly ONE line (user: detail yes, wrapping no). Near the right
            // edge it anchors via `right` so the wide box stays on screen.
            position: 'absolute', left: flipX ? undefined : tapeTip.x + 14, right: flipX ? cw - tapeTip.x + 14 : undefined, top: tapeTip.y + 14,
            zIndex: 50, pointerEvents: 'none', width: 'max-content', maxWidth: 700, whiteSpace: 'nowrap',
            background: 'rgba(10,10,15,0.96)', border: `1px solid ${borderCol}`,
            borderRadius: 4, padding: '6px 9px', fontFamily: 'Geist Mono, monospace', fontSize: 12, fontWeight: 700,
            color: '#e5e7eb', boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
          }}>
            {shown.map((ev, i) => {
              const sideCol = ev.side === 'buy' ? '#22d3ee' : '#a78bfa';
              const et = new Date(ev.t * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
              return (
                <div key={i} style={i > 0 ? { borderTop: '1px solid #2a2a33', marginTop: 6, paddingTop: 6 } : undefined}>
                  <div style={{ color: sideCol, marginBottom: 4 }}>{tipTitle(ev)}</div>
                  {fmtTipRows(ev).map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
                      <span style={{ color: '#9ca3af' }}>{k}</span><span>{v}</span>
                    </div>
                  ))}
                  <div style={{ color: '#6b7280', marginTop: 3, fontSize: 11 }}>{et} ET</div>
                </div>
              );
            })}
            {extra > 0 && <div style={{ color: '#9ca3af', marginTop: 6, fontSize: 11 }}>+{extra} more marker{extra > 1 ? 's' : ''} here — zoom in to separate</div>}
          </div>
        );
      })()}

      {/* Drawing SVG overlay — z-index ensures it sits above the lightweight-charts
          canvas. Without an explicit z-index the canvas's internal layers can
          end up on top and swallow our clicks. */}
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        style={{
          position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
          overflow: 'hidden',
          zIndex: 8,
          pointerEvents: drawMode ? 'auto' : 'none',
          cursor: drawMode === 'line' || drawMode === 'measure' ? 'crosshair' : drawMode === 'text' ? 'text' : 'default',
        }}
        onClick={handleSvgClick}
        onMouseMove={handleSvgMouseMove}
        onMouseLeave={() => { previewMouseRef.current = null; renderDrawingsRef.current(); }}
      />

      {/* Draw-mode debug indicator — visible whenever a drawing tool is active. */}
      {drawMode && (
        <div style={{
          position: 'absolute',
          top: 8,
          right: 80,
          zIndex: 30,
          background: 'rgba(90,155,255,0.18)',
          border: '1px solid #5a9bff',
          borderRadius: 4,
          padding: '4px 10px',
          color: '#5a9bff',
          fontFamily: 'Geist Mono, monospace',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.5,
          pointerEvents: 'none',
        }}>
          {drawMode === 'measure' ? '📏 MEASURE — click start, click end' : drawMode.toUpperCase()}
        </div>
      )}

      {/* Text input for draw-text tool */}
      {textInput && (
        <input
          autoFocus
          value={textValue}
          onChange={e => setTextValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') confirmText();
            if (e.key === 'Escape') { setTextInput(null); setTextValue(''); }
          }}
          onBlur={confirmText}
          style={{
            position: 'absolute', left: textInput.x, top: textInput.y - 18,
            background: 'rgba(10,10,12,0.9)', border: '1px solid #5a9bff',
            borderRadius: 2, color: '#fde047',
            fontFamily: 'Geist Mono, monospace', fontSize: 12, fontWeight: 600,
            padding: '2px 6px', outline: 'none', zIndex: 50, minWidth: 80,
          }}
        />
      )}

      {/* Left overlay — buttons row then Opening Bias below */}
      <div style={{ position: 'absolute', top: 8, left: 8, zIndex: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {(() => {
        // TIME-AND-WR + TRADE/NO-TRADE buttons retired 2026-06-06 — info now lives
        // in the always-on TRADE RULES box at top-center.
        const ctrlBtn = (color: string, active: boolean) => ({
          padding: '6px 14px',
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: 0.6,
          cursor: 'pointer' as const,
          // Border color shifts from faint (33 = 20% alpha) when off → full
          // saturation when on. Border WIDTH stays 1px so the button doesn't
          // change footprint and the row never jumps when toggled.
          border: `1px solid ${active ? color : `${color}33`}`,
          borderRadius: 3,
          // Active: tinted fill (33 ≈ 20% alpha) so the body of the button
          // reads as colored. Inactive: matches the chart background.
          background: active ? `${color}33` : 'rgba(10,10,12,0.85)',
          // Active: full-saturation label. Inactive: dimmed (80 = 50% alpha)
          // so off-buttons clearly recede.
          color: active ? color : `${color}b0`,
          // Active: outer glow + inset border doubles the visual weight without
          // changing pixel dimensions. Inactive: no shadow.
          boxShadow: active
            ? `0 0 12px ${color}55, inset 0 0 0 1px ${color}`
            : 'none',
          fontFamily: 'Geist Mono, monospace',
          transition: 'background 0.15s, box-shadow 0.15s, border-color 0.15s, color 0.15s',
          whiteSpace: 'nowrap' as const,
          pointerEvents: 'auto' as const,
        });

        return (
          <div ref={panelWrapRef} style={{ display: 'flex', flexDirection: 'row', gap: 4 }}>
            {/* ── OPENING BIAS — expands the opening-bias table (gap / bar1 / CVD3 / bias) ── */}
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setActivePanel(p => p === 'bias' ? null : 'bias')}
                title="Toggle the opening-bias table (9:29 gap, 9:31 bar1 position, 9:33 CVD3 → net BIAS)"
                style={ctrlBtn('#eab308', activePanel === 'bias')}
              >
                OPENING BIAS
              </button>
              {activePanel === 'bias' && (
                <div style={{ position: 'absolute', top: 'calc(100% + 3px)', left: 0, zIndex: 100 }}>
                  <OpeningBias symbol={selectedSymbol} barHistoryRef={barHistoryRef} barsVersion={barsVersion} />
                </div>
              )}
            </div>

            {/* ── REGIME ── */}
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setActivePanel(p => p === 'regime' ? null : 'regime')}
                style={ctrlBtn('#fb923c', activePanel === 'regime')}
              >
                REGIME
              </button>
              {activePanel === 'regime' && regimeCheckpoints.length > 0 && (
                <div style={{ position: 'absolute', top: 'calc(100% + 3px)', left: 0, zIndex: 100 }}>
                  <RegimePanel checkpoints={regimeCheckpoints} />
                </div>
              )}
            </div>

            {/* ── MEASURE — toggles the TradingView-style measuring tool ── */}
            <button
              onClick={() => setDrawMode(drawMode === 'measure' ? null : 'measure')}
              title="Measure: click start, click end (ESC to cancel)"
              style={{
                ...ctrlBtn('#5a9bff', drawMode === 'measure'),
                fontSize: 16,
                padding: '4px 10px',
              }}
            >
              📏
            </button>

            {/* QUALIFIED and TRADABLE are mutually exclusive AND independently
                dismissible. EXPERIMENTAL is an independent layer that can
                show on top of either. Four states for the primary pair:
                  - QUALIFIED selected → all gold-tier markers (broad view)
                  - TRADABLE selected  → only markers the new pipeline would OPEN
                  - Neither selected   → no primary markers
                Clicking the active button turns it off. Clicking the inactive
                one turns it on and the other off. EXPERIMENTAL toggles on/off
                independently. */}

            {/* ── QUALIFIED — markers for signals that passed quality gate ── */}
            <button
              onClick={() => {
                if (showQualified) { setShowQualified(false); }
                else               { setShowQualified(true); setShowTradable(false); }
              }}
              title="Toggle markers for quality-gated (qualified_signals) signals"
              style={ctrlBtn('#22c55e', showQualified)}
            >
              QUALIFIED
            </button>

            {/* ── TRADABLE — markers for what the new pipeline would OPEN ── */}
            <button
              onClick={() => {
                if (showTradable) { setShowTradable(false); }
                else              { setShowTradable(true); setShowQualified(false); }
              }}
              title="Toggle markers for tradable_signals where action='OPEN' (what the trader auto-takes when pipeline.activeMode='live')"
              style={ctrlBtn('#a855f7', showTradable)}
            >
              TRADABLE
            </button>

            {/* ── EXPERIMENTAL — markers for force-shadow rules (expl, etc.) ── */}
            <button
              onClick={() => setShowExperimental(!showExperimental)}
              title="Toggle markers for force-shadow rules — these are signals from rules that are logged but never traded (independent of QUALIFIED/TRADABLE)"
              style={ctrlBtn('#f59e0b', showExperimental)}
            >
              EXP
            </button>

            {/* ── HEAT — live Bookmap-style order-book heatmap + volume dots ──
                 DISABLED 2026-07-09 (Ravi): button hidden + heatmap:worker engine removed from
                 the dev scripts (see root package.json _heatmap_note). All code kept intact —
                 to reactivate, un-comment this block AND restore the worker in package.json.
            <button
              onClick={() => setHeatOn(!heatOn)}
              title="Toggle live order-book heatmap (resting depth) + volume dots (trade prints). Zoom in for full temporal detail. Streams from the MBO capture over /ws/heatmap."
              style={ctrlBtn('#ff5a3c', heatOn)}
            >
              HEAT
            </button>
            */}

            {/* ── FLOW — live L3 order-flow HUD (imbalance / aggressor delta / tape speed / temp / CVD) ── */}
            <button
              onClick={() => setFlowOn(!flowOn)}
              title="Toggle the live order-flow HUD — book imbalance, aggressor delta, tape speed, book temperature (MBO message rate) and true CVD, from the full L3 stream over /ws/flow."
              style={ctrlBtn('#22d3ee', flowOn)}
            >
              FLOW
            </button>

            {/* ── TAPE — live L3 event markers (sweeps / blocks / spoofs / icebergs / absorption) on the chart ── */}
            <button
              onClick={() => setTapeOn(!tapeOn)}
              title="Toggle live tape-event markers on the chart — sweeps (▲▼), blocks (●), icebergs (◆), spoofs (×) and absorption (⊢⊣ heavy flow, price pinned), from the full L3 stream over /ws/tape. Use the controls to dial density."
              style={ctrlBtn('#a78bfa', tapeOn)}
            >
              TAPE
            </button>

            {/* ── DRIFT — live filtered net-drift HUD (SHADOW; 0DTE/OTM/aggressor, 10m slope vs price-momentum placebo) ── */}
            <button
              onClick={() => setDriftOn(!driftOn)}
              title="Toggle the live NET-DRIFT HUD (shadow) — cumulative ABJ-filtered (0DTE/OTM/aggressor) call-vs-put premium for the mapped index (NQ→NDX, ES→SPX), its 10-min slope (the signal) and the price-momentum(10m) placebo it must beat. Forward-validation display only; gates nothing."
              style={ctrlBtn('#38bdf8', driftOn)}
            >
              DRIFT
            </button>

          </div>
        );
      })()}
      {flowOn && (
        <div style={{ display: 'flex' }}>
          <FlowHud symbol={selectedSymbol} />
        </div>
      )}
      {driftOn && (
        <div style={{ display: 'flex' }}>
          <DriftHud symbol={selectedSymbol} />
        </div>
      )}
      {tapeOn && (() => {
        const KIND_META: Record<TapeKind, { label: string; glyph: string }> = {
          sweep: { label: 'Sweep', glyph: '▲▼' }, block: { label: 'Block', glyph: '●' },
          iceberg: { label: 'Iceberg', glyph: '◆' }, spoof: { label: 'Spoof', glyph: '×' },
          absorption: { label: 'Absorb', glyph: '⊢⊣' }, stacked: { label: 'Stacked', glyph: '≡' },
          wall: { label: 'Wall', glyph: '▭' }, unfinished: { label: 'Unfin', glyph: '⌃' },
          trapped: { label: 'Trapped', glyph: '▷◁' }, stoprun: { label: 'StopRun', glyph: '»' },
          confluence: { label: 'Confluence', glyph: '★' },
        };
        const hasLevels = (k: TapeKind) => 'levels' in (TAPE_FLOORS[k] as Record<string, unknown>);
        const floorLev = (k: TapeKind) => (hasLevels(k) ? (TAPE_FLOORS[k] as { levels: number }).levels : 0);
        const toggleKind = (k: TapeKind) => setTapeKinds((prev) => {
          const next = new Set(prev); next.has(k) ? next.delete(k) : next.add(k); return next;
        });
        // While typing, store the raw value (allow transiently below the floor so you can type e.g.
        // "1"→"10"→"1000"); enforce the floor only on blur.
        const setMin = (k: TapeKind, v: number) => setTapeMinSizes((prev) => ({ ...prev, [k]: Math.max(0, v || 0) }));
        const setLev = (k: TapeKind, v: number) => setTapeMinLevels((prev) => ({ ...prev, [k]: Math.max(0, v || 0) }));
        const clampMin = (k: TapeKind) => setTapeMinSizes((prev) => ({ ...prev, [k]: Math.max(TAPE_FLOORS[k].size, prev[k] || 0) }));
        const clampLev = (k: TapeKind) => setTapeMinLevels((prev) => ({ ...prev, [k]: Math.max(floorLev(k), prev[k] || 0) }));
        const LUM = '#c4b5fd';   // luminescent lavender for the labels + numbers (was hard-to-see gray)
        const lbl = (fs: number): React.CSSProperties => ({ color: LUM, fontSize: fs, fontWeight: 700 });
        const inp = (on: boolean): React.CSSProperties => ({
          padding: '2px 5px', fontSize: 13, fontWeight: 700,
          background: 'var(--bg-2)', color: on ? '#ffffff' : 'var(--text-2)',
          border: `1px solid ${on ? 'rgba(167,139,250,0.5)' : 'var(--border)'}`, borderRadius: 3, opacity: on ? 1 : 0.5,
        });
        return (
          <div className="mono" style={{
            // responsive: wraps into CLEAN stacked rows on narrow windows (user preference
            // 2026-07-21 — over horizontal scrolling). Each kind group is flexShrink:0 so controls
            // keep their natural size and whole groups wrap as units, never mid-group.
            display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px 9px', marginTop: 6, padding: '5px 11px',
            maxWidth: '100%',
            background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 4,
            fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap',
          }}>
            <span style={{ color: '#a78bfa', fontSize: 12, fontWeight: 800, letterSpacing: 0.5 }}>TAPE</span>
            <button onClick={() => setTapePctMode((v) => !v)}
              title={tapePctMode
                ? 'PERCENTILE mode: size dials are percentiles of each event\'s OWN session (RTH vs overnight, per-symbol, recalibrated nightly) — "big" self-adjusts by clock. Click for absolute contracts.'
                : 'ABSOLUTE mode: size dials are fixed contract counts (a daytime-tuned number over-filters the overnight session). Click for percentile mode.'}
              style={{
                padding: '2px 7px', fontSize: 11, fontWeight: 800, cursor: 'pointer', borderRadius: 3,
                border: `1px solid ${tapePctMode ? '#34d399' : 'var(--border)'}`,
                background: tapePctMode ? 'rgba(52,211,153,0.15)' : 'transparent',
                color: tapePctMode ? '#34d399' : 'var(--text-2)', letterSpacing: 0.5,
              }}>
              {tapePctMode ? 'PCT' : 'ABS'}
            </button>
            {ALL_KINDS.map((k) => {
              const on = tapeKinds.has(k);
              return (
                <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                  <button onClick={() => toggleKind(k)} title={`Toggle ${KIND_META[k].label} markers`}
                    style={{
                      padding: '2px 7px', fontSize: 12, fontWeight: 700, cursor: 'pointer', borderRadius: 3,
                      border: `1px solid ${on ? '#a78bfa' : 'var(--border)'}`,
                      background: on ? 'rgba(167,139,250,0.15)' : 'transparent',
                      color: on ? LUM : 'var(--text-2)',
                    }}>
                    {KIND_META[k].glyph} {KIND_META[k].label}
                  </button>
                  {hasLevels(k) && (
                    <>
                      <input type="number" min={floorLev(k)} step={1} value={tapeMinLevels[k] || ''}
                        onChange={(e) => setLev(k, Number(e.target.value))} onBlur={() => clampLev(k)}
                        title={`${KIND_META[k].label}: minimum consecutive price levels (floor ${floorLev(k)})`}
                        disabled={!on} style={{ ...inp(on), width: 40 }} />
                      <span style={lbl(11)}>lvl</span>
                    </>
                  )}
                  {k === 'confluence' ? (
                    <>
                      <select value={confMinTier} onChange={(e) => setConfMinTier(Number(e.target.value))}
                        disabled={!on} style={{ ...inp(on), width: 74 }}
                        title="Importance filter: PRIME = defense+exhaustion aligned (rare) · KEY = +4-family/flip stars · ALL = everything">
                        <option value={1}>prime</option>
                        <option value={2}>key+</option>
                        <option value={3}>all</option>
                      </select>
                      <span style={lbl(11)} title="Show only the strongest N confluence stars in view (adaptive density)">top</span>
                      <input type="number" min={1} step={1} value={confTopN || ''}
                        onChange={(e) => setConfTopN(Math.max(1, Number(e.target.value) || 1))}
                        title="Max confluence markers shown in view, ranked tier-first"
                        disabled={!on} style={{ ...inp(on), width: 40 }} />
                    </>
                  ) : tapePctMode && PCT_KINDS.has(k) ? (
                  <><span style={lbl(12)}>≥</span>
                  <select value={tapeMinPct[k] ?? 0}
                    onChange={(e) => setTapeMinPct((prev) => ({ ...prev, [k]: Number(e.target.value) as 0 | 50 | 80 | 95 }))}
                    title={`${KIND_META[k].label}: show events at/above this percentile of their own session's distribution (all = engine floor only)`}
                    disabled={!on} style={{ ...inp(on), width: 60 }}>
                    <option value={0}>all</option>
                    <option value={50}>p50</option>
                    <option value={80}>p80</option>
                    <option value={95}>p95</option>
                  </select></>
                  ) : (
                  <><span style={lbl(12)}>≥</span>
                  <input type="number" min={TAPE_FLOORS[k].size} step={5} value={tapeMinSizes[k] || ''}
                    onChange={(e) => setMin(k, Number(e.target.value))} onBlur={() => clampMin(k)}
                    title={`${KIND_META[k].label}: min size in contracts (floor ${TAPE_FLOORS[k].size})${tapePctMode ? ' — no calibrated distribution for this kind, absolute even in PCT mode' : ''}`}
                    disabled={!on} style={{ ...inp(on), width: 56 }} /></>
                  )}
                  {hasLevels(k) && <span style={lbl(11)}>ct</span>}
                  {k === 'iceberg' && (
                    <>
                      <span style={lbl(11)} title="Roll up icebergs within ±N ticks into one diamond at the dominant tick">bkt</span>
                      <input type="number" min={1} step={1} value={iceBucketTicks || ''}
                        onChange={(e) => setIceBucketTicks(Math.max(1, Number(e.target.value) || 1))}
                        title="Iceberg roll-up bucket size in ticks (1 = per exact tick, higher = wider zones)"
                        disabled={!on} style={{ ...inp(on), width: 40 }} />
                      <span style={lbl(11)}>tk</span>
                    </>
                  )}
                </span>
              );
            })}
          </div>
        );
      })()}
      </div>

      {/* ── TRADE RULES — always-open quick reference, top-center.
          Lives at the chart root (NOT inside the top-left overlay) so the
          flex-center wrapper spans the full chart width. ── */}
      <div style={{
        position: 'absolute',
        top: 8,
        left: 0,
        right: 0,
        zIndex: 11,
        display: 'none', // TRADE RULES box hidden per Ravi 2026-06-18
        justifyContent: 'center',
        pointerEvents: 'none',
      }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '22px 36px 18px 1fr',
          rowGap: 4,
          columnGap: 6,
          alignItems: 'baseline',
          padding: '6px 12px',
          border: '1.5px solid #22c55e',
          borderRadius: 5,
          background: 'rgba(7, 18, 11, 0.92)',
          fontFamily: 'Geist Mono, monospace',
          fontSize: 12,
          fontWeight: 800,
          color: '#f5f5f5',
          letterSpacing: 0.3,
          whiteSpace: 'nowrap',
          boxShadow: '0 0 8px rgba(34, 197, 94, 0.25)',
          pointerEvents: 'auto',
        }}>
          {/* Header spans all 4 columns */}
          <div style={{
            gridColumn: '1 / span 4',
            fontSize: 11,
            color: '#22c55e',
            letterSpacing: 1,
            marginBottom: 1,
            borderBottom: '1px dotted #22c55e88',
            paddingBottom: 3,
          }}>
            🎯 TRADE RULES
          </div>

          {/* FLIP SHORT — take everywhere */}
          <span style={{ color: '#d64545', textAlign: 'center' }}>🌀</span>
          <span style={{ color: '#d64545' }}>FLIP↓</span>
          <span style={{ color: '#22c55e', textAlign: 'center' }}>→</span>
          <span>
            <span style={{ color: '#a5f3a3' }}>take all</span>
            <span style={{ color: '#666', margin: '0 6px' }}>|</span>
            <span style={{ color: '#fff' }}>78% WR</span>
          </span>

          {/* FLIP LONG — 10:30 onward only */}
          <span style={{ color: '#2bb673', textAlign: 'center' }}>🌀</span>
          <span style={{ color: '#2bb673' }}>FLIP↑</span>
          <span style={{ color: '#22c55e', textAlign: 'center' }}>→</span>
          <span>
            <span style={{ color: '#a5f3a3' }}>from 10:30</span>
            <span style={{ color: '#666', margin: '0 6px' }}>|</span>
            <span style={{ color: '#fff' }}>67% WR</span>
          </span>

          {/* CONT-REENTRY — score-90+ continuation entry after a qualifying parent */}
          <span style={{ color: '#a78bfa', textAlign: 'center' }}>🔁</span>
          <span style={{ color: '#a78bfa' }}>CONT↕</span>
          <span style={{ color: '#22c55e', textAlign: 'center' }}>→</span>
          <span>
            <span style={{ color: '#a5f3a3' }}>after parent + 20-55% pullback</span>
            <span style={{ color: '#666', margin: '0 6px' }}>|</span>
            <span style={{ color: '#fff' }}>83% (score≥90)</span>
          </span>

          {/* Universal cutoff */}
          <span style={{ color: '#fcd34d', textAlign: 'center' }}>⏰</span>
          <span style={{ color: '#fcd34d' }}>STOP</span>
          <span style={{ color: '#22c55e', textAlign: 'center' }}>→</span>
          <span>
            <span style={{ color: '#fff' }}>after 14:30</span>
            <span style={{ color: '#666', margin: '0 6px' }}>|</span>
            <span style={{ color: '#fcd34d' }}>late-day chop</span>
          </span>

          {/* FADE / EXPL retired from rules box 2026-06-04 — EXPL silenced (both sides losing),
              FADE shadow-only pending validation */}
        </div>
      </div>

      {/* Scroll to latest — bottom right, above the time axis. Also re-fits
          the price scale so the latest price action is in view (without this,
          jumping from an older Jun-4 view at 30,000-30,600 to today's
          ~29,000 leaves the candles below the visible band). */}
      <button
        onClick={() => {
          const chart = chartRef.current;
          if (!chart) return;
          chart.timeScale().scrollToRealTime();
          const ps = chart.priceScale('right');
          ps.applyOptions({ autoScale: false });
          ps.applyOptions({ autoScale: true });
        }}
        title="Go to latest"
        style={{
          position: 'absolute',
          bottom: 40,
          right: 16,
          zIndex: 20,
          background: 'var(--bg-2, #2a2a3a)',
          border: '1px solid var(--border, #555)',
          borderRadius: 4,
          color: '#ccc',
          cursor: 'pointer',
          padding: '5px 9px',
          fontSize: 16,
          fontWeight: 'bold',
          lineHeight: 1,
          userSelect: 'none',
        }}
      >
        »
      </button>

      {/* Calendar — bottom left, jumps the chart to a chosen day's RTH session */}
      <button
        onClick={() => setCalendarOpen(v => !v)}
        title="Jump to date"
        style={{
          position: 'absolute',
          bottom: 40,
          left: 16,
          zIndex: 20,
          background: 'var(--bg-2, #2a2a3a)',
          border: '1px solid var(--border, #555)',
          borderRadius: 4,
          color: '#ccc',
          cursor: 'pointer',
          padding: '4px 8px',
          fontSize: 14,
          lineHeight: 1,
          userSelect: 'none',
        }}
      >
        📅
      </button>
      {calendarOpen && (
        <div
          style={{
            position: 'absolute',
            bottom: 76,
            left: 16,
            zIndex: 30,
            background: 'var(--bg-2, #2a2a3a)',
            border: '1px solid var(--border, #555)',
            borderRadius: 6,
            padding: 12,
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            color: '#ccc',
            fontSize: 13,
            userSelect: 'none',
          }}
        >
          <div style={{ marginBottom: 8 }}>Jump to date (RTH session):</div>
          <input
            type="date"
            value={calendarDate}
            onChange={e => setCalendarDate(e.target.value)}
            autoFocus
            style={{
              background: 'var(--bg-1, #1a1a26)',
              border: '1px solid var(--border, #555)',
              borderRadius: 4,
              color: '#fff',
              padding: '4px 6px',
              fontSize: 13,
              colorScheme: 'dark',
              width: '100%',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
            <button
              onClick={() => setCalendarOpen(false)}
              style={{
                background: 'transparent',
                border: '1px solid var(--border, #555)',
                borderRadius: 4,
                color: '#aaa',
                cursor: 'pointer',
                padding: '4px 12px',
                fontSize: 13,
              }}
            >
              Cancel
            </button>
            <button
              onClick={async () => {
                const chart = chartRef.current;
                if (!chart || !calendarDate) { setCalendarOpen(false); return; }
                // RTH window for the chosen ET date: 09:30 → 16:00 ET (EDT-fixed).
                // Fetch a slightly wider window (pre-market through after-hours) so
                // there's context around the RTH session if the user scrolls.
                const [y, m, d] = calendarDate.split('-').map(Number) as [number, number, number];
                const fetchFromMs = Date.UTC(y, m - 1, d,  8,  0);  // 04:00 ET
                const fetchToMs   = Date.UTC(y, m - 1, d, 24,  0);  // 20:00 ET
                const fromSec = Math.floor(Date.UTC(y, m - 1, d, 13, 30) / 1000) as UTCTimestamp;
                const toSec   = Math.floor(Date.UTC(y, m - 1, d, 20,  0) / 1000) as UTCTimestamp;

                // Fetch + merge bars for that date on demand. The initial 7-day
                // fetch doesn't cover historical days, so we have to pull them
                // explicitly here.
                try {
                  const url = `/history/bars?symbol=${selectedSymbol}&from=${fetchFromMs}&to=${fetchToMs}&interval=${selectedTimeframe}`;
                  const res = await fetch(url);
                  if (res.ok) {
                    const data = await res.json() as {
                      bars: { ts: number; open: number; high: number; low: number; close: number; buyVolume: number; sellVolume: number }[];
                    };
                    const history = barHistoryRef.current[selectedSymbol] ?? new Map();
                    barHistoryRef.current[selectedSymbol] = history;
                    for (const bar of data.bars) {
                      const t = Math.floor(bar.ts / 1000);
                      if (!history.has(t)) {
                        history.set(t, {
                          open: bar.open, high: bar.high, low: bar.low, close: bar.close,
                          volume: (bar.buyVolume ?? 0) + (bar.sellVolume ?? 0),
                        });
                      }
                    }
                    // Replace series data with merged history so the new bars render.
                    const series = seriesRef.current;
                    if (series) {
                      const seriesData = Array.from(history.entries())
                        .sort((a, b) => a[0] - b[0])
                        .map(([t, b]) => ({
                          time: t as UTCTimestamp,
                          open: b.open, high: b.high, low: b.low, close: b.close,
                        }));
                      series.setData(seriesData);
                      lastLiveSecRef.current[selectedSymbol] = seriesData[seriesData.length - 1]!.time as number;
                    }
                    // Mark this day as covered for the dynamic loader.
                    const rk = `${selectedSymbol}:${selectedTimeframe}`;
                    loadedRangesRef.current[rk] = mergeRange(
                      loadedRangesRef.current[rk] ?? [],
                      fetchFromMs,
                      fetchToMs,
                    );
                    setBarsVersion(v => v + 1);
                  }
                } catch {
                  // best-effort; we still scroll to the date even if fetch failed
                }

                chart.timeScale().setVisibleRange({ from: fromSec, to: toSec });
                setCalendarOpen(false);
              }}
              style={{
                background: '#22c55e',
                border: '1px solid #22c55e',
                borderRadius: 4,
                color: '#0a1a0a',
                cursor: 'pointer',
                padding: '4px 16px',
                fontSize: 13,
                fontWeight: 'bold',
              }}
            >
              OK
            </button>
          </div>
        </div>
      )}

      {/* Signal overlay cards — hidden for now, re-enable by removing the `false &&` */}
      {false && cardPositions.map(({ sig, x, y, id }) => (
        <div key={id} style={{
          position: 'absolute', left: x, top: y, zIndex: 15, pointerEvents: 'none',
        }}>
          <SignalChartCard sig={sig} />
        </div>
      ))}
    </div>
  );
}
