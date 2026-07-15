// Aggregator-side FLOW hub — the LIGHT half of the order-flow pipeline.
//
// The heavy MBO tailing + book reconstruction runs in flow-worker.ts, which forwards a
// FlowSnapshot per symbol (~4/sec). The hub just keeps the latest per symbol, fans it out
// to browser subscribers, and tracks browser presence so the worker tails LAZILY. No
// firehose parsing ever happens here. Mirrors heatmap-hub, but FLOW is point-in-time so
// there's no ring — a new viewer just gets the last snapshot immediately.

import { EventEmitter } from 'node:events';
import type { Symbol as Sym, FlowSnapshot } from '@trading/contracts';

const latest: Record<Sym, FlowSnapshot | null> = { NQ: null, ES: null };
const bus = new EventEmitter();
bus.setMaxListeners(100);

let browsers = 0;                       // live browser subscribers
const activeBus = new EventEmitter();   // fires 'change' when browsers crosses 0↔1

// ── Worker → hub ────────────────────────────────────────────────────────────
export function ingestFlow(sym: Sym, snap: FlowSnapshot): void {
  // snap.cvd is the flow engine's RTH-anchored CVD from the SAME BMD capture Bookmap uses
  // (hydrated from the log at attach so it's complete). No longer overridden with the CQG/MNQ
  // cvdSession — that's a different contract/feed and diverges from the NQ Bookmap widget.
  latest[sym] = snap;
  bus.emit(`flow:${sym}`, snap);
}

// ── Hub → browser ───────────────────────────────────────────────────────────
export function flowLatest(sym: Sym): FlowSnapshot | null {
  return latest[sym];
}
export function onFlow(sym: Sym, fn: (snap: FlowSnapshot) => void): () => void {
  const key = `flow:${sym}`;
  bus.on(key, fn);
  return () => bus.off(key, fn);
}

// ── Lazy-activation: browser presence drives whether the worker should tail ───
export function flowBrowserConnected(): void {
  browsers++;
  if (browsers === 1) activeBus.emit('change', true);
}
export function flowBrowserDisconnected(): void {
  browsers = Math.max(0, browsers - 1);
  if (browsers === 0) {
    activeBus.emit('change', false);
    latest.NQ = null; latest.ES = null;   // drop stale reads; next viewer reseeds fresh
  }
}
export function flowActive(): boolean { return browsers > 0; }
export function onFlowActiveChange(fn: (active: boolean) => void): () => void {
  activeBus.on('change', fn);
  return () => activeBus.off('change', fn);
}
