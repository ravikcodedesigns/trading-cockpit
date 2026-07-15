// TapePrimitive — plots discrete L3 tape events (sweep / block / spoof / iceberg) as markers at
// the EXACT price + time each occurred (not bar-relative like signal markers). Reads the live
// TapeFeed each frame and applies the feed's display filter (kinds + min-size). zOrder 'top'.
//
//   sweep   → triangle (▲ buy / ▼ sell), size ∝ √contracts
//   block   → filled circle, radius ∝ √contracts
//   iceberg → solid diamond ◆ — native (order_id hidden qty) gets a YELLOW LUMINESCENT border;
//             inferred (price-level replenishment) is the plain solid diamond
//   spoof   → × (pulled/fake liquidity), drawn amber
//   absorption → I-beam ⊢⊣ (heavy one-sided flow, price pinned — λ collapsed vs baseline)
//   stacked → ≡ (3+ consecutive diagonally-imbalanced footprint levels = continuation)
//   wall    → rectangle (HELD) / cracked rectangle (BROKE) at a big resting level
//   unfinished → hollow chevron at a one-sided swing extreme (revisit magnet)
//   trapped → bowtie ▷◁ (aggressors caught offside at an extreme; colored by puke side)
import type {
  ISeriesApi, ISeriesPrimitive, IPrimitivePaneView, IPrimitivePaneRenderer,
  SeriesAttachedParameter, Time, IChartApi,
} from 'lightweight-charts';
import type { TapeFeed } from '../lib/tape-feed';
import type { TapeEvent } from '@trading/contracts';

const AMBER = '245,158,11';
const NATIVE_GLOW = '253,224,71';    // yellow luminescent border for NATIVE icebergs
const SYNTH_GLOW = '255,255,255';    // white luminescent border for SYNTHETIC episodes

// Liveness gauge for an ACTIVE iceberg episode — fuses queue + reload age into one timing word,
// drawn beside every live diamond. Resolved episodes don't get one (the shelf/slash marks those).
//   RELOAD  tranche posted & waiting NOW  ·  LIVE  filled <5s ago  ·  COOLING  5–15s  ·  STALE  >15s
function iceGauge(state: TapeEvent['state'], queueCt: number, lastFillT: number, nowSec: number): { label: string; color: string } | null {
  if (state !== 'active') return null;
  if (queueCt > 0) return { label: 'RELOAD', color: '74,222,128' };
  const age = nowSec - (lastFillT || 0);
  if (age < 5) return { label: 'LIVE', color: '163,230,53' };
  if (age < 15) return { label: 'COOLING', color: '251,191,36' };
  return { label: 'STALE', color: '248,113,113' };
}
// ALL markers use this non-candle palette so they never blend into the green/red candle bodies
// (a green marker on a green candle reads as "hidden behind" it). Cyan = buy-side, magenta = sell-side.
const BUY = '34,211,238';    // cyan
const SELL = '244,114,182';  // magenta
const ICE_BUY = BUY;
const ICE_SELL = SELL;

