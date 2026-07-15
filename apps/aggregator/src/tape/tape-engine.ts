// Live L3 TAPE event ENGINE — detects discrete order-flow events from the full MBO stream:
//
//   • block   — a single trade ≥ blockMinSize contracts.
//   • sweep   — one aggressor order taking ≥ sweepMinLevels price levels (or ≥ sweepMinSize
//               contracts) in a single execution burst (is_execution_start → _end).
//   • spoof   — a resting order ≥ spoofMinSize cancelled within spoofMaxLifeMs, never traded
//               (a fake wall pulled before it was hit).
//   • iceberg — a discrete hidden-liquidity EPISODE at one price+side: qualified by machine-latency
//               FILL-CONFIRMED refills, sized by traded − peak persistent displayed, resolved
//               held/broke when price leaves or trades through the level.
//
// Keeps only the light per-order state the detectors need (id → {ts, price, size, side, filled}),
// so it's cheaper than a full book. Runs in a DEDICATED process (tape-worker.ts).
//
// ── ALL DETECTION THRESHOLDS LIVE IN `TAPE_CFG` BELOW — tune them here. The cockpit also
//    filters what it DRAWS (per-kind + min-size) so density can be dialed live without a restart.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tailLog, type TailHandle, type LogEvent } from '../l3/log-tailer.js';
import { ofiStep, regress, type Quote } from '../l3/divergence.js';
import type { Symbol as Sym, TapeEvent } from '@trading/contracts';
import { TAPE_FLOORS } from '@trading/contracts';

