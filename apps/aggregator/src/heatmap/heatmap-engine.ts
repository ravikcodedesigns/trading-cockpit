// Live order-book heatmap ENGINE (Bookmap-style) — the heavy firehose consumer.
//
// Tails the front-month NQ/ES Bookmap MBO capture .log directly (sub-second) and
// reconstructs a LEAN resting book from `depth` events alone — each `depth` event carries
// the ABSOLUTE size at a price level (size 0 = level gone), so we skip the far heavier
// mbo_send/replace/cancel stream that order-level engines need. On a fixed cadence we
// snapshot the book within a price band around mid into a compact "column", tag on the
// trades that printed in that interval (the volume dots), and hand it to a callback.
//
// ⚠️ RUN THIS IN A DEDICATED PROCESS (heatmap-worker.ts), NEVER in the aggregator: parsing
// two full-size contract firehoses synchronously starves whatever event loop it shares —
// which wedged the live aggregator once. The worker forwards columns to the aggregator,
// which only rings + fans them out (10/sec, trivial).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tailLog, type TailHandle, type LogEvent } from '../l3/log-tailer.js';
import type { Symbol as Sym, HeatmapColumn } from '@trading/contracts';

// ── Column geometry — shared with the aggregator hub (snapshot header) ─────────
export const HM_TICK = 0.25;    // price per price_int unit (NQ + ES both 0.25)
export const HM_BAND = 150;     // half-width of the band, in ticks (±37.5 pts)
export const HM_COL_MS = 100;   // column cadence — Bookmap-smooth

// ── Tunables ─────────────────────────────────────────────────────────────────
const CAPTURE_DIR = process.env.HEATMAP_CAPTURE_DIR ?? path.join(os.homedir(), 'cockpit-mbo-capture');
// Front-month BMD contract codes in the .log filename. Hardcoded like l3-book-worker —
// bump on the quarterly roll (U6 = Sep 2026). Full-size contracts (deeper book than micros).
const SUFFIX: Record<Sym, string> = { NQ: 'NQU6', ES: 'ESU6' };
const ROLL_CHECK_MS = 15_000;
const SYMBOLS: Sym[] = ['NQ', 'ES'];

interface SymEngine {
  sym: Sym;
  suffix: string;
  bids: Map<number, number>;         // price_int → resting size
  asks: Map<number, number>;
  trades: Map<number, number>;       // price_int → signed size accumulated this column (+buy / −sell)
  lastTs: number;                    // last event ts (real epoch ms)
  anchor: number | null;             // last good mid (price_int)
  tail: TailHandle | null;
  logPath: string | null;
}

type OnColumn = (sym: Sym, col: HeatmapColumn) => void;

const engines = new Map<Sym, SymEngine>();
let colTimer: NodeJS.Timeout | null = null;
let rollTimer: NodeJS.Timeout | null = null;
let sink: OnColumn = () => {};

// Newest .log for a contract suffix (glob + lexicographic-last = newest date). Mirrors
// l3-book-worker.liveLog so roll behaviour is identical.
function liveLog(suffix: string): string | null {
  let files: string[];
  try {
    files = fs.readdirSync(CAPTURE_DIR).filter((f) => f.includes(`-${suffix}_`) && f.endsWith('.log')).sort();
  } catch { return null; }
  const newest = files[files.length - 1];
  return newest ? path.join(CAPTURE_DIR, newest) : null;
}

function applyDepth(e: SymEngine, d: any): void {
  const p = d.price_int as number;
  const size = d.size as number;
  const map = d.is_bid ? e.bids : e.asks;
  if (size > 0) map.set(p, size);
  else map.delete(p);
}

function applyTrade(e: SymEngine, d: any): void {
  const size = d.size as number;
  if (!size || size <= 0) return;                     // execution-end markers carry size 0
  const p = d.price_int as number;
  const signed = d.is_bid_aggressor ? size : -size;   // +buy-aggressor / −sell-aggressor
  e.trades.set(p, (e.trades.get(p) ?? 0) + signed);
}

