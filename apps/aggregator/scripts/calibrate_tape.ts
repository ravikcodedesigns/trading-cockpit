// TAPE calibration — replays the live detectors over the parquet MBO store (RTH, all captured
// days, per symbol) and computes the empirical distribution of each event's magnitude parameter
// → percentile breakpoints for confluence tiering + calibrated floors. Data-driven: thresholds
// come from what actually occurs on each symbol, not guessed numbers.
//
// 2026-07-15 audit rebuild — outputs THREE layers per symbol:
//   1. trade/order metrics (parity with tape-engine defaults, incl. AGGRESSOR-grouped block/sweep):
//      iceberg hidden/refills/duration · native · sweep levels/size · block ct · stacked · trapped
//      · flow |delta| · refill latency
//   2. DEPTH metrics from the reconstructed book (Part 2, previously missing): near-touch resting
//      level_depth (the wall K×median floor input) · near-touch |imb| (the confluence BOOK floor)
//      · persist-gated wall_peak · absorption |ΣOFI| (approximate: L1 OFI over 2s-sampled quotes —
//      coarser than the live 100ms cadence; scale-level parity only, noted in _meta)
//   3. TIME-OF-DAY buckets (open 09:30–10:15 ET · mid · late 15:00–16:00 ET) for every metric —
//      intraday magnitude is U-shaped; one whole-RTH distribution over-fires the open.
//
// Output: data/tape-calibration.json → read by src/tape/calibration.ts (graceful-fallback loader).
// Needs NODE_OPTIONS=--max-old-space-size=24576 (23M-event days OOM the 4GB default).

import { query } from '../src/lib/mbo-reader.js';
import { newIntensity, arrive, burstRatio } from '../src/tape/intensity.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../../../data/tape-calibration.json');
const TICK = 0.25;
// front-month rolls M6→U6 mid-span; resolve the dominant contract PER DAY (avoids roll contamination).
async function frontContract(symbol: string, day: string): Promise<string | null> {
  const r: any[] = await query(`SELECT contract, count(*) n FROM mbo_trades WHERE symbol='${symbol}' AND date='${day}' GROUP BY contract ORDER BY n DESC LIMIT 1`);
  return r[0]?.contract ?? null;
}

// detector params (mirror tape-engine DEFAULTS — flags on)
const REFILL_MS = 500, MIN_REFILLS = 4, ICE_PERSIST = 400, ICE_LEAVE_TICKS = 3, ICE_LEAVE_MS = 15_000, ICE_IDLE = 120_000;
const ICE_BREAK_TICKS = 3, ICE_BREAK_MS = 4_000;
const NAT_HIDDEN = 10, NAT_CUM = 40;
const WARMUP_MS = 30 * 60_000;
const SWEEP_GAP = 100, SWEEP_LEVELS = 3, SWEEP_MIN = 5;
const BLOCK_MIN = 25;
const FOOT_WIN = 90_000, FOOT_TICK = 500;
const STACK_RATIO = 3, STACK_LEVELS = 3, STACK_MINVOL = 10, STACK_WIN = 90_000;
const TRAP_BURST_MS = 3000, TRAP_TICKS = 12, TRAP_WIN = 20_000, TRAP_MINBURST = 30;
const FLOW_WIN = 25_000, FLOW_SAMPLE = 2000;   // sample rolling |delta| + |imb| + |ΣOFI| every 2s
// stop-run parity (session + rolling-swing refs only — daily structural levels aren't replayable
// historically here; the live engine adds them, distributions stay comparable)
const SR_REF_WIN = 15 * 60_000, SR_MIN_IDS = 6, SR_CASCADE_MS = 2000, SR_MINVOL = 25, SR_THROTTLE = 60_000;
const SR_TAU_FAST = 800, SR_TAU_SLOW = 60_000, SR_MIN_BURST = 4, SR_MIN_BASE_N = 30;   // Hawkes gate parity
const DEPTH_SAMPLE = 10_000;                   // sample near-touch level depths every 10s
const DEPTH_BAND = 10;                         // level_depth band: ±N ticks of touch — the wall floor's
                                               //   reference class is the book NEAR the fight, not 40t of
                                               //   1-lot outer levels that would drag the median to 1
const IMB_TICKS = 8;                           // confluence BOOK band (TAPE_CONF_ZONE)
const WALL_NEAR = 40, WALL_PERSIST = 1500, WALL_REG_MIN = 30;  // wall parity (TAPE_FLOORS.wall.size)
const ABS_WIN = 4000;                          // absorption rolling window