// ── Detection config. The per-kind floors come from the SHARED `TAPE_FLOORS` (same values the
//    cockpit UI defaults + clamps to). Env vars can only be used to raise them for experiments.
const num = (k: string, d: number) => (process.env[k] != null ? Number(process.env[k]) : d);
export const TAPE_CFG = {
  block:   { minSize: num('TAPE_BLOCK_MIN', TAPE_FLOORS.block.size) },
  sweep:   { minLevels: num('TAPE_SWEEP_LEVELS', TAPE_FLOORS.sweep.levels), minSize: num('TAPE_SWEEP_MIN', TAPE_FLOORS.sweep.size), gapMs: num('TAPE_SWEEP_GAP_MS', 100) },
  spoof:   { minSize: num('TAPE_SPOOF_MIN', TAPE_FLOORS.spoof.size), maxLifeMs: num('TAPE_SPOOF_LIFE_MS', 4000) },
  // SYNTHETIC iceberg = a discrete EPISODE of hidden-liquidity defense at one price+side (NOT a
  // rolling metric, NOT session-cumulative). Two independent tests must both pass:
  //   QUALIFY — ≥ minRefills FILL-CONFIRMED machine-latency refills: a fresh order posted at the
  //             level within refillMs of the fill that depleted it, which then TRADED itself.
  //             (Posts pulled unfilled never count — that's spoof flicker, routed to the spoof
  //             detector. Independent traders don't re-post within refillMs of depletion; algos do.)
  //   SIZE    — hidden reserve = contracts traded at the level during the episode − the PEAK
  //             PERSISTENT displayed size there (depth must rest ≥ persistMs to count toward the
  //             peak, so flashed orders can't deflate the estimate). traded ≈ displayed ⇒ no fire.
  // LIFECYCLE — provisional 'active' emits while defended (throttled emitMs, anchored at episode
  // start so the marker never moves); ends HELD (price rejected ≥ leaveTicks away for leaveMs, or
  // idle idleMs with the level still standing) or BROKE (a print through the level). One marker
  // per episode, all emits share epId → store upserts, client replaces.
  iceberg: {
    refillMs: num('TAPE_ICE_REFILL_MS', 500),
    minRefills: num('TAPE_ICE_REFILLS', 4),
    // minHidden is PER-SYMBOL — episode hidden sizes scale with book thickness (a global 40
    // silences NQ entirely). Calibrated over 19 RTH parquet days (calibrate_tape.ts, episodic):
    //   NQ hidden p80=7  p95=20  p99=44  (4,684 refill-qualified episodes)
    //   ES hidden p80=15 p95=54  p99=123 (123,828)
    // hidden p50=0 on BOTH — half of refill-qualified episodes are fully-visible churn; the
    // hidden test is the real discriminator. Defaults ≈ p90 (interpolated).
    minHidden: {
      NQ: num('TAPE_ICE_HIDDEN_NQ', num('TAPE_ICE_HIDDEN', 12)),
      ES: num('TAPE_ICE_HIDDEN_ES', num('TAPE_ICE_HIDDEN', 30)),
    } as Record<Sym, number>,
    persistMs: num('TAPE_ICE_PERSIST_MS', 400),
    leaveTicks: num('TAPE_ICE_LEAVE_TICKS', 3),
    leaveMs: num('TAPE_ICE_LEAVE_MS', 15_000),
    // BROKE needs CONFIRMATION (symmetric with held) — a single print through the level is a
    // 1-tick sweep that often immediately fails (= the defense working, not breaking). Only call
    // broke when price gets ≥ breakTicks beyond the level, or sustains beyond it for breakMs.
    breakTicks: num('TAPE_ICE_BREAK_TICKS', 3),
    breakMs: num('TAPE_ICE_BREAK_MS', 4_000),
    idleMs: num('TAPE_ICE_IDLE_MS', 120_000),
    emitMs: num('TAPE_ICE_EMIT_MS', 750),   // live-update throttle: exec/queue/hidden changes re-push the marker
  },
  // NATIVE iceberg = a SINGLE order_id whose cumulative fills exceed the largest size it ever
  // displayed (hidden quantity behind the display), replenished under the same id. Distinct from
  // the price-level (cross-order_id) `iceberg` inference above — this one follows the parent order.
  icebergNative: { minHidden: num('TAPE_ICE_NAT_HIDDEN', 10), minCum: num('TAPE_ICE_NAT_CUM', TAPE_FLOORS.iceberg.size) },
  // Absorption = significant net order flow (|ΣOFI| ≥ minFlow) whose price impact (Kyle's λ,
  // sampled over a rolling best-quote window) has collapsed to ≤ `collapse` × its running
  // baseline. Built on the validated ofiStep/regress primitives (divergence.ts).
  absorption: {
    winMs: num('TAPE_ABS_WIN_MS', 4000),                       // rolling best-quote window
    minQuotes: num('TAPE_ABS_MIN_Q', 15),                      // need this many quote CHANGES in-window
    minFlow: num('TAPE_ABS_MIN_FLOW', TAPE_FLOORS.absorption.size), // |ΣOFI| effort floor
    collapse: num('TAPE_ABS_COLLAPSE', 0.4),                   // fire when λ ≤ collapse × baseline λ
    ewma: num('TAPE_ABS_EWMA', 0.03),                          // baseline-λ EWMA weight
    throttleMs: num('TAPE_ABS_THROTTLE', 4000),
  },
  // Stacked footprint imbalance: ≥ minLevels CONSECUTIVE price levels where the diagonal
  // buy/sell aggressor ratio ≥ `ratio` and the dominant side has ≥ minVol contracts — a wall
  // of one-directional aggression = continuation.
  stacked: {
    ratio: num('TAPE_STACK_RATIO', 3.0),
    minLevels: num('TAPE_STACK_LEVELS', TAPE_FLOORS.stacked.levels),
    minVol: num('TAPE_STACK_MINVOL', TAPE_FLOORS.stacked.size),
    winMs: num('TAPE_STACK_WIN_MS', 90_000),
    throttleMs: num('TAPE_STACK_THROTTLE', 5_000),
  },
  // Wall hold/break: a resting level whose peak size ≥ minSize, that absorbs ≥ minHitVol of
  // trades, then either HOLDS (still ≥ holdFrac of peak + book rejects away) or BREAKS
  // (depleted ≤ breakFrac of peak + book crosses through it).
  wall: {
    minSize: num('TAPE_WALL_MIN', TAPE_FLOORS.wall.size),
    nearTicks: num('TAPE_WALL_NEAR', 40),        // only track walls within N ticks of touch (memory)
    minHitVol: num('TAPE_WALL_HIT', 40),         // must absorb ≥ this traded vol to count as tested
    breakFrac: num('TAPE_WALL_BREAK_FRAC', 0.2),
    holdFrac: num('TAPE_WALL_HOLD_FRAC', 0.5),
    rejectTicks: num('TAPE_WALL_REJECT', 6),     // book must move away N ticks to confirm a hold
    throttleMs: num('TAPE_WALL_THROTTLE', 8_000),
  },
  // Unfinished auction: a window extreme whose extreme level printed one-sided (opposite-side
  // volume ≤ maxOpp), with dominant vol ≥ minVol, after price reversed ≥ reverseTicks away.
  unfinished: {
    maxOpp: num('TAPE_UNF_MAX_OPP', 2),
    minVol: num('TAPE_UNF_MINVOL', TAPE_FLOORS.unfinished.size),
    reverseTicks: num('TAPE_UNF_REVERSE', 8),
    winMs: num('TAPE_UNF_WIN_MS', 90_000),
    throttleMs: num('TAPE_UNF_THROTTLE', 10_000),
  },
  // Trapped traders: a one-sided aggressor burst ≥ minBurst near a window extreme, that price
  // then reversed through by ≥ trapTicks within windowMs — the burst is offside and will puke.
  trapped: {
    minBurst: num('TAPE_TRAP_BURST', TAPE_FLOORS.trapped.size),
    burstMs: num('TAPE_TRAP_BURST_MS', 3_000),
    trapTicks: num('TAPE_TRAP_TICKS', 12),
    windowMs: num('TAPE_TRAP_WIN_MS', 20_000),
    throttleMs: num('TAPE_TRAP_THROTTLE', 10_000),
  },
  // Confluence: ≥ minKinds DISTINCT tape+flow signals aligning within `zoneTicks` and `winMs`.
  // Each distinct signal type contributes its weight ONCE (spam-proof); flow = rolling aggressor
  // delta sign + near-touch book-imbalance sign. Fires when the net directional score ≥ minScore.
  confluence: {
    winMs: num('TAPE_CONF_WIN_MS', 25_000),
    zoneTicks: num('TAPE_CONF_ZONE', 8),
    minScore: num('TAPE_CONF_MIN', TAPE_FLOORS.confluence.size),
    minKinds: num('TAPE_CONF_MIN_KINDS', 3),   // need ≥3 DISTINCT signals — kills iceberg+flow noise
    flowW: num('TAPE_CONF_FLOW_W', 1.5), flowMin: num('TAPE_CONF_FLOW_MIN', 80),   // aggressor-delta push
    imbW: num('TAPE_CONF_IMB_W', 1), imbMin: num('TAPE_CONF_IMB_MIN', 150),        // book-imbalance stack
    throttleMs: num('TAPE_CONF_THROTTLE', 20_000),
  },
  orderTtlMs: 20 * 60_000,   // drop tracked resting orders older than this (memory guard)
};
// Per-signal confluence weights (which discrete kinds count + how much). spoof/unfinished excluded.
const CONF_W: Record<string, number> = { iceberg: 2, absorption: 2, wall: 2, stacked: 1.5, sweep: 1.5, trapped: 1.5, block: 1 };
export const TICK = 0.25;
const ABS_TICK_MS = 100;    // best-quote sampling cadence for the absorption detector
const FOOT_TICK_MS = 500;   // footprint/wall evaluation cadence (stacked / unfinished / trapped / wall)
const TRADE_WIN_MS = 90_000; // rolling trade deque span (≥ the widest footprint window above)

const CAPTURE_DIR = process.env.HEATMAP_CAPTURE_DIR ?? path.join(os.homedir(), 'cockpit-mbo-capture');
const SUFFIX: Record<Sym, string> = { NQ: 'NQU6', ES: 'ESU6' };  // front-month; bump on the roll
const ROLL_CHECK_MS = 15_000;
const PRUNE_MS = 60_000;
const SYMBOLS: Sym[] = ['NQ', 'ES'];

interface Ord { ts: number; p: number; disp: number; bid: boolean; cf: number; }   // cf = cumulative filled
interface Sweep { dir: number; prices: Set<number>; size: number; lastTs: number; lastPrice: number; }

