// TAPE calibration (Part 1: trade/order metrics) — replays the live detectors over the parquet MBO
// store (RTH, all captured days, per symbol) and computes the empirical distribution of each event's
// magnitude parameter → percentile breakpoints for the confluence size-scoring. Data-driven: the
// thresholds come from what actually occurs on each symbol, not guessed numbers.
//
//   metrics: iceberg contracts/refills · sweep levels/size · block ct · stacked levels/vol · trapped ct · flow |delta|
//   (depth-based absorption/wall/imbalance are Part 2 — they need the full depth stream)
import { query } from '../src/lib/mbo-reader.js';
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
// detector params (mirror tape-engine defaults)
// iceberg = EPISODIC (2026-07-14 redesign): fill-confirmed machine-latency refills qualify;
// size = traded − peak persistent displayed; held/broke lifecycle. NO minHidden floor here —
// we record every refill-qualified episode's final hidden size; the floor is SET from these
// distributions. Displayed depth is reconstructed from the order stream (Σ resting disp per
// price+side), seeded by a 30-min pre-RTH warmup.
const REFILL_MS = 500, MIN_REFILLS = 4, ICE_PERSIST = 400, ICE_LEAVE_TICKS = 3, ICE_LEAVE_MS = 15_000, ICE_IDLE = 120_000;
const ICE_BREAK_TICKS = 3, ICE_BREAK_MS = 4_000;   // broke needs confirmation — 1-tick sweeps that snap back stay alive
const NAT_HIDDEN = 10, NAT_CUM = 40;
const WARMUP_MS = 30 * 60_000;
const SWEEP_GAP = 100, SWEEP_LEVELS = 3, SWEEP_MIN = 5;
const BLOCK_MIN = 25;
const FOOT_WIN = 90_000, FOOT_TICK = 500;
const STACK_RATIO = 3, STACK_LEVELS = 3, STACK_MINVOL = 10, STACK_WIN = 90_000;
const TRAP_BURST_MS = 3000, TRAP_TICKS = 12, TRAP_WIN = 20_000, TRAP_MINBURST = 30;
const FLOW_WIN = 25_000, FLOW_SAMPLE = 2000;   // sample rolling |delta| every 2s

type Ev = { ts: number; kind: string; pi: number; sz: number; buy: boolean; oid?: string; poid?: string; bid?: boolean };

function pctl(a: number[], p: number): number { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]!; }

async function loadDay(symbol: string, day: string): Promise<Ev[]> {
  const base = Date.parse(day + 'T00:00:00Z');
  const T0 = base + 13.5 * 3600_000, T1 = base + 20 * 3600_000;   // RTH (EDT)
  const c = await frontContract(symbol, day);
  if (!c) return [];
  // load from T0−warmup so pre-RTH resting orders seed the reconstructed book; processDay
  // gates metric RECORDING on ts ≥ T0 (state builds through the warmup, nothing is recorded).
  const tr: any[] = await query(`SELECT ts_ms, price_int, size, is_bid_aggressor, passive_order_id FROM mbo_trades WHERE symbol='${symbol}' AND contract='${c}' AND ts_ms BETWEEN ${T0 - WARMUP_MS} AND ${T1} AND size>0 ORDER BY ts_ms`);
  const mb: any[] = await query(`SELECT ts_ms, action, order_id, price_int, size, is_bid FROM mbo_events WHERE symbol='${symbol}' AND contract='${c}' AND ts_ms BETWEEN ${T0 - WARMUP_MS} AND ${T1} ORDER BY ts_ms`);
  const evs: Ev[] = [];
  for (const r of tr) evs.push({ ts: Number(r.ts_ms), kind: 'trade', pi: r.price_int, sz: r.size, buy: !!r.is_bid_aggressor, poid: r.passive_order_id ?? undefined });
  for (const r of mb) evs.push({ ts: Number(r.ts_ms), kind: r.action, pi: r.price_int, sz: r.size, buy: false, oid: r.order_id ?? undefined, bid: !!r.is_bid });
  evs.sort((a, b) => a.ts - b.ts || (a.kind === 'trade' ? 1 : -1));   // book updates before trades at same ts
  return evs;
}