type Ev = { ts: number; kind: string; pi: number; sz: number; buy: boolean; oid?: string; aoid?: string; poid?: string; bid?: boolean };
type Bucket = 'open' | 'mid' | 'late' | 'overnight';

function pctl(a: number[], p: number): number { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]!; }
function pctls(a: number[]): Record<string, number> { return { n: a.length, p20: pctl(a, .2), p50: pctl(a, .5), p80: pctl(a, .8), p95: pctl(a, .95), p99: pctl(a, .99) }; }

const METRICS = [
  'iceberg_ct', 'iceberg_refills', 'iceberg_dur_s', 'native_ct',
  'sweep_levels', 'sweep_size', 'block_ct', 'stacked_levels', 'stacked_vol', 'trapped_ct',
  'flow_delta', 'refill_lat_ms',
  'level_depth', 'imb_abs', 'wall_peak', 'absorption_ofi',
  'stoprun_ct', 'stoprun_ids', 'stoprun_burst',
] as const;
type Metric = typeof METRICS[number];

// per-metric samples: whole-RTH ('all' — the fallback the loader uses when a bucket is thin)
// + per ToD bucket, including OVERNIGHT (its own market: ~10-20% of RTH volume, different book)
type Store = Record<Metric, { all: number[]; open: number[]; mid: number[]; late: number[]; overnight: number[] }>;
function newStore(): Store {
  const s: any = {};
  for (const m of METRICS) s[m] = { all: [], open: [], mid: [], late: [], overnight: [] };
  return s as Store;
}

async function loadDay(symbol: string, day: string, winFrom?: number, winTo?: number): Promise<Ev[]> {
  const base = Date.parse(day + 'T00:00:00Z');
  const T0 = winFrom ?? base + 13.5 * 3600_000 - WARMUP_MS;
  const T1 = winTo ?? base + 20 * 3600_000;
  const c = await frontContract(symbol, day);
  if (!c) return [];
  // window includes the warmup lead-in; processDay gates metric RECORDING separately.
  const tr: any[] = await query(`SELECT ts_ms, price_int, size, is_bid_aggressor, aggressor_order_id, passive_order_id FROM mbo_trades WHERE symbol='${symbol}' AND contract='${c}' AND ts_ms BETWEEN ${T0} AND ${T1} AND size>0 ORDER BY ts_ms`);
  const mb: any[] = await query(`SELECT ts_ms, action, order_id, price_int, size, is_bid FROM mbo_events WHERE symbol='${symbol}' AND contract='${c}' AND ts_ms BETWEEN ${T0} AND ${T1} ORDER BY ts_ms`);
  // AUTHORITATIVE book state: the L2 depth stream (absolute size per price), same source the live
  // engine builds from. Order-stream reconstruction is NOT self-healing — one missed decrement
  // (e.g. an aggressor whose id the feed omitted) leaves a phantom level inside the spread FOREVER
  // and the book reads permanently crossed (first calibration run: imb_abs sampled n=0).
  // NULL-field rows exist in the depth parquet (~250/20M, conversion artifact) — ONE null Map key
  // poisons a best-bid/ask scan permanently (null < Infinity is true), which is how runs 1–3
  // sampled imb_abs n=0. Filter at the source.
  const dp: any[] = await query(`SELECT ts_ms, price_int, size, is_bid FROM mbo_depth WHERE symbol='${symbol}' AND contract='${c}' AND ts_ms BETWEEN ${T0} AND ${T1} AND price_int IS NOT NULL AND size IS NOT NULL AND is_bid IS NOT NULL ORDER BY ts_ms`);
  const evs: Ev[] = [];
  for (const r of tr) evs.push({ ts: Number(r.ts_ms), kind: 'trade', pi: r.price_int, sz: r.size, buy: !!r.is_bid_aggressor, aoid: r.aggressor_order_id ?? undefined, poid: r.passive_order_id ?? undefined });
  for (const r of mb) evs.push({ ts: Number(r.ts_ms), kind: r.action, pi: r.price_int, sz: r.size, buy: false, oid: r.order_id ?? undefined, bid: !!r.is_bid });
  for (const r of dp) evs.push({ ts: Number(r.ts_ms), kind: 'depth', pi: r.price_int, sz: r.size, buy: false, bid: !!r.is_bid });
  // book updates before trades at same ts — comparator must be CONSISTENT (the old
  // `a.kind==='trade' ? 1 : -1` returned -1 for BOTH orders of two book events = UB in V8 sort)
  const rank = (k: string): number => (k === 'trade' ? 1 : 0);
  evs.sort((a, b) => a.ts - b.ts || rank(a.kind) - rank(b.kind));
  return evs;
}