// One SYNTHETIC-iceberg episode (price+side). All emits share `id` so downstream replaces.
interface IceEp {
  id: string;
  pi: number; bid: boolean;
  t0: number;              // episode start = first qualifying refill post (marker anchor)
  traded: number;          // passive contracts filled at the level (this side) during the episode
  refills: number;         // FILL-CONFIRMED refills only
  pending: Map<string, number>;  // refill order_id → size, posted but not yet traded (pulled ⇒ never counted);
                                 // Σ values = the QUEUE: contracts replenished and waiting to execute
  dispCur: number;         // current displayed size at the level (from depth)
  dispSince: number;       // when dispCur last changed — persistence gate for the peak
  peakDisp: number;        // peak PERSISTENT displayed size during the episode
  awaySince: number;       // ts price first seen ≥ leaveTicks away on the defended side (0 = at level)
  pierceSince: number;     // ts price first seen through the level on the attack side (0 = not pierced)
  lastFillTs: number;      // last passive fill at the level
  emitted: boolean;        // provisional 'active' has been emitted (episode qualified)
  lastEmit: number;
  lastEmitSize: number;    // high-water hidden already emitted (marker size is monotone)
  lastEmitExec: number;    // exec/queue at last emit — re-emit when EITHER changes (live tape)
  lastEmitQ: number;
}
const epKey = (pi: number, bid: boolean): string => `${pi}|${bid ? 1 : 0}`;

interface SymEngine {
  sym: Sym;
  suffix: string;
  orders: Map<string, Ord>;               // live resting orders we've seen the send for
  recentFill: Map<number, { ts: number; bid: boolean }>;  // price_int → last full passive fill (arms refill detection)
  iceEps: Map<string, IceEp>;             // epKey(price,side) → open synthetic-iceberg episode
  refillWait: Map<string, string>;        // refill order_id → epKey (fill-confirmation routing)
  // native-iceberg tracking: per order_id, largest displayed size vs cumulative filled
  native: Map<string, { p: number; bid: boolean; maxDisp: number; cf: number; t0: number; ts: number; emitted: number }>;
  sweep: Sweep | null;                    // current aggressor execution group
  // ── absorption state: L2 best-quote + rolling OFI/Δmid window + baseline λ
  bidSz: Map<number, number>;             // price_int → size (from depth), for best-quote
  askSz: Map<number, number>;
  lastQ: Quote | null;                    // previous best-quote sample
  absWin: { ts: number; ofi: number; dmid: number }[];  // rolling OFI-step + Δmid window
  lamBase: number;                        // EWMA baseline of Kyle's λ (normal price impact)
  lamSeen: boolean;
  lastAbsTs: number;
  // ── footprint reads (stacked / unfinished / trapped): rolling classified-trade deque
  trades: { ts: number; pi: number; buy: boolean; size: number }[];
  lastTradePi: number;                    // last traded price_int (current-price proxy)
  // ── wall hold/break: tracked large resting levels
  walls: Map<number, { bid: boolean; peak: number; cur: number; hitVol: number; ts: number; fired: boolean }>;
  stackGuard: { ts: number; key: string };   // per-detector throttle (time + zone key)
  unfGuard: { ts: number; key: string };
  trapGuard: { ts: number; key: string };
  // confluence: rolling buffer of recent directional tape signals + per-zone throttle
  confWin: { ts: number; pi: number; dir: number; kind: string }[];
  lastConf: Map<string, number>;
  lastTs: number;
  tail: TailHandle | null;
  logPath: string | null;
}

type OnEvent = (sym: Sym, ev: TapeEvent) => void;

const engines = new Map<Sym, SymEngine>();
let rollTimer: NodeJS.Timeout | null = null;
let pruneTimer: NodeJS.Timeout | null = null;
let absTimer: NodeJS.Timeout | null = null;
let footTimer: NodeJS.Timeout | null = null;
let running = false;
let sink: OnEvent = () => {};

function liveLog(suffix: string): string | null {
  let files: string[];
  try { files = fs.readdirSync(CAPTURE_DIR).filter((f) => f.includes(`-${suffix}_`) && f.endsWith('.log')).sort(); }
  catch { return null; }
  const newest = files[files.length - 1];
  return newest ? path.join(CAPTURE_DIR, newest) : null;
}

function emit(e: SymEngine, ev: TapeEvent): void {
  sink(e.sym, ev);
  const w = CONF_W[ev.kind];
  if (w != null) feedConfluence(e, Math.round(ev.price / TICK), ev.side === 'buy' ? 1 : -1, ev.kind, ev.t * 1000);
}

// Near-touch book imbalance (contracts): Σ bid sizes within `ticks` of best bid − Σ ask sizes
// within `ticks` of best ask. >0 = bid-stacked (bullish lean).
function nearImbalance(e: SymEngine, ticks: number): number {
  const bbI = bestBidInt(e), baI = bestAskInt(e);
  if (bbI == null || baI == null) return 0;
  let bid = 0, ask = 0;
  for (const [k, s] of e.bidSz) if (k <= bbI && k >= bbI - ticks) bid += s;
  for (const [k, s] of e.askSz) if (k >= baI && k <= baI + ticks) ask += s;
  return bid - ask;
}

