// Aggregator-side TAPE hub — the LIGHT half of the tape-event pipeline.
//
// The heavy MBO tailing + detection runs in tape-worker.ts, which forwards TapeEvents here.
// The hub rings recent events per symbol (so a new viewer gets a backfill), fans them out to
// browsers, and tracks browser presence so the worker tails LAZILY. No firehose parsing here.

import { EventEmitter } from 'node:events';
import type { Symbol as Sym, TapeEvent, TapeSnapshot } from '@trading/contracts';

const RING = 400;        // recent events retained per symbol
const BACKFILL = 400;    // events sent to a browser on connect

const rings: Record<Sym, TapeEvent[]> = { NQ: [], ES: [] };
const bus = new EventEmitter();
bus.setMaxListeners(100);

let browsers = 0;
const activeBus = new EventEmitter();

// ── Worker → hub ────────────────────────────────────────────────────────────
export function ingestTapeEvent(sym: Sym, ev: TapeEvent): void {
  const ring = rings[sym];
  ring.push(ev);
  if (ring.length > RING) ring.splice(0, ring.length - RING);
  bus.emit(`ev:${sym}`, ev);
}

// ── Hub → browser ───────────────────────────────────────────────────────────
export function tapeSnapshot(sym: Sym): TapeSnapshot {
  return { type: 'tape-snapshot', symbol: sym, events: rings[sym].slice(-BACKFILL) };
}
export function onTapeEvent(sym: Sym, fn: (ev: TapeEvent) => void): () => void {
  const key = `ev:${sym}`;
  bus.on(key, fn);
  return () => bus.off(key, fn);
}

// ── Lazy-activation ───────────────────────────────────────────────────────────
export function tapeBrowserConnected(): void {
  browsers++;
  if (browsers === 1) activeBus.emit('change', true);
}
export function tapeBrowserDisconnected(): void {
  browsers = Math.max(0, browsers - 1);
  if (browsers === 0) { activeBus.emit('change', false); rings.NQ.length = 0; rings.ES.length = 0; }
}
export function tapeActive(): boolean { return browsers > 0; }
export function onTapeActiveChange(fn: (active: boolean) => void): () => void {
  activeBus.on('change', fn);
  return () => activeBus.off('change', fn);
}
