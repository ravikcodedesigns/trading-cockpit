// Live L3 TAPE event ENGINE — detects discrete order-flow events from the full MBO stream:
//
//   • block/sweep — ONE primitive (2026-07-15 audit): fills are aggregated per AGGRESSOR order
//                   (a 100-lot market order prints as several fills; per-print detection
//                   undercounts). 1 price level = block, ≥ minLevels = sweep.
//   • spoof   — a resting order pulled fast WITH intent evidence: near-touch when posted,
//               opposite side executed while it rested, and the pull REPEATS (layering).
//   • iceberg — a discrete hidden-liquidity EPISODE at one price+side: qualified by machine-latency
//               FILL-CONFIRMED refills, sized by traded − peak persistent displayed, resolved
//               held/broke when price leaves or trades through the level.
//   • absorption — Kyle-λ collapse under significant multi-level OFI, gated on STATISTICAL
//               significance (λ + K·SE below the line) with a per-time-of-day baseline.
//   • wall    — a PERSISTENT large resting level (book-relative floor) that HOLDS, BREAKS
//               (consumed by trades) or is PULLED (walked without a fight).
//   • stacked / unfinished / trapped — rolling-footprint reads (unchanged by the audit; stacked
//               is a powered null standalone and is downweighted in confluence).
//   • confluence — FAMILY-scored synthesis (src/tape/confluence.ts).
//
// All thresholds live in tape-config.ts (TAPE_CFG); every audit behavior has a kill-switch in
// TAPE_FEAT. Direction semantics are centralized in direction.ts — confluence and the outcome
// labeler read the same table. Runs in a DEDICATED process (tape-worker.ts).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tailLog, type TailHandle, type LogEvent } from '../l3/log-tailer.js';
import { ofiStep, ofiStepDeep, regress, type Quote, type BookLevel } from '../l3/divergence.js';
import type { Symbol as Sym, TapeEvent } from '@trading/contracts';
import { TAPE_CFG, TAPE_FEAT, CONF_FAMILY, CONF_W } from './tape-config.js';
import { expectedDir } from './direction.js';
import { newConfState, recordSignal, scoreZone, resolvePendingStars, type ConfState, type FlowEnv } from './confluence.js';
import { calGet, todBucket } from './calibration.js';
import { nearestStructTicks, structLevelBetween } from './structural.js';
import { newIntensity, arrive, burstRatio, type Intensity } from './intensity.js';

export { TAPE_CFG } from './tape-config.js';   // compat: thresholds used to live in this file

export const TICK = 0.25;
const ABS_TICK_MS = 100;    // best-quote sampling cadence for the absorption detector
const FOOT_TICK_MS = 500;   // footprint/wall evaluation cadence (stacked / unfinished / trapped / wall)
const TRADE_WIN_MS = 90_000; // rolling trade deque span (≥ the widest footprint window above)

const CAPTURE_DIR = process.env.HEATMAP_CAPTURE_DIR ?? path.join(os.homedir(), 'cockpit-mbo-capture');
const SUFFIX: Record<Sym, string> = { NQ: 'NQU6', ES: 'ESU6' };  // front-month; bump on the roll
const ROLL_CHECK_MS = 15_000;
const PRUNE_MS = 60_000;
const SYMBOLS: Sym[] = ['NQ', 'ES'];

interface Ord { ts: number; p: number; disp: number; bid: boolean; cf: number; near: boolean; }  // cf = cumulative filled
// One AGGRESSOR execution group (feat.aggrAgg): all fills attributed to one taking order (or, when
// the feed omits the id, one same-direction burst within gapMs). Closed → block (1 level) or sweep.
interface AggrGroup { aid: string; dir: number; prices: Set<number>; size: number; lastTs: number; lastPrice: number; }
interface Sweep { dir: number; prices: Set<number>; size: number; lastTs: number; lastPrice: number; }   // legacy path

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

interface Wall {
  bid: boolean;
  floor: number;    // the (possibly book-relative) size floor this wall registered against
  peak: number;     // peak size — counted from ARMING when the persistence gate is on
  cur: number;
  hitVol: number;   // traded volume printed AT the level while tracked (consumption evidence)
  ts: number;       // first seen ≥ floor (the marker anchor — it never moves)
  armed: boolean;   // passed the persistence gate (or gate disabled) — eligible to fire
  fired: boolean;
  id: string;       // epId once armed — 'active' + resolution emits share it (store upserts, chart replaces)
  lastEmit: number; lastEmitCur: number; lastEmitHit: number;   // live-update throttle state
}

// One STOP-RUN episode: a qualified distinct-aggressor cascade through a reference, awaiting its
// reclaimed/accepted resolution. All emits share `id` → store upserts, client replaces.
interface SrEp {
  id: string;
  dir: number;          // +1 = up through highs (buy stops), −1 = down through lows
  refPi: number;        // the swept reference (marker anchor — the level stops sat behind)
  refKind: string;      // 'session' | 'struct' | 'swing'
  t0: number;
  vol: number;          // cascade volume so far
  ids: Set<string>;     // distinct aggressor ids in the cascade
  peakBeyond: number;   // furthest penetration beyond the ref (ticks)
  burst?: number;       // Hawkes burst ratio λ̂f/λ̂s at qualification (self-excitation score)
  lastEmit: number;     // live-update throttle
}
// A cascade CANDIDATE — a breach print collecting distinct aggressors until it qualifies or expires.
interface SrCand { dir: number; refPi: number; refKind: string; t0: number; lastTs: number; vol: number; ids: Set<string>; }

// One TRAPPED-cohort episode: a burst caught offside at an extreme, awaiting its resolution —
// FLUSHED (adverse move extended → their exits fired) or RECOVERED (price back at their entries).
interface TrapEp {
  id: string;
  side: 'buy' | 'sell';   // the PUKE direction (as emitted): 'sell' = trapped longs
  extremePi: number;      // the extreme their burst chased
  t0: number;
  vol: number; ids: number;
  refKind: string;        // '' | session/struct/round — where traps matter most (stop density)
}

