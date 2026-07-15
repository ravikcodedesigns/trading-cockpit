// DEBUG harness for the episodic synthetic-iceberg detector — replays the tail of a live capture
// log through the same episode logic with counters, to see where NQ episodes die (refill gate vs
// hidden-size gate vs lifecycle). Read-only; run ad hoc:
//   pnpm --filter @trading/aggregator exec tsx scripts/ice_ep_debug.ts <SUFFIX> <tailMB>
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const SUFFIX = process.argv[2] ?? 'NQU6';
const TAIL_MB = Number(process.argv[3] ?? 200);
const CFG = { refillMs: 500, minRefills: 4, minHidden: 40, persistMs: 400, leaveTicks: 3, leaveMs: 15_000, idleMs: 120_000 };

const dir = `${process.env.HOME}/cockpit-mbo-capture`;
const log = fs.readdirSync(dir).filter((f) => f.includes(`-${SUFFIX}_`) && f.endsWith('.log')).sort().pop()!;
const path = `${dir}/${log}`;
const sz = fs.statSync(path).size;
console.log(`replaying last ${TAIL_MB}MB of ${log} (${(sz / 1e9).toFixed(1)}GB)`);
const raw = execSync(`tail -c ${TAIL_MB * 1024 * 1024} "${path}"`, { maxBuffer: (TAIL_MB + 64) * 1024 * 1024 }).toString();
const lines = raw.split('\n').slice(1);

interface Ep { pi: number; bid: boolean; t0: number; traded: number; refills: number; pending: Set<string>; dispCur: number; dispSince: number; peakDisp: number; awaySince: number; lastFillTs: number; qualified: boolean; maxHidden: number; maxRefills: number; }
const eps = new Map<string, Ep>();
const wait = new Map<string, string>();
const orders = new Map<string, { p: number; disp: number; bid: boolean }>();
const recentFill = new Map<number, { ts: number; bid: boolean }>();
const bidSz = new Map<number, number>(); const askSz = new Map<number, number>();
let lastTradePi = 0;
const key = (pi: number, bid: boolean) => `${pi}|${bid ? 1 : 0}`;

// death-reason tallies for CLOSED episodes
const dead = { qualified: 0, refillsShort: 0, hiddenShort: 0, both: 0 };
const qualifiedHidden: number[] = [];
const refillOkHidden: number[] = [];   // maxHidden of every episode that reached minRefills — floor-setting preview
let created = 0, refillPosts = 0, refillConfirms = 0, refillPulled = 0;
let sends = 0, trades = 0, t0 = 0, t1 = 0;

function hidden(ep: Ep, ts: number): number {
  if (ts - ep.dispSince >= CFG.persistMs && ep.dispCur > ep.peakDisp) { ep.peakDisp = ep.dispCur; ep.dispSince = ts; }
  return Math.max(0, ep.traded - ep.peakDisp);
}
function close(k: string, ep: Ep, ts: number): void {
  eps.delete(k);
  for (const id of ep.pending) wait.delete(id);
  const h = Math.max(ep.maxHidden, hidden(ep, ts));
  if (ep.maxRefills >= CFG.minRefills) refillOkHidden.push(h);
  if (ep.qualified) { dead.qualified++; qualifiedHidden.push(h); }
  else if (ep.maxRefills < CFG.minRefills && h < CFG.minHidden) dead.both++;
  else if (ep.maxRefills < CFG.minRefills) dead.refillsShort++;
  else dead.hiddenShort++;
}
function tick(ts: number): void {   // lifecycle resolve (the live engine does this at 500ms cadence)
  for (const [k, ep] of eps) {
    if (lastTradePi) {
      if (ep.bid ? lastTradePi < ep.pi : lastTradePi > ep.pi) { close(k, ep, ts); continue; }
      const away = ep.bid ? lastTradePi - ep.pi : ep.pi - lastTradePi;
      if (away >= CFG.leaveTicks) { if (!ep.awaySince) ep.awaySince = ts; if (ts - ep.awaySince >= CFG.leaveMs) { close(k, ep, ts); continue; } }
      else ep.awaySince = 0;
    }
    if (ts - Math.max(ep.lastFillTs, ep.t0) >= CFG.idleMs) close(k, ep, ts);
  }
}

