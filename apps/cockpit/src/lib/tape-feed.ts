import type { TapeEvent, TapeSnapshot, TapeEventPush, TapeKind, Symbol as Sym } from '@trading/contracts';
import { TAPE_FLOORS } from '@trading/contracts';

// Client-side TAPE feed. One WS to /ws/tape for live events of the active symbol, PLUS durable
// backfill via loadRange() → GET /tape/history (so markers persist on historical candles and you
// can scroll back to analyse what happened after each). Events are deduped by (t,kind,price,side)
// and bounded at MAX. A live display FILTER (kinds + per-kind size/level floors) dials marker
// density without touching the worker. The primitive reads `events` + `filter` each frame.

const MAX = 150000;        // client-side event cap — hold a full session so a zoomed-out view isn't
                           // truncated (which shifts the visible slice on refetch → marker flicker).
                           // The primitive only draws events inside the visible window, so this is cheap.
const RECONNECT_MS = 1500;

// Order = the TAPE bar's display order (user-arranged 2026-07-21)
export const ALL_KINDS: TapeKind[] = ['confluence', 'sweep', 'block', 'iceberg', 'absorption', 'stacked', 'wall', 'trapped', 'unfinished', 'stoprun', 'spoof'];

// Kinds that carry a consecutive-price-levels count (so the UI shows a `lvl` floor for them).
const hasLevels = (k: TapeKind): boolean => 'levels' in (TAPE_FLOORS[k] as Record<string, unknown>);

export interface TapeFilter {
  kinds: Set<TapeKind>;              // which event kinds to draw
  minSize: Record<TapeKind, number>; // per-kind min size floor (contracts) — dial each independently
  minLevels: Record<TapeKind, number>; // per-kind min consecutive levels (only sweep/stacked use it)
  // ── percentile mode: "show ≥ p80" instead of an absolute number. Resolves PER EVENT against
  //    the event's own session (overnight vs RTH) from the nightly-recalibrated tables, so "big"
  //    means the same thing at 3am and 10am and never needs manual retuning.
  pctMode?: boolean;
  minPct?: Partial<Record<TapeKind, 0 | 50 | 80 | 95>>;   // 0 = all (floor only)
  cal?: CalDoc | null;               // /tape/calibration payload
  symbol?: string;                   // calibration is per-symbol
}

// Calibration doc shape (subset we read): cal[sym][metric] = whole-RTH pctls; tod.overnight = night set.
export interface CalPctls { n: number; p50: number; p80: number; p95: number; }
export type CalDoc = Record<string, Record<string, CalPctls> & { tod?: Record<string, Record<string, CalPctls>> }>;

// Which calibrated distribution grades each kind's size (mirrors the engine's tier metrics).
// Absent kinds (spoof/unfinished/absorption/confluence) have no usable distribution — their
// counters stay absolute even in percentile mode.
const PCT_METRIC: Partial<Record<TapeKind, string>> = {
  block: 'block_ct', sweep: 'sweep_size', stacked: 'stacked_vol', trapped: 'trapped_ct',
  iceberg: 'iceberg_ct', wall: 'wall_peak', stoprun: 'stoprun_ct',
};

// RTH bounds cache (UTC ms) — Intl per event would wreck the draw loop; one lookup per day.
const _rthCache = new Map<number, { open: number; close: number }>();
function rthBoundsForSec(tSec: number): { open: number; close: number } {
  const dayKey = Math.floor(tSec / 86_400);
  let b = _rthCache.get(dayKey);
  if (!b) {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(tSec * 1000));
    const [y, m, d] = date.split('-').map(Number);
    b = { open: Date.UTC(y!, m! - 1, d!, 13, 30) / 1000, close: Date.UTC(y!, m! - 1, d!, 20, 0) / 1000 };  // EDT
    _rthCache.set(dayKey, b);
    if (_rthCache.size > 400) _rthCache.clear();
  }
  return b;
}

/** Percentile display floor for an event: its session's distribution (overnight vs whole-RTH),
 *  null when no calibration applies (caller falls back to the absolute counter). */
export function pctFloor(cal: CalDoc | null | undefined, symbol: string | undefined, kind: TapeKind, pct: number | undefined, tSec: number): number | null {
  if (!cal || !symbol || !pct) return null;
  const metric = PCT_METRIC[kind];
  if (!metric) return null;
  const sym = cal[symbol];
  if (!sym) return null;
  const b = rthBoundsForSec(tSec);
  const overnight = tSec < b.open || tSec >= b.close;
  const p = (overnight ? sym.tod?.overnight?.[metric] : undefined) ?? sym[metric];
  if (!p || typeof p !== 'object' || !('p50' in p) || (p as CalPctls).n < 100) return null;
  const pc = p as CalPctls;
  return pct >= 95 ? pc.p95 : pct >= 80 ? pc.p80 : pc.p50;
}

// Per-kind size floors (= defaults = minimums) from the shared TAPE_FLOORS.
export const floorMinSize = (): Record<TapeKind, number> =>
  Object.fromEntries(ALL_KINDS.map((k) => [k, TAPE_FLOORS[k].size])) as Record<TapeKind, number>;

// Per-kind level floors — 0 for kinds without a levels count.
export const floorMinLevels = (): Record<TapeKind, number> =>
  Object.fromEntries(ALL_KINDS.map((k) => [k, hasLevels(k) ? (TAPE_FLOORS[k] as { levels: number }).levels : 0])) as Record<TapeKind, number>;