interface SymEngine {
  sym: Sym;
  suffix: string;
  orders: Map<string, Ord>;               // live resting orders we've seen the send for
  recentFill: Map<number, { ts: number; bid: boolean }>;  // price_int → last full passive fill (arms refill detection)
  iceEps: Map<string, IceEp>;             // epKey(price,side) → open synthetic-iceberg episode
  refillWait: Map<string, string>;        // refill order_id → epKey (fill-confirmation routing)
  // native-iceberg tracking: per order_id, largest displayed size vs cumulative filled
  native: Map<string, { p: number; bid: boolean; maxDisp: number; cf: number; t0: number; ts: number; emitted: number }>;
  aggr: AggrGroup | null;                 // current aggressor execution group (feat.aggrAgg)
  sweep: Sweep | null;                    // legacy time-gap execution group (feat.aggrAgg OFF)
  spoofHist: Array<{ ts: number; pi: number; bid: boolean }>;  // qualifying pulls (repetition memory)
  // ── absorption state: L2 book + rolling OFI/Δmid window + baseline λ per ToD bucket
  bidSz: Map<number, number>;             // price_int → size (from depth)
  askSz: Map<number, number>;
  lastQ: Quote | null;                    // previous best-quote sample
  lastDeep: { bids: BookLevel[]; asks: BookLevel[] } | null;  // previous top-K snapshot (feat.mlOfi)
  absWin: { ts: number; ofi: number; dmid: number }[];  // rolling OFI-step + Δmid window
  lamBase: Map<string, { v: number; seen: boolean }>;   // EWMA baseline λ per bucket ('all' when ToD off)
  lastAbsTs: number;
  // ── footprint reads (stacked / unfinished / trapped): rolling classified-trade deque
  trades: { ts: number; pi: number; buy: boolean; size: number; aid: string }[];
  trapEps: Map<string, TrapEp>;           // open trapped-cohort episodes
  lastTradePi: number;                    // last traded price_int
  walls: Map<number, Wall>;
  stackRuns: Map<string, { id: string; lastTs: number }>;  // stacked-ladder run ids (one marker per zone run)
  // ── stop-run state: reference extremes + cascade tracking + arrival intensities
  srMin: Map<number, { hi: number; lo: number }>;  // minute-bucket trade extremes (rolling refWinMs)
  srSessionHi: number; srSessionLo: number; srDayKey: string;
  srCand: SrCand | null;
  srEps: Map<string, SrEp>;               // epId → open episode
  srLastFire: Map<string, number>;        // ref-zone throttle
  srSeenAid: Map<string, number>;         // aggressor id → last seen ts (first fill = ONE arrival)
  srArr: Record<1 | -1, { f: Intensity; s: Intensity }>;  // per-side arrival intensities (Hawkes gate)
  stackGuard: { ts: number; key: string };   // per-detector throttle (time + zone key)
  unfGuard: { ts: number; key: string };
  trapGuard: { ts: number; key: string };
  confSt: ConfState;                      // confluence scorer state (src/tape/confluence.ts)
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

// Every emit: (1) annotate structural proximity (feeds the outcome labeler's at-structure split —
// F5b says the same event means different things at a level vs mid-range), (2) sink, (3) feed the
// confluence scorer with the event's EXPECTED direction (direction.ts — a broke iceberg feeds the
// attacker's side, not the defender's).
function emit(e: SymEngine, ev: TapeEvent): void {
  if (TAPE_FEAT.confStruct) {
    const dTicks = nearestStructTicks(e.sym, ev.price, TICK, e.lastTs || Date.now());
    if (dTicks <= TAPE_CFG.confluence.structTicks[e.sym]) ev.atStruct = true;
  }
  sink(e.sym, ev);
  const eligible = TAPE_FEAT.confFamilies ? CONF_FAMILY[ev.kind] != null : CONF_W[ev.kind] != null;
  if (!eligible) return;
  if (ev.kind === 'wall' && (ev.state === 'pulled' || ev.state === 'active')) return;  // walked = not defense; standing = open coin
  if (ev.kind === 'stoprun' && ev.state === 'active') return; // unresolved run = an open coin, never scores
  const dir = TAPE_FEAT.brokeFlip ? expectedDir(ev) : (ev.side === 'buy' ? 1 : -1);
  if (!dir) return;
  // Contribution time = NOW, not ev.t — iceberg episode emits are anchored at t0, and a marker
  // anchored minutes back would age out of the confluence window the moment it re-fires.
  const now = e.lastTs || ev.t * 1000;
  const pi = Math.round(ev.price / TICK);
  // price-impact magnitude: a RECLAIMED stop run's fuel is its trapped cohort (distinct
  // aggressors forced offside), not its contract volume — recordSignal tiers it accordingly
  const mag = ev.kind === 'stoprun' && ev.state === 'reclaimed' ? (ev.levels ?? ev.size) : ev.size;
  recordSignal(e.confSt, e.sym, now, pi, dir, ev.kind, mag, ev.state);
  const conf = scoreZone(e.confSt, e.sym, now, pi, confEnv(e, now), TICK);
  if (conf) sink(e.sym, conf);
}

// Fresh flow/book/price context for the confluence scorer (also rebuilt at confirmation time —
// a provisional star is re-judged against the CURRENT tape, not a snapshot).
function confEnv(e: SymEngine, now: number): FlowEnv {
  return {
    flowDelta: rollingDelta(e, now),
    imbNet: nearImbalance(e, TAPE_CFG.confluence.zoneTicks),
    curPi: curPi(e),
  };
}

// Rolling aggressor delta over the confluence window (contracts, +ve = net buying).
function rollingDelta(e: SymEngine, now: number): number {
  let delta = 0; const from = now - TAPE_CFG.confluence.winMs;
  for (let i = e.trades.length - 1; i >= 0; i--) { const t = e.trades[i]!; if (t.ts < from) break; delta += t.buy ? t.size : -t.size; }
  return delta;
}

// Near-touch book imbalance (contracts): Σ bid sizes within `ticks` of best bid − Σ ask sizes
// within `ticks` of best ask. >0 = bid-stacked (bullish lean).
function nearImbalance(e: SymEngine, ticks: number): number {
  const bbI = bestBidInt(e), baI = bestAskInt(e);
  // crossed/one-sided book (stale depth interval) = no trustworthy imbalance — return neutral,
  // same guard bestQuote applies for absorption (parity with MarketBook.twoSided())
  if (bbI == null || baI == null || baI <= bbI) return 0;
  let bid = 0, ask = 0;
  for (const [k, s] of e.bidSz) if (k <= bbI && k >= bbI - ticks) bid += s;
  for (const [k, s] of e.askSz) if (k >= baI && k <= baI + ticks) ask += s;
  return bid - ask;
}

// Current-price proxy: mid-quote when available (doesn't stall on quiet tape), else last trade.
// Trade-THROUGH tests (iceberg pierce) still use last trade — a break is defined by prints.
function curPi(e: SymEngine): number {
  if (TAPE_FEAT.midProxy) {
    const bbI = bestBidInt(e), baI = bestAskInt(e);
    if (bbI != null && baI != null) return Math.round((bbI + baI) / 2);
  }
  return e.lastTradePi;
}

// Wall size floor: K × median near-touch level depth for the symbol (book-relative — flat floors
// are noise on ES and unreachable on NQ), never below the UI dial floor. Falls back to the legacy
// flat floor until a calibration with `level_depth` exists.
function wallFloor(e: SymEngine, ts: number): number {
  const W = TAPE_CFG.wall;
  if (!TAPE_FEAT.wallRelFloor) return W.minSize;
  const p = calGet(e.sym, 'level_depth', ts);
  return p && p.n >= 100 && p.p50 > 0 ? Math.max(W.relFloorMin, Math.round(W.relK * p.p50)) : W.minSize;
}

// ── Aggressor-group close: 1 price level = block, ≥ minLevels = sweep ─────────
function closeAggr(e: SymEngine): void {
  const g = e.aggr;
  if (!g) return;
  e.aggr = null;
  const S = TAPE_CFG.sweep;
  const side = g.dir > 0 ? 'buy' : 'sell';
  if (g.prices.size >= S.minLevels && g.size >= S.minSize) {
    emit(e, { t: g.lastTs / 1000, kind: 'sweep', price: g.lastPrice, side, size: g.size, levels: g.prices.size });
  } else if (g.size >= TAPE_CFG.block.minSize) {
    emit(e, { t: g.lastTs / 1000, kind: 'block', price: g.lastPrice, side, size: g.size, levels: g.prices.size });
  }
}

function closeLegacySweep(e: SymEngine): void {
  const r = e.sweep;
  e.sweep = null;
  const S = TAPE_CFG.sweep;
  if (r && r.prices.size >= S.minLevels && r.size >= S.minSize) {
    emit(e, { t: r.lastTs / 1000, kind: 'sweep', price: r.lastPrice, side: r.dir > 0 ? 'buy' : 'sell', size: r.size, levels: r.prices.size });
  }
}

function dispatch(e: SymEngine, evt: LogEvent): void {
  e.lastTs = evt.ts_ms;
  const d = evt.data as any;
  const ts = evt.ts_ms;
  switch (evt.kind) {
    case 'mbo_send': {
      // spoof proximity is judged at POST time — the order must have been visible near the touch
      const ref = d.is_bid ? bestBidInt(e) : bestAskInt(e);
      const near = ref != null && Math.abs(d.price_int - ref) <= TAPE_CFG.spoof.nearTicks;
      e.orders.set(d.order_id, { ts, p: d.price_int, disp: d.size, bid: !!d.is_bid, cf: 0, near });
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
      if (o) {
        o.p = d.price_int; o.disp = d.size;
        // a REPRICE is a fresh decision: the spoof-life clock restarts and proximity is re-judged
        // (legacy kept the original ts — an order repriced to the touch then pulled escaped)
        if (TAPE_FEAT.spoofIntent) {
          o.ts = ts;
          const ref = o.bid ? bestBidInt(e) : bestAskInt(e);
          o.near = ref != null && Math.abs(o.p - ref) <= TAPE_CFG.spoof.nearTicks;
        }
      }
      const nv = e.native.get(d.order_id);
      if (nv) { if (d.size > nv.maxDisp) nv.maxDisp = d.size; nv.p = d.price_int; nv.bid = !!d.is_bid; nv.ts = ts; }
      break;
    }
    case 'mbo_cancel': {
      const o = e.orders.get(d.order_id);
      if (o) {
        maybeEmitSpoof(e, o, ts);
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
      const prevPi = e.lastTradePi;   // pre-print price — the stop-run breach test needs it
      // footprint deque (stacked / unfinished / trapped) + current-price proxy
      if (size > 0) {
        e.trades.push({ ts, pi: d.price_int, buy, size, aid: (d.aggressor_order_id ?? '') as string });
        e.lastTradePi = d.price_int;
        const w = e.walls.get(d.price_int);
        if (w) w.hitVol += size;   // trades printing at a tracked wall = aggression tested against it
      }
      // STOP RUN — evaluate against the PRE-print references, then roll the extremes forward
      if (size > 0 && TAPE_FEAT.stopRun) {
        detectStopRun(e, ts, d.price_int, buy, size, (d.aggressor_order_id ?? '') as string, prevPi);
        rollSrExtremes(e, ts, d.price_int);
      }
      // BLOCK + SWEEP — one primitive (feat.aggrAgg): fills are grouped per aggressor order id
      // (falling back to same-direction bursts within gapMs when the feed omits the id). The
      // closed group emits as a block (1 level) or a sweep (≥ minLevels). Legacy path: per-print
      // blocks + time-gap sweep chaining.
      if (size > 0) {
        const S = TAPE_CFG.sweep, dir = buy ? 1 : -1;
        if (TAPE_FEAT.aggrAgg) {
          const aid = (d.aggressor_order_id ?? '') as string;
          const g = e.aggr;
          const same = g && g.dir === dir && ts - g.lastTs <= S.gapMs &&
            (g.aid !== '' && aid !== '' ? g.aid === aid : true);
          if (same) {
            g!.prices.add(d.price_int); g!.size += size; g!.lastTs = ts; g!.lastPrice = d.price;
            if (aid !== '') g!.aid = aid;
          } else {
            closeAggr(e);
            e.aggr = { aid, dir, prices: new Set([d.price_int]), size, lastTs: ts, lastPrice: d.price };
          }
        } else {
          if (size >= TAPE_CFG.block.minSize) {
            emit(e, { t: ts / 1000, kind: 'block', price: d.price, side: buy ? 'buy' : 'sell', size });
          }
          if (e.sweep && e.sweep.dir === dir && ts - e.sweep.lastTs <= S.gapMs) {
            e.sweep.prices.add(d.price_int); e.sweep.size += size; e.sweep.lastTs = ts; e.sweep.lastPrice = d.price;
          } else {
            closeLegacySweep(e);
            e.sweep = { dir, prices: new Set([d.price_int]), size, lastTs: ts, lastPrice: d.price };
          }
        }
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
      break;
    }
    case 'depth': {   // maintain the L2 book (absorption/imbalance) + track large resting walls
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
      // wall tracking: register candidates ≥ floor near the touch; the persistence gate (armed in
      // resolveWalls) keeps flashed size from ever counting. Peak counts from ARMING so a 500-lot
      // flash can't inflate the depletion base the hold/break fractions divide by.
      const w = e.walls.get(d.price_int);
      if (w) {
        w.cur = sz;
        if (w.armed && sz > w.peak) w.peak = sz;
      } else {
        const floor = wallFloor(e, ts);
        if (sz >= floor) {
          const bbI = bestBidInt(e), baI = bestAskInt(e);
          const ref = d.is_bid ? bbI : baI;   // distance to the touch on this side
          if (ref == null || Math.abs(d.price_int - ref) <= TAPE_CFG.wall.nearTicks) {
            e.walls.set(d.price_int, {
              bid: !!d.is_bid, floor, peak: sz, cur: sz, hitVol: 0, ts,
              armed: !TAPE_FEAT.wallPersist, fired: false,
              id: '', lastEmit: 0, lastEmitCur: 0, lastEmitHit: 0,
            });
          }
        }
      }
      break;
    }
  }
}

// SPOOF — a fast pull of a big never-filled order. Legacy: that alone fired (= the flicker
// bucket). Intent mode (feat.spoofIntent) adds the tests that separate spoofing/layering from
// routine MM re-quoting: (1) near-touch when posted (it had to be VISIBLE to pressure anyone),
// (2) the OPPOSITE side executed while it rested (a fake bid exists to get buys filling asks),
// (3) the pull REPEATS in the same zone (one-off pulls are noise; layering repeats).
function maybeEmitSpoof(e: SymEngine, o: Ord, ts: number): void {
  const S = TAPE_CFG.spoof;
  if (o.cf !== 0 || o.disp < S.minSize || ts - o.ts > S.maxLifeMs) return;
  if (!TAPE_FEAT.spoofIntent) {
    emit(e, { t: ts / 1000, kind: 'spoof', price: o.p * TICK, side: o.bid ? 'buy' : 'sell', size: o.disp, lifeMs: ts - o.ts });
    return;
  }
  if (!o.near) return;
  // opposite-side executions during the order's life: fake BID → buy-aggressor prints (their real
  // ask is getting lifted); fake ASK → sell-aggressor prints
  let oppExec = 0;
  for (let i = e.trades.length - 1; i >= 0; i--) {
    const t = e.trades[i]!;
    if (t.ts < o.ts) break;
    if (t.buy === o.bid) oppExec += t.size;
  }
  if (oppExec < S.minOppExec) return;
  // repetition: qualifying pulls same side / same zone / inside the window (this one included)
  const cutoff = ts - S.repeatWinMs;
  let repeats = 1;
  for (const h of e.spoofHist) {
    if (h.ts >= cutoff && h.bid === o.bid && Math.abs(h.pi - o.p) <= S.repeatZoneTicks) repeats++;
  }
  e.spoofHist.push({ ts, pi: o.p, bid: o.bid });
  if (repeats < S.minRepeats) return;
  emit(e, { t: ts / 1000, kind: 'spoof', price: o.p * TICK, side: o.bid ? 'buy' : 'sell', size: o.disp, lifeMs: ts - o.ts, repeats });
}

// Best bid/ask (+ sizes) from the L2 maps → a Quote for OFI. Null until the book seeds.
function bestQuote(e: SymEngine): Quote | null {
  let bbI = -Infinity, baI = Infinity;
  for (const k of e.bidSz.keys()) if (k > bbI) bbI = k;
  for (const k of e.askSz.keys()) if (k < baI) baI = k;
  if (!Number.isFinite(bbI) || !Number.isFinite(baI) || baI <= bbI) return null;
  return { bidPx: bbI * TICK, bidSz: e.bidSz.get(bbI)!, askPx: baI * TICK, askSz: e.askSz.get(baI)! };
}

// Top-K levels of one side, best-first, as BookLevels (px in PRICE units for the OFI rule).
function topLevels(map: Map<number, number>, isBid: boolean, K: number): BookLevel[] {
  const pis = [...map.keys()];
  pis.sort(isBid ? (a, b) => b - a : (a, b) => a - b);
  const out: BookLevel[] = [];
  for (let i = 0; i < K && i < pis.length; i++) out.push({ px: pis[i]! * TICK, sz: map.get(pis[i]!)! });
  return out;
}

// Sampled every ABS_TICK_MS: push the OFI/Δmid step, roll the window, and fire an absorption
// event when significant net flow shows collapsed price impact vs the running baseline λ.
// Audit upgrades: multi-level OFI (feat.mlOfi) · λ SIGNIFICANTLY below the line, point estimate
// + sigK·SE (feat.absSigGate) · per-time-of-day baseline (feat.todBaseline — λ is U-shaped
// intraday, one EWMA mislabels the open) · anchor at the defended extreme (feat.absLevelAnchor).
function absorptionTick(): void {
  const A = TAPE_CFG.absorption;
  for (const e of engines.values()) {
    // close stale aggressor/sweep groups on the clock — quiet tape must not defer the emit
    if (TAPE_FEAT.sweepTimerClose && e.lastTs) {
      if (e.aggr && e.lastTs - e.aggr.lastTs > TAPE_CFG.sweep.gapMs) closeAggr(e);
      if (e.sweep && e.lastTs - e.sweep.lastTs > TAPE_CFG.sweep.gapMs) closeLegacySweep(e);
    }
    const q = bestQuote(e);
    if (!q) continue;
    const now = e.lastTs || Date.now();
    if (e.lastQ) {
      const p = e.lastQ;
      const changed = q.bidPx !== p.bidPx || q.bidSz !== p.bidSz || q.askPx !== p.askPx || q.askSz !== p.askSz;
      // Only sample real best-quote CHANGES — zero-flow ticks poison the λ regression.
      if (!changed) continue;
      const mid = (x: Quote) => (x.bidPx + x.askPx) / 2;
      let ofi: number;
      if (TAPE_FEAT.mlOfi) {
        const bids = topLevels(e.bidSz, true, A.ofiDepth), asks = topLevels(e.askSz, false, A.ofiDepth);
        ofi = e.lastDeep ? ofiStepDeep(e.lastDeep.bids, e.lastDeep.asks, bids, asks, A.ofiDepth) : 0;
        e.lastDeep = { bids, asks };
      } else {
        ofi = ofiStep(e.lastQ, q);
      }
      e.absWin.push({ ts: now, ofi, dmid: mid(q) - mid(e.lastQ) });
      let cut = 0; while (cut < e.absWin.length && e.absWin[cut]!.ts < now - A.winMs) cut++; if (cut) e.absWin.splice(0, cut);
      if (e.absWin.length >= A.minQuotes) {
        const lam = regress(e.absWin.map((w) => w.ofi), e.absWin.map((w) => w.dmid));
        if (lam) {
          const cumOFI = e.absWin.reduce((s, w) => s + w.ofi, 0);
          const bucket = TAPE_FEAT.todBaseline ? todBucket(now) : 'all';
          let base = e.lamBase.get(bucket);
          if (!base) { base = { v: 0, seen: false }; e.lamBase.set(bucket, base); }
          // Significance gate: the UPPER edge of the λ CI must clear the collapse line — a noisy
          // near-zero point estimate over 15 quote changes is not evidence of absorption.
          const lamEff = TAPE_FEAT.absSigGate && Number.isFinite(lam.se) ? lam.lambda + A.sigK * lam.se : lam.lambda;
          if (base.seen && Math.abs(cumOFI) >= A.minFlow && lamEff <= A.collapse * base.v && now - e.lastAbsTs >= A.throttleMs) {
            e.lastAbsTs = now;
            // anchor at the defended extreme: buy flow absorbed → the seller defends the local
            // HIGH; sell flow absorbed → the buyer defends the local LOW (footprint convention)
            let price = mid(q);
            if (TAPE_FEAT.absLevelAnchor) {
              const from = now - A.winMs;
              let ext = NaN;
              for (let i = e.trades.length - 1; i >= 0; i--) {
                const t = e.trades[i]!;
                if (t.ts < from) break;
                if (Number.isNaN(ext)) ext = t.pi;
                else ext = cumOFI > 0 ? Math.max(ext, t.pi) : Math.min(ext, t.pi);
              }
              if (!Number.isNaN(ext)) price = ext * TICK;
            }
            emit(e, {
              t: now / 1000, kind: 'absorption', price,
              side: cumOFI > 0 ? 'sell' : 'buy',        // buy flow absorbed → SELLER defends (bearish) → 'sell'
              size: Math.round(Math.abs(cumOFI)), lamRatio: +(lam.lambda / base.v).toFixed(2),
            });
          }
          // Baseline tracks NORMAL impact only — never poison it with the collapsed/negative λ.
          if (lam.lambda > 0) {
            base.v = base.seen ? base.v + A.ewma * (lam.lambda - base.v) : lam.lambda;
            base.seen = true;
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

// Resolve open episodes: BROKE only on a CONFIRMED trade-through (≥ breakTicks beyond by PRINTS,
// or sustained beyond for breakMs — a 1-tick sweep that snaps back is the defense WORKING), HELD
// once price rejects ≥ leaveTicks away for leaveMs (mid-quote proxy — a quiet book still drifts
// away without prints), or on idle with the level still standing.
function resolveIceEps(e: SymEngine, now: number): void {
  if (!e.iceEps.size) return;
  const I = TAPE_CFG.iceberg;
  const printPi = e.lastTradePi;         // trade-through tests: prints only
  const midPi = curPi(e);                // held/away clocks: mid-quote proxy
  for (const [key, ep] of e.iceEps) {
    if (printPi) {
      const beyond = ep.bid ? ep.pi - printPi : printPi - ep.pi;   // >0 = printed through the level
      if (beyond > 0) {
        if (beyond >= I.breakTicks) { endIceEp(e, key, ep, now, 'broke'); continue; }
        if (!ep.pierceSince) ep.pierceSince = now;
        else if (now - ep.pierceSince >= I.breakMs) { endIceEp(e, key, ep, now, 'broke'); continue; }
        ep.awaySince = 0;
        continue;   // pierced but unconfirmed — neither held-clock nor idle should run
      }
      ep.pierceSince = 0;
    }
    if (midPi) {
      const away = ep.bid ? midPi - ep.pi : ep.pi - midPi;
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
    resolveStopRuns(e, now);
    resolveTraps(e, now);
    // confirm provisional confluence stars against the CURRENT tape (V2: an action area must
    // still qualify confirmMs later, with price still at the anchor)
    for (const conf of resolvePendingStars(e.confSt, e.sym, now, confEnv(e, now), TICK)) sink(e.sym, conf);
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
        // a persisting ladder is ONE evolving marker, not a trail of repeats: refires within the
        // footprint window share a per-zone run id (store upserts, chart updates in place)
        const runKey = `${dir}:${Math.round((top + bot) / 2 / 16)}`;
        let run = e.stackRuns.get(runKey);
        if (!run || now - run.lastTs > C.winMs) { run = { id: `${e.sym}-sk-${dir}-${now}`, lastTs: now }; e.stackRuns.set(runKey, run); }
        run.lastTs = now;
        emit(e, { t: now / 1000, kind: 'stacked', price: ((top + bot) / 2) * TICK, side: dir, size: Math.round(vol), levels: best.length, epId: run.id });
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
  const cur = curPi(e);
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

// TRAPPED TRADERS — a one-sided aggressor burst ≥ minBurst near a window extreme, which price
// then reversed through by ≥ trapTicks. Trapped longs → 'sell' (they puke) / shorts → 'buy'.
// LIFECYCLE (2026-07-15 review): each trap is an EPISODE (epId) — the scoring emit cadence below
// is UNCHANGED (STAR_FADE config freeze: trapped feeds the star's EXHAUSTION family), but emits
// now carry epId (one marker per trap, not a refire trail), the DISTINCT-aggressor cohort size
// (`levels` — 20 independent longs puke; one 30-lot institution defends), and a stop-density ref
// tag; resolveTraps() then settles each episode FLUSHED or RECOVERED (display/labeler-only).
function trapRefKind(e: SymEngine, pi: number, dir: number, now: number): string {
  if (Math.abs(pi - (dir > 0 ? e.srSessionHi : e.srSessionLo)) <= 2 && e.srDayKey) return 'session';
  if (nearestStructTicks(e.sym, pi * TICK, TICK, now) <= TAPE_CFG.confluence.structTicks[e.sym]) return 'struct';
  const grid = TAPE_CFG.stoprun.roundGrid[e.sym] ?? 0;
  if (grid > 0 && Math.abs(pi - Math.round(pi / grid) * grid) <= 2) return 'round';
  return '';
}

function openTrap(e: SymEngine, now: number, extremePi: number, side: 'buy' | 'sell', burst: number, ids: number): void {
  const key = `${side}:${Math.round(extremePi / 4)}`;
  let ep = e.trapEps.get(key);
  if (!ep) {
    ep = { id: `${e.sym}-tr-${extremePi}-${side === 'sell' ? 'L' : 'S'}-${now}`, side, extremePi, t0: now, vol: burst, ids, refKind: trapRefKind(e, extremePi, side === 'sell' ? 1 : -1, now) };
    e.trapEps.set(key, ep);
  } else { ep.vol = Math.max(ep.vol, burst); ep.ids = Math.max(ep.ids, ids); }
  // scoring emit carries the CURRENT burst (bit-identical to pre-lifecycle behavior — STAR_FADE
  // freeze); the episode's high-water vol/ids ride on the final resolution emit instead
  emit(e, {
    t: ep.t0 / 1000, kind: 'trapped', price: ep.extremePi * TICK, side, size: Math.round(burst),
    levels: ids, state: 'active', epId: ep.id, signals: ep.refKind ? [ep.refKind] : undefined,
  });
}

function detectTrapped(e: SymEngine, now: number): void {
  const C = TAPE_CFG.trapped;
  const win = e.trades.filter((t) => t.ts >= now - C.windowMs);
  if (win.length < 2) return;
  const cur = curPi(e);
  const hiPi = Math.max(...win.map((t) => t.pi)), loPi = Math.min(...win.map((t) => t.pi));
  // trapped LONGS: buy burst near the high, price now ≥ trapTicks below it
  if (cur <= hiPi - C.trapTicks) {
    const tHi = Math.max(...win.filter((t) => t.pi >= hiPi - 1).map((t) => t.ts));
    const bt = win.filter((t) => t.buy && t.pi >= hiPi - 2 && Math.abs(t.ts - tHi) <= C.burstMs);
    const burst = bt.reduce((s, t) => s + t.size, 0);
    if (burst >= C.minBurst && passGuard(e.trapGuard, now, `long:${hiPi}`, C.throttleMs)) {
      openTrap(e, now, hiPi, 'sell', burst, new Set(bt.map((t) => t.aid).filter(Boolean)).size);
    }
  }
  // trapped SHORTS: sell burst near the low, price now ≥ trapTicks above it
  if (cur >= loPi + C.trapTicks) {
    const tLo = Math.max(...win.filter((t) => t.pi <= loPi + 1).map((t) => t.ts));
    const bt = win.filter((t) => !t.buy && t.pi <= loPi + 2 && Math.abs(t.ts - tLo) <= C.burstMs);
    const burst = bt.reduce((s, t) => s + t.size, 0);
    if (burst >= C.minBurst && passGuard(e.trapGuard, now, `short:${loPi}`, C.throttleMs)) {
      openTrap(e, now, loPi, 'buy', burst, new Set(bt.map((t) => t.aid).filter(Boolean)).size);
    }
  }
}

// Settle open trap episodes: FLUSHED once the cohort's adverse move extends to flushTicks (their
// stops/pukes fired — the reversal thesis played), RECOVERED once price is back within
// recoverTicks of their entry extreme (trap dead). TTL settles stragglers by position.
function resolveTraps(e: SymEngine, now: number): void {
  if (!e.trapEps.size) return;
  const C = TAPE_CFG.trapped;
  const cur = curPi(e);
  if (!cur) return;
  for (const [key, ep] of e.trapEps) {
    const adverse = ep.side === 'sell' ? ep.extremePi - cur : cur - ep.extremePi;   // cohort's pain (ticks)
    let state: 'flushed' | 'recovered' | null = null;
    if (adverse >= C.flushTicks) state = 'flushed';
    else if (adverse <= C.recoverTicks) state = 'recovered';
    else if (now - ep.t0 >= C.ttlMs) state = adverse >= C.trapTicks ? 'flushed' : 'recovered';
    if (state) {
      e.trapEps.delete(key);
      emit(e, {
        t: ep.t0 / 1000, kind: 'trapped', price: ep.extremePi * TICK, side: ep.side, size: Math.round(ep.vol),
        levels: ep.ids, state, epId: ep.id, signals: ep.refKind ? [ep.refKind] : undefined, durMs: now - ep.t0,
      });
    }
  }
}

// ── STOP RUN ──────────────────────────────────────────────────────────────────
// Roll the reference extremes forward AFTER the breach test: minute-bucket rolling window
// (swing) + session H/L (reset on the ET day change).
function rollSrExtremes(e: SymEngine, ts: number, pi: number): void {
  const mKey = Math.floor(ts / 60_000);
  let b = e.srMin.get(mKey);
  if (!b) {
    b = { hi: pi, lo: pi };
    e.srMin.set(mKey, b);
    const cut = mKey - Math.ceil(TAPE_CFG.stoprun.refWinMs / 60_000);
    for (const k of e.srMin.keys()) if (k < cut) e.srMin.delete(k);
    // session day roll (ET) — checked once per minute, not per trade
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ts));
    if (day !== e.srDayKey) { e.srDayKey = day; e.srSessionHi = pi; e.srSessionLo = pi; }
  }
  if (pi > b.hi) b.hi = pi;
  if (pi < b.lo) b.lo = pi;
  if (pi > e.srSessionHi) e.srSessionHi = pi;
  if (pi < e.srSessionLo || e.srSessionLo === 0) e.srSessionLo = pi;
}

function srSwingRef(e: SymEngine, dir: number): number {
  let ext = dir > 0 ? -Infinity : Infinity;
  for (const b of e.srMin.values()) ext = dir > 0 ? Math.max(ext, b.hi) : Math.min(ext, b.lo);
  return ext;
}

// A print through a stop-pool reference opens a cascade CANDIDATE; distinct aggressor ids
// accumulating within cascadeMs qualify it into an episode. Priority of swept refs:
// session H/L > daily structural level > round number (Osler clustering) > rolling swing extreme.
function detectStopRun(e: SymEngine, ts: number, pi: number, buy: boolean, size: number, aid: string, prevPi: number): void {
  const S = TAPE_CFG.stoprun;
  const dir = buy ? 1 : -1;

  // arrival stream: the FIRST fill of each distinct aggressor id is one arrival event —
  // repeated fills of the same taking order are one decision, not new participants
  if (aid && ts - (e.srSeenAid.get(aid) ?? -Infinity) > S.cascadeMs) {
    const a = e.srArr[dir as 1 | -1];
    arrive(a.f, ts, S.tauFastMs);
    arrive(a.s, ts, S.tauSlowMs);
  }
  if (aid) e.srSeenAid.set(aid, ts);

  // feed an open episode first: further same-direction volume beyond the ref extends the run —
  // and LIVE-UPDATES the marker (1s throttle) so cascade size/cohort grow on screen as it happens
  for (const ep of e.srEps.values()) {
    if (ep.dir !== dir) continue;
    const beyond = dir > 0 ? pi - ep.refPi : ep.refPi - pi;
    if (beyond > 0) {
      ep.vol += size;
      if (aid) ep.ids.add(aid);
      if (beyond > ep.peakBeyond) ep.peakBeyond = beyond;
      if (ts - ep.lastEmit >= 1_000) {
        ep.lastEmit = ts;
        emit(e, {
          t: ep.t0 / 1000, kind: 'stoprun', price: ep.refPi * TICK, side: ep.dir > 0 ? 'buy' : 'sell',
          size: ep.vol, levels: ep.ids.size, state: 'active', epId: ep.id, signals: [ep.refKind],
          lamRatio: ep.burst, durMs: ts - ep.t0,
        });
      }
    }
  }

  // cascade candidate accounting
  const c = e.srCand;
  if (c && c.dir === dir && ts - c.lastTs <= S.cascadeMs && (dir > 0 ? pi > c.refPi : pi < c.refPi)) {
    c.lastTs = ts; c.vol += size;
    if (aid) c.ids.add(aid);
  } else if (!c || ts - c.lastTs > S.cascadeMs || c.dir !== dir) {
    // fresh breach test against the PRE-print references
    let refPi = 0, refKind = '';
    if (e.srDayKey) {
      if (dir > 0 && e.srSessionHi > 0 && pi > e.srSessionHi) { refPi = e.srSessionHi; refKind = 'session'; }
      else if (dir < 0 && e.srSessionLo > 0 && pi < e.srSessionLo) { refPi = e.srSessionLo; refKind = 'session'; }
    }
    if (!refKind && prevPi) {
      const lvl = dir > 0
        ? structLevelBetween(e.sym, prevPi * TICK, pi * TICK, ts)
        : structLevelBetween(e.sym, pi * TICK, prevPi * TICK, ts);
      if (lvl != null) { refPi = Math.round(lvl / TICK); refKind = 'struct'; }
    }
    if (!refKind && prevPi) {
      // round numbers: stops cluster just beyond them (Osler's FX order-book evidence — the
      // clustering mechanism is order-placement psychology, not venue-specific)
      const grid = S.roundGrid[e.sym] ?? 0;
      if (grid > 0) {
        if (dir > 0) {
          const r = Math.floor(pi / grid) * grid;
          if (pi > r && prevPi <= r) { refPi = r; refKind = 'round'; }
        } else {
          const r = Math.ceil(pi / grid) * grid;
          if (pi < r && prevPi >= r) { refPi = r; refKind = 'round'; }
        }
      }
    }
    if (!refKind) {
      const swing = srSwingRef(e, dir);
      if (Number.isFinite(swing) && (dir > 0 ? pi > swing : pi < swing)) { refPi = swing; refKind = 'swing'; }
    }
    if (refKind) {
      e.srCand = { dir, refPi, refKind, t0: ts, lastTs: ts, vol: size, ids: new Set(aid ? [aid] : []) };
    }
    return;
  }

  // qualification: many DISTINCT aggressors = triggered stops, not one player — PLUS (feat.srHawkes)
  // the arrival stream must be SELF-EXCITING: burst ratio λ̂f/λ̂s ≥ minBurst. A slow trickle of
  // different traders crossing a level over 2s is rotation, not a cascade; the gate never binds
  // until the baseline has matured (burstRatio returns null → count-only qualification).
  if (c && c.ids.size >= S.minDistinct && c.vol >= S.minVol) {
    let burst: number | null = null;
    if (TAPE_FEAT.srHawkes) {
      const a = e.srArr[dir as 1 | -1];
      burst = burstRatio(a.f, a.s, ts, S.tauFastMs, S.tauSlowMs, S.minBaseN);
      if (burst != null && burst < S.minBurst) return;   // candidate keeps accumulating — R can still rise
    }
    const zone = `${c.dir}:${Math.round(c.refPi / 8)}`;
    if (ts - (e.srLastFire.get(zone) ?? -Infinity) >= S.throttleMs) {
      e.srLastFire.set(zone, ts);
      const ep: SrEp = { id: `${e.sym}-sr-${c.refPi}-${c.dir > 0 ? 'u' : 'd'}-${c.t0}`, dir: c.dir, refPi: c.refPi, refKind: c.refKind, t0: c.t0, vol: c.vol, ids: new Set(c.ids), peakBeyond: Math.abs(pi - c.refPi), lastEmit: ts };
      if (burst != null) ep.burst = +burst.toFixed(1);
      e.srEps.set(ep.id, ep);
      emit(e, {
        t: ep.t0 / 1000, kind: 'stoprun', price: ep.refPi * TICK, side: ep.dir > 0 ? 'buy' : 'sell',
        size: ep.vol, levels: ep.ids.size, state: 'active', epId: ep.id, signals: [ep.refKind],
        lamRatio: ep.burst,
      });
    }
    e.srCand = null;
  }
}

// Resolve open stop-run episodes: RECLAIMED once price is back inside the swept ref (the sweep
// failed — the triggered cohort is offside), ACCEPTED once it extends well beyond or is still
// beyond at the acceptance deadline (genuine breakout).
function resolveStopRuns(e: SymEngine, now: number): void {
  if (!e.srEps.size) return;
  const S = TAPE_CFG.stoprun;
  const cur = curPi(e);
  if (!cur) return;
  for (const [id, ep] of e.srEps) {
    const beyond = ep.dir > 0 ? cur - ep.refPi : ep.refPi - cur;
    let state: 'reclaimed' | 'accepted' | null = null;
    if (beyond <= -S.reclaimTicks) state = 'reclaimed';
    else if (ep.peakBeyond >= S.extendTicks) state = 'accepted';
    else if (now - ep.t0 >= S.acceptMs) state = beyond > 0 ? 'accepted' : 'reclaimed';
    if (state) {
      e.srEps.delete(id);
      emit(e, {
        t: ep.t0 / 1000, kind: 'stoprun', price: ep.refPi * TICK, side: ep.dir > 0 ? 'buy' : 'sell',
        size: ep.vol, levels: ep.ids.size, state, epId: ep.id, signals: [ep.refKind], durMs: now - ep.t0,
        lamRatio: ep.burst,
      });
    }
  }
}

// WALL HOLD/BREAK/PULLED — arm candidates through the persistence gate, then resolve against the
// book. BREAK additionally requires CONSUMPTION (hitVol ≥ consumedFrac × peak) — a depleted level
// the tape never ate was PULLED by its owner (spoof-adjacent repositioning), not broken.
// LIVE LIFECYCLE (user directive 2026-07-15): an armed wall emits state 'active' IMMEDIATELY —
// "a bid wall is standing there right now, I lean long against it" — then live-updates as it's
// consumed, then resolves. All emits share the wall's epId (store upserts, chart replaces).
function emitWall(e: SymEngine, pi: number, w: Wall, now: number, state: TapeEvent['state']): void {
  // active/hold speak for the DEFENDER; break/pulled for the side that ran it over
  const side = state === 'break' || state === 'pulled' ? (w.bid ? 'sell' : 'buy') : (w.bid ? 'buy' : 'sell');
  w.lastEmit = now; w.lastEmitCur = w.cur; w.lastEmitHit = w.hitVol;
  emit(e, {
    t: w.ts / 1000, kind: 'wall', price: pi * TICK, side, size: Math.round(w.peak), state,
    epId: w.id, exec: Math.round(w.hitVol), levels: Math.round(w.cur), durMs: now - w.ts,
  });
}

function resolveWalls(e: SymEngine, now: number): void {
  if (!e.walls.size) return;
  const W = TAPE_CFG.wall;
  const bbI = bestBidInt(e), baI = bestAskInt(e);
  for (const [pi, w] of e.walls) {
    // persistence gate: a candidate must REST ≥ persistMs at/above its floor before it can fire.
    // Flashed size that dropped below the floor before arming is flicker — discard it.
    if (!w.armed) {
      if (w.cur >= w.floor) {
        if (now - w.ts >= W.persistMs) {
          w.armed = true; w.peak = w.cur;
          w.id = `${e.sym}-w-${pi}-${w.ts}`;
          emitWall(e, pi, w, now, 'active');   // the wall is STANDING — visible from this moment
        }
      } else {
        e.walls.delete(pi);
        continue;
      }
    }
    if (w.armed && !w.fired && w.hitVol >= W.minHitVol && bbI != null && baI != null) {
      // DEPLETED + book crossed through the level → break or pulled, split by consumption
      if (w.cur <= W.breakFrac * w.peak && (w.bid ? baI <= pi : bbI >= pi)) {
        const consumed = w.hitVol >= W.consumedFrac * w.peak;
        emitWall(e, pi, w, now, TAPE_FEAT.wallPulled && !consumed ? 'pulled' : 'break');
        w.fired = true;
      // HOLD: survived, and the book has rejected away from the level
      } else if (w.cur >= W.holdFrac * w.peak && (w.bid ? bbI >= pi + W.rejectTicks : baI <= pi - W.rejectTicks)) {
        emitWall(e, pi, w, now, 'hold');
        w.fired = true;
      }
    }
    // live update: remaining size or absorbed volume changed materially → re-push (1s throttle)
    if (w.armed && !w.fired && now - w.lastEmit >= 1_000 &&
        (w.cur !== w.lastEmitCur || w.hitVol !== w.lastEmitHit)) {
      emitWall(e, pi, w, now, 'active');
    }
    // prune: resolved, or vanished UNtested (pulled without a fight — pre-arming flashes are
    // handled above), or aged out, or far from the book. A tested wall (hitVol ≥ minHitVol) is
    // kept even while depleted so break/hold can still confirm. An armed-but-unresolved wall
    // must NEVER leave a dangling ACTIVE marker: still standing → 'hold', gone → 'pulled'.
    const far = bbI != null && baI != null && (pi < bbI - 400 || pi > baI + 400);
    const untestedGone = w.hitVol < W.minHitVol && w.cur < w.floor;
    if (w.fired || untestedGone || now - w.ts > TAPE_CFG.orderTtlMs || far) {
      if (w.armed && !w.fired) emitWall(e, pi, w, now, w.cur >= w.floor ? 'hold' : 'pulled');
      e.walls.delete(pi);
    }
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
    for (const [k, t] of e.confSt.lastConf) if (t < now2 - 5 * 60_000) e.confSt.lastConf.delete(k);
    for (const [k, t] of e.srLastFire) if (t < now2 - 5 * 60_000) e.srLastFire.delete(k);
    for (const [k, t] of e.srSeenAid) if (t < now2 - 60_000) e.srSeenAid.delete(k);
    for (const [k, r] of e.stackRuns) if (r.lastTs < now2 - 5 * 60_000) e.stackRuns.delete(k);
    // safety net — resolveTraps' TTL is the primary close; never leave a dangling active trap
    for (const [k, ep] of e.trapEps) if (ep.t0 < now2 - 2 * TAPE_CFG.trapped.ttlMs) {
      e.trapEps.delete(k);
      emit(e, { t: ep.t0 / 1000, kind: 'trapped', price: ep.extremePi * TICK, side: ep.side, size: Math.round(ep.vol), levels: ep.ids, state: 'recovered', epId: ep.id, durMs: now2 - ep.t0 });
    }
    const spCut = now2 - TAPE_CFG.spoof.repeatWinMs;
    let si = 0; while (si < e.spoofHist.length && e.spoofHist[si]!.ts < spCut) si++; if (si) e.spoofHist.splice(0, si);
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
      orders: new Map(), recentFill: new Map(), iceEps: new Map(), refillWait: new Map(), native: new Map(),
      aggr: null, sweep: null, spoofHist: [],
      bidSz: new Map(), askSz: new Map(), lastQ: null, lastDeep: null, absWin: [], lamBase: new Map(), lastAbsTs: 0,
      trades: [], lastTradePi: 0, walls: new Map(), stackRuns: new Map(), trapEps: new Map(),
      srMin: new Map(), srSessionHi: 0, srSessionLo: 0, srDayKey: '', srCand: null, srEps: new Map(), srLastFire: new Map(),
      srSeenAid: new Map(), srArr: { 1: { f: newIntensity(), s: newIntensity() }, [-1]: { f: newIntensity(), s: newIntensity() } },
      stackGuard: { ts: 0, key: '' }, unfGuard: { ts: 0, key: '' }, trapGuard: { ts: 0, key: '' },
      confSt: newConfState(),
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
