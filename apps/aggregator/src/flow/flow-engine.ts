// Live L3 order-flow ENGINE — the heavy MBO consumer behind the FLOW HUD.
//
// Tails the front-month NQ/ES Bookmap MBO .log (same source as the heatmap) and consumes the
// FULL order-level stream — mbo_send / mbo_replace / mbo_cancel plus attributed trades — into
// an OrderBook. It accumulates per-SECOND buckets (trades, buy/sell vol, msg count, sampled
// book imbalance), then once a second emits a FlowSnapshot carrying the same gauges aggregated
// over THREE trailing windows (1m / 5m / 15m) for a multi-timeframe confluence read.
//
// ⚠️ RUN THIS IN A DEDICATED PROCESS (flow-worker.ts), NEVER in the aggregator.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tailLog, type TailHandle, type LogEvent } from '../l3/log-tailer.js';
import { OrderBook } from '../l3/order-book.js';
import type { Symbol as Sym, FlowSnapshot, FlowWindow } from '@trading/contracts';

export const FLOW_MS = 1000;                  // emit cadence — 1/sec (windowed values are smooth)
// Each strip: [context window, delta sub-window] in seconds. imb/tps/mps average over the
// context window; the aggressor delta sums over the faster sub-window so it stays live.
export const FLOW_WINDOWS: Array<[number, number]> = [[60, 10], [300, 60], [900, 300]];
const MAX_WINDOW_SEC = 900;                   // retain this many seconds of buckets
// ± band for book imbalance, PER SYMBOL — the ES book is 5–10× thicker than NQ, so one flat band
// makes the two imbalance numbers incomparable. Same default until calibration says otherwise;
// env-tunable per symbol (FLOW_BAND_TICKS_NQ / FLOW_BAND_TICKS_ES).
const bandNum = (k: string, d: number): number => (process.env[k] != null ? Number(process.env[k]) : d);
export const FLOW_BAND_TICKS: Record<Sym, number> = {
  NQ: bandNum('FLOW_BAND_TICKS_NQ', 20),
  ES: bandNum('FLOW_BAND_TICKS_ES', 20),
};
const TICK = 0.25;                            // NQ + ES both 0.25

const CAPTURE_DIR = process.env.HEATMAP_CAPTURE_DIR ?? path.join(os.homedir(), 'cockpit-mbo-capture');
const SUFFIX: Record<Sym, string> = { NQ: 'NQU6', ES: 'ESU6' };  // front-month; bump on the roll
const ROLL_CHECK_MS = 15_000;
const SYMBOLS: Sym[] = ['NQ', 'ES'];

interface Bucket {
  sec: number;      // epoch second this bucket covers
  trades: number;   // trade prints
  buy: number;      // buy-aggressor volume
  sell: number;     // sell-aggressor volume
  msgs: number;     // mbo add/cancel/replace count
  imbSum: number;   // Σ sampled book imbalance (net contracts)
  imbN: number;     // # imbalance samples
}

interface SymEngine {
  sym: Sym;
  suffix: string;
  book: OrderBook;
  buckets: Bucket[];   // chronological, pruned to MAX_WINDOW_SEC
  lastTs: number;      // last event ts (real epoch ms)
  // RTH-anchored session CVD from the SAME BMD capture Bookmap uses (matches its Session CVD widget)
  rthCvd: number;      // net aggressor delta since 09:30 ET
  rthDate: string;     // ET date of the current session (YYYY-MM-DD)
  rthOpenMs: number;   // cached RTH window bounds (UTC ms)
  rthCloseMs: number;
  tail: TailHandle | null;
  logPath: string | null;
}

// RTH window (UTC ms) for the ET day of `tsMs`. EDT = UTC-4 (summer): 09:30 ET = 13:30 UTC.
function rthBoundsFor(tsMs: number): { open: number; close: number; date: string } {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(tsMs));
  const [y, m, d] = date.split('-').map(Number);
  return { open: Date.UTC(y!, m! - 1, d!, 13, 30, 0), close: Date.UTC(y!, m! - 1, d!, 20, 0, 0), date };
}