// A contributing tape signal just fired → record it, then re-evaluate confluence at its price zone.
function feedConfluence(e: SymEngine, pi: number, dir: number, kind: string, ts: number): void {
  const C = TAPE_CFG.confluence;
  e.confWin.push({ ts, pi, dir, kind });
  let cut = 0; while (cut < e.confWin.length && e.confWin[cut]!.ts < ts - C.winMs) cut++; if (cut) e.confWin.splice(0, cut);

  // Distinct signal types in this price zone (each kind counts ONCE, latest direction wins).
  const kd = new Map<string, number>();
  for (const c of e.confWin) if (Math.abs(c.pi - pi) <= C.zoneTicks) kd.set(c.kind, c.dir);
  let bull = 0, bear = 0, bullN = 0, bearN = 0; const sigs: string[] = [];
  for (const [k, d] of kd) { const w = CONF_W[k] ?? 0; if (d > 0) { bull += w; bullN++; } else { bear += w; bearN++; } sigs.push((d > 0 ? '+' : '-') + k); }

  // Flow signals: rolling aggressor delta + near-touch book imbalance.
  let delta = 0; const from = ts - C.winMs;
  for (let i = e.trades.length - 1; i >= 0; i--) { const t = e.trades[i]!; if (t.ts < from) break; delta += t.buy ? t.size : -t.size; }
  if (Math.abs(delta) >= C.flowMin) { if (delta > 0) { bull += C.flowW; bullN++; } else { bear += C.flowW; bearN++; } sigs.push((delta > 0 ? '+' : '-') + 'flow'); }
  const imb = nearImbalance(e, C.zoneTicks);
  if (Math.abs(imb) >= C.imbMin) { if (imb > 0) { bull += C.imbW; bullN++; } else { bear += C.imbW; bearN++; } sigs.push((imb > 0 ? '+' : '-') + 'imb'); }

  const net = bull - bear, dirC = net > 0 ? 1 : -1, score = Math.abs(net);
  const nKinds = dirC > 0 ? bullN : bearN;
  if (score < C.minScore || nKinds < C.minKinds) return;
  const key = dirC + ':' + Math.floor(pi / C.zoneTicks);
  if (ts - (e.lastConf.get(key) ?? -Infinity) < C.throttleMs) return;
  e.lastConf.set(key, ts);
  const aligned = sigs.filter((s) => (s[0] === '+') === (dirC > 0));
  sink(e.sym, { t: ts / 1000, kind: 'confluence', price: pi * TICK, side: dirC > 0 ? 'buy' : 'sell', size: +score.toFixed(1), levels: nKinds, signals: aligned.map((s) => s.slice(1)) });
}

function dispatch(e: SymEngine, evt: LogEvent): void {
  e.lastTs = evt.ts_ms;
  const d = evt.data as any;
  const ts = evt.ts_ms;
  switch (evt.kind) {
    case 'mbo_send': {
      e.orders.set(d.order_id, { ts, p: d.price_int, disp: d.size, bid: !!d.is_bid, cf: 0 });
      e.native.set(d.order_id, { p: d.price_int, bid: !!d.is_bid, maxDisp: d.size, cf: 0, t0: ts, ts, emitted: 0 });
      // iceberg (SYNTHETIC): a fresh post at a price+side whose display was JUST fully consumed,
      // within refillMs of that fill = machine-latency refill. It only COUNTS once it trades
      // (fill-confirmed) — until then it sits in `pending`, and a pull removes it (spoof flicker).
      // NOTE: native icebergs replenish under the SAME order_id (no new send), so they never feed
      // this path — the two detectors are structurally disjoint.
      const ff = e.recentFill.get(d.price_int);
      if (ff && ff.bid === !!d.is_bid && ts - ff.ts <= TAPE_CFG.iceberg.refillMs) {
        const key = epKey(d.price_int, !!d.is_bid);
        let ep = e.iceEps.get(key);
        if (!ep) {
          ep = {
            id: `${e.sym}-${d.price_int}-${d.is_bid ? 'b' : 'a'}-${ts}`,
            pi: d.price_int, bid: !!d.is_bid, t0: ts,
            traded: 0, refills: 0, pending: new Map(),
            dispCur: (d.is_bid ? e.bidSz : e.askSz).get(d.price_int) ?? 0, dispSince: ts, peakDisp: 0,
            awaySince: 0, pierceSince: 0, lastFillTs: ts, emitted: false, lastEmit: 0, lastEmitSize: 0, lastEmitExec: 0, lastEmitQ: 0,
          };
          e.iceEps.set(key, ep);
        }
        ep.pending.set(d.order_id, d.size);
        e.refillWait.set(d.order_id, key);
        maybeEmitIceEp(e, ep, ts);   // queue grew → live-update the marker (Q flashes as the reload posts)
      }
      break;
    }
    case 'mbo_replace': {
      const o = e.orders.get(d.order_id);
      if (o) { o.p = d.price_int; o.disp = d.size; }
      const nv = e.native.get(d.order_id);
      if (nv) { if (d.size > nv.maxDisp) nv.maxDisp = d.size; nv.p = d.price_int; nv.bid = !!d.is_bid; nv.ts = ts; }
      break;
    }
    case 'mbo_cancel': {
      const o = e.orders.get(d.order_id);
      if (o) {
        // spoof: big order pulled quickly, never traded
        if (o.cf === 0 && o.disp >= TAPE_CFG.spoof.minSize && ts - o.ts <= TAPE_CFG.spoof.maxLifeMs) {
          emit(e, { t: ts / 1000, kind: 'spoof', price: o.p * TICK, side: o.bid ? 'buy' : 'sell', size: o.disp, lifeMs: ts - o.ts });
        }
        e.orders.delete(d.order_id);
      }
      e.native.delete(d.order_id);
      // a pending refill pulled before trading = flicker, never a refill
      const wk = e.refillWait.get(d.order_id);
      if (wk) {
        e.refillWait.delete(d.order_id);
        const iep = e.iceEps.get(wk);
        if (iep && iep.pending.delete(d.order_id)) maybeEmitIceEp(e, iep, ts);   // queue shrank → live-update
      }
      break;
    }
    case 'trade': {
      const size = d.size as number;
      const buy = !!d.is_bid_aggressor;
      // footprint deque (stacked / unfinished / trapped) + current-price proxy
      if (size > 0) {
        e.trades.push({ ts, pi: d.price_int, buy, size });
        e.lastTradePi = d.price_int;
        const w = e.walls.get(d.price_int);
        if (w) w.hitVol += size;   // trades printing at a tracked wall = aggression tested against it
      }
      // block
      if (size > 0 && size >= TAPE_CFG.block.minSize) {
        emit(e, { t: ts / 1000, kind: 'block', price: d.price, side: buy ? 'buy' : 'sell', size });
      }
      // SYNTHETIC-iceberg episode accumulation: every passive fill at an open episode's level
      // (passive side = opposite of the aggressor) grows `traded`; a fill of a pending refill
      // order CONFIRMS that refill. Emits/updates the provisional 'active' marker when qualified.
      if (size > 0) {
        const ep = e.iceEps.get(epKey(d.price_int, !buy));
        if (ep) {
          ep.traded += size; ep.lastFillTs = ts;
          if (d.passive_order_id && ep.pending.has(d.passive_order_id)) {
            ep.pending.delete(d.passive_order_id);
            e.refillWait.delete(d.passive_order_id);
            ep.refills++;
          }
          maybeEmitIceEp(e, ep, ts);
        }
      }
      // passive fill bookkeeping (arms iceberg refill detection)
      if (size > 0 && d.passive_order_id) {
        const o = e.orders.get(d.passive_order_id);
        if (o) {
          o.cf += size;
          if (o.disp <= size) { e.recentFill.set(o.p, { ts, bid: o.bid }); e.orders.delete(d.passive_order_id); }
          else o.disp -= size;
        }
        // iceberg (NATIVE): this one order_id has now been filled beyond the largest size it ever
        // displayed → there was hidden quantity behind the display. Re-fires as it keeps reloading;
        // all fires share an epId (the order_id) so downstream keeps ONE marker per parent order.
        const nv = e.native.get(d.passive_order_id);
        if (nv) {
          nv.cf += size; nv.ts = ts;
          const N = TAPE_CFG.icebergNative;
          if (nv.cf - nv.maxDisp >= N.minHidden && nv.cf - nv.emitted >= N.minCum) {
            nv.emitted = nv.cf;
            emit(e, {
              t: nv.t0 / 1000, kind: 'iceberg', price: nv.p * TICK, side: nv.bid ? 'buy' : 'sell',
              size: nv.cf, refills: Math.max(1, Math.round(nv.cf / Math.max(1, nv.maxDisp))), durMs: ts - nv.t0, native: true,
              epId: `${e.sym}-n-${d.passive_order_id}`,
            });
          }
        }
      }
      // SWEEP = a fast RUN of same-direction aggressor trades walking through ≥ minLevels distinct
      // price levels (Bookmap execution_start/end delimit single-price fills, so the old grouping
      // never fired). A run extends while same side + within gapMs; it closes (and emits if it
      // spanned enough levels) when the next trade breaks it (side flip or a gap).
      if (size > 0) {
        const S = TAPE_CFG.sweep, dir = buy ? 1 : -1;
        const closeRun = () => {
          const r = e.sweep;
          if (r && r.prices.size >= S.minLevels && r.size >= S.minSize) {
            emit(e, { t: r.lastTs / 1000, kind: 'sweep', price: r.lastPrice, side: r.dir > 0 ? 'buy' : 'sell', size: r.size, levels: r.prices.size });
          }
        };
        if (e.sweep && e.sweep.dir === dir && ts - e.sweep.lastTs <= S.gapMs) {
          e.sweep.prices.add(d.price_int); e.sweep.size += size; e.sweep.lastTs = ts; e.sweep.lastPrice = d.price;
        } else {
          closeRun();
          e.sweep = { dir, prices: new Set([d.price_int]), size, lastTs: ts, lastPrice: d.price };
        }
      }
      break;
    }
    case 'depth': {   // maintain the L2 best-quote (absorption) + track large resting walls
      const map = d.is_bid ? e.bidSz : e.askSz;
      const sz = d.size as number;
      if (!sz) map.delete(d.price_int); else map.set(d.price_int, sz);
      // iceberg episode: track PEAK PERSISTENT displayed at the level — the outgoing value counts
      // toward the peak only if it rested ≥ persistMs (flashed size never deflates the hidden estimate)
      const iep = e.iceEps.get(epKey(d.price_int, !!d.is_bid));
      if (iep) {
        if (ts - iep.dispSince >= TAPE_CFG.iceberg.persistMs && iep.dispCur > iep.peakDisp) iep.peakDisp = iep.dispCur;
        iep.dispCur = sz; iep.dispSince = ts;
      }
      // wall tracking: register/update levels whose size is (or was) ≥ minSize, near touch
      const W = TAPE_CFG.wall;
      const w = e.walls.get(d.price_int);
      if (w) {
        w.cur = sz;
        if (sz > w.peak) w.peak = sz;
      } else if (sz >= W.minSize) {
        const bbI = bestBidInt(e), baI = bestAskInt(e);
        const ref = d.is_bid ? bbI : baI;   // distance to the touch on this side
        if (ref == null || Math.abs(d.price_int - ref) <= W.nearTicks) {
          e.walls.set(d.price_int, { bid: !!d.is_bid, peak: sz, cur: sz, hitVol: 0, ts, fired: false });
        }
      }
      break;
    }
  }
}

