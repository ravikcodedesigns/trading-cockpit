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
import { pctFloor } from '../lib/tape-feed';
import type { TapeEvent } from '@trading/contracts';
import { TAPE_FLOORS } from '@trading/contracts';

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
        // percentile mode: the floor is the event's own session's distribution (overnight vs RTH),
        // so "show the big ones" self-adjusts by clock; kinds without a calibrated distribution
        // (and any calibration gap) fall back to the absolute counter.
        let minSz = minSize[ev.kind] ?? 0;
        if (feed.filter.pctMode) {
          const pf = pctFloor(feed.filter.cal, feed.filter.symbol, ev.kind, feed.filter.minPct?.[ev.kind], ev.t);
          if (pf != null) minSz = Math.max(TAPE_FLOORS[ev.kind]?.size ?? 0, pf);
        }
        if (!kinds.has(ev.kind) || ev.size < minSz) continue;
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
        } else if (ev.kind === 'wall') { // brick: rectangle outline; a BREAK gets a diagonal crack;
          // ACTIVE (standing RIGHT NOW — lean on it) = bright + filled, live-updating; resolved dims.
          // PULLED (walked without a fight — spoof-adjacent) renders dashed with a small pull-away arrow
          const w = r * 1.5, h = r * 1.1;
          const live = ev.state === 'active';
          if (live) { ctx.fillStyle = `rgba(${col},0.22)`; ctx.fillRect(x - w, y - h, w * 2, h * 2); }
          ctx.lineWidth = (live ? 3 : 2.2) * hr; ctx.strokeStyle = `rgba(${col},${live ? 1 : 0.8})`;
          if (ev.state === 'pulled') ctx.setLineDash([3 * hr, 2.5 * hr]);
          ctx.strokeRect(x - w, y - h, w * 2, h * 2);
          ctx.setLineDash([]);
          if (ev.state === 'break') { ctx.beginPath(); ctx.moveTo(x - w, y + h); ctx.lineTo(x + w, y - h); ctx.stroke(); }
          if (ev.state === 'pulled') { // arrow out of the brick: the owner left, nobody ate it
            ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - h * 1.9);
            ctx.moveTo(x - r * 0.45, y - h * 1.4); ctx.lineTo(x, y - h * 1.9); ctx.lineTo(x + r * 0.45, y - h * 1.4);
            ctx.stroke();
          }
        } else if (ev.kind === 'unfinished') { // hollow chevron pointing toward the magnet (buy=up / sell=down)
          const up = ev.side === 'buy'; const h = r * 1.4;
          ctx.lineWidth = 2.2 * hr; ctx.strokeStyle = `rgba(${col},0.95)`;
          ctx.beginPath();
          if (up) { ctx.moveTo(x - r, y + r * 0.5); ctx.lineTo(x, y - h); ctx.lineTo(x + r, y + r * 0.5); }
          else    { ctx.moveTo(x - r, y - r * 0.5); ctx.lineTo(x, y + h); ctx.lineTo(x + r, y - r * 0.5); }
          ctx.stroke();
        } else if (ev.kind === 'stoprun') { // double chevron » through the swept ref, pointing run
          // direction; RECLAIMED adds a reversal hook (sweep failed → spring), ACCEPTED fills solid,
          // active = bright hollow (still an open coin)
          const up = ev.side === 'buy';
          const h = r * 1.1, dy = up ? -1 : 1;
          ctx.lineWidth = 2.2 * hr;
          ctx.strokeStyle = `rgba(${col},${ev.state === 'active' ? 1 : 0.9})`;
          ctx.beginPath();
          for (let i = 0; i < 2; i++) {
            const yy = y - dy * i * h * 0.8;
            ctx.moveTo(x - r, yy); ctx.lineTo(x, yy + dy * h); ctx.lineTo(x + r, yy);
          }
          ctx.stroke();
          if (ev.state === 'accepted') { ctx.fillStyle = `rgba(${col},0.35)`; ctx.fillRect(x - r, y - h * 1.6, r * 2, h * 3.2); }
          if (ev.state === 'reclaimed') { // hook arrow AGAINST the run — the triggered cohort is offside
            ctx.beginPath();
            ctx.moveTo(x + r * 1.6, y + dy * h * 1.4); ctx.lineTo(x + r * 1.6, y - dy * h * 1.6);
            ctx.moveTo(x + r * 1.15, y - dy * h * 1.05); ctx.lineTo(x + r * 1.6, y - dy * h * 1.6); ctx.lineTo(x + r * 2.05, y - dy * h * 1.05);
            ctx.stroke();
          }
        } else if (ev.kind === 'trapped') { // bowtie ▷◁ — a cohort caught offside; expected to puke `side`
          // lifecycle: ACTIVE = bright (cohort trapped NOW) · FLUSHED = extending arrow (they puked,
          // reversal played) · RECOVERED = dim + strike (trap died, cohort freed)
          const dead = ev.state === 'recovered';
          ctx.fillStyle = `rgba(${col},${dead ? 0.35 : 1})`;
          ctx.beginPath();
          ctx.moveTo(x - r, y - r); ctx.lineTo(x, y); ctx.lineTo(x - r, y + r); ctx.closePath();
          ctx.moveTo(x + r, y - r); ctx.lineTo(x, y); ctx.lineTo(x + r, y + r); ctx.closePath();
          ctx.fill();
          ctx.lineWidth = 1 * hr; ctx.strokeStyle = 'rgba(10,10,15,0.7)'; ctx.stroke();
          if (ev.state === 'flushed') {   // the puke fired — arrow extending in the puke direction
            const dy = ev.side === 'sell' ? 1 : -1;
            ctx.beginPath(); ctx.lineWidth = 2 * hr; ctx.strokeStyle = `rgba(${col},0.95)`;
            ctx.moveTo(x, y + dy * r); ctx.lineTo(x, y + dy * r * 2.4);
            ctx.moveTo(x - r * 0.5, y + dy * r * 1.9); ctx.lineTo(x, y + dy * r * 2.4); ctx.lineTo(x + r * 0.5, y + dy * r * 1.9);
            ctx.stroke();
          }
          if (dead) {   // struck: the trap thesis failed
            ctx.beginPath(); ctx.lineWidth = 1.8 * hr; ctx.strokeStyle = 'rgba(255,255,255,0.65)';
            ctx.moveTo(x - r * 1.3, y + r * 1.3); ctx.lineTo(x + r * 1.3, y - r * 1.3); ctx.stroke();
          }
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
      // ── Star IMPORTANCE TIERS (display-only; engine/store/study untouched). Provisional
      //    composition-based prioritization until the 2026-07-29 outcome review:
      //    T1 PRIME — passive level-defense (iceberg/wall/absorption) AND exhaustion (trapped/
      //       stop-run) aligned in one zone: rare, maps to the validated trap-conditioner pattern.
      //    T2 KEY — ≥4 families agreed, or a FLIP (zone reversed its read).
      //    T3 rest — incl. pure taker/flow/book stars (the whipsaw flavor). Hidden by default.
      //    NOTE deliberately NOT ranked by raw score: genesis-day labels measured high score
      //    ANTI-selecting at the 2m horizon (39% vs 56%) — score breaks ties only.
      const tierOf = (ev: TapeEvent): number => {
        const sigs = ev.signals ?? [];
        const levelDef = sigs.some((s) => s === 'iceberg' || s === 'wall' || s === 'absorption');
        const exh = sigs.some((s) => s === 'trapped' || s === 'stoprun');
        const fam = ev.levels ?? 0;
        if (levelDef && exh && fam >= 5) return 1;               // ~4/day across both symbols (genesis dist.)
        if ((levelDef && exh && fam >= 4) || ev.flip) return 2;  // ~5/hour/symbol
        return 3;
      };
      const confTop = confDrawn
        .filter((c) => tierOf(c.ev) <= (this.src.confMinTier || 2))
        .sort((a, b) => tierOf(a.ev) - tierOf(b.ev) || b.ev.size - a.ev.size)
        .slice(0, Math.max(1, this.src.confTopN || 8));
      for (const c of confTop) {
        const x = c.xc * hr, y = c.yc * vr;
        if (x < -20 || x > width + 20 || y < -20 || y > height + 20) continue;
        this.src.hits.push({ x: c.xc, y: c.yc, ev: c.ev });
        const tier = tierOf(c.ev);
        // SUPERSEDED: a NEWER opposite star exists nearby → this one's read has been reversed.
        // Drawn dimmed with a strike — history stays visible, the zone's current call is unambiguous.
        const superseded = confDrawn.some((o) =>
          o.ev.side !== c.ev.side && o.ev.t > c.ev.t && (o.ev.t - c.ev.t) * 1000 < 120_000 &&
          Math.abs(o.ev.price - c.ev.price) <= 8 * 0.25);
        // ── Star color = EVIDENCE direction (user decision 2026-07-15, made informed): cyan when
        // the aggregated microstructure evidence points LONG (buy sweeps, held bid icebergs,
        // broken ask icebergs/walls, buy flow…), pink when it points SHORT. The user explicitly
        // chose this mapping knowing the follow-vs-fade trade meaning stays UNDER MEASUREMENT
        // until the STAR_FADE_PREREG review (2026-07-29) — the tooltip carries that caveat; the
        // review may re-map colors to trade space per confirmed cohort.
        const col = c.ev.side === 'buy' ? BUY : SELL;
        let cr = Math.max(8 * hr, Math.min(18 * hr, (6 + c.ev.size * 1.5) * hr));   // size ∝ score
        if (tier === 1) cr *= 1.25;   // PRIME stars read bigger at a glance
        if (tier === 3) cr *= 0.75;   // standard stars recede when shown at all
        const rin = cr * 0.44;
        ctx.save();
        ctx.beginPath();
        for (let i = 0; i < 10; i++) { const rad = i % 2 === 0 ? cr : rin; const a = -Math.PI / 2 + i * Math.PI / 5; const px = x + Math.cos(a) * rad, py = y + Math.sin(a) * rad; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
        ctx.closePath();
        ctx.fillStyle = `rgba(${col},${superseded ? 0.3 : 0.95})`; ctx.fill();
        ctx.lineWidth = 1.8 * hr; ctx.strokeStyle = `rgba(255,255,255,${superseded ? 0.35 : 0.92})`; ctx.stroke();   // bright edge = key marker
        if (superseded) {   // struck through: a newer opposite star reversed this zone's read
          ctx.beginPath(); ctx.moveTo(x - cr - 3 * hr, y + cr + 3 * hr); ctx.lineTo(x + cr + 3 * hr, y - cr - 3 * hr);
          ctx.lineWidth = 2 * hr; ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.stroke();
        }
        if (c.ev.flip && !superseded) {   // FLIP badge: this star reversed the zone's previous read
          ctx.beginPath(); ctx.arc(x, y, cr + 3.5 * hr, -Math.PI * 0.15, Math.PI * 1.15);
          ctx.lineWidth = 1.6 * hr; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.stroke();
          ctx.beginPath();   // arrowhead on the arc = "reversed"
          const ax = x + Math.cos(-Math.PI * 0.15) * (cr + 3.5 * hr), ay = y + Math.sin(-Math.PI * 0.15) * (cr + 3.5 * hr);
          ctx.moveTo(ax - 4 * hr, ay - 3 * hr); ctx.lineTo(ax, ay); ctx.lineTo(ax - 1 * hr, ay + 5 * hr); ctx.stroke();
        }
        if (tier === 1) {   // PRIME double ring — defense + trapped opponents aligned in one zone
          for (const rr of [3.5, 6]) {
            ctx.beginPath(); ctx.arc(x, y, cr + rr * hr, 0, Math.PI * 2);
            ctx.lineWidth = 1.3 * hr; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke();
          }
        }
        if (c.ev.atStruct) {   // AT-STRUCTURE halo — F5b: the same confluence means something different at a level
          ctx.beginPath(); ctx.arc(x, y, cr + (tier === 1 ? 9 : c.ev.flip ? 6.5 : 3.5) * hr, 0, Math.PI * 2);
          ctx.lineWidth = 1.4 * hr; ctx.strokeStyle = 'rgba(253,224,71,0.85)'; ctx.stroke();
        }
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
  confTopN = 8;               // show only the top-N confluence stars in view — adaptive density
  confMinTier = 2;            // 1 = PRIME only · 2 = prime+key (default) · 3 = all stars
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
  setConfMinTier(n: number) { const v = Math.min(3, Math.max(1, Math.round(n))); if (v !== this.confMinTier) { this.confMinTier = v; this._requestUpdate?.(); } }
  refresh() { this._requestUpdate?.(); }
}
