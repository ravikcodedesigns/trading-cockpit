// Aggregator-side heatmap hub — the LIGHT half of the heatmap pipeline.
//
// The heavy MBO tailing runs in a separate process (heatmap-worker.ts) which forwards
// built columns here (~10/sec). The hub just rings them per symbol, fans them out to
// browser subscribers, and tracks whether any browser is watching so the worker can tail
// LAZILY — idle when nobody's looking. No firehose parsing ever happens in this process.

import { EventEmitter } from 'node:events';
import type { Symbol as Sym, HeatmapColumn, HeatmapSnapshot } from '@trading/contracts';
import { HM_TICK, HM_BAND, HM_COL_MS } from './heatmap-engine.js';

const RING = 3000;       // retained per symbol (~5 min at 100ms)
const BACKFILL = 600;    // columns sent to a browser on connect (~60 s)

const rings: Record<Sym, HeatmapColumn[]> = { NQ: [], ES: [] };
const bus = new EventEmitter();
bus.setMaxListeners(100);

let browsers = 0;                       // live browser subscribers
const activeBus = new EventEmitter();   // fires 'change' when browsers crosses 0↔1

// ── Worker → hub ────────────────────────────────────────────────────────────
export function ingestColumn(sym: Sym, col: HeatmapColumn): void {
  const ring = rings[sym];
  ring.push(col);
  if (ring.length > RING) ring.splice(0, ring.length - RING);
  bus.emit(`col:${sym}`, col);
}

// ── Hub → browser ───────────────────────────────────────────────────────────
export function heatmapSnapshot(sym: Sym): HeatmapSnapshot {
  return { type: 'heatmap-snapshot', symbol: sym, tick: HM_TICK, band: HM_BAND, colMs: HM_COL_MS, cols: rings[sym].slice(-BACKFILL) };
}

export function onHeatmapColumn(sym: Sym, fn: (col: HeatmapColumn) => void): () => void {
  const key = `col:${sym}`;
  bus.on(key, fn);
  return () => bus.off(key, fn);
}

// ── Lazy-activation: browser presence drives whether the worker should tail ───
export function browserConnected(): void {
  browsers++;
  if (browsers === 1) activeBus.emit('change', true);
}
export function browserDisconnected(): void {
  browsers = Math.max(0, browsers - 1);
  if (browsers === 0) {
    activeBus.emit('change', false);
    rings.NQ.length = 0; rings.ES.length = 0;   // drop stale book; next viewer reseeds fresh
  }
}
export function heatmapActive(): boolean { return browsers > 0; }
export function onHeatmapActiveChange(fn: (active: boolean) => void): () => void {
  activeBus.on('change', fn);
  return () => activeBus.off('change', fn);
}
