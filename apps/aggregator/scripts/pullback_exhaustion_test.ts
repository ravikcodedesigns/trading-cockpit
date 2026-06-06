// Pullback-Exhaustion LONG — empirical test
//
// Based on clean-impulse hunt discovery: 540 clean +12pt LONG impulses across
// 16 days had median feature pattern:
//   - vwap_dist = -8.0 (price below 5min VWAP)
//   - net_aggressor_60s = -368 (preceded by seller aggression)
//   - range_5min = 16.3pt
//
// Hypothesis: TRIGGER on this feature pattern, predict clean +12pt impulse.
// TP = +12, SL = -3 (R:R 1:4 strict per goal).

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

console.log = (...a:any[]) => { fs.writeSync(1, a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')+'\n'); };

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TK_DB = path.resolve(__dirname, '../../../data/ticks.db');
const tk = new Database(TK_DB, { readonly: true });

const SYMBOL = 'NQ';
const TP_PTS = 12;
const SL_PTS = 3;
const SL_SLIP = 1;
const ENTRY_SLIP = 0.5;
const SPREAD = 0.25;
const HORIZON_MS = 10*60_000;
const COOLDOWN_MS = 10*60_000;

// TIGHTENED trigger filter v2 — match median observed pattern strictly
const VWAP_DIST_MIN = -25;        // p10
const VWAP_DIST_MAX = -5;         // tighter than -3
const NET_AGG_MAX = -500;         // between p10 (-1385) and p50 (-368), stricter selling
const RANGE_MIN = 12;             // tighter range filter
const RANGE_MAX = 25;
const TOD_START_MIN = 10*60;      // 10:00 ET
const TOD_END_MIN = 12*60;        // 12:00 ET (densest impulse bucket)

const SCAN_START = Date.parse('2026-05-01T00:00:00Z');
const SCAN_END   = Date.parse('2026-06-03T05:00:00Z');

console.log(`═══ Pullback-Exhaustion LONG empirical test ═══`);
console.log(`Trigger: vwap_dist ∈ [${VWAP_DIST_MIN},${VWAP_DIST_MAX}], net_agg_60s ≤ ${NET_AGG_MAX}, range_5min ∈ [${RANGE_MIN},${RANGE_MAX}]`);
console.log(`TP=${TP_PTS} SL=${SL_PTS} (R:R 1:4) horizon ${HORIZON_MS/60_000}min cooldown ${COOLDOWN_MS/60_000}min\n`);

function isRTH(tsMs: number): boolean {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(tsMs));
  const g = (t: string) => p.find(x => x.type === t)?.value ?? '';
  const m = parseInt(g('hour'), 10)*60 + parseInt(g('minute'), 10);
  return ['Mon','Tue','Wed','Thu','Fri'].includes(g('weekday')) && m >= TOD_START_MIN && m < TOD_END_MIN;
}
function etDate(ms: number): string { return new Date(ms - 4*60*60_000).toISOString().substring(0,10); }

interface TradeOutcome { ts: number; entry: number; outcome: 'WIN'|'LOSS'|'TIMESTOP'; exit: number; pnlSlip: number; et_date: string; }
const trades: TradeOutcome[] = [];
const dailyWR: Record<string, {w:number; l:number; t:number}> = {};

let curMs = SCAN_START;
let totalSignals = 0;
while (curMs < SCAN_END) {
  const start = curMs, end = curMs + 24*60*60_000;
  curMs = end;
  const wd = new Date(start - 4*60*60_000).getUTCDay();
  if (wd === 0 || wd === 6) continue;

  const ticks = tk.prepare(`SELECT ts, price, size, is_bid_aggressor FROM trades WHERE symbol = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC`)
    .all(SYMBOL, start, end) as Array<{ts:number;price:number;size:number;is_bid_aggressor:number}>;
  if (ticks.length < 1000) continue;
  const tsArr = ticks.map(t=>t.ts);

  function idxAtOrAfter(ts: number): number {
    let lo=0,hi=tsArr.length-1,res=tsArr.length;
    while(lo<=hi){const m=(lo+hi)>>1;if(tsArr[m]!>=ts){res=m;hi=m-1}else lo=m+1}
    return res;
  }
  function priceAt(ts: number): number | null {
    let lo=0,hi=tsArr.length-1,res=-1;
    while(lo<=hi){const m=(lo+hi)>>1;if(tsArr[m]!<=ts){res=m;lo=m+1}else hi=m-1}
    return res>=0?ticks[res]!.price:null;
  }

  let cooldownUntil = 0;
  const SCAN_RES = 5000;
  for (let scanTs = ticks[0]!.ts; scanTs < ticks[ticks.length-1]!.ts - HORIZON_MS; scanTs += SCAN_RES) {
    if (!isRTH(scanTs)) continue;
    if (scanTs < cooldownUntil) continue;

    // Compute features
    const px = priceAt(scanTs);
    if (px === null) continue;
    const vwapStart = scanTs - 5*60_000;
    const featStart = scanTs - 60_000;
    let sumPV=0, sumV=0, hi=-Infinity, lo=Infinity, netVol=0;
    const vsi = idxAtOrAfter(vwapStart);
    for (let i=vsi; i<ticks.length; i++) {
      const t = ticks[i]!;
      if (t.ts > scanTs) break;
      sumPV += t.price * t.size;
      sumV += t.size;
      if (t.ts >= featStart) {
        if (t.price > hi) hi = t.price;
        if (t.price < lo) lo = t.price;
        netVol += (t.is_bid_aggressor === 1 ? 1 : -1) * t.size;
      }
    }
    if (sumV === 0) continue;
    const vwap = sumPV / sumV;
    const vwapDist = px - vwap;
    const range = hi - lo;

    // Apply trigger
    if (vwapDist < VWAP_DIST_MIN || vwapDist > VWAP_DIST_MAX) continue;
    if (netVol > NET_AGG_MAX) continue;
    if (range < RANGE_MIN || range > RANGE_MAX) continue;

    // Trigger fires — simulate LONG entry
    totalSignals++;
    const fillIdx = idxAtOrAfter(scanTs);
    if (fillIdx >= ticks.length) continue;
    const fillTs = ticks[fillIdx]!.ts;
    const fillPx = ticks[fillIdx]!.price + SPREAD/2 + ENTRY_SLIP;
    const slPx = fillPx - SL_PTS;
    const tpPx = fillPx + TP_PTS;
    const hardStop = fillTs + HORIZON_MS;
    const startIdx = idxAtOrAfter(fillTs+1);
    let outcome: 'WIN'|'LOSS'|'TIMESTOP' = 'TIMESTOP';
    let exit = fillPx;
    for (let i=startIdx; i<ticks.length; i++) {
      const t = ticks[i]!;
      if (t.ts > hardStop) { exit = t.price; break; }
      if (t.price >= tpPx) { outcome = 'WIN'; exit = tpPx; break; }
      if (t.price <= slPx) { outcome = 'LOSS'; exit = slPx; break; }
    }
    const pnlSlip = outcome === 'WIN' ? TP_PTS
      : outcome === 'LOSS' ? -(SL_PTS + SL_SLIP)
      : (exit - fillPx) - 0.5;

    const dateLabel = etDate(scanTs);
    trades.push({ ts: scanTs, entry: fillPx, outcome, exit, pnlSlip, et_date: dateLabel });
    if (!dailyWR[dateLabel]) dailyWR[dateLabel] = {w:0,l:0,t:0};
    if (outcome === 'WIN') dailyWR[dateLabel]!.w++;
    else if (outcome === 'LOSS') dailyWR[dateLabel]!.l++;
    else dailyWR[dateLabel]!.t++;
    cooldownUntil = scanTs + COOLDOWN_MS;
  }
}

const wins = trades.filter(t=>t.outcome==='WIN').length;
const losses = trades.filter(t=>t.outcome==='LOSS').length;
const tstops = trades.filter(t=>t.outcome==='TIMESTOP').length;
const totSlip = trades.reduce((s,t)=>s+t.pnlSlip,0);
const wr = (wins+losses) > 0 ? wins/(wins+losses)*100 : 0;
console.log(`Trigger fires: ${totalSignals}`);
console.log(`Trades simulated: ${trades.length}`);
console.log(`WIN=${wins}  LOSS=${losses}  TIMESTOP=${tstops}`);
console.log(`WR: ${wr.toFixed(1)}%   Slipped: ${totSlip.toFixed(1)}pts ($${(totSlip*2).toFixed(0)} on 1 MNQ)`);
console.log(`Per-trade: ${(totSlip/trades.length).toFixed(2)} pts/trade slipped`);
console.log(`Avg trades/day: ${(trades.length/Object.keys(dailyWR).length).toFixed(1)}`);

console.log(`\n── Daily WR breakdown ──`);
console.log(`  date        n   W   L   T   WR%`);
for (const [d, x] of Object.entries(dailyWR).sort()) {
  const tot = x.w + x.l;
  const dwr = tot > 0 ? (x.w/tot*100).toFixed(1) : '—';
  console.log(`  ${d}   ${(x.w+x.l+x.t).toString().padStart(3)}   ${x.w.toString().padStart(3)}   ${x.l.toString().padStart(3)}   ${x.t.toString().padStart(3)}   ${dwr}%`);
}

console.log(`\n══ Verdict ══`);
if (wr >= 70 && totSlip > 0) {
  console.log(`✅ ${wr.toFixed(1)}% WR with +${totSlip.toFixed(1)}pts — MEETS GOAL → ready to ship`);
} else if (wr >= 50) {
  console.log(`⚠ ${wr.toFixed(1)}% WR — iterate confluence further`);
} else {
  console.log(`❌ ${wr.toFixed(1)}% WR — pattern doesn't predict, kill`);
}
console.log(`Done.`);