// Seed today's RTH BMD CVD by replaying the capture log [09:30 ET → now]. Runs once on first attach
// (so the value is complete even if FLOW is opened mid-session); ADDS to any live-accumulated delta.
function hydrateRthCvd(e: SymEngine, file: string): void {
  const now = Date.now();
  const bd = rthBoundsFor(now);
  if (now < bd.open) return;                       // pre-RTH: nothing to seed
  e.rthDate = bd.date; e.rthOpenMs = bd.open; e.rthCloseMs = bd.close;
  const upTo = Math.min(now, bd.close);
  let sum = 0, buf = '', stop = false;
  const s = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  s.on('data', (chunk) => {
    if (stop) return;
    buf += chunk; const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const line of lines) {
      const i = line.indexOf('"ts_ms":'); if (i < 0) continue;
      let j = i + 8, ds = ''; while (j < line.length) { const c = line[j]!; if (c >= '0' && c <= '9') ds += c; else if (ds) break; j++; }
      const ts = ds ? Number(ds) : NaN; if (!Number.isFinite(ts)) continue;
      if (ts < bd.open) continue;                  // cheap-skip pre-RTH (no JSON.parse)
      if (ts >= upTo) { stop = true; s.destroy(); return; }
      if (line.indexOf('"kind":"trade"') < 0) continue;
      let d: any; try { d = JSON.parse(line); } catch { continue; }
      const sz = d.data?.size; if (sz > 0) sum += d.data.is_bid_aggressor ? sz : -sz;
    }
  });
  s.on('close', () => { e.rthCvd += sum; });       // ADD (don't clobber live-since-attach)
  s.on('error', () => { /* leave live-only */ });
}

type OnSnapshot = (sym: Sym, snap: FlowSnapshot) => void;

const engines = new Map<Sym, SymEngine>();
let snapTimer: NodeJS.Timeout | null = null;
let rollTimer: NodeJS.Timeout | null = null;
let sink: OnSnapshot = () => {};

function liveLog(suffix: string): string | null {
  let files: string[];
  try {
    files = fs.readdirSync(CAPTURE_DIR).filter((f) => f.includes(`-${suffix}_`) && f.endsWith('.log')).sort();
  } catch { return null; }
  const newest = files[files.length - 1];
  return newest ? path.join(CAPTURE_DIR, newest) : null;
}

// Get (or start) the bucket for `sec`, pruning anything older than the max window.
function bucketFor(e: SymEngine, sec: number): Bucket {
  let last = e.buckets[e.buckets.length - 1];
  if (!last || last.sec !== sec) {
    last = { sec, trades: 0, buy: 0, sell: 0, msgs: 0, imbSum: 0, imbN: 0 };
    e.buckets.push(last);
    const cut = sec - MAX_WINDOW_SEC;
    let i = 0; while (i < e.buckets.length && e.buckets[i]!.sec < cut) i++;
    if (i) e.buckets.splice(0, i);
  }
  return last;
}

function dispatch(e: SymEngine, ev: LogEvent): void {
  e.lastTs = ev.ts_ms;
  const d = ev.data as any;
  const sec = Math.floor(ev.ts_ms / 1000);
  switch (ev.kind) {
    case 'depth':       e.book.applyDepth(d); break;
    case 'mbo_send':    e.book.applySend(d);    bucketFor(e, sec).msgs++; break;
    case 'mbo_replace': e.book.applyReplace(d); bucketFor(e, sec).msgs++; break;
    case 'mbo_cancel':  e.book.applyCancel(d);  bucketFor(e, sec).msgs++; break;
    case 'trade': {
      e.book.applyTrade(d);
      const size = d.size as number;
      if (size > 0) {
        const b = bucketFor(e, sec); b.trades++; if (d.is_bid_aggressor) b.buy += size; else b.sell += size;
        // RTH-anchored BMD session CVD (matches Bookmap): recompute bounds only when we leave the
        // cached window, reset on a new ET day, then accumulate aggressor delta inside RTH.
        const ts = ev.ts_ms;
        if (ts < e.rthOpenMs || ts >= e.rthCloseMs) {
          const bd = rthBoundsFor(ts);
          if (bd.date !== e.rthDate) { e.rthDate = bd.date; e.rthCvd = 0; }
          e.rthOpenMs = bd.open; e.rthCloseMs = bd.close;
        }
        if (ts >= e.rthOpenMs && ts < e.rthCloseMs) e.rthCvd += d.is_bid_aggressor ? size : -size;
      }
      break;
    }
  }
}