// Best bid/ask (+ sizes) from the L2 maps → a Quote for OFI. Null until the book seeds.
function bestQuote(e: SymEngine): Quote | null {
  let bbI = -Infinity, baI = Infinity;
  for (const k of e.bidSz.keys()) if (k > bbI) bbI = k;
  for (const k of e.askSz.keys()) if (k < baI) baI = k;
  if (!Number.isFinite(bbI) || !Number.isFinite(baI) || baI <= bbI) return null;
  return { bidPx: bbI * TICK, bidSz: e.bidSz.get(bbI)!, askPx: baI * TICK, askSz: e.askSz.get(baI)! };
}

// Sampled every ABS_TICK_MS: push the OFI/Δmid step, roll the window, and fire an absorption
// event when significant net flow shows collapsed price impact vs the running baseline λ.
function absorptionTick(): void {
  const A = TAPE_CFG.absorption;
  for (const e of engines.values()) {
    const q = bestQuote(e);
    if (!q) continue;
    const now = e.lastTs || Date.now();
    if (e.lastQ) {
      const p = e.lastQ;
      const changed = q.bidPx !== p.bidPx || q.bidSz !== p.bidSz || q.askPx !== p.askPx || q.askSz !== p.askSz;
      // Only sample real best-quote CHANGES — zero-flow ticks poison the λ regression.
      if (!changed) continue;
      const mid = (x: Quote) => (x.bidPx + x.askPx) / 2;
      e.absWin.push({ ts: now, ofi: ofiStep(e.lastQ, q), dmid: mid(q) - mid(e.lastQ) });
      let cut = 0; while (cut < e.absWin.length && e.absWin[cut]!.ts < now - A.winMs) cut++; if (cut) e.absWin.splice(0, cut);
      if (e.absWin.length >= A.minQuotes) {
        const lam = regress(e.absWin.map((w) => w.ofi), e.absWin.map((w) => w.dmid));
        if (lam) {
          const cumOFI = e.absWin.reduce((s, w) => s + w.ofi, 0);
          // Absorption: enough net directional flow, price impact collapsed below baseline
          // (near-zero OR negative λ — price pinned/reversing under the flow), throttled.
          if (e.lamSeen && Math.abs(cumOFI) >= A.minFlow && lam.lambda <= A.collapse * e.lamBase && now - e.lastAbsTs >= A.throttleMs) {
            e.lastAbsTs = now;
            emit(e, {
              t: now / 1000, kind: 'absorption', price: mid(q),
              side: cumOFI > 0 ? 'sell' : 'buy',        // buy flow absorbed → SELLER defends (bearish) → 'sell'
              size: Math.round(Math.abs(cumOFI)), lamRatio: +(lam.lambda / e.lamBase).toFixed(2),
            });
          }
          // Baseline tracks NORMAL impact only — never poison it with the collapsed/negative λ.
          if (lam.lambda > 0) {
            e.lamBase = e.lamSeen ? e.lamBase + A.ewma * (lam.lambda - e.lamBase) : lam.lambda;
            e.lamSeen = true;
          }
        }
      }
    }
    e.lastQ = q;
  }
}