function processDay(evs: Ev[], M: Record<string, number[]>, T0: number): void {
  const orders = new Map<string, { p: number; disp: number; ts: number; bid: boolean }>();
  const recentFill = new Map<number, { ts: number; bid: boolean }>();
  const native = new Map<string, { p: number; maxDisp: number; cf: number; emitted: number; ts: number }>();
  // EPISODIC synthetic iceberg — mirrors the live engine. Displayed depth is reconstructed from
  // resting orders: agg(price,side) = Σ disp, updated on send/cancel/replace/fill.
  type Ep = { pi: number; bid: boolean; t0: number; traded: number; refills: number; pending: Set<string>; dispCur: number; dispSince: number; peakDisp: number; awaySince: number; pierceSince: number; lastFillTs: number; maxHidden: number };
  const eps = new Map<string, Ep>();
  const wait = new Map<string, string>();               // refill order_id → ep key
  const agg = new Map<string, number>();                // (pi|side) → Σ resting displayed
  const k2 = (pi: number, bid: boolean) => `${pi}|${bid ? 1 : 0}`;
  const bump = (pi: number, bid: boolean, dSz: number, ts: number): void => {
    const k = k2(pi, bid);
    const next = (agg.get(k) ?? 0) + dSz;
    if (next <= 0) agg.delete(k); else agg.set(k, next);
    const ep = eps.get(k);
    if (ep) {   // persistence gate: outgoing value counts toward peak only if it rested ≥ persistMs
      if (ts - ep.dispSince >= ICE_PERSIST && ep.dispCur > ep.peakDisp) ep.peakDisp = ep.dispCur;
      ep.dispCur = Math.max(0, next); ep.dispSince = ts;
    }
  };
  const epHidden = (ep: Ep, ts: number): number => {
    if (ts - ep.dispSince >= ICE_PERSIST && ep.dispCur > ep.peakDisp) { ep.peakDisp = ep.dispCur; ep.dispSince = ts; }
    return Math.max(0, ep.traded - ep.peakDisp);
  };
  const closeEp = (key: string, ep: Ep, ts: number): void => {
    eps.delete(key);
    for (const id of ep.pending) wait.delete(id);
    if (ep.refills < MIN_REFILLS || ts < T0) return;    // record refill-QUALIFIED episodes, RTH only
    M.iceberg_ct!.push(Math.max(epHidden(ep, ts), ep.maxHidden));   // HIGH-WATER hidden (matches live engine)
    M.iceberg_refills!.push(ep.refills);
    M.iceberg_dur_s!.push(Math.round((ts - ep.t0) / 1000));
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
  let sweep: { dir: number; prices: Set<number>; size: number; lastTs: number } | null = null;
  const trades: { ts: number; pi: number; buy: boolean; sz: number }[] = [];
  let lastFoot = 0, lastFlow = 0, lastTradePi = 0;
  const closeSweep = (ts: number) => { if (sweep && ts >= T0 && sweep.prices.size >= SWEEP_LEVELS && sweep.size >= SWEEP_MIN) { M.sweep_levels!.push(sweep.prices.size); M.sweep_size!.push(sweep.size); } };

  for (const e of evs) {
    const ts = e.ts;
    const rth = ts >= T0;
    if (e.kind === 'send') {
      orders.set(e.oid!, { p: e.pi, disp: e.sz, ts, bid: !!e.bid });
      native.set(e.oid!, { p: e.pi, maxDisp: e.sz, cf: 0, emitted: 0, ts });
      bump(e.pi, !!e.bid, e.sz, ts);
      // machine-latency refill post → pending until it TRADES (pull ⇒ never counts)
      const ff = recentFill.get(e.pi);
      if (ff && ff.bid === !!e.bid && ts - ff.ts <= REFILL_MS) {
        const key = k2(e.pi, !!e.bid);
        let ep = eps.get(key);
        if (!ep) { ep = { pi: e.pi, bid: !!e.bid, t0: ts, traded: 0, refills: 0, pending: new Set(), dispCur: agg.get(key) ?? 0, dispSince: ts, peakDisp: 0, awaySince: 0, pierceSince: 0, lastFillTs: ts, maxHidden: 0 }; eps.set(key, ep); }
        ep.pending.add(e.oid!); wait.set(e.oid!, key);
      }
    } else if (e.kind === 'replace') {
      const o = orders.get(e.oid!);
      if (o) { bump(o.p, o.bid, -o.disp, ts); bump(e.pi, o.bid, e.sz, ts); o.p = e.pi; o.disp = e.sz; }
      const n = native.get(e.oid!); if (n) { if (e.sz > n.maxDisp) n.maxDisp = e.sz; n.p = e.pi; n.ts = ts; }
    } else if (e.kind === 'cancel') {
      const o = orders.get(e.oid!);
      if (o) { bump(o.p, o.bid, -o.disp, ts); orders.delete(e.oid!); }
      const n = native.get(e.oid!); if (n && n.emitted > 0 && ts >= T0) { M.native_ct!.push(n.cf); } native.delete(e.oid!);
      const wk = wait.get(e.oid!);
      if (wk) { wait.delete(e.oid!); eps.get(wk)?.pending.delete(e.oid!); }
    }
    else if (e.kind === 'trade') {
      const size = e.sz, dir = e.buy ? 1 : -1;
      trades.push({ ts, pi: e.pi, buy: e.buy, sz: size }); lastTradePi = e.pi;
      if (rth && size >= BLOCK_MIN) M.block_ct!.push(size);
      // sweep run
      if (sweep && sweep.dir === dir && ts - sweep.lastTs <= SWEEP_GAP) { sweep.prices.add(e.pi); sweep.size += size; sweep.lastTs = ts; }
      else { closeSweep(ts); sweep = { dir, prices: new Set([e.pi]), size, lastTs: ts }; }
      // iceberg episode accumulation (passive side = opposite of aggressor) + refill confirmation
      const ep = eps.get(k2(e.pi, !e.buy));
      if (ep) {
        ep.traded += size; ep.lastFillTs = ts;
        if (e.poid && ep.pending.has(e.poid)) { ep.pending.delete(e.poid); wait.delete(e.poid); ep.refills++; }
        const h = epHidden(ep, ts); if (h > ep.maxHidden) ep.maxHidden = h;
      }
      // passive fills → resting book decrement + recentFill arming + native tracking
      if (e.poid) {
        const o = orders.get(e.poid);
        if (o) {
          bump(o.p, o.bid, -Math.min(size, o.disp), ts);
          if (o.disp <= size) { recentFill.set(o.p, { ts, bid: o.bid }); orders.delete(e.poid); } else o.disp -= size;
        }
        const n = native.get(e.poid);
        if (n) { n.cf += size; n.ts = ts; if (n.cf - n.maxDisp >= NAT_HIDDEN && n.cf - n.emitted >= NAT_CUM) n.emitted = n.cf; }   // mark qualified; PEAK recorded on cancel/day-end
      }
      // footprint eval (stacked, trapped) + episode lifecycle — event-time paced
      if (ts - lastFoot >= FOOT_TICK) {
        lastFoot = ts;
        resolveEps(ts);
        let cut = 0; while (cut < trades.length && trades[cut]!.ts < ts - FOOT_WIN) cut++; if (cut) trades.splice(0, cut);
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
          if (rth && best.length >= STACK_LEVELS) { M.stacked_levels!.push(best.length); M.stacked_vol!.push(best.reduce((s, p) => s + (d > 0 ? g(p).buy : g(p).sell), 0)); }
        }
        // trapped
        const tw = trades.filter((t) => t.ts >= ts - TRAP_WIN);
        if (rth && tw.length >= 2) {
          const hi = Math.max(...tw.map((t) => t.pi)), lo = Math.min(...tw.map((t) => t.pi));
          if (lastTradePi <= hi - TRAP_TICKS) { const tHi = Math.max(...tw.filter((t) => t.pi >= hi - 1).map((t) => t.ts)); const b = tw.filter((t) => t.buy && t.pi >= hi - 2 && Math.abs(t.ts - tHi) <= TRAP_BURST_MS).reduce((s, t) => s + t.sz, 0); if (b >= TRAP_MINBURST) M.trapped_ct!.push(b); }
          if (lastTradePi >= lo + TRAP_TICKS) { const tLo = Math.max(...tw.filter((t) => t.pi <= lo + 1).map((t) => t.ts)); const b = tw.filter((t) => !t.buy && t.pi <= lo + 2 && Math.abs(t.ts - tLo) <= TRAP_BURST_MS).reduce((s, t) => s + t.sz, 0); if (b >= TRAP_MINBURST) M.trapped_ct!.push(b); }
        }
      }
      // flow |delta| sample
      if (ts - lastFlow >= FLOW_SAMPLE) { lastFlow = ts; let del = 0; const f2 = ts - FLOW_WIN; for (let i = trades.length - 1; i >= 0; i--) { if (trades[i]!.ts < f2) break; del += trades[i]!.buy ? trades[i]!.sz : -trades[i]!.sz; } if (rth && del !== 0) M.flow_delta!.push(Math.abs(del)); }
    }
  }
  const tEnd = evs.length ? evs[evs.length - 1]!.ts : 0;
  closeSweep(tEnd);
  // flush episodes/natives still open at session end
  for (const [key, ep] of eps) closeEp(key, ep, tEnd);
  for (const n of native.values()) if (n.emitted > 0) M.native_ct!.push(n.cf);
}

