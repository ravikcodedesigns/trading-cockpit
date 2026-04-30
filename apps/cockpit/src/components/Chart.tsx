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
        timeVisible: true,
        secondsVisible: true,
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
      rightPriceScale: { borderColor: '#28282f' },
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
        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };
    onResize();
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      priceLinesRef.current = [];
    };
  }, []);

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
      const add = (price: number, color: string, title: string, style = LineStyle.Solid) => {
        priceLinesRef.current.push(
          series.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title })
        );
      };
      add(levels.bullZone.high, '#2bb673', 'Bull H');
      add(levels.bullZone.low, '#2bb673', 'Bull L');
      add(levels.bearZone.high, '#d64545', 'Bear H');
      add(levels.bearZone.low, '#d64545', 'Bear L');
      add(levels.ddBands.upper, '#6e6e78', 'DD↑', LineStyle.Dashed);
      add(levels.ddBands.lower, '#6e6e78', 'DD↓', LineStyle.Dashed);
      add(levels.hedgePressure, '#f2a633', 'HP', LineStyle.Dotted);
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
    const markers = symbolSignals
      .map((sig) => {
        const bucket = bucketSecs(sig.ts);
        // Skip signals whose time isn't in our visible bar history
        if (!history.has(bucket)) return null;
        const isLong = sig.direction === 'long';
        return {
          time: bucket as UTCTimestamp,
          position: (isLong ? 'belowBar' : 'aboveBar') as 'belowBar' | 'aboveBar',
          color: isLong ? '#2bb673' : '#d64545',
          shape: (isLong ? 'arrowUp' : 'arrowDown') as 'arrowUp' | 'arrowDown',
          text: `${sig.ruleId.toUpperCase().slice(0, 4)}·${sig.score}`,
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