class Renderer implements IPrimitivePaneRenderer {
  constructor(private src: TapePrimitive) {}
  draw(target: any) {
    const series = this.src.series, chart = this.src.chart;
    if (!series || !chart) return;
    const feed = this.src.feed;
    if (!feed.events.length) return;
    const ts = chart.timeScale();
    const barSec = this.src.barSeconds || 60;
    const { kinds, minSize, minLevels } = feed.filter;

    target.useBitmapCoordinateSpace((scope: any) => {
      const ctx = scope.context as CanvasRenderingContext2D;
      const hr = (scope.horizontalPixelRatio as number) || 1;
      const vr = (scope.verticalPixelRatio as number) || 1;
      const width = scope.bitmapSize?.width ?? 0;
      const height = scope.bitmapSize?.height ?? 0;
      this.src.hits.length = 0;   // rebuilt each frame in CSS coords for hover hit-testing
      const TICK = 0.25;
      const bucketTicks = Math.max(1, Math.round(this.src.iceBucketTicks || 4));
      // Iceberg re-fire snapshots, deduped to the fullest per (bar, exact price, side) — rolled up below.
      const iceExact = new Map<string, { xc: number; priceInt: number; side: TapeEvent['side']; size: number; refills: number; native: boolean; durMs: number; barTime: number; state?: TapeEvent['state']; exec: number; queueCt: number; lastFillT: number }>();
      const confDrawn: { xc: number; yc: number; ev: TapeEvent }[] = [];   // confluence events in view → top-N drawn after

      // Only process events inside the VISIBLE time range — the feed can hold 20k+ events and
      // recomputing coordinates for all of them every scroll/zoom frame drops frames (markers flicker).
      // Cheap numeric pre-filter before the expensive timeToCoordinate/priceToCoordinate lookups.
      const vis = ts.getVisibleRange();
      const visFrom = vis && typeof vis.from === 'number' ? (vis.from as number) - barSec * 2 : -Infinity;
      const visTo = vis && typeof vis.to === 'number' ? (vis.to as number) + barSec * 2 : Infinity;

      for (const ev of feed.events) {
        if (ev.t < visFrom || ev.t > visTo) continue;   // off-screen → skip cheaply
        if (!kinds.has(ev.kind) || ev.size < (minSize[ev.kind] ?? 0)) continue;
        if (ev.levels != null && ev.levels < (minLevels[ev.kind] ?? 0)) continue;
        // Event time → bar boundary → x (timeToCoordinate resolves exact bar times only).
        const barTime = Math.floor(ev.t / barSec) * barSec;
        const xc = ts.timeToCoordinate(barTime as unknown as Time);
        if (xc == null) continue;
        const yc = series.priceToCoordinate(ev.price);
        if (yc == null) continue;
        if (ev.kind === 'iceberg') {   // collect for the roll-up; drawn as bucketed diamonds after the loop
          const pInt = Math.round(ev.price / TICK);
          const key = barTime + '|' + pInt + '|' + ev.side;
          const cur = iceExact.get(key);
          if (!cur || ev.size > cur.size) iceExact.set(key, { xc, priceInt: pInt, side: ev.side, size: ev.size, refills: ev.refills ?? 0, native: !!ev.native, durMs: ev.durMs ?? 0, barTime, state: ev.state, exec: ev.exec ?? 0, queueCt: ev.queueCt ?? 0, lastFillT: ev.lastFillT ?? 0 });
          continue;
        }
        if (ev.kind === 'confluence') { confDrawn.push({ xc, yc, ev }); continue; }   // top-N drawn after the loop
        this.src.hits.push({ x: xc, y: yc, ev });
        const x = xc * hr, y = yc * vr;
        if (x < -20 || x > width + 20 || y < -20 || y > height + 20) continue;

        const col = ev.kind === 'spoof' ? AMBER : ev.side === 'buy' ? BUY : SELL;
        const r = Math.max(3 * hr, Math.min(11 * hr, Math.sqrt(ev.size) * 1.6 * hr));

        ctx.save();
        if (ev.kind === 'block') {
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${col},1)`; ctx.fill();
          ctx.lineWidth = 1.2 * hr; ctx.strokeStyle = 'rgba(10,10,15,0.85)'; ctx.stroke();  // dark edge = crisp on any candle
        } else if (ev.kind === 'sweep') {
          const up = ev.side === 'buy'; const h = r * 1.5;
          ctx.beginPath();
          if (up) { ctx.moveTo(x, y - h); ctx.lineTo(x - r, y + r * 0.6); ctx.lineTo(x + r, y + r * 0.6); }
          else    { ctx.moveTo(x, y + h); ctx.lineTo(x - r, y - r * 0.6); ctx.lineTo(x + r, y - r * 0.6); }
          ctx.closePath(); ctx.fillStyle = `rgba(${col},1)`; ctx.fill();
          ctx.lineWidth = 1 * hr; ctx.strokeStyle = 'rgba(10,10,15,0.7)'; ctx.stroke();
        } else if (ev.kind === 'absorption') { // I-beam "held wall": heavy flow, price pinned
          const w = r * 1.7, cap = r * 0.9;
          ctx.lineWidth = 2.4 * hr; ctx.strokeStyle = `rgba(${col},0.95)`;
          ctx.beginPath();
          ctx.moveTo(x - w, y); ctx.lineTo(x + w, y);                       // the wall
          ctx.moveTo(x - w, y - cap); ctx.lineTo(x - w, y + cap);           // left cap
          ctx.moveTo(x + w, y - cap); ctx.lineTo(x + w, y + cap);           // right cap
          ctx.stroke();
        } else if (ev.kind === 'stacked') { // three stacked dashes ≡ — a ladder of imbalanced levels
          const w = r * 1.4;
          ctx.lineWidth = 2.2 * hr; ctx.strokeStyle = `rgba(${col},0.95)`;
          ctx.beginPath();
          for (let i = -1; i <= 1; i++) { const yy = y + i * r * 0.9; ctx.moveTo(x - w, yy); ctx.lineTo(x + w, yy); }
          ctx.stroke();
        } else if (ev.kind === 'wall') { // brick: rectangle outline; a BREAK gets a diagonal crack
          const w = r * 1.5, h = r * 1.1;
          ctx.lineWidth = 2.2 * hr; ctx.strokeStyle = `rgba(${col},0.95)`;
          ctx.strokeRect(x - w, y - h, w * 2, h * 2);
          if (ev.state === 'break') { ctx.beginPath(); ctx.moveTo(x - w, y + h); ctx.lineTo(x + w, y - h); ctx.stroke(); }
        } else if (ev.kind === 'unfinished') { // hollow chevron pointing toward the magnet (buy=up / sell=down)
          const up = ev.side === 'buy'; const h = r * 1.4;
          ctx.lineWidth = 2.2 * hr; ctx.strokeStyle = `rgba(${col},0.95)`;
          ctx.beginPath();
          if (up) { ctx.moveTo(x - r, y + r * 0.5); ctx.lineTo(x, y - h); ctx.lineTo(x + r, y + r * 0.5); }
          else    { ctx.moveTo(x - r, y - r * 0.5); ctx.lineTo(x, y + h); ctx.lineTo(x + r, y - r * 0.5); }
          ctx.stroke();
        } else if (ev.kind === 'trapped') { // bowtie ▷◁ — aggressors caught offside, will puke `side`
          ctx.fillStyle = `rgba(${col},1)`;
          ctx.beginPath();
          ctx.moveTo(x - r, y - r); ctx.lineTo(x, y); ctx.lineTo(x - r, y + r); ctx.closePath();
          ctx.moveTo(x + r, y - r); ctx.lineTo(x, y); ctx.lineTo(x + r, y + r); ctx.closePath();
          ctx.fill();
          ctx.lineWidth = 1 * hr; ctx.strokeStyle = 'rgba(10,10,15,0.7)'; ctx.stroke();
        } else { // spoof — an ×
          ctx.lineWidth = 2 * hr; ctx.strokeStyle = `rgba(${AMBER},0.95)`;
          ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke();
        }
        ctx.restore();
      }

      // ── Roll up icebergs into ±bucketTicks price buckets (per bar + side) → ONE diamond at the most
      //    significant tick, sized + labeled by the TOTAL hidden contracts in the bucket. Collapses the
      //    per-tick / re-fire swarm into a handful of meaningful hidden-liquidity markers.
      type Bkt = { xc: number; barTime: number; anchorInt: number; anchorSize: number; total: number; refills: number; native: boolean; side: TapeEvent['side']; durMs: number; state?: TapeEvent['state']; exec: number; queueCt: number; lastFillT: number };
      const buckets = new Map<string, Bkt>();
      for (const e of iceExact.values()) {
        const bk = e.barTime + '|' + Math.floor(e.priceInt / bucketTicks) + '|' + e.side;
        let b = buckets.get(bk);
        if (!b) { b = { xc: e.xc, barTime: e.barTime, anchorInt: e.priceInt, anchorSize: 0, total: 0, refills: 0, native: false, side: e.side, durMs: 0, exec: 0, queueCt: 0, lastFillT: 0 }; buckets.set(bk, b); }
        b.total += e.size;
        b.exec += e.exec;                 // bucket totals: executed + queued sum across episodes
        b.queueCt += e.queueCt;
        if (e.lastFillT > b.lastFillT) b.lastFillT = e.lastFillT;   // freshest reload in the bucket
        if (e.size > b.anchorSize) { b.anchorSize = e.size; b.anchorInt = e.priceInt; b.state = e.state; }   // most significant tick = anchor (its episode state labels the bucket)
        if (e.refills > b.refills) b.refills = e.refills;
        if (e.durMs > b.durMs) b.durMs = e.durMs;
        b.native = b.native || e.native;
      }

      // draw one diamond per bucket; collect the on-screen ones for top-N + labels
      const drawn: { x: number; y: number; r: number; b: Bkt }[] = [];
      for (const b of buckets.values()) {
        const yc = series.priceToCoordinate(b.anchorInt * TICK);
        if (yc == null) continue;
        const x = b.xc * hr, y = yc * vr;
        if (x < -20 || x > width + 20 || y < -20 || y > height + 20) continue;
        this.src.hits.push({ x: b.xc, y: yc, ev: { t: b.barTime, kind: 'iceberg', price: b.anchorInt * TICK, side: b.side, size: b.total, refills: b.refills, durMs: b.durMs || undefined, native: b.native, state: b.state, exec: b.exec || undefined, queueCt: b.queueCt, lastFillT: b.lastFillT || undefined } });
        const ic = b.side === 'buy' ? ICE_BUY : ICE_SELL;
        // size ∝ hidden contracts, scaled for EPISODIC sizes (tens–low hundreds; the old ×0.22 was
        // tuned for rolling-cumulative thousands and pinned everything <330ct at the 4px floor):
        // 12ct→6px · 26→8 · 50→9 · 97→11 · 400+→16 cap
        const r = Math.max(6 * hr, Math.min(16 * hr, (4 + Math.sqrt(b.total) * 0.7) * hr));
        ctx.save();
        ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
        ctx.fillStyle = `rgba(${ic},0.95)`; ctx.fill();
        ctx.lineWidth = 1.5 * hr; ctx.strokeStyle = 'rgba(10,10,15,0.9)'; ctx.stroke();
        // luminescent border while the diamond path is still current. Native (rare) keeps the true
        // shadow glow; synthetic fakes it with two concentric ring strokes — shadowBlur on hundreds
        // of diamonds froze the crosshair/scroll (canvas shadows are the priciest paint op).
        // Episode-state visual language: BRIGHT rim = ACTIVE (fight live now) · dim rim = resolved ·
        // horizontal bar = HELD (level held firm) · diagonal slash = BROKE (defense failed).
        if (b.native) {
          ctx.shadowColor = `rgba(${NATIVE_GLOW},0.9)`; ctx.shadowBlur = 8 * hr;
          ctx.lineWidth = 2 * hr; ctx.strokeStyle = `rgba(${NATIVE_GLOW},1)`;
          ctx.stroke(); ctx.stroke();
        } else {
          const live = b.state === 'active';
          ctx.lineWidth = 3 * hr; ctx.strokeStyle = `rgba(${SYNTH_GLOW},${live ? 0.28 : 0.12})`; ctx.stroke();   // outer halo
          ctx.lineWidth = 1.4 * hr; ctx.strokeStyle = `rgba(${SYNTH_GLOW},${live ? 0.95 : 0.4})`; ctx.stroke();  // rim: bright = live
        }
        if (b.state === 'broke') {   // diagonal slash = defense failed (same language as wall break)
          ctx.shadowBlur = 0; ctx.lineWidth = 1.5 * hr; ctx.strokeStyle = 'rgba(10,10,15,0.9)';
          ctx.beginPath(); ctx.moveTo(x - r, y + r); ctx.lineTo(x + r, y - r); ctx.stroke();
        } else if (b.state === 'held') {   // horizontal shelf = level held firm
          ctx.shadowBlur = 0; ctx.lineWidth = 1.5 * hr; ctx.strokeStyle = `rgba(${SYNTH_GLOW},0.9)`;
          ctx.beginPath(); ctx.moveTo(x - r * 1.5, y); ctx.lineTo(x + r * 1.5, y); ctx.stroke();
        }
        ctx.restore();
        drawn.push({ x, y, r, b });
      }

      // top-N buckets by total contracts → panel + box labels; the rest get a plain white total
      const top = [...drawn].sort((a, b) => b.b.total - a.b.total).slice(0, 5);
      this.src.topIce = top.map((d) => ({ t: d.b.barTime, kind: 'iceberg' as const, price: d.b.anchorInt * TICK, side: d.b.side, size: d.b.total, refills: d.b.refills, durMs: d.b.durMs || undefined, native: d.b.native, state: d.b.state, exec: d.b.exec || undefined, queueCt: d.b.queueCt, lastFillT: d.b.lastFillT || undefined }));
      const topSet = new Set(top);

      const nowSec = Date.now() / 1000;
      const mainFont = `700 ${11 * hr}px 'Geist Mono', monospace`;
      const gaugeFont = `700 ${9 * hr}px 'Geist Mono', monospace`;
      ctx.textBaseline = 'middle';
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 3 * hr;
      for (const d of drawn) {
        if (topSet.has(d)) continue;
        ctx.font = mainFont;
        ctx.fillStyle = 'rgba(255,255,255,0.96)';
        const num = String(d.b.total);
        ctx.fillText(num, d.x + d.r + 4 * hr, d.y);
        const g = iceGauge(d.b.state, d.b.queueCt, d.b.lastFillT, nowSec);   // timing word beside every live diamond
        if (g) {
          const nw = ctx.measureText(num).width;
          ctx.font = gaugeFont;
          ctx.fillStyle = `rgba(${g.color},0.95)`;
          ctx.fillText(g.label, d.x + d.r + 4 * hr + nw + 5 * hr, d.y);
        }
      }
      ctx.restore();

      ctx.font = mainFont;
      for (const d of top) {
        const b = d.b;
        // H = hidden · E = executed total · Q = queued to execute (live episodes only) · ×reloads
        const txt = `H${b.total}${b.exec ? ` E${b.exec}` : ''}${b.queueCt ? ` Q${b.queueCt}` : ''} ×${b.refills}`;
        const g = iceGauge(b.state, b.queueCt, b.lastFillT, nowSec);
        const tcol = b.native ? NATIVE_GLOW : (b.side === 'buy' ? ICE_BUY : ICE_SELL);
        ctx.font = mainFont;
        const tw = ctx.measureText(txt).width;
        ctx.font = gaugeFont;
        const gw = g ? ctx.measureText(g.label).width + 6 * hr : 0;
        const pad = 4 * hr, boxH = 15 * hr, gap = d.r + 6 * hr, boxW = tw + gw + pad * 2;
        let lx = d.x + gap;                                  // right of the diamond
        if (lx + boxW > width) lx = d.x - gap - boxW;        // flip left near the right edge
        ctx.fillStyle = 'rgba(8,8,12,0.9)';
        ctx.fillRect(lx - pad, d.y - boxH / 2, boxW, boxH);
        ctx.lineWidth = 1 * hr; ctx.strokeStyle = `rgba(${tcol},0.85)`;
        ctx.strokeRect(lx - pad, d.y - boxH / 2, boxW, boxH);
        ctx.font = mainFont;
        ctx.fillStyle = `rgba(${tcol},1)`;
        ctx.fillText(txt, lx, d.y);
        if (g) {
          ctx.font = gaugeFont;
          ctx.fillStyle = `rgba(${g.color},1)`;
          ctx.fillText(g.label, lx + tw + 6 * hr, d.y);
        }
      }

      // ── Confluence ★: show only the TOP-N by score in view (adaptive density — market-activity
      //    independent). Drawn last so the key markers sit on top of everything.
      const confTop = confDrawn.sort((a, b) => b.ev.size - a.ev.size).slice(0, Math.max(1, this.src.confTopN || 8));
      for (const c of confTop) {
        const x = c.xc * hr, y = c.yc * vr;
        if (x < -20 || x > width + 20 || y < -20 || y > height + 20) continue;
        this.src.hits.push({ x: c.xc, y: c.yc, ev: c.ev });
        const col = c.ev.side === 'buy' ? BUY : SELL;
        const cr = Math.max(8 * hr, Math.min(18 * hr, (6 + c.ev.size * 1.5) * hr));   // size ∝ score
        const rin = cr * 0.44;
        ctx.save();
        ctx.beginPath();
        for (let i = 0; i < 10; i++) { const rad = i % 2 === 0 ? cr : rin; const a = -Math.PI / 2 + i * Math.PI / 5; const px = x + Math.cos(a) * rad, py = y + Math.sin(a) * rad; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
        ctx.closePath();
        ctx.fillStyle = `rgba(${col},0.95)`; ctx.fill();
        ctx.lineWidth = 1.8 * hr; ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.stroke();   // bright edge = key marker
        ctx.textBaseline = 'middle'; ctx.font = `800 ${12 * hr}px 'Geist Mono', monospace`;
        const t = `${c.ev.size}${c.ev.levels ? '·' + c.ev.levels : ''}`, pad = 4 * hr, tw = ctx.measureText(t).width, lx = x + cr + 5 * hr;
        ctx.fillStyle = 'rgba(8,8,12,0.92)'; ctx.fillRect(lx - pad, y - 9 * hr, tw + pad * 2, 18 * hr);
        ctx.lineWidth = 1 * hr; ctx.strokeStyle = `rgba(${col},0.9)`; ctx.strokeRect(lx - pad, y - 9 * hr, tw + pad * 2, 18 * hr);
        ctx.fillStyle = `rgba(${col},1)`; ctx.fillText(t, lx, y);
        ctx.restore();
      }
    });
  }
}

class View implements IPrimitivePaneView {
  private r: Renderer;
  constructor(src: TapePrimitive) { this.r = new Renderer(src); }
  zOrder() { return 'top' as const; }
  renderer() { return this.r; }
}

export class TapePrimitive implements ISeriesPrimitive<Time> {
  series: ISeriesApi<any> | null = null;
  chart: IChartApi | null = null;
  enabled = true;
  barSeconds = 60;
  feed: TapeFeed;
  hits: { x: number; y: number; ev: TapeEvent }[] = [];   // CSS-coord marker positions (for hover)
  topIce: TapeEvent[] = [];   // top-N iceberg buckets currently ON SCREEN (ranked) — mirrored to the corner panel
  iceBucketTicks = 4;         // roll up icebergs within ±this many ticks into one diamond at the dominant tick
  confTopN = 8;               // show only the top-N confluence stars (by score) in view — adaptive density
  private _view: View;
  private _requestUpdate?: () => void;

  // Nearest drawn marker within `radius` CSS px of (px,py) — used for the hover tooltip.
  hitTest(px: number, py: number, radius = 9): TapeEvent | null {
    let best: TapeEvent | null = null, bestD = radius * radius;
    for (const h of this.hits) {
      const dx = h.x - px, dy = h.y - py, d = dx * dx + dy * dy;
      if (d <= bestD) { bestD = d; best = h.ev; }
    }
    return best;
  }

  constructor(feed: TapeFeed) { this.feed = feed; this._view = new View(this); feed.onUpdate(() => this._requestUpdate?.()); }
  attached(p: SeriesAttachedParameter<Time>) { this.series = p.series as any; this.chart = p.chart as any; this._requestUpdate = p.requestUpdate; }
  detached() { this.series = null; this.chart = null; }
  updateAllViews() { /* renderer reads live feed */ }
  paneViews(): IPrimitivePaneView[] { return this.enabled ? [this._view] : []; }
  setEnabled(on: boolean) { this.enabled = on; this._requestUpdate?.(); }
  setBarSeconds(sec: number) { if (sec > 0 && sec !== this.barSeconds) { this.barSeconds = sec; this._requestUpdate?.(); } }
  setIceBucketTicks(n: number) { const v = Math.max(1, Math.round(n)); if (v !== this.iceBucketTicks) { this.iceBucketTicks = v; this._requestUpdate?.(); } }
  setConfTopN(n: number) { const v = Math.max(1, Math.round(n)); if (v !== this.confTopN) { this.confTopN = v; this._requestUpdate?.(); } }
  refresh() { this._requestUpdate?.(); }
}
