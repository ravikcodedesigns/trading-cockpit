import { useEffect, useRef, useState } from 'react';
import { OpeningBias } from './OpeningBias';
import { RegimePanel } from './RegimePanel';
import type { CheckpointData, FactorDir, RegimeLabel } from './RegimePanel';
import { TradeNoTradePopover } from './TradeNoTradePopover';
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
import { tradingDayFor } from '@trading/contracts';
import type { ConfluenceSignal } from '@trading/contracts';
import { SignalChartCard } from './SignalFeed';

// ── Drawing tool types ─────────────────────────────────────────────────────
type DrawMode = 'line' | 'text' | null;
type Drawing =
  | { id: string; kind: 'line'; p1: { time: number; price: number }; p2: { time: number; price: number } }
  | { id: string; kind: 'text'; point: { time: number; price: number }; text: string };

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
    if (price === null) return null;
    const { upper, lower } = levels.ddBands;
    if (upper === lower) return null;
    return ((price - lower) / (upper - lower)) > 0.5 ? 'bull' : 'bear';
  };

  const greaterMkt = (price: number | null): FactorDir => {
    if (price === null) return null;
    if (price > levels.bullZone.high) return 'bull';
    if (price < levels.bearZone.low)  return 'bear';
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
    { name: 'HP',          dir: cmp(p931, levels.hedgePressure) },
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

  // Incremented after historical bars finish loading so the markers effect
  // re-runs with a populated barHistoryRef (post-entry markers arrive via a
  // separate fast fetch that often completes before the bar history).
  const [barsVersion, setBarsVersion] = useState(0);

  const [activePanel, setActivePanel] = useState<'regime' | 'wr' | 'trade' | null>(null);
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

  // Clear bar history when timeframe changes so historical bars re-fetch
  useEffect(() => {
    barHistoryRef.current[selectedSymbol] = new Map();
  }, [selectedTimeframe]); // eslint-disable-line react-hooks/exhaustive-deps

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
        // Chart history: 1 month (43200 minutes).
        const url = `/history/bars?symbol=${selectedSymbol}&minutes=43200&interval=${selectedTimeframe}`;
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

      const addLevelLine = (price: number, color: string, title: string, style: LineStyle, width: 1 | 2 | 3 | 4) => {
        const ls = chart.addLineSeries({
          color,
          lineWidth: width,
          lineStyle: style,
          priceLineVisible: false,
          // Show the last-value label (which lightweight-charts puts on
          // the price axis) ONLY for today's levels. Past days' lines
          // remain visible on the chart but don't clutter the price axis.
          lastValueVisible: isToday,
          crosshairMarkerVisible: false,
          title: isToday ? title : '',  // hover tooltip; only meaningful for today
        });
        ls.setData([
          { time: start as UTCTimestamp, value: price },
          { time: end as UTCTimestamp, value: price },
        ]);
        levelLinesRef.current.push(ls);
      };

      // Pass clean labels (no date suffix). Title only appears on the price
      // axis for today's lines (per isToday gate above).
      addLevelLine(dayLevels.bullZone.high, '#2bb673', 'Bull H', LineStyle.Solid, 2);
      addLevelLine(dayLevels.bullZone.low,  '#2bb673', 'Bull L', LineStyle.Solid, 2);
      addLevelLine(dayLevels.bearZone.high, '#d64545', 'Bear H', LineStyle.Solid, 2);
      addLevelLine(dayLevels.bearZone.low,  '#d64545', 'Bear L', LineStyle.Solid, 2);
      addLevelLine(dayLevels.ddBands.upper, '#9ee04a', 'DD↑',    LineStyle.Solid, 2);
      addLevelLine(dayLevels.ddBands.lower, '#9ee04a', 'DD↓',    LineStyle.Solid, 2);
      addLevelLine(dayLevels.hedgePressure, '#4a8fdc', 'HP',     LineStyle.Solid, 2);

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

    const symbolSignals = recentSignals
      .filter((s) => s.symbol === selectedSymbol)
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
        // CLEAN → 1m chart only
        if (ruleId === 'clean-impulse') return selectedTimeframe === 1;
        // RR → 1m chart only
        if (ruleId === 'reject-resistance') return selectedTimeframe === 1;
        // ALA (BOUNCE + RECLAIM + ZONE_RECLAIM) → 1m chart only
        if (ruleId === 'ala-bounce' || ruleId === 'ala-reclaim' || ruleId === 'ala-zone-reclaim') return selectedTimeframe === 1;
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
  }, [recentSignals, selectedSymbol, selectedTimeframe, barsVersion]);

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

    if (drawModeRef.current === 'line') {
      if (!pendingLineRef.current) {
        pendingLineRef.current = { time: time as number, price };
        renderDrawingsRef.current();
      } else {
        drawingsRef.current = [...drawingsRef.current, {
          id: String(Date.now()), kind: 'line',
          p1: pendingLineRef.current,
          p2: { time: time as number, price },
        }];
        pendingLineRef.current = null;
        previewMouseRef.current = null;
        renderDrawingsRef.current();
      }
    } else if (drawModeRef.current === 'text') {
      setTextInput({ x, y, time: time as number, price });
      setTextValue('');
    }
  };

  const handleSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (drawModeRef.current !== 'line' || !pendingLineRef.current) return;
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

    // Preview line while placing second point
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
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', String(x1)); dot.setAttribute('cy', String(y1));
        dot.setAttribute('r', '3'); dot.setAttribute('fill', '#5a9bff');
        svg.appendChild(dot);
      }
    }
  };

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%', background: 'var(--bg-0)' }} />

      {/* Drawing SVG overlay */}
      <svg
        ref={svgRef}
        style={{
          position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
          overflow: 'hidden',
          pointerEvents: drawMode ? 'auto' : 'none',
          cursor: drawMode === 'line' ? 'crosshair' : drawMode === 'text' ? 'text' : 'default',
        }}
        onClick={handleSvgClick}
        onMouseMove={handleSvgMouseMove}
        onMouseLeave={() => { previewMouseRef.current = null; renderDrawingsRef.current(); }}
      />

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
        const WR_ROWS: { window: string; lo: number; hi: number; cf: string; cfs: string; expl: string; abso: string }[] = [
          { window: '09:30–09:59', lo: 570, hi: 600, cf: '—',                cfs: '100% (n=4)',   expl: '100% (n=3)',     abso: '100% (n=4)'  },
          { window: '10:00–10:29', lo: 600, hi: 630, cf: '50% (n=2) ⚠',   cfs: '50% (n=2) ⚠', expl: '100% (n=2)',     abso: '50% (n=6) ⚠' },
          { window: '10:30–11:29', lo: 630, hi: 690, cf: '80% (n=5)',      cfs: '100% (n=3)',   expl: '100% (n=4)',     abso: '57% (n=7) ⚠'  },
          { window: '11:30–12:59', lo: 690, hi: 780, cf: '79% (n=14)',     cfs: '100% (n=1)',   expl: '70% (n=10)',     abso: '63% (n=8)'    },
          { window: '13:00–14:29', lo: 780, hi: 870, cf: '40% (n=5) ⚠',   cfs: '0% (n=1) ⚠',  expl: '50% (n=12) ⚠',  abso: '67% (n=9)'    },
          { window: '14:30–15:59', lo: 870, hi: 960, cf: '—',              cfs: '—',            expl: '18% (n=17) ⚠',  abso: '60% (n=5)'   },
        ];
        const etMin = (() => {
          const p = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
          }).formatToParts(new Date());
          return parseInt(p.find(x => x.type === 'hour')?.value ?? '0', 10) * 60
               + parseInt(p.find(x => x.type === 'minute')?.value ?? '0', 10);
        })();
        const activeIdx = WR_ROWS.findIndex(r => etMin >= r.lo && etMin < r.hi);

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

            {/* ── TIME AND WR ── */}
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setActivePanel(p => p === 'wr' ? null : 'wr')}
                style={ctrlBtn('#f59e0b', activePanel === 'wr')}
              >
                TIME AND WR
              </button>
              {activePanel === 'wr' && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 3px)', left: 0,
                  background: 'rgba(10,10,12,0.95)',
                  border: '1px dotted #444',
                  borderRadius: 4,
                  fontFamily: 'IBM Plex Mono, monospace',
                  fontSize: 11,
                  fontWeight: 700,
                  color: '#d0d0d8',
                  overflow: 'hidden',
                  zIndex: 100,
                }}>
                  <div style={{
                    display: 'grid', gridTemplateColumns: '96px 88px 88px 110px 88px',
                    padding: '5px 10px', borderBottom: '1px dotted #444',
                    color: '#888', fontSize: 10, fontWeight: 700, letterSpacing: 0.6,
                  }}>
                    <span>WINDOW</span><span>CF↑</span><span>CF↓</span><span>EXPL↑</span><span>ABSO↑</span>
                  </div>
                  {WR_ROWS.map((row, i) => {
                    const isActive = i === activeIdx;
                    const wrColor = (v: string) =>
                      v === '—'           ? '#555'    :
                      v.startsWith('100') ? '#2bb673' :
                      v.includes('⚠')     ? '#e05252' : '#d0d0d8';
                    return (
                      <div key={row.window} style={{
                        display: 'grid', gridTemplateColumns: '96px 88px 88px 110px 88px',
                        padding: '4px 10px',
                        borderBottom: '1px dotted #333',
                        background: isActive ? 'rgba(90,155,255,0.13)' : 'transparent',
                        borderLeft: isActive ? '3px solid #5a9bff' : '3px solid transparent',
                      }}>
                        <span style={{ color: isActive ? '#7ab8ff' : '#999', fontWeight: isActive ? 800 : 700 }}>
                          {row.window}
                        </span>
                        <span style={{ color: wrColor(row.cf) }}>{row.cf}</span>
                        <span style={{ color: wrColor(row.cfs) }}>{row.cfs}</span>
                        <span style={{ color: wrColor(row.expl) }}>{row.expl}</span>
                        <span style={{ color: wrColor(row.abso) }}>{row.abso}</span>
                      </div>
                    );
                  })}
                  <div style={{
                    padding: '4px 10px 5px', borderTop: '1px dotted #444',
                    color: '#777', fontSize: 10, fontWeight: 600, letterSpacing: 0.3,
                  }}>
                    SL: CF↑ 55 · CF↓ 105 · EXPL 70 · ABSO 140  |  TP: 80 pts
                  </div>
                </div>
              )}
            </div>

            {/* ── TRADE/NO TRADE ── */}
            <TradeNoTradePopover
              open={activePanel === 'trade'}
              onToggle={() => setActivePanel(p => p === 'trade' ? null : 'trade')}
            />

            {/* ── DRAW: LINE ── */}
            <button
              onClick={() => setDrawMode(drawMode === 'line' ? null : 'line')}
              style={ctrlBtn('#5a9bff', drawMode === 'line')}
            >
              LINE
            </button>

            {/* ── DRAW: TEXT ── */}
            <button
              onClick={() => setDrawMode(drawMode === 'text' ? null : 'text')}
              style={ctrlBtn('#fde047', drawMode === 'text')}
            >
              TEXT
            </button>

            {/* ── CLEAR DRAWINGS ── */}
            <button
              onClick={() => {
                drawingsRef.current = [];
                pendingLineRef.current = null;
                previewMouseRef.current = null;
                renderDrawingsRef.current();
              }}
              style={ctrlBtn('#777', false)}
            >
              CLR
            </button>
          </div>
        );
      })()}
      <OpeningBias symbol={selectedSymbol} barHistoryRef={barHistoryRef} barsVersion={barsVersion} />
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
