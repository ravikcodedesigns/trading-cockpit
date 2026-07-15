// Heatmap worker — the DEDICATED process that tails the NQ/ES MBO firehose and streams
// order-book columns to the aggregator. Kept off the aggregator's event loop on purpose:
// parsing two full-size contract firehoses synchronously starves whatever loop it shares.
//
// Flow: connect to the aggregator's /ws/heatmap-ingest. The aggregator tells us whether any
// browser is watching (`{type:'active'}`). We tail + build columns ONLY while active — idle
// otherwise — and forward each column as `{type:'col', symbol, col}`. Reconnects on drop and
// re-syncs the active flag, so an aggregator restart is transparent.

import WebSocket from 'ws';
import { startHeatmapEngine, stopHeatmapEngine, heatmapEngineRunning } from '../src/heatmap/heatmap-engine.js';
import type { Symbol as Sym, HeatmapColumn } from '@trading/contracts';

const INGEST_URL = process.env.HEATMAP_INGEST_URL ?? 'ws://127.0.0.1:8787/ws/heatmap-ingest';
const RECONNECT_MS = 2000;

let ws: WebSocket | null = null;

function forward(sym: Sym, col: HeatmapColumn): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'col', symbol: sym, col })); } catch { /* dropped */ }
  }
}

function setActive(active: boolean): void {
  if (active && !heatmapEngineRunning()) {
    console.log('[heatmap-worker] active → start tailing NQ/ES');
    startHeatmapEngine(forward);
  } else if (!active && heatmapEngineRunning()) {
    console.log('[heatmap-worker] idle → stop tailing');
    stopHeatmapEngine();
  }
}

function connect(): void {
  console.log(`[heatmap-worker] connecting → ${INGEST_URL}`);
  const sock = new WebSocket(INGEST_URL);
  ws = sock;

  sock.on('open', () => console.log('[heatmap-worker] connected to aggregator'));
  sock.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type?: string; active?: boolean };
      if (msg.type === 'active') setActive(!!msg.active);
    } catch { /* ignore */ }
  });
  sock.on('close', () => {
    if (ws === sock) ws = null;
    stopHeatmapEngine();                 // stop tailing while disconnected
    setTimeout(connect, RECONNECT_MS);   // aggregator restart → retry
  });
  sock.on('error', () => { try { sock.close(); } catch { /* noop */ } });
}

process.on('SIGTERM', () => { stopHeatmapEngine(); process.exit(0); });
process.on('SIGINT', () => { stopHeatmapEngine(); process.exit(0); });

connect();