export class TapeFeed {
  events: TapeEvent[] = [];
  filter: TapeFilter = { kinds: new Set(ALL_KINDS), minSize: floorMinSize(), minLevels: floorMinLevels() };
  // Replay-only knobs (live leaves these at the defaults, so live rendering is unchanged):
  maxT: number | null = null;   // reveal only events with t <= maxT (the virtual clock, in seconds)
  spread = false;               // spread events horizontally within their candle by sub-minute time
  private keys = new Set<string>();          // dedup: (t|kind|price|side) — history + live overlap
  private eps = new Map<string, TapeEvent>(); // iceberg episodes by epId — updates REPLACE in place
  private ws: WebSocket | null = null;
  private symbol: Sym;
  private updateCb: (() => void) | null = null;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private loadSeq = 0;                        // guards against out-of-order loadRange responses

  // opts.replay: skip the live /ws/tape connection — session replay populates events via
  // loadRange() over the recorded day instead of streaming today's live tape.
  constructor(symbol: Sym, opts?: { replay?: boolean }) { this.symbol = symbol; if (!opts?.replay) this.connect(); }

  onUpdate(cb: () => void): void { this.updateCb = cb; }
  requestRedraw(): void { this.updateCb?.(); }   // replay: force a primitive repaint as the clock advances
  setFilter(f: TapeFilter): void { this.filter = f; this.updateCb?.(); }

  private keyOf(ev: TapeEvent): string { return `${ev.t}|${ev.kind}|${ev.price}|${ev.side}`; }
  private add(ev: TapeEvent): boolean {
    // Episode events (iceberg provisional→final) share an epId — mutate the existing object in
    // place so the marker updates (grows / resolves held-broke) instead of accumulating copies.
    // In-place mutation keeps the events array's sort stable (episode `t` is anchored at start).
    if (ev.epId) {
      const prior = this.eps.get(ev.epId);
      if (prior) {
        if (prior.size === ev.size && prior.state === ev.state && prior.refills === ev.refills
          && prior.queueCt === ev.queueCt && prior.exec === ev.exec) return false;
        Object.assign(prior, ev);
        return true;
      }
      this.eps.set(ev.epId, ev);
      this.events.push(ev);
      // episode markers are anchored at their START (t0) but arrive when they QUALIFY — the first
      // emit can land seconds late. The draw loop binary-searches this array by t, so keep the
      // sort invariant on the rare out-of-order push (cheap: sorted-array sort is near-linear).
      if (this.events.length > 1 && this.events[this.events.length - 2]!.t > ev.t) this.events.sort((a, b) => a.t - b.t);
      return true;
    }
    const k = this.keyOf(ev);
    if (this.keys.has(k)) return false;
    this.keys.add(k); this.events.push(ev); return true;
  }
  private trim(): void {
    if (this.events.length <= MAX) return;
    const drop = this.events.length - MAX;
    for (let i = 0; i < drop; i++) {
      const ev = this.events[i]!;
      if (ev.epId) this.eps.delete(ev.epId); else this.keys.delete(this.keyOf(ev));
    }
    this.events.splice(0, drop);
  }
  private clear(): void { this.events = []; this.keys.clear(); this.eps.clear(); }

  // Durable backfill: load persisted markers for [fromSec, toSec] and merge them in (keeping any
  // live events newer than the range). Called by the chart on load + on scroll into history.
  async loadRange(fromSec: number, toSec: number): Promise<void> {
    const seq = ++this.loadSeq;
    const sym = this.symbol;
    try {
      const r = await fetch(`/tape/history?symbol=${sym}&from=${Math.floor(fromSec)}&to=${Math.ceil(toSec)}&limit=100000`);
      if (!r.ok || seq !== this.loadSeq || sym !== this.symbol) return;   // stale / superseded
      const j = (await r.json()) as { events: TapeEvent[] };
      if (seq !== this.loadSeq || sym !== this.symbol) return;
      const liveTail = this.events.filter((e) => e.t > toSec);            // preserve live beyond the range
      this.clear();
      for (const ev of j.events) this.add(ev);
      for (const ev of liveTail) this.add(ev);
      this.events.sort((a, b) => a.t - b.t);
      this.trim();
      this.updateCb?.();
    } catch { /* keep prior events */ }
  }

  setSymbol(symbol: Sym): void {
    if (symbol === this.symbol) return;
    this.symbol = symbol;
    this.clear();
    this.reconnect();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    try { this.ws?.close(); } catch { /* noop */ }
    this.ws = null;
  }

  private reconnect(): void { try { this.ws?.close(); } catch { /* noop */ } this.ws = null; this.connect(); }

  private connect(): void {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: WebSocket;
    try { ws = new WebSocket(`${proto}://${location.host}/ws/tape?symbol=${this.symbol}`); }
    catch { this.scheduleReconnect(); return; }
    this.ws = ws;

    ws.onmessage = (ev) => {
      let msg: TapeSnapshot | TapeEventPush | { type: 'pong' };
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      if (msg.type === 'tape-snapshot') {
        if (msg.symbol !== this.symbol) return;
        let changed = false;
        for (const ev of msg.events) changed = this.add(ev) || changed;   // merge, don't clobber history
        if (changed) { this.events.sort((a, b) => a.t - b.t); this.trim(); this.updateCb?.(); }
      } else if (msg.type === 'tape-event') {
        if (msg.symbol !== this.symbol) return;
        if (this.add(msg.ev)) { this.trim(); this.updateCb?.(); }          // live arrives in order → no re-sort
      }
    };
    ws.onopen = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => { try { ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'ping' })); } catch { /* noop */ } }, 15000);
    };
    ws.onclose = () => { if (this.pingTimer) clearInterval(this.pingTimer); this.scheduleReconnect(); };
    ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, RECONNECT_MS);
  }
}
