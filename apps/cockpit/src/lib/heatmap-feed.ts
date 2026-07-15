import type { HeatmapColumn, HeatmapSnapshot, HeatmapColumnPush, Symbol as Sym } from '@trading/contracts';

// Client-side live heatmap feed. Owns one WS to /ws/heatmap for the ACTIVE symbol,
// keeps a ring buffer of columns, and exposes the data the canvas primitive reads on
// every draw. On symbol switch it reconnects and clears (the server streams per-symbol).
//
// The primitive reads `feed.data` directly each frame (live, no copy) and is nudged to
// repaint via the onUpdate callback whenever a new column lands — mirroring how the
// zoneBands primitive is driven.

const RING = 3000;             // ~5 min at 100ms — matches server retention
const RECONNECT_MS = 1500;

export interface HeatmapData {
  tick: number;                // price per price_int unit
  band: number;                // half-width in ticks
  colMs: number;
  cols: HeatmapColumn[];       // chronological ring
}

export class HeatmapFeed {
  data: HeatmapData = { tick: 0.25, band: 150, colMs: 100, cols: [] };
  private ws: WebSocket | null = null;
  private symbol: Sym;
  private updateCb: (() => void) | null = null;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(symbol: Sym) {
    this.symbol = symbol;
    this.connect();
  }

  onUpdate(cb: () => void): void { this.updateCb = cb; }

  setSymbol(symbol: Sym): void {
    if (symbol === this.symbol) return;
    this.symbol = symbol;
    this.data = { ...this.data, cols: [] };   // clear — new symbol streams fresh
    this.reconnect();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    try { this.ws?.close(); } catch { /* noop */ }
    this.ws = null;
  }

  private reconnect(): void {
    try { this.ws?.close(); } catch { /* noop */ }
    this.ws = null;
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws/heatmap?symbol=${this.symbol}`;
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch { this.scheduleReconnect(); return; }
    this.ws = ws;

    ws.onmessage = (ev) => {
      let msg: HeatmapSnapshot | HeatmapColumnPush | { type: 'pong' };
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      if (msg.type === 'heatmap-snapshot') {
        if (msg.symbol !== this.symbol) return;   // stale frame from a prior symbol
        this.data = { tick: msg.tick, band: msg.band, colMs: msg.colMs, cols: msg.cols.slice(-RING) };
        this.updateCb?.();
      } else if (msg.type === 'heatmap-column') {
        if (msg.symbol !== this.symbol) return;
        const cols = this.data.cols;
        cols.push(msg.col);
        if (cols.length > RING) cols.splice(0, cols.length - RING);
        this.updateCb?.();
      }
    };
    ws.onopen = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        try { ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'ping' })); } catch { /* noop */ }
      }, 15000);
    };
    ws.onclose = () => { if (this.pingTimer) clearInterval(this.pingTimer); this.scheduleReconnect(); };
    ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, RECONNECT_MS);
  }
}
