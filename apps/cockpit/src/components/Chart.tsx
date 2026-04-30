import { useEffect, useRef } from 'react';
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

export function Chart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);

  // Per-symbol bar history kept in a ref so it survives re-renders.
  const barHistoryRef = useRef<Record<string, Map<number, {
    open: number; high: number; low: number; close: number;
  }>>>({ NQ: new Map(), ES: new Map() });

  const selectedSymbol = useStore((s) => s.selectedSymbol);
  const levels = useStore((s) => s.levels[s.selectedSymbol]);
  const flashAlpha = useStore((s) => s.flashAlpha[s.selectedSymbol]);
  const recentEvents = useStore((s) => s.recentEvents);
  const recentSignals = useStore((s) => s.recentSignals);

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
    seriesRef.current = chart.addCandlestickSeries({
      upColor: '#2bb673',
      downColor: '#d64545',
      borderUpColor: '#2bb673',
      borderDownColor: '#d64545',
      wickUpColor: '#2bb673',
      wickDownColor: '#d64545',
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
      priceLinesRef.current = [];
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
        const url = `http://127.0.0.1:8787/history/bars?symbol=${selectedSymbol}&minutes=1440`;
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
      } catch {
        // History fetch is best-effort; live WS updates will still work.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedSymbol]);

  // When recentEvents updates, push new bar events for the selected symbol into the chart.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    const history = barHistoryRef.current[selectedSymbol] ?? new Map();
    barHistoryRef.current[selectedSymbol] = history;

    let updated = false;
    for (const ev of recentEvents) {
      if (ev.source !== 'bookmap' || ev.type !== 'bar') continue;
      if (ev.symbol !== selectedSymbol) continue;
      const t = Math.floor(ev.ts / 1000);
      history.set(t, { open: ev.open, high: ev.high, low: ev.low, close: ev.close });
      updated = true;
    }
    if (!updated) return;

    const data = Array.from(history.entries())
      .sort((a, b) => a[0] - b[0])
      .slice(-1800)
      .map(([t, b]) => ({
        time: t as UTCTimestamp,
        open: b.open, high: b.high, low: b.low, close: b.close,
      }));

    series.setData(data);

    // No auto-fit. With fixed barSpacing the chart naturally shows the most
    // recent bars at a sensible width and the user can scroll/zoom freely.
  }, [recentEvents, selectedSymbol]);

  // Sync price lines when levels or FA change
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    for (const line of priceLinesRef.current) series.removePriceLine(line);
    priceLinesRef.current = [];

    if (levels) {
      const add = (price: number, color: string, title: string, style = LineStyle.Solid, width: 1 | 2 | 3 | 4 = 1) => {
        priceLinesRef.current.push(
          series.createPriceLine({ price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title })
        );
      };
      // Primary RS levels — colors and weights matched to RocketScooter platform.
      add(levels.bullZone.high, '#2bb673', 'Bull H', LineStyle.Solid, 2);
      add(levels.bullZone.low,  '#2bb673', 'Bull L', LineStyle.Solid, 2);
      add(levels.bearZone.high, '#d64545', 'Bear H', LineStyle.Solid, 2);
      add(levels.bearZone.low,  '#d64545', 'Bear L', LineStyle.Solid, 2);
      add(levels.ddBands.upper, '#9ee04a', 'DD↑',    LineStyle.Solid, 2);  // lime
      add(levels.ddBands.lower, '#9ee04a', 'DD↓',    LineStyle.Solid, 2);  // lime
      add(levels.hedgePressure, '#4a8fdc', 'HP',     LineStyle.Solid, 2);  // blue

      // Additional RS reference levels (QQQ Open/Close, HG, MHP, etc.)
      const styleMap: Record<string, LineStyle> = {
        solid: LineStyle.Solid,
        dashed: LineStyle.Dashed,
        dotted: LineStyle.Dotted,
        'large-dashed': LineStyle.LargeDashed,
        'sparse-dotted': LineStyle.SparseDotted,
      };
      if (levels.additionalLevels) {
        for (const al of levels.additionalLevels) {
          add(
            al.price,
            al.color ?? '#5a9bff',
            al.label,
            styleMap[al.style ?? 'dashed'] ?? LineStyle.Dashed,
            (al as { width?: 1 | 2 | 3 | 4 }).width ?? 1
          );
        }
      }
    }
    if (flashAlpha) {
      const add = (price: number, color: string, title: string) => {
        priceLinesRef.current.push(
          series.createPriceLine({ price, color, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title })
        );
      };
      add(flashAlpha.zeroGamma, '#4a8fdc', '0γ');
      add(flashAlpha.dealerFlip, '#4a8fdc', 'flip');
      flashAlpha.callWalls.slice(0, 2).forEach((p, i) => add(p, '#2bb67388', `CW${i + 1}`));
      flashAlpha.putWalls.slice(0, 2).forEach((p, i) => add(p, '#d6454588', `PW${i + 1}`));
    }
  }, [levels, flashAlpha]);

  // Render signal markers on the chart (arrows below/above candles).
  // Reactive on signals, symbol, AND the bar history we have, so markers
  // re-render when new bars come in or new signals fire.
  useEffect(() => {
    const series = seriesRef.current;
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

    const symbolSignals = recentSignals.filter((s) => s.symbol === selectedSymbol);

    // No dedup: every signal becomes a marker. Multiple markers at the same
    // time will stack vertically on the candle automatically.
    // Visual differentiation by ruleId:
    //   - sweep -> arrow (existing behavior)
    //   - delta-divergence -> circle (different shape so they're not confused)
    const markers = symbolSignals
      .map((sig) => {
        const bucket = bucketSecs(sig.ts);
        if (!history.has(bucket)) return null;
        const isLong = sig.direction === 'long';
        const color = isLong ? '#2bb673' : '#d64545';
        const position = (isLong ? 'belowBar' : 'aboveBar') as 'belowBar' | 'aboveBar';

        let shape: 'arrowUp' | 'arrowDown' | 'circle';
        let label: string;
        if (sig.ruleId === 'delta-divergence') {
          shape = 'circle';
          label = `DIV·${sig.score}`;
        } else {
          shape = isLong ? 'arrowUp' : 'arrowDown';
          label = `${sig.ruleId.toUpperCase().slice(0, 4)}·${sig.score}`;
        }

        return {
          time: bucket as UTCTimestamp,
          position,
          color,
          shape,
          text: label,
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .sort((a, b) => (a.time as number) - (b.time as number));

    series.setMarkers(markers);
  }, [recentSignals, recentSignals.length, recentEvents, selectedSymbol]);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', background: 'var(--bg-0)' }} />
  );
}
