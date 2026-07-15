// Tape worker — DEDICATED process that tails the NQ/ES MBO firehose, detects order-flow events
// (block / sweep / spoof / iceberg / absorption / stacked / wall / unfinished / trapped), PERSISTS
// every one to data/tape-events.db, and streams them to the aggregator for the cockpit TAPE layer.
// Kept off the aggregator's event loop (same rationale as heatmap/flow/L3).
//
// ALWAYS-ON: unlike the old lazy build, this tails + persists continuously (independent of viewers)
// so the historical record is complete and the cockpit can backfill markers for any past range.
// It still forwards live events to the hub over /ws/tape-ingest whenever that socket is connected.

import WebSocket from 'ws';
import { startTapeEngine, stopTapeEngine } from '../src/tape/tape-engine.js';
import { enqueueTapeEvent, startTapePersist, stopTapePersist } from '../src/tape/tape-store.js';
import type { Symbol as Sym, TapeEvent } from '@trading/contracts';

const INGEST_URL = process.env.TAPE_INGEST_URL ?? 'ws://127.0.0.1:8787/ws/tape-ingest';
const RECONNECT_MS = 2000;

let ws: WebSocket | null = null;

function forward(sym: Sym, ev: TapeEvent): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'ev', symbol: sym, ev })); } catch { /* dropped */ }
  }
}

// Every detected event: persist ALWAYS (durable), forward when a viewer path is connected.
function handle(sym: Sym, ev: TapeEvent): void {
  enqueueTapeEvent(sym, ev);
  forward(sym, ev);
}

function connect(): void {
  console.log(`[tape-worker] connecting → ${INGEST_URL}`);
  const sock = new WebSocket(INGEST_URL);
  ws = sock;
  sock.on('open', () => console.log('[tape-worker] connected to aggregator'));
  // We ignore the hub's `active` flag now — tailing is always-on so the record is complete.
  sock.on('message', () => { /* no-op */ });
  sock.on('close', () => { if (ws === sock) ws = null; setTimeout(connect, RECONNECT_MS); });   // keep tailing/persisting
  sock.on('error', () => { try { sock.close(); } catch { /* noop */ } });
}

// Always-on: start persistence + detection immediately, independent of any viewer.
startTapePersist();
startTapeEngine(handle);
console.log('[tape-worker] always-on: tailing + persisting NQ/ES → data/tape-events.db');
connect();

process.on('SIGTERM', () => { stopTapeEngine(); stopTapePersist(); process.exit(0); });
process.on('SIGINT', () => { stopTapeEngine(); stopTapePersist(); process.exit(0); });