function aggregate(e: SymEngine, nowSec: number, ctxSec: number, deltaSec: number): FlowWindow {
  const ctxCut = nowSec - ctxSec;
  const dCut = nowSec - deltaSec;
  let trades = 0, msgs = 0, imbSum = 0, imbN = 0, dBuy = 0, dSell = 0;
  for (const b of e.buckets) {
    if (b.sec <= ctxCut) continue;
    trades += b.trades; msgs += b.msgs; imbSum += b.imbSum; imbN += b.imbN;
    if (b.sec > dCut) { dBuy += b.buy; dSell += b.sell; }   // delta only over the faster sub-window
  }
  // deltaPct = delta / total volume over the delta sub-window (−1..+1): the regime-comparable
  // read — a +300 delta means something different at the open (2% of tape) vs lunch (30%).
  const vol = dBuy + dSell;
  return {
    sec: ctxSec, deltaSec, imb: imbN ? imbSum / imbN : 0, delta: dBuy - dSell,
    deltaPct: vol > 0 ? (dBuy - dSell) / vol : 0, vol,
    tps: trades / ctxSec, mps: msgs / ctxSec,
  };
}

function tick(): void {
  for (const e of engines.values()) {
    const bbI = e.book.bestBid(), baI = e.book.bestAsk();
    if (bbI == null || baI == null) continue;   // book not seeded yet
    const now = e.lastTs || Date.now();
    const nowSec = Math.floor(now / 1000);

    // Sample the current book imbalance into this second's bucket (so the per-window imb is a
    // trailing average, not the instantaneous flicker).
    const mid = Math.round((bbI + baI) / 2);
    const band = FLOW_BAND_TICKS[e.sym];
    const imbNet = e.book.depthNear(mid, band, 'bid').size - e.book.depthNear(mid, band, 'ask').size;
    const b = bucketFor(e, nowSec); b.imbSum += imbNet; b.imbN++;

    sink(e.sym, {
      type: 'flow', symbol: e.sym, ts: now / 1000,
      bestBid: bbI * TICK, bestAsk: baI * TICK, spreadTicks: Math.round(baI - bbI),
      cvd: e.rthCvd, bandTicks: band,
      windows: FLOW_WINDOWS.map(([ctx, dlt]) => aggregate(e, nowSec, ctx, dlt)),
    });
  }
}

function ensureTail(e: SymEngine): void {
  const latest = liveLog(e.suffix);
  if (!latest || latest === e.logPath) return;
  const firstAttach = e.logPath === null;
  if (e.tail) e.tail.stop();
  e.logPath = latest;
  e.tail = tailLog(latest, (ev) => dispatch(e, ev), { fromStart: !firstAttach });
  if (firstAttach) hydrateRthCvd(e, latest);   // seed today's RTH BMD CVD (log has 09:30 ET → now)
}

export function startFlowEngine(onSnapshot: OnSnapshot): void {
  sink = onSnapshot;
  if (snapTimer) return;   // already running
  for (const sym of SYMBOLS) {
    engines.set(sym, {
      sym, suffix: SUFFIX[sym], book: new OrderBook(sym, TICK),
      buckets: [], lastTs: Date.now(), rthCvd: 0, rthDate: '', rthOpenMs: 0, rthCloseMs: 0, tail: null, logPath: null,
    });
    ensureTail(engines.get(sym)!);
  }
  snapTimer = setInterval(tick, FLOW_MS);
  rollTimer = setInterval(() => { for (const e of engines.values()) ensureTail(e); }, ROLL_CHECK_MS);
}

export function stopFlowEngine(): void {
  if (snapTimer) { clearInterval(snapTimer); snapTimer = null; }
  if (rollTimer) { clearInterval(rollTimer); rollTimer = null; }
  for (const e of engines.values()) e.tail?.stop();
  engines.clear();
  sink = () => {};
}

export function flowEngineRunning(): boolean { return snapTimer != null; }
