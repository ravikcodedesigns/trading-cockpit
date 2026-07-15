// HeatmapPrimitive — draws a live Bookmap-style order-book heatmap + volume dots on
// the cockpit candle chart via two pane views:
//   • heat cells  → zOrder 'bottom' (behind candles): resting depth as colored rows,
//     intensity log-normalized to the visible max, on a dark-blue→cyan→green→yellow→white ramp.
//   • volume dots → zOrder 'top' (over candles): each interval's trades as bubbles,
//     radius ∝ √size, green = buy-aggressor / red = sell-aggressor.
//
// The renderer reads the live HeatmapFeed each frame (no copy). Columns are pixel-strided:
// when many 100ms columns collapse into one screen pixel (chart zoomed out) we draw one per
// pixel, so cost is bounded by pane width, not column count. Zoom in for full temporal detail.
import type {
  ISeriesApi, ISeriesPrimitive, IPrimitivePaneView, IPrimitivePaneRenderer,
  SeriesAttachedParameter, Time, IChartApi,
} from 'lightweight-charts';
import type { HeatmapFeed } from '../lib/heatmap-feed';

// Heat color ramp (t 0→1). Perceptually climbs dark→cool→warm→hot like Bookmap's default.
const RAMP: Array<[number, number, number, number]> = [
  [0.00, 8, 14, 44],      // near-dark blue
  [0.22, 22, 62, 168],    // blue
  [0.45, 20, 150, 168],   // teal
  [0.65, 54, 190, 96],    // green
  [0.82, 224, 210, 48],   // yellow
  [1.00, 255, 255, 232],  // near-white (walls)
];

function heat(t: number): [number, number, number] {
  const c = t <= 0 ? 0 : t >= 1 ? 1 : t;
  for (let i = 1; i < RAMP.length; i++) {
    const [p1, r1, g1, b1] = RAMP[i]!;
    if (c <= p1) {
      const [p0, r0, g0, b0] = RAMP[i - 1]!;
      const f = (c - p0) / (p1 - p0 || 1);
      return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f];
    }
  }
  return [RAMP[RAMP.length - 1]![1], RAMP[RAMP.length - 1]![2], RAMP[RAMP.length - 1]![3]];
}

// Visible-window subset + per-frame normalization refs, computed once and shared by both views.
interface Frame {
  cols: import('@trading/contracts').HeatmapColumn[];
  tick: number;
  xs: number[];            // left x (bitmap px) per column
  widths: number[];        // px width per column
  tickPx: number;          // px height of one price tick
  logMaxDepth: number;     // log(maxDepthSize+1) for normalization
  maxTrade: number;        // max |trade size| for dot scaling
}