let lastTick = 0;
for (const line of lines) {
  if (!line) continue;
  let ev: any; try { ev = JSON.parse(line); } catch { continue; }
  const d = ev.data, ts = ev.ts_ms;
  if (!t0) t0 = ts; t1 = ts;
  if (ts - lastTick >= 500) { tick(ts); lastTick = ts; }
  switch (ev.kind) {
    case 'mbo_send': {
      sends++;
      orders.set(d.order_id, { p: d.price_int, disp: d.size, bid: !!d.is_bid });
      const ff = recentFill.get(d.price_int);
      if (ff && ff.bid === !!d.is_bid && ts - ff.ts <= CFG.refillMs) {
        refillPosts++;
        const k = key(d.price_int, !!d.is_bid);
        let ep = eps.get(k);
        if (!ep) { created++; ep = { pi: d.price_int, bid: !!d.is_bid, t0: ts, traded: 0, refills: 0, pending: new Set(), dispCur: (d.is_bid ? bidSz : askSz).get(d.price_int) ?? 0, dispSince: ts, peakDisp: 0, awaySince: 0, lastFillTs: ts, qualified: false, maxHidden: 0, maxRefills: 0 }; eps.set(k, ep); }
        ep.pending.add(d.order_id); wait.set(d.order_id, k);
      }
      break;
    }
    case 'mbo_replace': { const o = orders.get(d.order_id); if (o) { o.p = d.price_int; o.disp = d.size; } break; }
    case 'mbo_cancel': {
      orders.delete(d.order_id);
      const wk = wait.get(d.order_id);
      if (wk) { wait.delete(d.order_id); eps.get(wk)?.pending.delete(d.order_id); refillPulled++; }
      break;
    }
    case 'trade': {
      const size = d.size as number; if (!(size > 0)) break;
      trades++;
      lastTradePi = d.price_int;
      const buy = !!d.is_bid_aggressor;
      const ep = eps.get(key(d.price_int, !buy));
      if (ep) {
        ep.traded += size; ep.lastFillTs = ts;
        if (d.passive_order_id && ep.pending.has(d.passive_order_id)) { ep.pending.delete(d.passive_order_id); wait.delete(d.passive_order_id); ep.refills++; refillConfirms++; if (ep.refills > ep.maxRefills) ep.maxRefills = ep.refills; }
        const h = hidden(ep, ts); if (h > ep.maxHidden) ep.maxHidden = h;
        if (ep.refills >= CFG.minRefills && h >= CFG.minHidden) ep.qualified = true;
      }
      if (d.passive_order_id) {
        const o = orders.get(d.passive_order_id);
        if (o) { if (o.disp <= size) { recentFill.set(o.p, { ts, bid: o.bid }); orders.delete(d.passive_order_id); } else o.disp -= size; }
      }
      break;
    }
    case 'depth': {
      const map = d.is_bid ? bidSz : askSz;
      if (!d.size) map.delete(d.price_int); else map.set(d.price_int, d.size);
      const ep = eps.get(key(d.price_int, !!d.is_bid));
      if (ep) { if (ts - ep.dispSince >= CFG.persistMs && ep.dispCur > ep.peakDisp) ep.peakDisp = ep.dispCur; ep.dispCur = d.size; ep.dispSince = ts; }
      break;
    }
  }
}
for (const [k, ep] of eps) close(k, ep, t1);

console.log(`span ${((t1 - t0) / 60000).toFixed(1)} min | sends ${sends} trades ${trades}`);
console.log(`episodes created: ${created} | refill posts ${refillPosts} → confirmed ${refillConfirms}, pulled-unfilled ${refillPulled}`);
console.log(`deaths — QUALIFIED: ${dead.qualified} | refills<${CFG.minRefills}: ${dead.refillsShort} | hidden<${CFG.minHidden}: ${dead.hiddenShort} | both short: ${dead.both}`);
for (const [label, arr] of [['qualified', qualifiedHidden], ['refills-OK (floor preview)', refillOkHidden]] as const) {
  if (!arr.length) continue;
  arr.sort((a, b) => a - b);
  const q = (p: number) => arr[Math.floor(p * (arr.length - 1))];
  console.log(`${label} n=${arr.length} — maxHidden p20 ${q(0.2)} p50 ${q(0.5)} p80 ${q(0.8)} p95 ${q(0.95)} p99 ${q(0.99)} max ${arr[arr.length - 1]}`);
}
