// ZoneBandsPrimitive — shades the RS liquidity-map zone bands on the cockpit
// chart as filled rectangles drawn BEHIND the candles (zOrder 'bottom'). Each band
// is CONFINED to its day's RTH time window [from,to] (epoch seconds), so every day's
// zones render inside that day's session and previous days stay shaded as you scroll
// back — instead of one day's bands smearing across the whole pane.
// Colors match the RS platform: bull #4a4f61 ~67% transp, bear #c5b1ab ~57% transp.
import type {
  ISeriesApi, ISeriesPrimitive, IPrimitivePaneView, IPrimitivePaneRenderer,
  SeriesAttachedParameter, Time, IChartApi,
} from 'lightweight-charts';

// from/to = UTCTimestamp (seconds) bounding the band horizontally (the day's RTH).
export type Band = { low: number; high: number; from: number; to: number };

const BULL_FILL = 'rgba(74, 79, 97, 0.33)';    // #4a4f61
const BEAR_FILL = 'rgba(197, 177, 171, 0.43)'; // #c5b1ab

class Renderer implements IPrimitivePaneRenderer {
  constructor(private src: ZoneBandsPrimitive) {}
  draw(target: any) {
    const series = this.src.series;
    const chart = this.src.chart;
    if (!series || !chart) return;
    const ts = chart.timeScale();
    const vis = ts.getVisibleRange() as unknown as { from: number; to: number } | null;
    target.useBitmapCoordinateSpace((scope: any) => {
      const ctx = scope.context as CanvasRenderingContext2D;
      const vr = scope.verticalPixelRatio as number;
      const hr = scope.horizontalPixelRatio as number;
      const width = scope.bitmapSize.width as number;
      const paint = (bands: Band[], fill: string) => {
        ctx.fillStyle = fill;
        for (const b of bands) {
          const yHigh = series.priceToCoordinate(b.high);
          const yLow = series.priceToCoordinate(b.low);
          if (yHigh == null || yLow == null) continue;
          // Clamp the band's RTH window to the visible range, then map time→x.
          let f = b.from, t = b.to;
          if (vis) {
            f = Math.max(f, vis.from);
            t = Math.min(t, vis.to);
            if (f >= t) continue; // this day's RTH window is off-screen
          }
          const x0 = ts.timeToCoordinate(f as unknown as Time);
          const x1 = ts.timeToCoordinate(t as unknown as Time);
          const left = (x0 == null ? 0 : x0) * hr;
          const right = (x1 == null ? width / hr : x1) * hr;
          const top = Math.min(yHigh, yLow) * vr;
          const h = Math.max(Math.abs(yLow - yHigh) * vr, 1);
          ctx.fillRect(Math.min(left, right), top, Math.max(Math.abs(right - left), 1), h);
        }
      };
      paint(this.src.bull, BULL_FILL);
      paint(this.src.bear, BEAR_FILL);
    });
  }
}

class PaneView implements IPrimitivePaneView {
  private r: Renderer;
  constructor(src: ZoneBandsPrimitive) { this.r = new Renderer(src); }
  zOrder() { return 'bottom' as const; }   // behind the candles
  renderer() { return this.r; }
}

export class ZoneBandsPrimitive implements ISeriesPrimitive<Time> {
  series: ISeriesApi<any> | null = null;
  chart: IChartApi | null = null;
  bull: Band[] = [];
  bear: Band[] = [];
  private _view: PaneView;
  private _requestUpdate?: () => void;
  constructor() { this._view = new PaneView(this); }
  attached(p: SeriesAttachedParameter<Time>) {
    this.series = p.series as any;
    this.chart = p.chart as any;
    this._requestUpdate = p.requestUpdate;
  }
  detached() { this.series = null; this.chart = null; }
  updateAllViews() { /* renderer reads live data each draw */ }
  paneViews(): IPrimitivePaneView[] { return [this._view]; }
  setBands(bull: Band[], bear: Band[]) { this.bull = bull; this.bear = bear; this._requestUpdate?.(); }
}