function dispatch(e: SymEngine, ev: LogEvent): void {
  e.lastTs = ev.ts_ms;
  if (ev.kind === 'depth') applyDepth(e, ev.data);
  else if (ev.kind === 'trade') applyTrade(e, ev.data);
  // mbo_send / mbo_replace / mbo_cancel deliberately ignored — depth events already carry
  // the absolute per-level size, which is all a heatmap needs.
}

function deriveAnchor(e: SymEngine): number | null {
  let bestBid = -Infinity, bestAsk = Infinity;
  for (const k of e.bids.keys()) if (k > bestBid) bestBid = k;
  for (const k of e.asks.keys()) if (k < bestAsk) bestAsk = k;
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestAsk <= bestBid) return e.anchor;
  return Math.round((bestBid + bestAsk) / 2);
}

function buildColumn(e: SymEngine): HeatmapColumn | null {
  const anchor = deriveAnchor(e);
  if (anchor == null) { e.trades.clear(); return null; }
  e.anchor = anchor;

  // Resting depth within the band — fixed 2·BAND+1 lookups, independent of book size.
  const s: number[] = [];
  for (let off = -HM_BAND; off <= HM_BAND; off++) {
    const p = anchor + off;
    const b = e.bids.get(p);
    if (b) { s.push(off, b); continue; }   // a price is bid XOR ask in a healthy book
    const a = e.asks.get(p);
    if (a) s.push(off, a);
  }

  // Trades this interval, clamped to the band.
  const x: number[] = [];
  if (e.trades.size) {
    for (const [p, ss] of e.trades) {
      const off = p - anchor;
      if (off >= -HM_BAND && off <= HM_BAND && ss !== 0) x.push(off, ss);
    }
    e.trades.clear();
  }

  // Column ts in SECONDS to match the candle time axis (real epoch, no TZ shift).
  return { t: e.lastTs / 1000, a: anchor, s, x };
}

function tick(): void {
  for (const e of engines.values()) {
    const col = buildColumn(e);
    if (col) sink(e.sym, col);
  }
}

function ensureTail(e: SymEngine): void {
  const latest = liveLog(e.suffix);
  if (!latest || latest === e.logPath) return;
  const firstAttach = e.logPath === null;
  if (e.tail) e.tail.stop();
  e.logPath = latest;
  // First attach: live tail from EOF (avoid replaying a multi-GB file). On roll: read the
  // new day's file from the start so we don't miss its head.
  e.tail = tailLog(latest, (ev) => dispatch(e, ev), { fromStart: !firstAttach });
}

// Start tailing + emitting columns via `onColumn`. Idempotent. Call stopHeatmapEngine() to
// halt and release the book (a later start reseeds fresh from EOF).
export function startHeatmapEngine(onColumn: OnColumn): void {
  sink = onColumn;
  if (colTimer) return;   // already running
  for (const sym of SYMBOLS) {
    engines.set(sym, {
      sym, suffix: SUFFIX[sym],
      bids: new Map(), asks: new Map(), trades: new Map(),
      lastTs: Date.now(), anchor: null, tail: null, logPath: null,
    });
    ensureTail(engines.get(sym)!);
  }
  colTimer = setInterval(tick, HM_COL_MS);
  rollTimer = setInterval(() => { for (const e of engines.values()) ensureTail(e); }, ROLL_CHECK_MS);
}

export function stopHeatmapEngine(): void {
  if (colTimer) { clearInterval(colTimer); colTimer = null; }
  if (rollTimer) { clearInterval(rollTimer); rollTimer = null; }
  for (const e of engines.values()) e.tail?.stop();
  engines.clear();
  sink = () => {};
}

export function heatmapEngineRunning(): boolean { return colTimer != null; }