async function main(): Promise<void> {
  const cal: any = {};
  for (const symbol of ['NQ', 'ES']) {
    const days: any[] = await query(`SELECT DISTINCT date::VARCHAR d FROM mbo_events WHERE symbol='${symbol}' ORDER BY d`);
    const M: Record<string, number[]> = { iceberg_ct: [], iceberg_refills: [], iceberg_dur_s: [], native_ct: [], sweep_levels: [], sweep_size: [], block_ct: [], stacked_levels: [], stacked_vol: [], trapped_ct: [], flow_delta: [] };
    for (const { d } of days) {
      const t0 = Date.now();
      const evs = await loadDay(symbol, d);
      if (evs.length < 5000) { console.error(`  ${symbol} ${d} skip (${evs.length} evs)`); continue; }
      const base = Date.parse(d + 'T00:00:00Z');
      processDay(evs, M, base + 13.5 * 3600_000);
      console.error(`  ${symbol} ${d} evs=${evs.length} ice=${M.iceberg_ct!.length} nat=${M.native_ct!.length} swp=${M.sweep_size!.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
    const out: any = {};
    for (const [k, arr] of Object.entries(M)) out[k] = { n: arr.length, p20: pctl(arr, .2), p50: pctl(arr, .5), p80: pctl(arr, .8), p95: pctl(arr, .95), p99: pctl(arr, .99) };
    cal[symbol] = out;
    console.error(`==== ${symbol} done: ${days.length} days ====`);
  }
  cal._meta = {
    computed: 'RTH, parquet, front-month, 30-min warmup',
    metrics: 'trade/order (part 1) — iceberg_ct = EPISODIC hidden reserve (traded − peak persistent displayed) of refill-qualified episodes, NO floor; native_ct separate',
  };
  fs.writeFileSync(OUT, JSON.stringify(cal, null, 2));
  console.log('wrote', OUT);
  console.log(JSON.stringify(cal, null, 2));
  process.exit(0);
}
main();
