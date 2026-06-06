// Candidate B — filter search: find the high-conviction subset from the
// 182 fade-variant trades that achieves ≥70% slipped WR.
//
// Approach: re-run the candidate-B fade backtest but capture FEATURES per trade.
// Then find filter combinations that select for the winning subset.
//
// Features per trade:
//   - cancel_burst_count (asks or bids cancelled in 500ms)
//   - aggressor_size (size of the confirming aggressor trade)
//   - range_5min (5min hi-lo)
//   - vwap_dist (how far from 5min VWAP)
//   - hour_of_day (RTH minute bucket)
//   - opposing_cancels (cancels on the trade direction side)
//   - cancel_imbalance (opp_cancels - same_cancels)
//
// Then for each feature, find thresholds where the filtered subset has ≥70% WR.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

console.log = (...args: any[]) => {
  fs.writeSync(1, args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n');
};

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const MBO_DB = path.resolve(__dirname, '../../../data/mbo.db');
const TK_DB  = path.resolve(__dirname, '../../../data/ticks.db');

const SYMBOL_MBO = 'MNQM';
const CONTRACT   = 'MNQM6_CME_BMD';
const SYMBOL_TK  = 'NQ';
const SCAN_RTH_START = 1780405800000;
const SCAN_RTH_END   = 1780425600000;
const CANCEL_WINDOW = 500;
const CANCEL_LIFETIME = 100;
const VWAP_WIN = 5*60_000;
const TP_PTS = 12;
const SL_PTS = 3;
const TRAIL = 6;
const TIMESTOP = 5*60_000;
const ENTRY_SLIP = 0.5;
const SPREAD = 0.25;
const SL_SLIP = 1.0;

const mbo = new Database(MBO_DB, { readonly: true });
const tk  = new Database(TK_DB,  { readonly: true });

console.log('═══ Candidate B Filter Search — find winning subset ═══\n');

const quickCancels = mbo.prepare(`
  SELECT cancel_ts_ms ts, is_bid, send_price price
  FROM mbo_orders
  WHERE symbol=? AND status='cancelled' AND is_bid IS NOT NULL
    AND send_ts_ms IS NOT NULL AND cancel_ts_ms IS NOT NULL
    AND cancel_ts_ms BETWEEN ? AND ?
    AND (cancel_ts_ms - send_ts_ms) < ?
  ORDER BY cancel_ts_ms ASC
`).all(SYMBOL_MBO, SCAN_RTH_START, SCAN_RTH_END, CANCEL_LIFETIME) as Array<{ts:number;is_bid:number;price:number}>;

const aggs = mbo.prepare(`
  SELECT ts_ms ts, is_bid_aggressor is_bid_agg, size
  FROM mbo_trades
  WHERE symbol=? AND ts_ms BETWEEN ? AND ?
    AND aggressor_order_id != ''
  ORDER BY ts_ms ASC
`).all(SYMBOL_MBO, SCAN_RTH_START, SCAN_RTH_END) as Array<{ts:number;is_bid_agg:number;size:number}>;

const ticks = tk.prepare(`SELECT ts, price FROM trades WHERE symbol=? AND ts BETWEEN ? AND ? ORDER BY ts ASC`)
  .all(SYMBOL_TK, SCAN_RTH_START - VWAP_WIN, SCAN_RTH_END + 10*60_000) as Array<{ts:number;price:number}>;
const ticksVol = tk.prepare(`SELECT ts, price, size FROM trades WHERE symbol=? AND ts BETWEEN ? AND ? ORDER BY ts ASC`)
  .all(SYMBOL_TK, SCAN_RTH_START - VWAP_WIN, SCAN_RTH_END + 10*60_000) as Array<{ts:number;price:number;size:number}>;

console.log(`Loaded ${quickCancels.length.toLocaleString()} quick-cancels, ${aggs.length.toLocaleString()} aggressor trades, ${ticks.length.toLocaleString()} NQ ticks\n`);

function tickIdxAtOrAfter(ts: number): number {
  let lo=0,hi=ticks.length-1,res=ticks.length;
  while(lo<=hi){const m=(lo+hi)>>1;if(ticks[m]!.ts>=ts){res=m;hi=m-1}else lo=m+1}
  return res;
}
function priceAt(ts: number): number | null {
  let lo=0,hi=ticks.length-1,res=-1;
  while(lo<=hi){const m=(lo+hi)>>1;if(ticks[m]!.ts<=ts){res=m;lo=m+1}else hi=m-1}
  return res>=0?ticks[res]!.price:null;
}
function vwapRange(ts: number) {
  const start = ts - VWAP_WIN;
  let lo=0,hi=ticksVol.length-1,si=ticksVol.length;
  while(lo<=hi){const m=(lo+hi)>>1;if(ticksVol[m]!.ts>=start){si=m;hi=m-1}else lo=m+1}
  let sumPV=0,sumV=0,h=-Infinity,l=Infinity,n=0;
  for(let i=si;i<ticksVol.length;i++){const t=ticksVol[i]!;if(t.ts>ts)break;sumPV+=t.price*t.size;sumV+=t.size;if(t.price>h)h=t.price;if(t.price<l)l=t.price;n++}
  if(sumV===0||n<10)return null;
  return {vwap:sumPV/sumV, high:h, low:l, n};
}
function etMinute(ts: number): number {
  const d = new Date(ts - 4*60*60_000);
  return d.getUTCHours()*60 + d.getUTCMinutes();
}

interface TradeFeatures {
  ts: number; direction: 'long'|'short';
  burst_cancels: number; same_side_cancels: number; cancel_imb: number;
  agg_size: number; range_5m: number;
  vwap_dist: number;  // signed: +ve = above vwap (long-aligned), -ve = below
  et_minute: number;
  outcome: 'WIN'|'LOSS'|'TIMESTOP';
  pnl_slip: number;
}

const trades: TradeFeatures[] = [];
let cancelIdx = 0;
let activeUntil = 0;

for (const agg of aggs) {
  const ts = agg.ts;
  if (ts < activeUntil) continue;

  const wStart = ts - CANCEL_WINDOW;
  while (cancelIdx < quickCancels.length && quickCancels[cancelIdx]!.ts < wStart) cancelIdx++;
  let ask=0, bid=0;
  for (let i=cancelIdx; i<quickCancels.length; i++) {
    const c = quickCancels[i]!;
    if (c.ts > ts) break;
    if (c.is_bid === 0) ask++; else bid++;
  }

  // FADE variant: ask cancel-burst → SHORT (sell aggressor); bid cancel-burst → LONG (buy aggressor)
  const MIN_BURST = 15;
  const isShort = ask >= MIN_BURST && bid < MIN_BURST && agg.is_bid_agg === 0;
  const isLong  = bid >= MIN_BURST && ask < MIN_BURST && agg.is_bid_agg === 1;
  if (!isShort && !isLong) continue;

  const vr = vwapRange(ts);
  if (!vr) continue;
  const px = priceAt(ts);
  if (px === null) continue;
  const range = vr.high - vr.low;
  if (range < 5) continue;

  const direction: 'long'|'short' = isLong ? 'long' : 'short';
  const dir = direction === 'long' ? 1 : -1;

  // Market entry
  const fillIdx = tickIdxAtOrAfter(ts);
  if (fillIdx >= ticks.length) continue;
  const fillTs = ticks[fillIdx]!.ts;
  const fillPx = ticks[fillIdx]!.price + dir*(SPREAD/2 + ENTRY_SLIP);
  const slPx = fillPx - dir*SL_PTS;
  const tpPx = fillPx + dir*TP_PTS;

  // Walk forward with trail
  let outcome: 'WIN'|'LOSS'|'TIMESTOP' = 'TIMESTOP';
  let exitPx = fillPx;
  let effSL = slPx;
  let trailed = false;
  const startIdx = tickIdxAtOrAfter(fillTs+1);
  const hardStop = fillTs + TIMESTOP;
  for (let i=startIdx; i<ticks.length; i++) {
    const t = ticks[i]!;
    if (t.ts > hardStop) { exitPx = t.price; break; }
    const move = dir*(t.price - fillPx);
    if (!trailed && move >= TRAIL) { effSL = fillPx; trailed = true; }
    const hitTP = dir===1 ? t.price>=tpPx : t.price<=tpPx;
    const hitSL = dir===1 ? t.price<=effSL : t.price>=effSL;
    if (hitTP) { outcome='WIN'; exitPx=tpPx; break; }
    if (hitSL) {
      outcome = trailed && Math.abs(effSL - fillPx) < 0.01 ? 'TIMESTOP' : 'LOSS';
      exitPx = effSL;
      break;
    }
  }
  activeUntil = hardStop;

  const pnlSlip = outcome === 'WIN' ? TP_PTS
    : outcome === 'LOSS' ? -(SL_PTS + SL_SLIP)
    : dir*(exitPx - fillPx) - 0.5;

  trades.push({
    ts, direction,
    burst_cancels: direction === 'long' ? bid : ask,
    same_side_cancels: direction === 'long' ? ask : bid,
    cancel_imb: (direction === 'long' ? bid - ask : ask - bid),
    agg_size: agg.size,
    range_5m: range,
    vwap_dist: dir * (px - vr.vwap),
    et_minute: etMinute(ts),
    outcome, pnl_slip: pnlSlip,
  });
}

console.log(`Total trades collected: ${trades.length}`);
const wins = trades.filter(t=>t.outcome==='WIN');
const losses = trades.filter(t=>t.outcome==='LOSS');
const tstops = trades.filter(t=>t.outcome==='TIMESTOP');
console.log(`  WIN=${wins.length}  LOSS=${losses.length}  TIMESTOP=${tstops.length}`);
console.log(`  Base WR: ${wins.length/(wins.length+losses.length)*100|0}%`);
console.log(`  Base slip total: ${trades.reduce((s,t)=>s+t.pnl_slip,0).toFixed(1)} pts\n`);

// ── Feature distribution comparison (WIN vs LOSS) ──
function stats(arr: number[]) {
  const sorted = [...arr].sort((a,b)=>a-b);
  if (!sorted.length) return null;
  return {
    n: sorted.length,
    p25: sorted[Math.floor(sorted.length*0.25)],
    p50: sorted[Math.floor(sorted.length*0.5)],
    p75: sorted[Math.floor(sorted.length*0.75)],
    p90: sorted[Math.floor(sorted.length*0.9)],
    mean: sorted.reduce((s,v)=>s+v,0)/sorted.length,
  };
}

const features = ['burst_cancels','same_side_cancels','cancel_imb','agg_size','range_5m','vwap_dist','et_minute'] as const;
console.log(`══ Feature distribution: WIN vs LOSS ══`);
console.log(`${'feature'.padEnd(20)} ${'win-p25'.padStart(8)} ${'win-p50'.padStart(8)} ${'win-p75'.padStart(8)} | ${'loss-p25'.padStart(8)} ${'loss-p50'.padStart(8)} ${'loss-p75'.padStart(8)}`);
for (const f of features) {
  const ws = stats(wins.map(w=>w[f] as number));
  const ls = stats(losses.map(l=>l[f] as number));
  if (!ws || !ls) continue;
  console.log(`${f.padEnd(20)} ${ws.p25!.toFixed(1).padStart(8)} ${ws.p50!.toFixed(1).padStart(8)} ${ws.p75!.toFixed(1).padStart(8)} | ${ls.p25!.toFixed(1).padStart(8)} ${ls.p50!.toFixed(1).padStart(8)} ${ls.p75!.toFixed(1).padStart(8)}`);
}

// ── Single-feature threshold search ──
console.log(`\n══ Single-feature threshold filtering (TP=${TP_PTS}, SL=${SL_PTS}, slipped) ══`);
console.log(`${'filter'.padEnd(35)} ${'n_pass'.padStart(7)} ${'WIN'.padStart(5)} ${'LOSS'.padStart(5)} ${'WR%'.padStart(7)} ${'slip $'.padStart(8)}`);

interface FilterSpec { name: string; pred: (t: TradeFeatures) => boolean; }
const filters: FilterSpec[] = [
  { name: 'burst_cancels >= 30',  pred: t => t.burst_cancels >= 30 },
  { name: 'burst_cancels >= 50',  pred: t => t.burst_cancels >= 50 },
  { name: 'burst_cancels >= 80',  pred: t => t.burst_cancels >= 80 },
  { name: 'cancel_imb >= 20',     pred: t => t.cancel_imb >= 20 },
  { name: 'cancel_imb >= 40',     pred: t => t.cancel_imb >= 40 },
  { name: 'cancel_imb >= 60',     pred: t => t.cancel_imb >= 60 },
  { name: 'agg_size >= 5',        pred: t => t.agg_size >= 5 },
  { name: 'agg_size >= 10',       pred: t => t.agg_size >= 10 },
  { name: 'range_5m >= 8',        pred: t => t.range_5m >= 8 },
  { name: 'range_5m >= 12',       pred: t => t.range_5m >= 12 },
  { name: 'vwap_dist > 0',        pred: t => t.vwap_dist > 0 },     // trade direction aligned with VWAP
  { name: 'vwap_dist > 2',        pred: t => t.vwap_dist > 2 },
  { name: 'vwap_dist > 5',        pred: t => t.vwap_dist > 5 },
  { name: 'vwap_dist <= -2',      pred: t => t.vwap_dist <= -2 },   // counter-VWAP
  { name: 'et 09:54-12:00',       pred: t => t.et_minute >= 594 && t.et_minute < 720 },
  { name: 'et 12:00-14:30',       pred: t => t.et_minute >= 720 && t.et_minute < 870 },
  { name: 'et 14:30-16:00',       pred: t => t.et_minute >= 870 && t.et_minute < 960 },
  { name: 'LONG only',            pred: t => t.direction === 'long' },
  { name: 'SHORT only',           pred: t => t.direction === 'short' },
];

const results: Array<{filter: FilterSpec; n: number; w: number; l: number; ts: number; wr: number; slip: number}> = [];
for (const f of filters) {
  const subset = trades.filter(f.pred);
  const w = subset.filter(t=>t.outcome==='WIN').length;
  const l = subset.filter(t=>t.outcome==='LOSS').length;
  const ts2 = subset.filter(t=>t.outcome==='TIMESTOP').length;
  const wr = (w+l) > 0 ? w/(w+l)*100 : 0;
  const slipSum = subset.reduce((s,t)=>s+t.pnl_slip,0);
  results.push({filter: f, n: subset.length, w, l, ts: ts2, wr, slip: slipSum * 2});
  console.log(`${f.name.padEnd(35)} ${subset.length.toString().padStart(7)} ${w.toString().padStart(5)} ${l.toString().padStart(5)} ${wr.toFixed(1).padStart(6)}% ${('$'+slipSum*2|0).toString().padStart(8)}`);
}

// ── Stacked filter exploration ──
console.log(`\n══ Stacked filters (top candidates) ══`);
const stacked: FilterSpec[] = [
  { name: 'burst>=30 & vwap>0',                  pred: t => t.burst_cancels>=30 && t.vwap_dist>0 },
  { name: 'burst>=50 & vwap>0',                  pred: t => t.burst_cancels>=50 && t.vwap_dist>0 },
  { name: 'burst>=80 & vwap>0 & et<14:30',       pred: t => t.burst_cancels>=80 && t.vwap_dist>0 && t.et_minute<870 },
  { name: 'cancel_imb>=40 & vwap>0',             pred: t => t.cancel_imb>=40 && t.vwap_dist>0 },
  { name: 'burst>=30 & range>=8 & vwap>0',       pred: t => t.burst_cancels>=30 && t.range_5m>=8 && t.vwap_dist>0 },
  { name: 'burst>=50 & range>=8 & vwap>2',       pred: t => t.burst_cancels>=50 && t.range_5m>=8 && t.vwap_dist>2 },
  { name: 'imb>=40 & range>=8 & vwap>2',         pred: t => t.cancel_imb>=40 && t.range_5m>=8 && t.vwap_dist>2 },
  { name: 'imb>=60 & range>=10 & vwap>5',        pred: t => t.cancel_imb>=60 && t.range_5m>=10 && t.vwap_dist>5 },
  { name: 'LONG & vwap>2 & burst>=30',           pred: t => t.direction==='long' && t.vwap_dist>2 && t.burst_cancels>=30 },
  { name: 'LONG & vwap>5 & burst>=50',           pred: t => t.direction==='long' && t.vwap_dist>5 && t.burst_cancels>=50 },
  { name: 'SHORT & vwap>2 & burst>=30',          pred: t => t.direction==='short' && t.vwap_dist>2 && t.burst_cancels>=30 },
  { name: 'SHORT & vwap>5 & burst>=50',          pred: t => t.direction==='short' && t.vwap_dist>5 && t.burst_cancels>=50 },
  { name: 'agg>=5 & vwap>2 & burst>=30',         pred: t => t.agg_size>=5 && t.vwap_dist>2 && t.burst_cancels>=30 },
  { name: 'agg>=10 & vwap>2 & burst>=30',        pred: t => t.agg_size>=10 && t.vwap_dist>2 && t.burst_cancels>=30 },
];
console.log(`${'filter'.padEnd(45)} ${'n_pass'.padStart(7)} ${'WIN'.padStart(5)} ${'LOSS'.padStart(5)} ${'WR%'.padStart(7)} ${'slip $'.padStart(8)} ${'verdict'}`);
for (const f of stacked) {
  const subset = trades.filter(f.pred);
  const w = subset.filter(t=>t.outcome==='WIN').length;
  const l = subset.filter(t=>t.outcome==='LOSS').length;
  const wr = (w+l) > 0 ? w/(w+l)*100 : 0;
  const slipSum = subset.reduce((s,t)=>s+t.pnl_slip,0);
  const verdict = wr >= 70 && slipSum > 0 ? '✅ SHIPPABLE' : wr >= 50 ? 'iterate' : 'kill';
  console.log(`${f.name.padEnd(45)} ${subset.length.toString().padStart(7)} ${w.toString().padStart(5)} ${l.toString().padStart(5)} ${wr.toFixed(1).padStart(6)}% ${('$'+(slipSum*2|0)).toString().padStart(8)} ${verdict}`);
}

console.log(`\nDone.`);