// mode 'rth' (default): record inside RTH into all + open/mid/late. mode 'overnight': record
// everything outside RTH into the overnight bucket only (its own market, its own thresholds).
// recFrom = warmup gate — state builds from the window start, nothing records before recFrom.
function processDay(evs: Ev[], M: Store, T0: number, recFrom = T0, mode: 'rth' | 'overnight' = 'rth'): void {
  const openEnd = T0 + 45 * 60_000;                 // 10:15 ET
  const lateStart = T0 + 5.5 * 3600_000;            // 15:00 ET
  const rthEnd = T0 + 6.5 * 3600_000;               // 16:00 ET
  const bucketOf = (ts: number): Bucket => (ts < openEnd ? 'open' : ts >= lateStart ? 'late' : 'mid');
  const rec = (m: Metric, ts: number, v: number): void => {
    if (ts < recFrom) return;
    if (mode === 'overnight') {
      if (ts >= T0 && ts < rthEnd) return;   // boundary guard — RTH samples never leak in
      M[m].overnight.push(v);
      return;
    }
    if (ts < T0 || ts >= rthEnd) return;
    M[m].all.push(v); M[m][bucketOf(ts)].push(v);
  };

  const orders = new Map<string, { p: number; disp: number; ts: number; bid: boolean }>();
  const recentFill = new Map<number, { ts: number; bid: boolean }>();
  const native = new Map<string, { p: number; maxDisp: number; cf: number; emitted: number; ts: number }>();
  // AUTHORITATIVE displayed depth per side, fed by the L2 depth stream (live-engine parity).
  // The order stream below is used ONLY for refill/native/iceberg bookkeeping, never book state.
  const bidDepth = new Map<number, number>();
  const askDepth = new Map<number, number>();
  // EPISODIC synthetic iceberg — mirrors the live engine.
  type Ep = { pi: number; bid: boolean; t0: number; traded: number; refills: number; pending: Set<string>; dispCur: number; dispSince: number; peakDisp: number; awaySince: number; pierceSince: number; lastFillTs: number; maxHidden: number };
  const eps = new Map<string, Ep>();
  const wait = new Map<string, string>();               // refill order_id → ep key
  const k2 = (pi: number, bid: boolean) => `${pi}|${bid ? 1 : 0}`;
  // Depth-event application (mirrors the live engine's `case 'depth'`): absolute size per
  // price+side, plus the iceberg persistent-peak gate and wall candidate tracking.
  const applyDepth = (pi: number, bid: boolean, sz: number, ts: number): void => {
    if (!Number.isFinite(pi) || !Number.isFinite(sz)) return;   // belt-and-braces vs corrupt rows
    const depth = bid ? bidDepth : askDepth;
    if (sz <= 0) depth.delete(pi); else depth.set(pi, sz);
    const ep = eps.get(k2(pi, bid));
    if (ep) {   // persistence gate: outgoing value counts toward peak only if it rested ≥ persistMs
      if (ts - ep.dispSince >= ICE_PERSIST && ep.dispCur > ep.peakDisp) ep.peakDisp = ep.dispCur;
      ep.dispCur = Math.max(0, sz); ep.dispSince = ts;
    }
    // WALL parity: candidate levels ≥ WALL_REG_MIN near the (sampled) touch; persistence-armed below
    const wk = (bid ? 1 : -1) * pi;
    const w = walls.get(wk);
    if (w) {
      w.cur = Math.max(0, sz);
      if (w.armed && w.cur > w.peak) w.peak = w.cur;
    } else if (sz >= WALL_REG_MIN && lastBest.bb != null && lastBest.ba != null) {
      const ref = bid ? lastBest.bb : lastBest.ba;   // touch is ≤ 2s stale — fine for a distribution
      if (Math.abs(pi - ref) <= WALL_NEAR) walls.set(wk, { ts, peak: sz, cur: sz, armed: false });
    }
  };
  const epHidden = (ep: Ep, ts: number): number => {
    if (ts - ep.dispSince >= ICE_PERSIST && ep.dispCur > ep.peakDisp) { ep.peakDisp = ep.dispCur; ep.dispSince = ts; }
    return Math.max(0, ep.traded - ep.peakDisp);
  };
  const closeEp = (key: string, ep: Ep, ts: number): void => {
    eps.delete(key);
    for (const id of ep.pending) wait.delete(id);
    if (ep.refills < MIN_REFILLS) return;    // record refill-QUALIFIED episodes (rec() gates RTH)
    rec('iceberg_ct', ts, Math.max(epHidden(ep, ts), ep.maxHidden));   // HIGH-WATER hidden (matches live)
    rec('iceberg_refills', ts, ep.refills);
    rec('iceberg_dur_s', ts, Math.round((ts - ep.t0) / 1000));
  };
  const resolveEps = (ts: number): void => {
    for (const [key, ep] of eps) {
      if (lastTradePi) {
        const beyond = ep.bid ? ep.pi - lastTradePi : lastTradePi - ep.pi;
        if (beyond > 0) {   // pierced — broke only when confirmed (depth or time)
          if (beyond >= ICE_BREAK_TICKS) { closeEp(key, ep, ts); continue; }
          if (!ep.pierceSince) ep.pierceSince = ts;
          else if (ts - ep.pierceSince >= ICE_BREAK_MS) { closeEp(key, ep, ts); continue; }
          ep.awaySince = 0;
          continue;
        }
        ep.pierceSince = 0;
        const away = ep.bid ? lastTradePi - ep.pi : ep.pi - lastTradePi;
        if (away >= ICE_LEAVE_TICKS) { if (!ep.awaySince) ep.awaySince = ts; if (ts - ep.awaySince >= ICE_LEAVE_MS) { closeEp(key, ep, ts); continue; } }
        else ep.awaySince = 0;
      }
      if (ts - Math.max(ep.lastFillTs, ep.t0) >= ICE_IDLE) closeEp(key, ep, ts);
    }
  };
  // AGGRESSOR-grouped block/sweep (parity with feat.aggrAgg): fills grouped per aggressor order,
  // falling back to same-direction bursts within SWEEP_GAP when the id is absent.
  let aggr: { aid: string; dir: number; prices: Set<number>; size: number; lastTs: number } | null = null;
  const closeAggr = (): void => {
    const g = aggr; aggr = null;
    if (!g) return;
    if (g.prices.size >= SWEEP_LEVELS && g.size >= SWEEP_MIN) { rec('sweep_levels', g.lastTs, g.prices.size); rec('sweep_size', g.lastTs, g.size); }
    else if (g.size >= BLOCK_MIN) rec('block_ct', g.lastTs, g.size);
  };
  // wall tracking: key = signed pi (+bid/−ask); armed after WALL_PERSIST at/above WALL_REG_MIN
  const walls = new Map<number, { ts: number; peak: number; cur: number; armed: boolean }>();
  const lastBest: { bb: number | null; ba: number | null } = { bb: null, ba: null };
  const scanBest = (): void => {
    let bb = -Infinity, ba = Infinity;
    for (const k of bidDepth.keys()) if (k > bb) bb = k;
    for (const k of askDepth.keys()) if (k < ba) ba = k;
    lastBest.bb = Number.isFinite(bb) ? bb : null;
    lastBest.ba = Number.isFinite(ba) ? ba : null;
  };
  // absorption |ΣOFI| (approximate: L1 OFI over the 2s-sampled quote series)
  let prevQ: { bp: number; bs: number; ap: number; as: number } | null = null;
  const absWin: { ts: number; ofi: number }[] = [];

  const trades: { ts: number; pi: number; buy: boolean; sz: number }[] = [];
  let lastFoot = 0, lastFlow = 0, lastBook = 0, lastDepthSample = 0, lastTradePi = 0;
  // stop-run parity state: minute-bucket rolling extremes + session H/L + cascade candidate +
  // per-side arrival intensities (Hawkes gate)
  const srMin = new Map<number, { hi: number; lo: number }>();
  let srHi = 0, srLo = 0;
  let srCand: { dir: number; refPi: number; t0: number; lastTs: number; vol: number; ids: Set<string> } | null = null;
  const srFired = new Map<string, number>();
  const srSeen = new Map<string, number>();
  const srArr = { 1: { f: newIntensity(), s: newIntensity() }, [-1]: { f: newIntensity(), s: newIntensity() } } as Record<number, { f: ReturnType<typeof newIntensity>; s: ReturnType<typeof newIntensity> }>;

  for (const e of evs) {
    const ts = e.ts;
    const rth = ts >= recFrom;   // "recording live" gate — rec() does the session routing
    if (e.kind === 'depth') {
      applyDepth(e.pi, !!e.bid, e.sz, ts);
      // Book-state sampling is DEPTH-PACED: a depth event is a book-consistent instant. Sampling
      // on trades (runs 1–4) hits the microseconds right after a print, before the follow-up book
      // updates land — the book reads transiently crossed at exactly those moments and near all
      // imb/OFI samples were discarded (imb_abs n≈0 while depth-paced probes passed 63%).
      if (ts - lastBook >= FLOW_SAMPLE) {
        lastBook = ts;
        scanBest();
        if (lastBest.bb != null && lastBest.ba != null && lastBest.ba > lastBest.bb) {
          // near-touch imbalance (confluence BOOK floor input)
          let bidN = 0, askN = 0;
          for (const [k, s] of bidDepth) if (k <= lastBest.bb && k >= lastBest.bb - IMB_TICKS) bidN += s;
          for (const [k, s] of askDepth) if (k >= lastBest.ba && k <= lastBest.ba + IMB_TICKS) askN += s;
          if (rth) rec('imb_abs', ts, Math.abs(bidN - askN));
          // absorption |ΣOFI| over the rolling window (L1 rule on the sampled quote series)
          const q = { bp: lastBest.bb, bs: bidDepth.get(lastBest.bb)!, ap: lastBest.ba, as: askDepth.get(lastBest.ba)! };
          if (prevQ) {
            let bidC: number;
            if (q.bp > prevQ.bp) bidC = q.bs; else if (q.bp < prevQ.bp) bidC = -prevQ.bs; else bidC = q.bs - prevQ.bs;
            let askC: number;
            if (q.ap < prevQ.ap) askC = -q.as; else if (q.ap > prevQ.ap) askC = prevQ.as; else askC = -(q.as - prevQ.as);
            absWin.push({ ts, ofi: bidC + askC });
            let ci = 0; while (ci < absWin.length && absWin[ci]!.ts < ts - ABS_WIN) ci++; if (ci) absWin.splice(0, ci);
            const cum = absWin.reduce((s, w) => s + w.ofi, 0);
            if (rth && cum !== 0) rec('absorption_ofi', ts, Math.abs(cum));
          }
          prevQ = q;
          // per-level near-touch depth (wall K×median floor input) — 10s cadence
          if (ts - lastDepthSample >= DEPTH_SAMPLE) {
            lastDepthSample = ts;
            if (rth) {
              for (const [k, s] of bidDepth) if (k <= lastBest.bb && k >= lastBest.bb - DEPTH_BAND) rec('level_depth', ts, s);
              for (const [k, s] of askDepth) if (k >= lastBest.ba && k <= lastBest.ba + DEPTH_BAND) rec('level_depth', ts, s);
            }
          }
        }
      }
    } else if (e.kind === 'send') {
      orders.set(e.oid!, { p: e.pi, disp: e.sz, ts, bid: !!e.bid });
      native.set(e.oid!, { p: e.pi, maxDisp: e.sz, cf: 0, emitted: 0, ts });
      // machine-latency refill post → pending until it TRADES (pull ⇒ never counts)
      const ff = recentFill.get(e.pi);
      if (ff && ff.bid === !!e.bid && ts - ff.ts <= REFILL_MS) {
        rec('refill_lat_ms', ts, ts - ff.ts);
        const key = k2(e.pi, !!e.bid);
        let ep = eps.get(key);
        if (!ep) { ep = { pi: e.pi, bid: !!e.bid, t0: ts, traded: 0, refills: 0, pending: new Set(), dispCur: (e.bid ? bidDepth : askDepth).get(e.pi) ?? 0, dispSince: ts, peakDisp: 0, awaySince: 0, pierceSince: 0, lastFillTs: ts, maxHidden: 0 }; eps.set(key, ep); }
        ep.pending.add(e.oid!); wait.set(e.oid!, key);
      }
    } else if (e.kind === 'replace') {
      const o = orders.get(e.oid!);
      if (o) { o.p = e.pi; o.disp = e.sz; }
      const n = native.get(e.oid!); if (n) { if (e.sz > n.maxDisp) n.maxDisp = e.sz; n.p = e.pi; n.ts = ts; }
    } else if (e.kind === 'cancel') {
      const o = orders.get(e.oid!);
      if (o) orders.delete(e.oid!);
      const n = native.get(e.oid!); if (n && n.emitted > 0) { rec('native_ct', ts, n.cf); } native.delete(e.oid!);
      const wk = wait.get(e.oid!);
      if (wk) { wait.delete(e.oid!); eps.get(wk)?.pending.delete(e.oid!); }
    }
    else if (e.kind === 'trade') {
      const size = e.sz, dir = e.buy ? 1 : -1;
      // STOP RUN (before extremes roll): breach of session/rolling ref + distinct-aggressor cascade
      {
        // arrival stream: first fill per distinct aggressor id (Hawkes gate parity)
        if (e.aoid && ts - (srSeen.get(e.aoid) ?? -Infinity) > SR_CASCADE_MS) {
          const a = srArr[dir]!;
          arrive(a.f, ts, SR_TAU_FAST);
          arrive(a.s, ts, SR_TAU_SLOW);
        }
        if (e.aoid) srSeen.set(e.aoid, ts);
        const c = srCand;
        if (c && c.dir === dir && ts - c.lastTs <= SR_CASCADE_MS && (dir > 0 ? e.pi > c.refPi : e.pi < c.refPi)) {
          c.lastTs = ts; c.vol += size;
          if (e.aoid) c.ids.add(e.aoid);
          if (c.ids.size >= SR_MIN_IDS && c.vol >= SR_MINVOL) {
            const a = srArr[dir]!;
            const burst = burstRatio(a.f, a.s, ts, SR_TAU_FAST, SR_TAU_SLOW, SR_MIN_BASE_N);
            if (burst == null || burst >= SR_MIN_BURST) {
              const zone = `${c.dir}:${Math.round(c.refPi / 8)}`;
              if (ts - (srFired.get(zone) ?? -Infinity) >= SR_THROTTLE) {
                srFired.set(zone, ts);
                rec('stoprun_ct', ts, c.vol); rec('stoprun_ids', ts, c.ids.size);
                if (burst != null) rec('stoprun_burst', ts, +burst.toFixed(1));
              }
              srCand = null;
            }
          }
        } else if (!c || ts - c.lastTs > SR_CASCADE_MS || c.dir !== dir) {
          let refPi = 0;
          if (dir > 0 && srHi > 0 && e.pi > srHi) refPi = srHi;
          else if (dir < 0 && srLo > 0 && e.pi < srLo) refPi = srLo;
          else {
            let ext = dir > 0 ? -Infinity : Infinity;
            for (const b of srMin.values()) ext = dir > 0 ? Math.max(ext, b.hi) : Math.min(ext, b.lo);
            if (Number.isFinite(ext) && (dir > 0 ? e.pi > ext : e.pi < ext)) refPi = ext;
          }
          if (refPi) srCand = { dir, refPi, t0: ts, lastTs: ts, vol: size, ids: new Set(e.aoid ? [e.aoid] : []) };
        }
        // roll extremes AFTER the breach test
        const mKey = Math.floor(ts / 60_000);
        let b = srMin.get(mKey);
        if (!b) { b = { hi: e.pi, lo: e.pi }; srMin.set(mKey, b); const cut = mKey - Math.ceil(SR_REF_WIN / 60_000); for (const k of srMin.keys()) if (k < cut) srMin.delete(k); }
        if (e.pi > b.hi) b.hi = e.pi;
        if (e.pi < b.lo) b.lo = e.pi;
        if (e.pi > srHi) srHi = e.pi;
        if (e.pi < srLo || srLo === 0) srLo = e.pi;
      }
      trades.push({ ts, pi: e.pi, buy: e.buy, sz: size }); lastTradePi = e.pi;
      // aggressor group (block/sweep unified — one primitive)
      {
        const aid = e.aoid ?? '';
        const same = aggr && aggr.dir === dir && ts - aggr.lastTs <= SWEEP_GAP &&
          (aggr.aid !== '' && aid !== '' ? aggr.aid === aid : true);
        if (same) { aggr!.prices.add(e.pi); aggr!.size += size; aggr!.lastTs = ts; if (aid) aggr!.aid = aid; }
        else { closeAggr(); aggr = { aid, dir, prices: new Set([e.pi]), size, lastTs: ts }; }
      }
      // iceberg episode accumulation (passive side = opposite of aggressor) + refill confirmation
      const ep = eps.get(k2(e.pi, !e.buy));
      if (ep) {
        ep.traded += size; ep.lastFillTs = ts;
        if (e.poid && ep.pending.has(e.poid)) { ep.pending.delete(e.poid); wait.delete(e.poid); ep.refills++; }
        const h = epHidden(ep, ts); if (h > ep.maxHidden) ep.maxHidden = h;
      }
      // aggressor fills consume the aggressor's own order (keeps the orders map honest; book
      // state itself comes from the depth stream now)
      if (e.aoid) {
        const o = orders.get(e.aoid);
        if (o) { if (o.disp <= size) orders.delete(e.aoid); else o.disp -= size; }
      }
      // passive fills → recentFill arming + native tracking (book state comes from depth)
      if (e.poid) {
        const o = orders.get(e.poid);
        if (o) {
          if (o.disp <= size) { recentFill.set(o.p, { ts, bid: o.bid }); orders.delete(e.poid); } else o.disp -= size;
        }
        const n = native.get(e.poid);
        if (n) { n.cf += size; n.ts = ts; if (n.cf - n.maxDisp >= NAT_HIDDEN && n.cf - n.emitted >= NAT_CUM) n.emitted = n.cf; }   // mark qualified; PEAK recorded on cancel/day-end
      }
      // footprint eval (stacked, trapped) + episode/wall lifecycle — event-time paced
      if (ts - lastFoot >= FOOT_TICK) {
        lastFoot = ts;
        resolveEps(ts);
        let cut = 0; while (cut < trades.length && trades[cut]!.ts < ts - FOOT_WIN) cut++; if (cut) trades.splice(0, cut);
        // wall arming/resolution (persistence parity; record peak when the wall retires)
        for (const [wk, w] of walls) {
          if (!w.armed) {
            if (w.cur >= WALL_REG_MIN) { if (ts - w.ts >= WALL_PERSIST) { w.armed = true; w.peak = w.cur; } }
            else { walls.delete(wk); continue; }
          }
          if (w.armed && (w.cur <= 0.2 * w.peak || ts - w.ts > 20 * 60_000)) { rec('wall_peak', ts, w.peak); walls.delete(wk); }
        }
        // stacked
        const fp = new Map<number, { buy: number; sell: number }>(); const from = ts - STACK_WIN;
        for (const t of trades) { if (t.ts < from) continue; let x = fp.get(t.pi); if (!x) { x = { buy: 0, sell: 0 }; fp.set(t.pi, x); } if (t.buy) x.buy += t.sz; else x.sell += t.sz; }
        const g = (p: number) => fp.get(p) ?? { buy: 0, sell: 0 };
        const prices = [...fp.keys()].sort((a, b) => a - b);
        for (const d of [1, -1]) {
          const imb = (p: number) => d > 0 ? (g(p).buy >= STACK_MINVOL && g(p).buy >= STACK_RATIO * g(p - 1).sell) : (g(p).sell >= STACK_MINVOL && g(p).sell >= STACK_RATIO * g(p + 1).buy);
          let run: number[] = [], best: number[] = [];
          for (const p of prices) { const cont = run.length === 0 || p === run[run.length - 1]! + 1; if (imb(p) && cont) run.push(p); else { if (run.length > best.length) best = run; run = imb(p) ? [p] : []; } }
          if (run.length > best.length) best = run;
          if (rth && best.length >= STACK_LEVELS) { rec('stacked_levels', ts, best.length); rec('stacked_vol', ts, best.reduce((s, p) => s + (d > 0 ? g(p).buy : g(p).sell), 0)); }
        }
        // trapped
        const tw = trades.filter((t) => t.ts >= ts - TRAP_WIN);
        if (rth && tw.length >= 2) {
          const hi = Math.max(...tw.map((t) => t.pi)), lo = Math.min(...tw.map((t) => t.pi));
          if (lastTradePi <= hi - TRAP_TICKS) { const tHi = Math.max(...tw.filter((t) => t.pi >= hi - 1).map((t) => t.ts)); const b = tw.filter((t) => t.buy && t.pi >= hi - 2 && Math.abs(t.ts - tHi) <= TRAP_BURST_MS).reduce((s, t) => s + t.sz, 0); if (b >= TRAP_MINBURST) rec('trapped_ct', ts, b); }
          if (lastTradePi >= lo + TRAP_TICKS) { const tLo = Math.max(...tw.filter((t) => t.pi <= lo + 1).map((t) => t.ts)); const b = tw.filter((t) => !t.buy && t.pi <= lo + 2 && Math.abs(t.ts - tLo) <= TRAP_BURST_MS).reduce((s, t) => s + t.sz, 0); if (b >= TRAP_MINBURST) rec('trapped_ct', ts, b); }
        }
      }
      // flow |delta| — trade-paced (2s of trade time)
      if (ts - lastFlow >= FLOW_SAMPLE) {
        lastFlow = ts;
        let del = 0; const f2 = ts - FLOW_WIN;
        for (let i = trades.length - 1; i >= 0; i--) { if (trades[i]!.ts < f2) break; del += trades[i]!.buy ? trades[i]!.sz : -trades[i]!.sz; }
        if (rth && del !== 0) rec('flow_delta', ts, Math.abs(del));
      }
    }
  }
  const tEnd = evs.length ? evs[evs.length - 1]!.ts : 0;
  closeAggr();
  // flush episodes/natives/walls still open at session end
  for (const [key, ep] of eps) closeEp(key, ep, tEnd);
  for (const n of native.values()) if (n.emitted > 0) rec('native_ct', tEnd, n.cf);
  for (const w of walls.values()) if (w.armed) rec('wall_peak', tEnd, w.peak);
}