function bestBidInt(e: SymEngine): number | null { let b = -Infinity; for (const k of e.bidSz.keys()) if (k > b) b = k; return Number.isFinite(b) ? b : null; }
function bestAskInt(e: SymEngine): number | null { let a = Infinity; for (const k of e.askSz.keys()) if (k < a) a = k; return Number.isFinite(a) ? a : null; }

// Throttle a detector: fire only if the zone key changed or `ms` elapsed since the last fire.
function passGuard(g: { ts: number; key: string }, now: number, key: string, ms: number): boolean {
  if (g.key === key && now - g.ts < ms) return false;
  g.ts = now; g.key = key; return true;
}

// Hidden reserve right now: traded during the episode − peak persistent displayed. Promote the
// current display into the peak first if it has rested long enough.
function iceHidden(ep: IceEp, ts: number): number {
  if (ts - ep.dispSince >= TAPE_CFG.iceberg.persistMs && ep.dispCur > ep.peakDisp) { ep.peakDisp = ep.dispCur; ep.dispSince = ts; }
  return Math.max(0, ep.traded - ep.peakDisp);
}

// Provisional 'active' emit — fires once qualified (both tests), then re-emits (same epId) LIVE
// as the tape hits the level: any change in executed, queued, or hidden re-pushes the marker,
// throttled to emitMs. Marker size = high-water hidden (monotone — the marker never shrinks).
// Anchored at ep.t0 so the marker never moves off its origin bar.
function maybeEmitIceEp(e: SymEngine, ep: IceEp, ts: number): void {
  const I = TAPE_CFG.iceberg;
  if (ep.refills < I.minRefills) return;
  const hi = Math.max(iceHidden(ep, ts), ep.lastEmitSize);
  if (hi < I.minHidden[e.sym]) return;
  let q = 0; for (const sz of ep.pending.values()) q += sz;
  if (ep.emitted && (ts - ep.lastEmit < I.emitMs ||
    (hi <= ep.lastEmitSize && ep.traded === ep.lastEmitExec && q === ep.lastEmitQ))) return;
  ep.emitted = true; ep.lastEmit = ts; ep.lastEmitSize = hi; ep.lastEmitExec = ep.traded; ep.lastEmitQ = q;
  emit(e, {
    t: ep.t0 / 1000, kind: 'iceberg', price: ep.pi * TICK, side: ep.bid ? 'buy' : 'sell',
    size: hi, refills: ep.refills, durMs: ts - ep.t0, native: false, state: 'active', epId: ep.id,
    exec: ep.traded, queueCt: q, lastFillT: ep.lastFillTs / 1000,
  });
}

// Resolve open episodes against the current print: BROKE only on a CONFIRMED trade-through
// (≥ breakTicks beyond the level, or sustained beyond for breakMs — a 1-tick sweep that snaps
// back is the defense WORKING and keeps the episode alive), HELD once price rejects ≥ leaveTicks
// away for leaveMs (grace window — a brief 1-tick bounce doesn't end it), or on idle with the
// level still standing. Episodes that never qualified die silently; qualified ones get their
// final (same-epId) outcome emit.
function resolveIceEps(e: SymEngine, now: number): void {
  if (!e.iceEps.size) return;
  const I = TAPE_CFG.iceberg;
  const cur = e.lastTradePi;
  for (const [key, ep] of e.iceEps) {
    if (cur) {
      const beyond = ep.bid ? ep.pi - cur : cur - ep.pi;   // >0 = price through the level (attack side)
      if (beyond > 0) {
        if (beyond >= I.breakTicks) { endIceEp(e, key, ep, now, 'broke'); continue; }
        if (!ep.pierceSince) ep.pierceSince = now;
        else if (now - ep.pierceSince >= I.breakMs) { endIceEp(e, key, ep, now, 'broke'); continue; }
        ep.awaySince = 0;
        continue;   // pierced but unconfirmed — neither held-clock nor idle should run
      }
      ep.pierceSince = 0;
      const away = ep.bid ? cur - ep.pi : ep.pi - cur;
      if (away >= I.leaveTicks) {
        if (!ep.awaySince) ep.awaySince = now;
        if (now - ep.awaySince >= I.leaveMs) { endIceEp(e, key, ep, now, 'held'); continue; }
      } else ep.awaySince = 0;
    }
    if (now - Math.max(ep.lastFillTs, ep.t0) >= I.idleMs) endIceEp(e, key, ep, now, 'held');
  }
}

function endIceEp(e: SymEngine, key: string, ep: IceEp, now: number, state: 'held' | 'broke'): void {
  e.iceEps.delete(key);
  for (const id of ep.pending.keys()) e.refillWait.delete(id);
  if (!ep.emitted) return;   // never qualified — no marker to finalize
  // Final size = HIGH-WATER hidden, not hidden-at-close: a large display arriving late in the
  // episode raises peakDisp and can drag current hidden below the floor it qualified at — the
  // reserve that WAS revealed doesn't un-happen. lastEmitSize is the high-water already emitted.
  emit(e, {
    t: ep.t0 / 1000, kind: 'iceberg', price: ep.pi * TICK, side: ep.bid ? 'buy' : 'sell',
    size: Math.max(iceHidden(ep, now), ep.lastEmitSize), refills: ep.refills, durMs: now - ep.t0, native: false, state, epId: ep.id,
    exec: ep.traded, queueCt: 0, lastFillT: ep.lastFillTs / 1000,   // resolved: nothing left queued
  });
}

