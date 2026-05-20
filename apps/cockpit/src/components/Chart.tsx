import { useEffect, useRef, useState } from 'react';
import { OpeningBias } from './OpeningBias';
import { RSContextBar } from './RSContextBar';
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

  // Per-symbol bar history kept in a ref so it survives re-renders.
  const barHistoryRef = useRef<Record<string, Map<number, {
    open: number; high: number; low: number; close: number;
  }>>>({ NQ: new Map(), ES: new Map() });

  // Incremented after historical bars finish loading so the markers effect
  // re-runs with a populated barHistoryRef (post-entry markers arrive via a
  // separate fast fetch that often completes before the bar history).
  const [barsVersion, setBarsVersion] = useState(0);

  const [cardPositions, setCardPositions] = useState<
    { sig: ConfluenceSignal; x: number; y: number; id: string }[]
  >([]);
  // Stable ref so the chart's subscribeVisibleLogicalRangeChange subscription
  // always calls the latest closure without needing to re-subscribe.
  const computeCardsRef = useRef<() => void>(() => {});

  const selectedSymbol    = useStore((s) => s.selectedSymbol);
  const selectedTimeframe = useStore((s) => s.selectedTimeframe);
  const setTimeframe      = useStore((s) => s.setTimeframe);
  const levelsByDay    = useStore((s) => s.levelsByDay);
  const flashAlpha     = useStore((s) => s.flashAlpha[s.selectedSymbol]);
  const recentEvents   = useStore((s) => s.recentEvents);
  const recentSignals  = useStore((s) => s.recentSignals);

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

    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      computeCardsRef.current();
    });

    const onResize = () => {
      if (containerRef.current && chart) {
        // Capture the current visible logical range BEFORE resizing.
        // Without this, resize causes the chart to re-fit content based on
        // new dimensions, which can balloon a few bars to fill the chart
        // (when scrolled back) or compress everything beyond readability.
        const ts = chart.timeScale();
        const visibleRange = ts.getVisibleLogicalRange();

        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });

        // Restore the visible range so user's scroll/zoom position is
        // preserved across window resize. Done in a microtask so the
        // resize layout settles first.
        if (visibleRange) {
          queueMicrotask(() => {
            try {
              ts.setVisibleLogicalRange(visibleRange);
            } catch {
              // Chart may have been disposed during async resize
            }
          });
        }
      }
    };
    onResize();
    window.addEventListener('resize', onResize);

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
      window.removeEventListener('resize', onResize);
      if (containerRef.current) {
        containerRef.current.removeEventListener('wheel', onWheelOverAxis);
      }
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
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
          bars: { ts: number; open: number; high: number; low: number; close: number }[];
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
            });
          }
        }

        const seriesData = Array.from(history.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([time, ohlc]) => ({ time: time as UTCTimestamp, ...ohlc }));
        series.setData(seriesData);

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
        history.set(t, { open: ev.open, high: ev.high, low: ev.low, close: ev.close });
      } else {
        history.set(t, {
          open:  existing.open,
          high:  Math.max(existing.high, ev.high),
          low:   Math.min(existing.low,  ev.low),
          close: ev.close,
        });
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

    // Helper: compute the [start, end] timestamps for a trading day in
    // seconds since epoch, suitable for lightweight-charts UTCTimestamp.
    // Trading day = 09:30 ET on Day N -> 09:30 ET on Day N+1 (with weekend
    // gap handling: Friday's day extends to Monday 09:30).
    const dayBoundsSeconds = (tradingDay: string): { start: number; end: number } => {
      // Parse YYYY-MM-DD as a Date in NY timezone.
      // We construct an ISO string in UTC that represents 09:30 NY time on
      // that date. NY is UTC-4 (EDT) or UTC-5 (EST); use a heuristic by
      // building a Date and asking what offset NY had then.
      const [y, m, d] = tradingDay.split('-').map(Number);
      const naiveLocal = new Date(Date.UTC(y, m - 1, d, 13, 30, 0)); // 13:30 UTC ~= 09:30 EDT
      // Cross-check by formatting back; if the resulting NY hour isn't 9
      // we're off by an hour (DST), shift accordingly.
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: '2-digit', hour12: false,
      });
      const nyHour = parseInt(fmt.format(naiveLocal), 10);
      const offsetCorrection = (9 - nyHour) * 60 * 60 * 1000;
      const start = naiveLocal.getTime() + offsetCorrection;

      // End = 09:30 ET on next trading day.
      // For Friday's trading day, end = Monday 09:30 ET.
      const dt = new Date(start);
      const startWeekday = dt.getUTCDay(); // 0=Sun .. 6=Sat
      let daysForward = 1;
      if (startWeekday === 5) daysForward = 3; // Fri -> Mon
      const end = start + daysForward * 24 * 60 * 60 * 1000;

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
          label = `EXPL🚀·${sig.score}`;
          return {
            time: bucket as UTCTimestamp,
            position,
            color: '#00ff88',
            shape,
            text: label,
            size: 3,
          };
        } else if (ruleId === 'clean-impulse') {
          shape = isLong ? 'arrowUp' : 'arrowDown';
          label = isLong ? `CLEAN ↑ FLIP` : `CLEAN ↓ FLIP`;
          return {
            time: bucket as UTCTimestamp,
            position,
            color: '#f59e0b',   // amber — distinct from green absorption and teal EXPL
            shape,
            text: label,
            size: 2,
          };
        } else if (ruleId === 'absorption') {
          shape = isLong ? 'arrowUp' : 'arrowDown';
          const conviction = (sig as any).conviction;
          const convSuffix = conviction ? ` ${conviction}` : '';
          label = `ABSO·${sig.score}${convSuffix}`;
          return {
            time: bucket as UTCTimestamp,
            position,
            color: getSignalPaletteColor(sig.ts),
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

    // Only the most recent today's signal gets TP/DD lines.
    const todaySignals = symbolSignals.filter(s => s.ts >= todayRthStart);
    const latestSig = todaySignals.length > 0
      ? todaySignals.reduce((a, b) => a.ts > b.ts ? a : b)
      : null;

    const nowSec = Math.floor(Date.now() / 1000);
    if (latestSig) {
      const sig = latestSig;
      const bucket = bucketSecs(sig.ts);
      const bar = history.get(bucket);
      if (bar) {
        const entry  = bar.close;
        const isLong = sig.direction?.toLowerCase() === 'long';
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
  }, [recentSignals, recentSignals.length, recentEvents, selectedSymbol, barsVersion]);

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

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%', background: 'var(--bg-0)' }} />

      {/* Timeframe switcher */}
      <div style={{
        position: 'absolute', top: 8, left: 8,
        display: 'flex', gap: 4, zIndex: 10,
      }}>
        {([1, 5, 15] as const).map((tf) => (
          <button
            key={tf}
            onClick={() => {
              // Clear bar history so it re-fetches at new timeframe
              barHistoryRef.current[selectedSymbol] = new Map();
              setTimeframe(tf);
            }}
            style={{
              padding: '3px 10px',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: 0.5,
              cursor: 'pointer',
              border: 'none',
              borderRadius: 3,
              background: selectedTimeframe === tf ? 'var(--accent, #5a9bff)' : 'var(--bg-2, #2a2a3a)',
              color: selectedTimeframe === tf ? '#fff' : 'var(--text-1, #888)',
              transition: 'background 0.15s',
            }}
          >
            {tf}m
          </button>
        ))}
      </div>

      {/* RS context strip — below timeframe buttons, top-left */}
      <div style={{
        position: 'absolute', top: 36, left: 8, zIndex: 10,
        padding: '3px 8px',
        background: 'rgba(10,10,12,0.7)',
        borderRadius: 3,
        border: '1px solid var(--border)',
      }}>
        <RSContextBar />
      </div>

      <OpeningBias symbol={selectedSymbol} barHistoryRef={barHistoryRef} barsVersion={barsVersion} />

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
