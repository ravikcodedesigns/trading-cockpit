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
  // Map: bar timestamp (sec) -> { o,h,l,c }
  const barHistoryRef = useRef<Record<string, Map<number, {
    open: number; high: number; low: number; close: number;
  }>>>({ NQ: new Map(), ES: new Map() });

  // Track last event index processed per symbol so we don't reapply old events.
  const lastSeenIndexRef = useRef<Record<string, number>>({ NQ: 0, ES: 0 });

  const selectedSymbol = useStore((s) => s.selectedSymbol);
  const levels = useStore((s) => s.levels[s.selectedSymbol]);
  const flashAlpha = useStore((s) => s.flashAlpha[s.selectedSymbol]);
  const recentEvents = useStore((s) => s.recentEvents);

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
        secondsVisible: false,
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

  // Apply incoming bar events (both partial and sealed).
  // We use series.update() per-bar, which is fast and lets the chart's
  // current candle "tick" live as partial updates arrive.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    const history = barHistoryRef.current[selectedSymbol] ?? new Map();
    barHistoryRef.current[selectedSymbol] = history;

    let didInitialLoad = history.size > 0;

    for (const ev of recentEvents) {
      if (ev.source !== 'bookmap' || ev.type !== 'bar') continue;
      if (ev.symbol !== selectedSymbol) continue;
      const t = Math.floor(ev.ts / 1000);
      const bar = { open: ev.open, high: ev.high, low: ev.low, close: ev.close };
      history.set(t, bar);

      // If this is the first time we're populating the chart, do a bulk setData
      // at the end. Otherwise update incrementally.
      if (didInitialLoad) {
        try {
          series.update({
            time: t as UTCTimestamp,
            open: bar.open, high: bar.high, low: bar.low, close: bar.close,
          });
        } catch {
          // update() throws if the bar's time is older than the latest bar.
          // Fall through to a full setData below in that case.
          didInitialLoad = false;
        }
      }
    }

    // Initial population (or recovery from out-of-order update)
    if (!didInitialLoad) {
      const data = Array.from(history.entries())
        .sort((a, b) => a[0] - b[0])
        .slice(-360)   // last 6 hours of 1-min bars
        .map(([t, b]) => ({
          time: t as UTCTimestamp,
          open: b.open, high: b.high, low: b.low, close: b.close,
        }));
      if (data.length > 0) series.setData(data);
    }
  }, [recentEvents, selectedSymbol]);

  // Reset visible series when symbol changes
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const history = barHistoryRef.current[selectedSymbol] ?? new Map();
    barHistoryRef.current[selectedSymbol] = history;
    const data = Array.from(history.entries())
      .sort((a, b) => a[0] - b[0])
      .slice(-360)
      .map(([t, b]) => ({
        time: t as UTCTimestamp,
        open: b.open, high: b.high, low: b.low, close: b.close,
      }));
    series.setData(data);
  }, [selectedSymbol]);

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

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', background: 'var(--bg-0)' }} />
  );
}