// Evaluated every FOOT_TICK_MS: builds the rolling footprint and runs the price-action reads
// (stacked imbalance, unfinished auction, trapped traders) + resolves tracked walls + episodes.
function footprintTick(): void {
  for (const e of engines.values()) {
    const now = e.lastTs;
    if (!now || !e.trades.length) { resolveWalls(e, now || 0); continue; }
    // prune the deque to the widest window
    let cut = 0; while (cut < e.trades.length && e.trades[cut]!.ts < now - TRADE_WIN_MS) cut++;
    if (cut) e.trades.splice(0, cut);

    detectStacked(e, now);
    detectUnfinished(e, now);
    detectTrapped(e, now);
    resolveWalls(e, now);
    resolveIceEps(e, now);
  }
}

// Footprint over [now-winMs, now]: price_int → {buy = lifted-offer (ask col), sell = hit-bid (bid col)}.
function footprint(e: SymEngine, now: number, winMs: number): Map<number, { buy: number; sell: number }> {
  const fp = new Map<number, { buy: number; sell: number }>();
  const from = now - winMs;
  for (const t of e.trades) {
    if (t.ts < from) continue;
    let c = fp.get(t.pi); if (!c) { c = { buy: 0, sell: 0 }; fp.set(t.pi, c); }
    if (t.buy) c.buy += t.size; else c.sell += t.size;
  }
  return fp;
}

// STACKED IMBALANCE — ≥ minLevels consecutive levels where the DIAGONAL aggressor ratio ≥ `ratio`.
//   buy imbalance at P:  buy[P] (ask col) ≥ ratio × sell[P-1] (bid col one tick below), buy[P] ≥ minVol
//   sell imbalance at P: sell[P] (bid col) ≥ ratio × buy[P+1] (ask col one tick above), sell[P] ≥ minVol
function detectStacked(e: SymEngine, now: number): void {
  const C = TAPE_CFG.stacked;
  const fp = footprint(e, now, C.winMs);
  if (fp.size < C.minLevels) return;
  const prices = [...fp.keys()].sort((a, b) => a - b);
  const g = (pi: number) => fp.get(pi) ?? { buy: 0, sell: 0 };
  const buyImb = (pi: number) => { const c = g(pi); return c.buy >= C.minVol && c.buy >= C.ratio * g(pi - 1).sell; };
  const sellImb = (pi: number) => { const c = g(pi); return c.sell >= C.minVol && c.sell >= C.ratio * g(pi + 1).buy; };
  // longest consecutive (by tick) run of same-direction imbalance
  for (const dir of ['buy', 'sell'] as const) {
    const imb = dir === 'buy' ? buyImb : sellImb;
    let run: number[] = [];
    let best: number[] = [];
    for (let i = 0; i < prices.length; i++) {
      const pi = prices[i]!;
      const contig = run.length === 0 || pi === run[run.length - 1]! + 1;
      if (imb(pi) && contig) run.push(pi);
      else { if (run.length > best.length) best = run; run = imb(pi) ? [pi] : []; }
    }
    if (run.length > best.length) best = run;
    if (best.length >= C.minLevels) {
      const top = best[best.length - 1]!, bot = best[0]!;
      const vol = best.reduce((s, pi) => s + (dir === 'buy' ? g(pi).buy : g(pi).sell), 0);
      const key = `${dir}:${bot}-${top}`;
      if (passGuard(e.stackGuard, now, key, C.throttleMs)) {
        emit(e, { t: now / 1000, kind: 'stacked', price: ((top + bot) / 2) * TICK, side: dir, size: Math.round(vol), levels: best.length });
      }
    }
  }
}

// UNFINISHED AUCTION — a window extreme whose extreme level printed one-sided (opposite ≤ maxOpp),
// after price reversed ≥ reverseTicks away. Upside magnet ('buy' high) / downside magnet ('sell' low).
function detectUnfinished(e: SymEngine, now: number): void {
  const C = TAPE_CFG.unfinished;
  const fp = footprint(e, now, C.winMs);
  if (!fp.size) return;
  const prices = [...fp.keys()];
  const hiPi = Math.max(...prices), loPi = Math.min(...prices);
  const cur = e.lastTradePi;
  // unfinished HIGH: buyers made the top with ~no responsive sellers, price now well below it
  const hc = fp.get(hiPi)!;
  if (hc.buy >= C.minVol && hc.sell <= C.maxOpp && cur <= hiPi - C.reverseTicks) {
    if (passGuard(e.unfGuard, now, `hi:${hiPi}`, C.throttleMs)) {
      emit(e, { t: now / 1000, kind: 'unfinished', price: hiPi * TICK, side: 'buy', size: Math.round(hc.buy) });
    }
  }
  // unfinished LOW: sellers made the bottom with ~no responsive buyers, price now well above it
  const lc = fp.get(loPi)!;
  if (lc.sell >= C.minVol && lc.buy <= C.maxOpp && cur >= loPi + C.reverseTicks) {
    if (passGuard(e.unfGuard, now, `lo:${loPi}`, C.throttleMs)) {
      emit(e, { t: now / 1000, kind: 'unfinished', price: loPi * TICK, side: 'sell', size: Math.round(lc.sell) });
    }
  }
}