async function main(): Promise<void> {
  const cal: any = {};
  for (const symbol of ['NQ', 'ES']) {
    const days: any[] = await query(`SELECT DISTINCT date::VARCHAR d FROM mbo_events WHERE symbol='${symbol}' ORDER BY d`);
    const M = newStore();
    for (const { d } of days) {
      const t0 = Date.now();
      const base = Date.parse(d + 'T00:00:00Z');
      const T0 = base + 13.5 * 3600_000;
      // PASS 1 — RTH (unchanged semantics: warmup lead-in, records 09:30–16:00 → all + open/mid/late)
      let evs = await loadDay(symbol, d);
      const nRth = evs.length;
      if (nRth >= 5000) processDay(evs, M, T0);
      // PASS 2 — overnight AM (00:00 UTC → RTH open; fresh book, 30-min warmup)
      evs = await loadDay(symbol, d, base, T0);
      const nAm = evs.length;
      if (nAm >= 5000) processDay(evs, M, T0, base + 30 * 60_000, 'overnight');
      // PASS 3 — overnight PM (16:00 ET close → midnight UTC; fresh book, 30-min warmup)
      evs = await loadDay(symbol, d, base + 20 * 3600_000, base + 24 * 3600_000);
      const nPm = evs.length;
      if (nPm >= 5000) processDay(evs, M, T0, base + 20.5 * 3600_000, 'overnight');
      evs = [];   // release before the next day's load
      if (nRth < 5000 && nAm < 5000 && nPm < 5000) { console.error(`  ${symbol} ${d} skip (thin)`); continue; }
      console.error(`  ${symbol} ${d} rth=${nRth} ovnAM=${nAm} ovnPM=${nPm} ice=${M.iceberg_ct.all.length}/${M.iceberg_ct.overnight.length} swp=${M.sweep_size.all.length}/${M.sweep_size.overnight.length} imb=${M.imb_abs.all.length}/${M.imb_abs.overnight.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
    const out: any = { tod: { open: {}, mid: {}, late: {}, overnight: {} } };
    for (const m of METRICS) {
      out[m] = pctls(M[m].all);
      for (const b of ['open', 'mid', 'late', 'overnight'] as const) out.tod[b][m] = pctls(M[m][b]);
    }
    cal[symbol] = out;
    console.error(`==== ${symbol} done: ${days.length} days ====`);
  }
  cal._meta = {
    computed: 'parquet, front-month, 30-min warmups; RTH → all + open(09:30–10:15)/mid/late(15:00–16:00) ET; ' +
      'OVERNIGHT bucket = everything outside RTH, replayed in two passes (00:00 UTC→open, 16:00 ET→24:00 UTC) — ' +
      'its own threshold set, auto-selected by the loader at night',
    metrics: 'book state = AUTHORITATIVE mbo_depth stream (live-engine parity; order-stream reconstruction is not ' +
      'self-healing — phantom levels crossed the book permanently, first run sampled imb n=0); ' +
      'block/sweep AGGRESSOR-grouped (parity w/ feat.aggrAgg); iceberg_ct = EPISODIC high-water hidden; ' +
      'level_depth = near-touch resting per-level size (wall K×median floor input); imb_abs = near-touch |bid−ask| (±8t); ' +
      'wall_peak = persist-gated (1.5s) armed peaks; absorption_ofi = |ΣOFI| over 4s, L1 rule on 2s-sampled quotes ' +
      '(APPROXIMATE — live samples best-quote changes at 100ms and can use multi-level OFI; scale parity only); ' +
      'refill_lat_ms = fill→repost latency of qualifying iceberg refill posts',
  };
  fs.writeFileSync(OUT, JSON.stringify(cal, null, 2));
  console.log('wrote', OUT);
  console.log(JSON.stringify(cal, null, 2));
  process.exit(0);
}
main();
