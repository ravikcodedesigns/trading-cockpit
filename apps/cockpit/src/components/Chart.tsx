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
import { tradingDayFor, lookupLevelStyle } from '@trading/contracts';
import type { ConfluenceSignal, LevelStyle } from '@trading/contracts';
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
  '#f472b6', // pink
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
function playSignalSound(ac: AudioContext, direction: string, ruleId: string): void {
  try {
    const master = ac.createGain();
    master.gain.value = 0.25;
    master.connect(ac.destination);

    const tone = (freq: number, startSec: number, durSec: number) => {
      const osc = ac.createOscillator();
      const env = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      env.gain.setValueAtTime(0, startSec);
      env.gain.linearRampToValueAtTime(1, startSec + 0.01);
      env.gain.exponentialRampToValueAtTime(0.001, startSec + durSec);
      osc.connect(env);
      env.connect(master);
      osc.start(startSec);
      osc.stop(startSec + durSec);
    };

    const t = ac.currentTime;
    if (ruleId === 'expl') {
      tone(440, t,        0.18);
      tone(660, t + 0.18, 0.18);
      tone(880, t + 0.36, 0.22);
    } else if (ruleId === 'clean-impulse') {
      const [f1, f2] = direction === 'long' ? [440, 660] : [660, 440];
      tone(f1, t,        0.18);
      tone(f2, t + 0.18, 0.28);
    } else if (ruleId === 'reject-resistance') {
      // descending three-tone — distinct from FLIP and EXPL
      tone(800, t,         0.14);
      tone(600, t + 0.14,  0.14);
      tone(400, t + 0.28,  0.22);
    } else if (ruleId === 'ala-bounce' || ruleId === 'ala-reclaim' || ruleId === 'ala-zone-reclaim') {
      // ascending three-tone — long bias signal at hedge-pressure / zone level
      tone(400, t,         0.14);
      tone(600, t + 0.14,  0.14);
      tone(800, t + 0.28,  0.22);
    } else {
      tone(direction === 'long' ? 528 : 396, t, 0.35);
    }
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
  // Per-level label entries for today's levels, drawn as SVG text in the
  // drawing overlay (positioned at top-right of each line) so we can control
  // font-size and placement beyond what lightweight-charts' price-axis chip
  // allows.
  const levelLabelsRef = useRef<Array<{ price: number; label: string; color: string }>>([]);
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
  // Symbols currently mid-fetch (prevents redundant requests).
  const fetchInFlightRef = useRef<Set<string>>(new Set());
  // Debounce timer for the scroll-driven dynamic loader.
  const dynamicLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest dynamic-load callback, populated by an effect so the chart's
  // visible-range subscription always reaches the most recent closure.
  const dynamicLoadRef = useRef<(fromMs: number, toMs: number) => void>(() => {});

  // Incremented after historical bars finish loading so the markers effect
  // re-runs with a populated barHistoryRef (post-entry markers arrive via a
  // separate fast fetch that often completes before the bar history).
  const [barsVersion, setBarsVersion] = useState(0);

  const [activePanel, setActivePanel] = useState<'regime' | null>(null);
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
  const [showQualified, setShowQualified] = useState(true);
  const [showV3,        setShowV3]        = useState(true);
  const qualifiedTsRef = useRef<Set<number>>(new Set());
  const v3OpenTsRef    = useRef<Set<number>>(new Set());
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
  const levelsByDay    = useStore((s) => s.levelsByDay);
  const flashAlpha     = useStore((s) => s.flashAlpha[s.selectedSymbol]);
  const recentEvents   = useStore((s) => s.recentEvents);
  const recentSignals  = useStore((s) => s.recentSignals);

  // Fetch the set of "qualified" and "V3-OPEN" signal-timestamp buckets so
  // the chart can render only the relevant markers when those toggles are on.
  // Re-runs on symbol change and polls every 60s for fresh decisions.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await fetch(`/signals/marks?symbol=${selectedSymbol}`);
        if (!res.ok) return;
        const data = await res.json() as { qualifiedTs: number[]; v3OpenTs: number[] };
        if (cancelled) return;
        qualifiedTsRef.current = new Set(data.qualifiedTs);
        v3OpenTsRef.current    = new Set(data.v3OpenTs);
        setBarsVersion(v => v + 1);   // re-trigger marker render
      } catch { /* best-effort */ }
    };
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [selectedSymbol]);

  // Clear bar history when timeframe changes so historical bars re-fetch
  useEffect(() => {
    barHistoryRef.current[selectedSymbol] = new Map();
    // Loaded ranges are per (symbol, timeframe) — clear only the active key
    // so a timeframe change forces a re-fetch but other (symbol, tf) caches stay.
    loadedRangesRef.current[`${selectedSymbol}:${selectedTimeframe}`] = [];
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
          loadedRangesRef.current[rk] = mergeRange(loadedRangesRef.current[rk] ?? [], gFrom, gTo);
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
        fontFamily: 'IBM Plex Mono, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#17171c' },
        horzLines: { color: '#17171c' },
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
    seriesRef.current = chart.addCandlestickSeries({
      upColor: '#2bb673',
      downColor: '#d64545',
      borderUpColor: '#2bb673',
      borderDownColor: '#d64545',
      wickUpColor: '#2bb673',
      wickDownColor: '#d64545',
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
    chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
      if (!range) return;
      if (dynamicLoadTimerRef.current) clearTimeout(dynamicLoadTimerRef.current);
      dynamicLoadTimerRef.current = setTimeout(() => {
        const fromMs = (range.from as number) * 1000;
        const toMs   = (range.to   as number) * 1000;
        dynamicLoadRef.current(fromMs, toMs);
      }, 250);
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
  // The cockpit's in-memory bar history is wiped on browser refresh, but
  // the aggregator's SQLite has all bars persisted. This call rehydrates
  // the chart so users don't lose context after every reload.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    let cancelled = false;
    (async () => {
      try {
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

        const seriesData = Array.from(history.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([time, ohlc]) => ({ time: time as UTCTimestamp, open: ohlc.open, high: ohlc.high, low: ohlc.low, close: ohlc.close }));
        series.setData(seriesData);

        // Compute session VWAP from historical bars (resets at RTH 09:30 ET each day).
        // data.bars is already sorted ascending by ts from the server.
        vwapSessionsRef.current.clear();
        const sessAcc = new Map<string, { sumPV: number; sumV: number }>();
        const vwapPoints: { time: UTCTimestamp; value: number }[] = [];
        for (const bar of data.bars) {
          if (!isRTHBar(bar.ts)) continue;
          const vol = (bar.buyVolume ?? 0) + (bar.sellVolume ?? 0);
          if (vol === 0) continue;
          const day = tradingDayFor(bar.ts);
          let s = sessAcc.get(day);
          if (!s) { s = { sumPV: 0, sumV: 0 }; sessAcc.set(day, s); }
          s.sumPV += ((bar.high + bar.low + bar.close) / 3) * vol;
          s.sumV  += vol;
          const t = Math.floor(bar.ts / 1000) as UTCTimestamp;
          vwapPoints.push({ time: t, value: s.sumPV / s.sumV });
          vwapSessionsRef.current.set(day, { sumPV: s.sumPV, sumV: s.sumV, lastBucket: t as number });
        }
        if (vwapSeriesRef.current && vwapPoints.length > 0) {
          vwapSeriesRef.current.setData(vwapPoints);
        }

        // After bulk-loading history, keep the view anchored to recent data.
        // Without this, lightweight-charts auto-fits ALL bars into the viewport,
        // which compresses months of data into a tiny view. We scroll to the
        // right edge while capping the visible window at 7 days so the user
        // sees recent context at a readable zoom and can scroll left for history.
        const chart = chartRef.current;
        if (chart && seriesData.length > 0) {
          const nowSec = Math.floor(Date.now() / 1000) as UTCTimestamp;
          const sevenDaysAgoSec = (nowSec - 7 * 24 * 60 * 60) as UTCTimestamp;
          chart.timeScale().setVisibleRange({ from: sevenDaysAgoSec, to: nowSec });
        }
        // Mark this initial window as covered so the dynamic loader skips it.
        const rk = `${selectedSymbol}:${selectedTimeframe}`;
        loadedRangesRef.current[rk] = mergeRange(
          loadedRangesRef.current[rk] ?? [],
          fetchFromMs,
          fetchToMs,
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

    const data = Array.from(history.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([t, b]) => ({
        time: t as UTCTimestamp,
        open: b.open, high: b.high, low: b.low, close: b.close,
      }));

    series.setData(data);

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

      // Structural levels (PDH/PDL/PDC/ONH/ONL/ONO/POC/VAH/VAL) get a custom
      // SVG badge above the line at the chart's right edge.  RS levels keep
      // their built-in price-axis chip so the two systems stay visually
      // distinct.
      const STRUCTURAL_LABELS = new Set(['PDH','PDL','PDC','ONH','ONL','ONO','POC','VAH','VAL']);

      // addLevelLine consults the standardized LEVEL_STYLES palette
      // (packages/contracts/src/level-styles.ts) before falling back to the
      // caller's args. This means daily_levels.json entries with stale
      // colors get auto-canonicalized to the current spec.
      const addLevelLine = (price: number, color: string, title: string, style: LineStyle, width: 1 | 2 | 3 | 4) => {
        const canonical = lookupLevelStyle(title);
        const finalColor = canonical?.color ?? color;
        const finalWidth = canonical?.width ?? width;
        const finalStyle = canonical
          ? (styleMap[canonical.style] ?? style)
          : style;
        const isStructural = STRUCTURAL_LABELS.has(title);
        const ls = chart.addLineSeries({
          color: finalColor,
          lineWidth: finalWidth,
          lineStyle: finalStyle,
          priceLineVisible: false,
          // RS levels: show last-value chip on price axis (only for today).
          // Structural levels: chip disabled — we draw an SVG badge instead.
          lastValueVisible: isToday && !isStructural,
          crosshairMarkerVisible: false,
          title: isToday ? title : '',  // hover tooltip; only meaningful for today
        });
        ls.setData([
          { time: start as UTCTimestamp, value: price },
          { time: end as UTCTimestamp, value: price },
        ]);
        levelLinesRef.current.push(ls);
        if (isToday && isStructural) {
          levelLabelsRef.current.push({ price, label: title, color: finalColor });
        }
      };

      // Pass clean labels (no date suffix). RS structural lines (Bull/Bear/DD/HP)
      // are optional — skip if the field is absent so instruments without RS
      // framework data (e.g., ES Step 1) render only their additionalLevels.
      // NOTE: the color/style/width args below are now fallbacks — LEVEL_STYLES
      // overrides them when the label matches a known entry.
      if (dayLevels.bullZone) {
        addLevelLine(dayLevels.bullZone.high, '#2bb673', 'Bull H', LineStyle.Solid, 2);
        addLevelLine(dayLevels.bullZone.low,  '#2bb673', 'Bull L', LineStyle.Solid, 2);
      }
      if (dayLevels.bearZone) {
        addLevelLine(dayLevels.bearZone.high, '#d64545', 'Bear H', LineStyle.Solid, 2);
        addLevelLine(dayLevels.bearZone.low,  '#d64545', 'Bear L', LineStyle.Solid, 2);
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
  }, [levelsByDay, flashAlpha, selectedSymbol]);

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

    // Apply the QUALIFIED / V3 toggle filters. Both ON = pass-through
    // (default), both OFF = nothing rendered, exactly one ON = only that
    // category, both ON = union (legacy + qualified + V3).
    //
    // Match by minute-bucket of sig.ts because the server keys its returned
    // timestamp lists the same way (Math.floor(ts/60000)*60).
    const filterByToggles = (sigTsMs: number): boolean => {
      const bucket = Math.floor(sigTsMs / 60000) * 60;
      const isQualified = qualifiedTsRef.current.has(bucket);
      const isV3Open    = v3OpenTsRef.current.has(bucket);
      const isUnknown   = !isQualified && !isV3Open;
      // Always keep "unknown" signals (e.g. silenced ones the chart already
      // chose to show) when both toggles are off, so the chart isn't blank.
      if (!showQualified && !showV3) return isUnknown;
      if (showQualified && isQualified) return true;
      if (showV3        && isV3Open)    return true;
      if (showQualified && showV3 && isUnknown) return true;
      return false;
    };

    const symbolSignals = recentSignals
      .filter((s) => s.symbol === selectedSymbol)
      .filter((s) => filterByToggles(s.ts))
      .filter((s) => {
        const ruleId = (s as any).ruleId ?? (s as any).rule_id ?? "";
        // Strategy D: compression-breakout → 15m chart only
        if (ruleId === 'compression-breakout') return selectedTimeframe === 15;
        // Strategy E 15m: bear bar absorption → 15m chart only
        if (ruleId === 'absorption-scalp-15m') return selectedTimeframe === 15;
        // Strategy E 5m: bull bar absorption → 5m chart only
        if (ruleId === 'absorption-scalp') return selectedTimeframe === 5;
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
        const bucket = bucketSecs(sig.ts);
        if (!history.has(bucket)) return null;
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
        } else if (ruleId === 'compression-breakout') {
          shape = isLong ? 'arrowUp' : 'arrowDown';
          label = `COMP`;
        } else if (ruleId === 'absorption-scalp') {
          shape = 'arrowUp';
          label = `SCALP`;
        } else if (ruleId === 'absorption-scalp-15m') {
          shape = 'arrowUp';
          label = `SCALP`;
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
            size: 3,
          };
        } else if (ruleId === 'clean-impulse') {
          shape = isLong ? 'arrowUp' : 'arrowDown';
          const cfWarning = regimeAlignment('clean-impulse', sig.direction, sig.ts, regimeCheckpoints) === 'against';
          const rsScore = (sig as any).rsScore ?? (sig as any).rs_score;
          const rsStr = rsScore != null ? ` ${rsScore}` : '';
          label = (isLong ? 'FLIP ↑' : 'FLIP ↓') + rsStr + (cfWarning ? ' !' : '');
          return {
            time: bucket as UTCTimestamp,
            position,
            color: cfWarning ? '#fb923c' : '#f59e0b',
            shape,
            text: label,
            size: 2,
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
            size: 2,
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
            size: 2,
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
            size: 2,
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
            size: 2,
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
            size: 2,
          };
        } else if (ruleId === 'cont-reentry') {
          // CONT-REENTRY shadow signal (Strategy CONT). Violet to stand apart from
          // FLIP(amber)/EXPL(green)/RR(purple)/FADE(cyan)/BNC(cyan).
          shape = isLong ? 'arrowUp' : 'arrowDown';
          label = (isLong ? 'CONT-REENTRY-SHADOW ↑' : 'CONT-REENTRY-SHADOW ↓') + `·${sig.score}`;
          return {
            time: bucket as UTCTimestamp,
            position,
            color: '#8b5cf6',  // violet
            shape,
            text: label,
            size: 2,
          };
        } else if (ruleId === 'es-flip') {
          // ES-FLIP shadow signal (ES-tuned FLIP detector). Hot pink to be unmistakably
          // distinct from NQ FLIP(amber) and other rules. Only appears on /ES chart.
          shape = isLong ? 'arrowUp' : 'arrowDown';
          const passCount = (sig as any).passCount;
          const kStr = passCount ? `·K${passCount}` : '';
          label = (isLong ? 'ES-FLIP ↑' : 'ES-FLIP ↓') + kStr + `·${sig.score}`;
          return {
            time: bucket as UTCTimestamp,
            position,
            color: '#ec4899',  // hot pink
            shape,
            text: label,
            size: 2,
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
            size: 2,
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

    const allMarkers = [...markers]
      .sort((a, b) => (a.time as number) - (b.time as number));

    series.setMarkers(allMarkers);

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

    // Clean-flip signals: draw structural SL from payload + TP lines for each recent signal.
    const todayCleanFlips = todaySignals.filter(s => {
      const ruleId = (s as any).ruleId ?? (s as any).rule_id ?? '';
      return ruleId === 'clean-impulse';
    });
    for (const sig of todayCleanFlips) {
      const bucket = bucketSecs(sig.ts);
      const isRecent = nowSec - bucket < 4 * 3600;
      if (!isRecent) continue;
      const stopLevel: number | undefined = (sig as any).stopLevel;
      const entry: number = (sig as any).entry ?? history.get(bucket)?.close;
      if (!entry) continue;
      const isLong = sig.direction?.toLowerCase() === 'long';
      const sign   = isLong ? 1 : -1;
      const addLine = (price: number, color: string, title: string, style: LineStyle) => {
        const pl = series.createPriceLine({
          price, color, lineWidth: 1, lineStyle: style,
          axisLabelVisible: true, title,
        });
        signalLinesRef.current.push(pl);
      };
      if (stopLevel) addLine(stopLevel, '#d64545', 'SL', LineStyle.Solid);
      addLine(entry + sign * 20, '#2bb673', 'TP1', LineStyle.Dashed);
      addLine(entry + sign * 40, '#2bb673', 'TP2', LineStyle.SparseDotted);
    }

    // All other signals: latest one gets generic TP/DD offset lines.
    const latestOther = todaySignals
      .filter(s => {
        const ruleId = (s as any).ruleId ?? (s as any).rule_id ?? '';
        return ruleId !== 'clean-impulse';
      })
      .reduce((a, b) => a && a.ts > b.ts ? a : b, null as typeof todaySignals[0] | null);
    if (latestOther) {
      const bucket = bucketSecs(latestOther.ts);
      const bar = history.get(bucket);
      if (bar) {
        const entry  = bar.close;
        const isLong = latestOther.direction?.toLowerCase() === 'long';
        const sign   = isLong ? 1 : -1;
        const isRecent = nowSec - bucket < 4 * 3600;
        const addPriceLine = (offset: number, color: string, title: string, style: LineStyle) => {
          const pl = series.createPriceLine({
            price: entry + sign * offset,
            color, lineWidth: 1, lineStyle: style,
            axisLabelVisible: isRecent, title,
          });
          signalLinesRef.current.push(pl);
        };
        addPriceLine( 20, '#2bb673', 'TP1', LineStyle.Dashed);
        addPriceLine( 40, '#2bb673', 'TP2', LineStyle.SparseDotted);
        addPriceLine(-10, '#d64545', 'DD1', LineStyle.Dashed);
        addPriceLine(-20, '#d64545', 'DD2', LineStyle.SparseDotted);
      }
    }
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
          if (ruleId === 'compression-breakout') return selectedTimeframe === 15;
          if (ruleId === 'absorption-scalp')   return selectedTimeframe === 5;
          if (ruleId === 'absorption-scalp-15m') return selectedTimeframe === 15;
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
  }, [recentSignals, selectedSymbol, selectedTimeframe, barsVersion, showQualified, showV3]);

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
      ltxt.setAttribute('font-family', 'IBM Plex Mono, monospace');
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
        el.setAttribute('font-family', 'IBM Plex Mono, monospace');
        el.setAttribute('font-size', '12'); el.setAttribute('font-weight', '600');
        el.textContent = d.text;
        svg.appendChild(el);
      }
    }

    // Structural level badges: drawn as a filled pill ABOVE each line, pulled
    // ~80px in from the right edge of the chart pane so they sit clearly
    // inside the pane (NOT in the price-axis column where RS chips live).
    const paneWidth = ts.width();
    if (paneWidth > 0 && levelLabelsRef.current.length > 0) {
      const RIGHT_INSET = 80;
      const xRight = paneWidth - RIGHT_INSET;
      const FONT_PX = 16;
      const CHAR_W = 9.6;
      const PAD_X = 8;
      const PAD_Y = 4;
      const PILL_H = FONT_PX + PAD_Y * 2;
      const LINE_GAP = 5;
      for (const lbl of levelLabelsRef.current) {
        const yLine = series.priceToCoordinate(lbl.price);
        if (yLine === null) continue;
        const textW = lbl.label.length * CHAR_W;
        const pillW = textW + PAD_X * 2;
        const pillX = xRight - pillW;
        const pillY = yLine - LINE_GAP - PILL_H;
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(pillX));
        rect.setAttribute('y', String(pillY));
        rect.setAttribute('width', String(pillW));
        rect.setAttribute('height', String(PILL_H));
        rect.setAttribute('rx', '4');
        rect.setAttribute('fill', lbl.color);
        rect.setAttribute('stroke', '#0a0a0b');
        rect.setAttribute('stroke-width', '1');
        svg.appendChild(rect);
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        el.setAttribute('x', String(xRight - PAD_X));
        el.setAttribute('y', String(pillY + PILL_H - PAD_Y - 2));
        el.setAttribute('text-anchor', 'end');
        el.setAttribute('fill', '#0a0a0b');
        el.setAttribute('font-family', 'IBM Plex Mono, monospace');
        el.setAttribute('font-size', String(FONT_PX));
        el.setAttribute('font-weight', '800');
        el.textContent = lbl.label;
        svg.appendChild(el);
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

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%', background: 'var(--bg-0)' }} />

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
          fontFamily: 'IBM Plex Mono, monospace',
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
            fontFamily: 'IBM Plex Mono, monospace', fontSize: 12, fontWeight: 600,
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
          padding: '3px 10px',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.5,
          cursor: 'pointer' as const,
          border: `1px solid ${color}55`,
          borderRadius: 3,
          background: active ? `${color}1a` : 'rgba(10,10,12,0.85)',
          color,
          fontFamily: 'IBM Plex Mono, monospace',
          transition: 'background 0.15s',
          whiteSpace: 'nowrap' as const,
          pointerEvents: 'auto' as const,
        });

        return (
          <div ref={panelWrapRef} style={{ display: 'flex', flexDirection: 'row', gap: 4 }}>
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
                fontSize: 14,
                padding: '2px 8px',
              }}
            >
              📏
            </button>

            {/* ── QUALIFIED — toggles markers for signals that passed quality gate */}
            <button
              onClick={() => setShowQualified(v => !v)}
              title="Toggle markers for quality-gated (qualified_signals) signals"
              style={ctrlBtn('#22c55e', showQualified)}
            >
              QUALIFIED
            </button>

            {/* ── V3 — toggles markers for signals V3 actually OPENed */}
            <button
              onClick={() => setShowV3(v => !v)}
              title="Toggle markers for signals V3 OPENed (v3_decisions.action='OPEN')"
              style={ctrlBtn('#a855f7', showV3)}
            >
              V3
            </button>

          </div>
        );
      })()}
      <OpeningBias symbol={selectedSymbol} barHistoryRef={barHistoryRef} barsVersion={barsVersion} />
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
        display: 'flex',
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
          fontFamily: 'IBM Plex Mono, monospace',
          fontSize: 12,
          fontWeight: 700,
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

      {/* Scroll to latest — bottom right, above the time axis */}
      <button
        onClick={() => {
          const chart = chartRef.current;
          if (chart) chart.timeScale().scrollToRealTime();
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