// TRAPPED TRADERS — a one-sided aggressor burst ≥ minBurst that pushed to a window extreme, which
// price then reversed through by ≥ trapTicks. Trapped longs → 'sell' (they puke) / shorts → 'buy'.
function detectTrapped(e: SymEngine, now: number): void {
  const C = TAPE_CFG.trapped;
  const win = e.trades.filter((t) => t.ts >= now - C.windowMs);
  if (win.length < 2) return;
  const cur = e.lastTradePi;
  const hiPi = Math.max(...win.map((t) => t.pi)), loPi = Math.min(...win.map((t) => t.pi));
  // trapped LONGS: buy burst near the high, price now ≥ trapTicks below it
  if (cur <= hiPi - C.trapTicks) {
    const tHi = Math.max(...win.filter((t) => t.pi >= hiPi - 1).map((t) => t.ts));
    const burst = win.filter((t) => t.buy && t.pi >= hiPi - 2 && Math.abs(t.ts - tHi) <= C.burstMs).reduce((s, t) => s + t.size, 0);
    if (burst >= C.minBurst && passGuard(e.trapGuard, now, `long:${hiPi}`, C.throttleMs)) {
      emit(e, { t: now / 1000, kind: 'trapped', price: hiPi * TICK, side: 'sell', size: Math.round(burst) });
    }
  }
  // trapped SHORTS: sell burst near the low, price now ≥ trapTicks above it
  if (cur >= loPi + C.trapTicks) {
    const tLo = Math.max(...win.filter((t) => t.pi <= loPi + 1).map((t) => t.ts));
    const burst = win.filter((t) => !t.buy && t.pi <= loPi + 2 && Math.abs(t.ts - tLo) <= C.burstMs).reduce((s, t) => s + t.size, 0);
    if (burst >= C.minBurst && passGuard(e.trapGuard, now, `short:${loPi}`, C.throttleMs)) {
      emit(e, { t: now / 1000, kind: 'trapped', price: loPi * TICK, side: 'buy', size: Math.round(burst) });
    }
  }
}

// WALL HOLD/BREAK — resolve tracked large resting levels against the current book position.
function resolveWalls(e: SymEngine, now: number): void {
  if (!e.walls.size) return;
  const W = TAPE_CFG.wall;
  const bbI = bestBidInt(e), baI = bestAskInt(e);
  for (const [pi, w] of e.walls) {
    if (!w.fired && w.hitVol >= W.minHitVol && bbI != null && baI != null) {
      // BREAK: depleted, and the book has crossed through the level
      if (w.cur <= W.breakFrac * w.peak && (w.bid ? baI <= pi : bbI >= pi)) {
        emit(e, { t: now / 1000, kind: 'wall', price: pi * TICK, side: w.bid ? 'sell' : 'buy', size: Math.round(w.peak), state: 'break' });
        w.fired = true;
      // HOLD: survived, and the book has rejected away from the level
      } else if (w.cur >= W.holdFrac * w.peak && (w.bid ? bbI >= pi + W.rejectTicks : baI <= pi - W.rejectTicks)) {
        emit(e, { t: now / 1000, kind: 'wall', price: pi * TICK, side: w.bid ? 'buy' : 'sell', size: Math.round(w.peak), state: 'hold' });
        w.fired = true;
      }
    }
    // prune: resolved, or vanished UNtested (pulled without a fight), or aged out, or far from book.
    // A tested wall (hitVol ≥ minHitVol) is kept even while depleted so break/hold can still confirm.
    const far = bbI != null && baI != null && (pi < bbI - 400 || pi > baI + 400);
    const untestedGone = w.hitVol < W.minHitVol && w.cur < W.minSize;
    if (w.fired || untestedGone || now - w.ts > TAPE_CFG.orderTtlMs || far) e.walls.delete(pi);
  }
}

function prune(): void {
  const now = Date.now();
  for (const e of engines.values()) {
    const cut = (e.lastTs || now) - TAPE_CFG.orderTtlMs;
    for (const [id, o] of e.orders) if (o.ts < cut) e.orders.delete(id);
    for (const [p, f] of e.recentFill) if (f.ts < cut) e.recentFill.delete(p);
    // stale episodes are resolved by resolveIceEps (idle path); this is only a safety net
    for (const [k, ep] of e.iceEps) if (Math.max(ep.lastFillTs, ep.t0) < cut) endIceEp(e, k, ep, e.lastTs || now, 'held');
    for (const [id, k] of e.refillWait) if (!e.iceEps.has(k)) e.refillWait.delete(id);
    const now2 = e.lastTs || now;
    for (const [id, nv] of e.native) if (nv.ts < cut || (nv.cf === 0 && nv.ts < now2 - 60_000)) e.native.delete(id);
    for (const [k, t] of e.lastConf) if (t < now2 - 5 * 60_000) e.lastConf.delete(k);
  }
}

function ensureTail(e: SymEngine): void {
  const latest = liveLog(e.suffix);
  if (!latest || latest === e.logPath) return;
  const firstAttach = e.logPath === null;
  if (e.tail) e.tail.stop();
  e.logPath = latest;
  e.tail = tailLog(latest, (ev) => dispatch(e, ev), { fromStart: !firstAttach });
}

export function startTapeEngine(onEvent: OnEvent): void {
  sink = onEvent;
  if (running) return;
  running = true;
  for (const sym of SYMBOLS) {
    engines.set(sym, {
      sym, suffix: SUFFIX[sym],
      orders: new Map(), recentFill: new Map(), iceEps: new Map(), refillWait: new Map(), native: new Map(), sweep: null,
      bidSz: new Map(), askSz: new Map(), lastQ: null, absWin: [], lamBase: 0, lamSeen: false, lastAbsTs: 0,
      trades: [], lastTradePi: 0, walls: new Map(),
      stackGuard: { ts: 0, key: '' }, unfGuard: { ts: 0, key: '' }, trapGuard: { ts: 0, key: '' },
      confWin: [], lastConf: new Map(),
      lastTs: Date.now(), tail: null, logPath: null,
    });
    ensureTail(engines.get(sym)!);
  }
  rollTimer = setInterval(() => { for (const e of engines.values()) ensureTail(e); }, ROLL_CHECK_MS);
  pruneTimer = setInterval(prune, PRUNE_MS);
  absTimer = setInterval(absorptionTick, ABS_TICK_MS);
  footTimer = setInterval(footprintTick, FOOT_TICK_MS);
}

export function stopTapeEngine(): void {
  if (rollTimer) { clearInterval(rollTimer); rollTimer = null; }
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
  if (absTimer) { clearInterval(absTimer); absTimer = null; }
  if (footTimer) { clearInterval(footTimer); footTimer = null; }
  for (const e of engines.values()) e.tail?.stop();
  engines.clear();
  running = false;
  sink = () => {};
}

export function tapeEngineRunning(): boolean { return running; }