class CellsRenderer implements IPrimitivePaneRenderer {
  constructor(private src: HeatmapPrimitive) {}
  draw(target: any) {
    const series = this.src.series;
    if (!series) return;
    target.useBitmapCoordinateSpace((scope: any) => {
      const f = this.src.frame(scope);
      if (!f) return;
      const ctx = scope.context as CanvasRenderingContext2D;
      const vr = scope.verticalPixelRatio as number;
      const half = f.tickPx / 2;
      for (let i = 0; i < f.cols.length; i++) {
        const col = f.cols[i]!;
        const x = f.xs[i]!, w = f.widths[i]!;
        if (w <= 0) continue;
        const s = col.s;
        for (let k = 0; k < s.length; k += 2) {
          const size = s[k + 1]!;
          if (size <= 0) continue;
          const price = (col.a + s[k]!) * f.tick;
          const yc = series.priceToCoordinate(price);
          if (yc == null) continue;
          const t = Math.log(size + 1) / f.logMaxDepth;
          const [r, g, b] = heat(t);
          ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${(0.16 + 0.72 * Math.min(t, 1)).toFixed(3)})`;
          ctx.fillRect(x, (yc * vr) - half, w, Math.max(f.tickPx, 1));
        }
      }
    });
  }
}

class DotsRenderer implements IPrimitivePaneRenderer {
  constructor(private src: HeatmapPrimitive) {}
  draw(target: any) {
    const series = this.src.series;
    if (!series) return;
    target.useBitmapCoordinateSpace((scope: any) => {
      const f = this.src.frame(scope);
      if (!f) return;
      const ctx = scope.context as CanvasRenderingContext2D;
      const vr = scope.verticalPixelRatio as number;
      const hr = scope.horizontalPixelRatio as number;
      const maxT = f.maxTrade;
      const rMax = 7 * hr;                 // max bubble radius (bitmap px)
      for (let i = 0; i < f.cols.length; i++) {
        const col = f.cols[i]!;
        const cx = f.xs[i]! + f.widths[i]! / 2;
        const x = col.x;
        for (let k = 0; k < x.length; k += 2) {
          const signed = x[k + 1]!;
          const size = Math.abs(signed);
          if (size <= 0) continue;
          const price = (col.a + x[k]!) * f.tick;
          const yc = series.priceToCoordinate(price);
          if (yc == null) continue;
          const rad = Math.max(1.2 * hr, Math.sqrt(size / maxT) * rMax);
          ctx.beginPath();
          ctx.arc(cx, yc * vr, rad, 0, Math.PI * 2);
          ctx.fillStyle = signed > 0 ? 'rgba(38,208,124,0.85)' : 'rgba(240,72,72,0.85)';
          ctx.fill();
        }
      }
    });
  }
}

class CellsView implements IPrimitivePaneView {
  private r: CellsRenderer;
  constructor(src: HeatmapPrimitive) { this.r = new CellsRenderer(src); }
  zOrder() { return 'bottom' as const; }
  renderer() { return this.r; }
}
class DotsView implements IPrimitivePaneView {
  private r: DotsRenderer;
  constructor(src: HeatmapPrimitive) { this.r = new DotsRenderer(src); }
  zOrder() { return 'top' as const; }
  renderer() { return this.r; }
}

export class HeatmapPrimitive implements ISeriesPrimitive<Time> {
  series: ISeriesApi<any> | null = null;
  chart: IChartApi | null = null;
  enabled = true;
  barSeconds = 60;               // seconds per candle bar — set from the chart's timeframe
  private feed: HeatmapFeed;
  private _cells: CellsView;
  private _dots: DotsView;
  private _requestUpdate?: () => void;

  constructor(feed: HeatmapFeed) {
    this.feed = feed;
    this._cells = new CellsView(this);
    this._dots = new DotsView(this);
    feed.onUpdate(() => this._requestUpdate?.());
  }

  attached(p: SeriesAttachedParameter<Time>) {
    this.series = p.series as any;
    this.chart = p.chart as any;
    this._requestUpdate = p.requestUpdate;
  }
  detached() { this.series = null; this.chart = null; }
  updateAllViews() { /* renderers read live feed each draw */ }
  paneViews(): IPrimitivePaneView[] { return this.enabled ? [this._cells, this._dots] : []; }
  setEnabled(on: boolean) { this.enabled = on; this._requestUpdate?.(); }
  setBarSeconds(sec: number) { if (sec > 0 && sec !== this.barSeconds) { this.barSeconds = sec; this._requestUpdate?.(); } }

  // Build the shared per-frame layout: map each column's time→x, pixel-stride, and compute
  // normalization refs. Returns null if nothing to draw.
  //
  // Time→x is LINEAR, not timeToCoordinate(): LWC's timeToCoordinate snaps to the nearest bar
  // and returns null past the last bar, so it collapses 100ms sub-bar columns onto one x and
  // drops the live right edge entirely. Instead we anchor on the last visible bar and
  // extrapolate at the time-scale's px-per-second (barSpacing / barSeconds) — full sub-bar
  // resolution, and live columns extend right of the last bar like Bookmap. The heatmap only
  // spans the last few (contiguous) minutes, so uniform-spacing extrapolation is exact here.
  frame(scope: any): Frame | null {
    if (!this.enabled || !this.series || !this.chart) return null;
    const data = this.feed.data;
    if (!data.cols.length) return null;
    const ts = this.chart.timeScale();
    const vis = ts.getVisibleRange() as unknown as { from: number; to: number } | null;
    if (!vis) return null;

    // Pixel ratios + bitmap width come from the render SCOPE (inside useBitmapCoordinateSpace),
    // NOT the renderer target — the target has no bitmapSize, which silently zeroed the width
    // clip and dropped every column.
    const hr = (scope.horizontalPixelRatio as number) || 1;
    const width = (scope.bitmapSize?.width as number) ?? 0;

    // Anchor: find the chart's live-edge bar and map columns relative to it at the axis's
    // px-per-second (barSpacing / barSeconds — verified to match the real time scale exactly).
    // Do NOT anchor on vis.to: LWC pads a session-close marker (16:00) a few bars past the real
    // data, so timeToCoordinate(vis.to) can jump the anchor 3.5h and fling the strip far left.
    // timeToCoordinate also snaps to bars and returns null past the last bar, so EVERY live
    // column can be null (all newer than the last completed candle). So we step back from "now"
    // in bar intervals until one maps — that locates the last real bar, and live columns then
    // extrapolate to its right (the live edge), exactly where Bookmap draws them.
    const all = data.cols;
    const barSpacing = ts.options().barSpacing || 6;        // CSS px between adjacent bars
    const barSec = this.barSeconds || 60;
    const pxPerSec = barSpacing / barSec;                   // CSS px per second
    const nowT = all[all.length - 1]!.t;                    // heatmap live edge ≈ now
    // timeToCoordinate ONLY resolves times that land exactly on a bar boundary (:00 of the
    // bar interval) — sub-bar times return null. Column timestamps are arbitrary sub-second
    // capture times, so we must anchor on a floored bar boundary, then step back a bar at a
    // time to the last real candle. Columns then extrapolate off that anchor at pxPerSec.
    const lastBarT = Math.floor(nowT / barSec) * barSec;    // floor "now" onto the bar grid
    let anchorT = 0, xRefCss: number | null = null;
    for (let k = 0; k < 30; k++) {
      const t = lastBarT - k * barSec;
      const x = ts.timeToCoordinate(t as unknown as Time);
      if (x != null) { anchorT = t; xRefCss = x; break; }
    }
    if (xRefCss == null) return null;   // chart's last bar is >30 bars behind the live edge → off-screen right
    const pxOf = (t: number) => (xRefCss! + (t - anchorT) * pxPerSec) * hr;  // → bitmap px
    const cols: Frame['cols'] = [];
    const xs: number[] = [];
    const widths: number[] = [];
    let logMaxDepth = Math.log(2);
    let maxTrade = 1;
    let lastPx = -Infinity;

    for (let i = 0; i < all.length; i++) {
      const col = all[i]!;
      const px = pxOf(col.t);
      if (px < -4) continue;                      // left of view
      if (px > width + 4) break;                  // right of view (columns are chronological)
      if (px - lastPx < 1) continue;              // pixel-stride: one column per screen px
      // Width = distance to the next drawn column (filled in on next iteration); seed with 1px.
      if (widths.length) widths[widths.length - 1] = Math.max(1, px - lastPx);
      lastPx = px;
      cols.push(col); xs.push(px); widths.push(2 * hr);
      // Normalization refs over the drawn set.
      for (let k = 1; k < col.s.length; k += 2) { const l = Math.log(col.s[k]! + 1); if (l > logMaxDepth) logMaxDepth = l; }
      for (let k = 1; k < col.x.length; k += 2) { const a = Math.abs(col.x[k]!); if (a > maxTrade) maxTrade = a; }
    }
    if (!cols.length) return null;

    const anchorPrice = cols[cols.length - 1]!.a * data.tick;
    const y0 = this.series.priceToCoordinate(anchorPrice);
    const y1 = this.series.priceToCoordinate(anchorPrice - data.tick);
    const vr = (scope.verticalPixelRatio as number) || 1;
    const tickPx = (y0 != null && y1 != null) ? Math.abs(y1 - y0) * vr : 1;

    return { cols, tick: data.tick, xs, widths, tickPx: Math.max(tickPx, 1), logMaxDepth, maxTrade };
  }
}
