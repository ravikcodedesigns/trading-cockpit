// VWAP-Pullback-Bounce LONG (RTH only, MNQ)
//
// Thesis: in a sustained uptrend (5min VWAP rising), pullbacks to VWAP get bought.
// Setup:
//   1. RTH only (09:30–16:00 ET)
//   2. 5min VWAP rising over last 5 minutes (vwap[t] > vwap[t-5min] by 2pt+)
//   3. Price was ≥5pt above VWAP recently (peak of uptrend > 5pt above VWAP in last 5min)
//   4. Current 1-min bar pulls back to within 1.5pt of VWAP (close)
//   5. Bar is bullish (close > open) OR neutral
//   6. Time-of-day: 09:30–14:30 ET
//
// Entry: Market BUY at 1-min bar close (with 0.5pt slip)
// SL: 3pt below entry (R:R 1:4)
// TP: 12pt, trail to BE after +6
// Hard timestop: 10min
// Cooldown: 5min between signals

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

console.log = (...args: any[]) => { fs.writeSync(1, args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n'); };

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TK_DB = path.resolve(__dirname, '../../../data/ticks.db');
const MBO_DB = path.resolve(__dirname, '../../../data/mbo.db');

const SYMBOL_TK = 'NQ';
const SYMBOL_MBO = 'MNQM';
const RTH_START = 1780405800000;
const RTH_END   = 1780425600000;
const TOD_CUTOFF_MIN = 14*60 + 30;

const BAR_MS = 60_000;
const VWAP_WIN_MS = 5 * 60_000;
const VWAP_RISE_MIN = 2.0;        // VWAP must be 2pt higher than 5min ago
const PEAK_ABOVE_VWAP = 5.0;      // recent peak ≥5pt above VWAP
const PEAK_LOOKBACK_MS = 5 * 60_000;
const PULLBACK_PROX = 1.5;        // close within 1.5pt of VWAP

const TP_PTS = 12;
const SL_PTS = 3;
const TRAIL = 6;
const TIMESTOP = 10 * 60_000;
const COOLDOWN = 5 * 60_000;
const SPREAD = 0.25;
const ENTRY_SLIP = 0.5;
const SL_SLIP = 1.0;

const tk = new Database(TK_DB, { readonly: true });
const mbo = new Database(MBO_DB, { readonly: true });

console.log('═══ VWAP Pullback LONG (uptrend bounce) ═══');
console.log(`5min VWAP must rise ≥${VWAP_RISE_MIN}pt; recent peak ≥${PEAK_ABOVE_VWAP}pt above VWAP`);
console.log(`Pullback: bar close within ${PULLBACK_PROX}pt of VWAP, bar non-bearish`);
console.log(`Time: 09:30–14:30 ET  TP=${TP_PTS}  SL=${SL_PTS} (R:R 1:4)  Trail BE +${TRAIL}\n`);

const ticks = tk.prepare(`
  SELECT ts, price, size FROM trades WHERE symbol=? AND ts BETWEEN ? AND ?
  ORDER BY ts ASC
`).all(SYMBOL_TK, RTH_START - VWAP_WIN_MS, RTH_END + 15*60_000) as Array<{ts:number;price:number;size:number}>;
console.log(`Loaded ${ticks.length.toLocaleString()} NQ ticks`);

// Build 1-min bars
interface Bar { ts: number; open: number; high: number; low: number; close: number; }
const bars: Bar[] = [];
let curBucket = 0, curBar: Bar | null = null;
for (const t of ticks) {
  const bk = Math.floor(t.ts / BAR_MS) * BAR_MS;
  if (bk !== curBucket) {
    if (curBar) bars.push(curBar);
    curBar = { ts: bk, open: t.price, high: t.price, low: t.price, close: t.price };
    curBucket = bk;
  } else if (curBar) {
    if (t.price > curBar.high) curBar.high = t.price;
    if (t.price < curBar.low) curBar.low = t.price;
    curBar.close = t.price;
  }
}
if (curBar) bars.push(curBar);
console.log(`Built ${bars.length} 1-min bars`);

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
function vwapAt(ts: number): { vwap: number; peakAbove: number; vwapPrev: number } | null {
  const start = ts - VWAP_WIN_MS;
  let lo=0,hi=ticks.length-1,si=ticks.length;
  while(lo<=hi){const m=(lo+hi)>>1;if(ticks[m]!.ts>=start){si=m;hi=m-1}else lo=m+1}
  let sumPV=0,sumV=0,peak=-Infinity,n=0;
  for(let i=si;i<ticks.length;i++){
    const t = ticks[i]!;
    if (t.ts > ts) break;
    sumPV += t.price * t.size;
    sumV += t.size;
    if (t.price > peak) peak = t.price;
    n++;
  }
  if (sumV === 0 || n < 10) return null;
  const vwap = sumPV / sumV;
  // Also VWAP 5min ago to measure rise
  const tsPrev = ts - VWAP_WIN_MS;
  const startPrev = tsPrev - VWAP_WIN_MS;
  lo = 0; hi = ticks.length-1; si = ticks.length;
  while(lo<=hi){const m=(lo+hi)>>1;if(ticks[m]!.ts>=startPrev){si=m;hi=m-1}else lo=m+1}
  let pv2=0,v2=0,n2=0;
  for(let i=si;i<ticks.length;i++){
    const t = ticks[i]!;
    if (t.ts > tsPrev) break;
    pv2 += t.price * t.size;
    v2 += t.size;
    n2++;
  }
  if (v2 === 0 || n2 < 10) return null;
  return { vwap, peakAbove: peak - vwap, vwapPrev: pv2/v2 };
}
function etMinute(ts:number): number {
  const d = new Date(ts - 4*60*60_000);
  return d.getUTCHours()*60 + d.getUTCMinutes();
}

interface Trade { ts: number; vwap: number; close: number; entry: number; sl: number; tp: number; outcome: 'WIN'|'LOSS'|'TIMESTOP'; exit: number; pnlSlip: number; }
const trades: Trade[] = [];
let cooldownUntil = 0;
let skipReasons: Record<string,number> = {};

for (const bar of bars) {
  if (bar.ts < RTH_START || bar.ts >= RTH_END) continue;
  const signalTs = bar.ts + BAR_MS;  // signal at bar close
  if (signalTs < cooldownUntil) { skipReasons['COOLDOWN'] = (skipReasons['COOLDOWN']??0)+1; continue; }
  if (etMinute(signalTs) >= TOD_CUTOFF_MIN) { skipReasons['LATE_DAY'] = (skipReasons['LATE_DAY']??0)+1; continue; }

  const vr = vwapAt(signalTs);
  if (!vr) { skipReasons['NO_VWAP'] = (skipReasons['NO_VWAP']??0)+1; continue; }
  if ((vr.vwap - vr.vwapPrev) < VWAP_RISE_MIN) { skipReasons['VWAP_FLAT'] = (skipReasons['VWAP_FLAT']??0)+1; continue; }
  if (vr.peakAbove < PEAK_ABOVE_VWAP) { skipReasons['NO_PEAK'] = (skipReasons['NO_PEAK']??0)+1; continue; }
  if (Math.abs(bar.close - vr.vwap) > PULLBACK_PROX) { skipReasons['NOT_PULLBACK'] = (skipReasons['NOT_PULLBACK']??0)+1; continue; }
  if (bar.close < bar.open - 1.0) { skipReasons['BEARISH_BAR'] = (skipReasons['BEARISH_BAR']??0)+1; continue; }

  // Trade!
  const fillIdx = tickIdxAtOrAfter(signalTs);
  if (fillIdx >= ticks.length) continue;
  const fillTs = ticks[fillIdx]!.ts;
  const lastPx = ticks[fillIdx]!.price;
  const fillPx = lastPx + SPREAD/2 + ENTRY_SLIP;
  const slPx = fillPx - SL_PTS;
  const tpPx = fillPx + TP_PTS;

  let outcome: 'WIN'|'LOSS'|'TIMESTOP' = 'TIMESTOP';
  let exitPx = fillPx, effSL = slPx, trailed = false;
  const sIdx = tickIdxAtOrAfter(fillTs+1);
  const hardStop = fillTs + TIMESTOP;
  for (let i = sIdx; i < ticks.length; i++) {
    const t = ticks[i]!;
    if (t.ts > hardStop) { exitPx = t.price; break; }
    const move = t.price - fillPx;
    if (!trailed && move >= TRAIL) { effSL = fillPx; trailed = true; }
    if (t.price >= tpPx) { outcome='WIN'; exitPx=tpPx; break; }
    if (t.price <= effSL) {
      outcome = trailed && Math.abs(effSL - fillPx) < 0.01 ? 'TIMESTOP' : 'LOSS';
      exitPx = effSL; break;
    }
  }

  const pnlSlip = outcome === 'WIN' ? TP_PTS
    : outcome === 'LOSS' ? -(SL_PTS + SL_SLIP)
    : (exitPx - fillPx) - 0.5;

  trades.push({ ts: signalTs, vwap: vr.vwap, close: bar.close, entry: fillPx, sl: slPx, tp: tpPx, outcome, exit: exitPx, pnlSlip });
  cooldownUntil = signalTs + COOLDOWN;
}

console.log(`\nSkip reasons:`);
for (const [k,v] of Object.entries(skipReasons)) console.log(`  ${k}: ${v}`);

console.log(`\nSignals fired: ${trades.length}`);
const w = trades.filter(t=>t.outcome==='WIN').length;
const l = trades.filter(t=>t.outcome==='LOSS').length;
const ts = trades.filter(t=>t.outcome==='TIMESTOP').length;
const totSlip = trades.reduce((s,t)=>s+t.pnlSlip,0);
const wr = (w+l) > 0 ? w/(w+l)*100 : 0;
console.log(`WIN=${w}  LOSS=${l}  TIMESTOP=${ts}`);
console.log(`WR: ${wr.toFixed(1)}%   Slipped: ${totSlip.toFixed(1)}pts ($${(totSlip*2).toFixed(0)} on 1 MNQ)`);

console.log(`\n── Trades ──`);
const fmt = (ms:number) => new Date(ms-4*60*60_000).toISOString().substring(11,19);
console.log(`  time(ET)  vwap     close    entry    outcome  exit     pnl`);
for (const t of trades) {
  console.log(`  ${fmt(t.ts)}  ${t.vwap.toFixed(2)}  ${t.close.toFixed(2)}  ${t.entry.toFixed(2)}  ${t.outcome.padEnd(8)} ${t.exit.toFixed(2)}  ${(t.pnlSlip>=0?'+':'')+t.pnlSlip.toFixed(1)}`);
}

console.log(`\n══ Verdict ══`);
if (wr >= 70 && totSlip > 0) {
  console.log(`✅ ${wr.toFixed(1)}% slipped WR with +${totSlip.toFixed(1)} pts/day — SHIP TO V3 SHADOW`);
} else if (wr >= 50 && totSlip > 0) {
  console.log(`⚠ ${wr.toFixed(1)}% WR / positive — iterate further with MBO confluence to push to 70+`);
} else {
  console.log(`❌ ${wr.toFixed(1)}% WR — kill or relax conditions`);
}
console.log(`Done.`);
