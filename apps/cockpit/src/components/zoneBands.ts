// ZoneBandsPrimitive — shades the RS liquidity-map zone bands on the cockpit
// chart as filled rectangles spanning the full pane width, drawn BEHIND the
// candles (zOrder 'bottom'). Colors match the RS platform exactly:
//   bull  #4a4f61 @ ~67% transparency   bear  #c5b1ab @ ~57% transparency
import type {
  ISeriesApi, ISeriesPrimitive, IPrimitivePaneView, IPrimitivePaneRenderer,
  SeriesAttachedParameter, Time,
} from 'lightweight-charts';

export type Band = { low: number; high: number };

const BULL_FILL = 'rgba(74, 79, 97, 0.33)';    // #4a4f61
const BEAR_FILL = 'rgba(197, 177, 171, 0.43)'; // #c5b1ab

class Renderer implements IPrimitivePaneRenderer {
  constructor(private src: ZoneBandsPrimitive) {}
  draw(target: any) {
    const series = this.src.series;
    if (!series) return;
    target.useBitmapCoordinateSpace((scope: any) => {
      const ctx = scope.context as CanvasRenderingContext2D;
      const vr = scope.verticalPixelRatio as number;
      const width = scope.bitmapSize.width as number;
      const paint = (bands: Band[], fill: string) => {
        ctx.fillStyle = fill;
        for (const b of bands) {
          const yHigh = series.priceToCoordinate(b.high);
          const yLow = series.priceToCoordinate(b.low);
          if (yHigh == null || yLow == null) continue;
          const top = Math.min(yHigh, yLow) * vr;
          const h = Math.max(Math.abs(yLow - yHigh) * vr, 1);
          ctx.fillRect(0, top, width, h);
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
  bull: Band[] = [];
  bear: Band[] = [];
  private _view: PaneView;
  private _requestUpdate?: () => void;
  constructor() { this._view = new PaneView(this); }
  attached(p: SeriesAttachedParameter<Time>) { this.series = p.series as any; this._requestUpdate = p.requestUpdate; }
  detached() { this.series = null; }
  updateAllViews() { /* renderer reads live data each draw */ }
  paneViews(): IPrimitivePaneView[] { return [this._view]; }
  setBands(bull: Band[], bear: Band[]) { this.bull = bull; this.bear = bear; this._requestUpdate?.(); }
}
