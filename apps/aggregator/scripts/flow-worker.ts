// Flow worker — the DEDICATED process that tails the NQ/ES MBO firehose, reconstructs the
// full L3 order book, and streams FlowSnapshots (imbalance, aggressor delta, tape speed,
// book temperature, true CVD) to the aggregator for the cockpit FLOW HUD. Kept off the
// aggregator's event loop on purpose (same rationale as the heatmap / L3 workers).
//
// Flow: connect to /ws/flow-ingest. The aggregator tells us whether any browser is watching
// (`{type:'active'}`). We tail + build the book ONLY while active — idle otherwise — and
// forward each snapshot as `{type:'snap', symbol, snap}`. Reconnects on drop and re-syncs the
// active flag, so an aggregator restart is transparent.

import WebSocket from 'ws';
import { startFlowEngine, stopFlowEngine, flowEngineRunning } from '../src/flow/flow-engine.js';
import type { Symbol as Sym, FlowSnapshot } from '@trading/contracts';

const INGEST_URL = process.env.FLOW_INGEST_URL ?? 'ws://127.0.0.1:8787/ws/flow-ingest';
const RECONNECT_MS = 2000;

let ws: WebSocket | null = null;

function forward(sym: Sym, snap: FlowSnapshot): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'snap', symbol: sym, snap })); } catch { /* dropped */ }
  }
}

function setActive(active: boolean): void {
  if (active && !flowEngineRunning()) {
    console.log('[flow-worker] active → start tailing NQ/ES');
    startFlowEngine(forward);
  } else if (!active && flowEngineRunning()) {
    console.log('[flow-worker] idle → stop tailing');
    stopFlowEngine();
  }
}

function connect(): void {
  console.log(`[flow-worker] connecting → ${INGEST_URL}`);
  const sock = new WebSocket(INGEST_URL);
  ws = sock;

  sock.on('open', () => console.log('[flow-worker] connected to aggregator'));
  sock.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type?: string; active?: boolean };
      if (msg.type === 'active') setActive(!!msg.active);
    } catch { /* ignore */ }
  });
  sock.on('close', () => {
    if (ws === sock) ws = null;
    stopFlowEngine();                    // stop tailing while disconnected
    setTimeout(connect, RECONNECT_MS);   // aggregator restart → retry
  });
  sock.on('error', () => { try { sock.close(); } catch { /* noop */ } });
}

process.on('SIGTERM', () => { stopFlowEngine(); process.exit(0); });
process.on('SIGINT', () => { stopFlowEngine(); process.exit(0); });

connect();
