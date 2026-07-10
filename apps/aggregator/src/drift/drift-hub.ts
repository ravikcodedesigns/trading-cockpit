// Aggregator-side DRIFT hub — the light half of the net-drift HUD pipeline.
//
// The drift-worker polls the Quant Data net-drift API (SPX + NDX) every 60s, computes the
// cumulative filtered drift + 10-min slope, and forwards a DriftSnapshot per future. The hub
// keeps the latest per symbol, fans it out to browser subscribers, and tracks browser
// presence so the worker polls LAZILY (no API calls when nobody's watching). Mirrors
// flow-hub; drift is point-in-time so there's no ring — a new viewer gets the last snapshot.

import { EventEmitter } from 'node:events';
import type { Symbol as Sym, DriftSnapshot } from '@trading/contracts';

const latest: Record<Sym, DriftSnapshot | null> = { NQ: null, ES: null };
const bus = new EventEmitter();
bus.setMaxListeners(100);

let browsers = 0;
const activeBus = new EventEmitter();

// ── Worker → hub ────────────────────────────────────────────────────────────
export function ingestDrift(sym: Sym, snap: DriftSnapshot): void {
  latest[sym] = snap;
  bus.emit(`drift:${sym}`, snap);
}

// ── Hub → browser ───────────────────────────────────────────────────────────
export function driftLatest(sym: Sym): DriftSnapshot | null {
  return latest[sym];
}
export function onDrift(sym: Sym, fn: (snap: DriftSnapshot) => void): () => void {
  const key = `drift:${sym}`;
  bus.on(key, fn);
  return () => bus.off(key, fn);
}

// ── Lazy-activation: browser presence drives whether the worker should poll ───
export function driftBrowserConnected(): void {
  browsers++;
  if (browsers === 1) activeBus.emit('change', true);
}
export function driftBrowserDisconnected(): void {
  browsers = Math.max(0, browsers - 1);
  if (browsers === 0) activeBus.emit('change', false);
}
export function driftActive(): boolean { return browsers > 0; }
export function onDriftActiveChange(fn: (active: boolean) => void): () => void {
  activeBus.on('change', fn);
  return () => activeBus.off('change', fn);
}
