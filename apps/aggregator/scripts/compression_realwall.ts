// Compression + Real-Bid-Wall — Candidate A relaxed-proxy
//
// Logic: combine EXPL's structural compression component with MBO's unique
// real-bid-wall detection. Trade the bounce off MBO-confirmed institutional bids.
//
// Setup:
//   1. Find 5-bar rolling 1-min windows with range ≤ 12pt (compression)
//   2. Within last 60s before signal, find bid orders that:
//        - have lifetime > 5s (NOT HFT spoof)
//        - size ≥ 20 contracts
//        - price within ±2pt of the compression-range low
//   3. ≥ 3 such "real bid wall" orders observed
//   4. NO new aggressor sells at the range low in last 5s before signal (capitulation)
//   5. Time-of-day: 09:30–14:30 ET (skip end-of-day chop)
//
// Entry: Market BUY at signal time (with 0.5pt slip)
// SL: 3pt below entry (R:R 1:4 with TP=12)
// TP: 12pt + trail-to-BE after +6pt
// Hard timestop 10min

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
const SYMBOL_TK  = 'NQ';
const RTH_START  = 1780405800000;     // 09:30 ET
const RTH_END    = 1780425600000;     // 16:00 ET
const TOD_CUTOFF_MIN = 14*60 + 30;    // skip after 14:30 ET

// Compression
const COMPRESSION_BARS = 5;
const COMPRESSION_MAX_RANGE = 12.0;
const BAR_MS = 60_000;

// MBO real-wall
const WALL_LOOKBACK_MS = 60_000;
const WALL_MIN_LIFETIME_MS = 5_000;
const WALL_MIN_SIZE = 20;
const WALL_PRICE_BUFFER = 2.0;
const WALL_MIN_ORDERS = 3;

// Capitulation
const CAP_WINDOW_MS = 5_000;
const CAP_ZONE_PT = 1.0;

// Cooldown — no repeat within 10 min same compression box
const COOLDOWN_MS = 10 * 60_000;

// Execution
const TP_PTS = 12;
const SL_PTS = 3;
const TRAIL = 6;
const TIMESTOP = 10 * 60_000;
const ENTRY_SLIP = 0.5;
const SPREAD = 0.25;
const SL_SLIP = 1.0;

const mbo = new Database(MBO_DB, { readonly: true });
const tk  = new Database(TK_DB,  { readonly: true });

console.log('═══ Compression + Real-Bid-Wall + Capitulation ═══');
console.log(`Compression: 5-bar 1-min range ≤ ${COMPRESSION_MAX_RANGE}pt`);
console.log(`Real wall: ≥${WALL_MIN_ORDERS} bid orders, size≥${WALL_MIN_SIZE}, life>${WALL_MIN_LIFETIME_MS/1000}s, within ${WALL_PRICE_BUFFER}pt of range-low`);
console.log(`Capitulation: zero aggressor sells in last ${CAP_WINDOW_MS/1000}s at range-low ±${CAP_ZONE_PT}pt`);
console.log(`Time filter: 09:30–14:30 ET`);
console.log(`TP=${TP_PTS}  SL=${SL_PTS} (R:R 1:4)  Trail BE after +${TRAIL}\n`);

// Pull all RTH NQ ticks
const ticks = tk.prepare(`
  SELECT ts, price, size, is_bid_aggressor FROM trades
  WHERE symbol=? AND ts BETWEEN ? AND ? ORDER BY ts ASC
`).all(SYMBOL_TK, RTH_START - 10*60_000, RTH_END + 15*60_000) as Array<{ts:number;price:number;size:number;is_bid_aggressor:number}>;
console.log(`Loaded ${ticks.length.toLocaleString()} NQ ticks`);

// Build 1-min bars from NQ ticks
interface Bar { ts: number; high: number; low: number; close: number; }
const bars: Bar[] = [];
let curBucket = 0;
let curBar: Bar | null = null;
for (const t of ticks) {
  const bucket = Math.floor(t.ts / BAR_MS) * BAR_MS;
  if (bucket !== curBucket) {
    if (curBar) bars.push(curBar);
    curBar = { ts: bucket, high: t.price, low: t.price, close: t.price };
    curBucket = bucket;
  } else if (curBar) {
    if (t.price > curBar.high) curBar.high = t.price;
    if (t.price < curBar.low) curBar.low = t.price;
    curBar.close = t.price;
  }
}
if (curBar) bars.push(curBar);
console.log(`Built ${bars.length} 1-min bars`);

// Pull MBO bid orders (only bids, with usable lifetime)
const bidOrders = mbo.prepare(`
  SELECT send_ts_ms ts_send, send_price price, send_size size, last_ts_ms ts_last, status
  FROM mbo_orders
  WHERE symbol=? AND is_bid=1 AND send_ts_ms IS NOT NULL
    AND send_ts_ms BETWEEN ? AND ?
    AND send_size >= ?
  ORDER BY send_ts_ms ASC
`).all(SYMBOL_MBO, RTH_START - WALL_LOOKBACK_MS, RTH_END, WALL_MIN_SIZE) as Array<{
  ts_send: number; price: number; size: number; ts_last: number; status: string;
}>;
console.log(`Loaded ${bidOrders.length.toLocaleString()} bid orders (size ≥ ${WALL_MIN_SIZE})`);

// Sell-aggressor events (is_bid_aggressor=0 means sell aggressor)
const sellAggs = mbo.prepare(`
  SELECT ts_ms ts, price FROM mbo_trades
  WHERE symbol=? AND is_bid_aggressor=0 AND ts_ms BETWEEN ? AND ?
    AND aggressor_order_id != ''
  ORDER BY ts_ms ASC
`).all(SYMBOL_MBO, RTH_START - CAP_WINDOW_MS, RTH_END) as Array<{ts:number;price:number}>;
console.log(`Loaded ${sellAggs.length.toLocaleString()} sell-aggressor trades`);

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
function etMinute(ts:number): number {
  const d = new Date(ts - 4*60*60_000);
  return d.getUTCHours()*60 + d.getUTCMinutes();
}

// Walk bars: for each 5-bar window, detect compression
const trades: Array<{ts:number;entry:number;sl:number;tp:number;outcome:'WIN'|'LOSS'|'TIMESTOP';exit:number;pnlSlip:number;rangeLow:number;rangeHigh:number;wallOrders:number}> = [];
let cooldownUntil = 0;

let skipReasons: Record<string,number> = {};

for (let i = COMPRESSION_BARS - 1; i < bars.length; i++) {
  const window = bars.slice(i - COMPRESSION_BARS + 1, i + 1);
  const high = Math.max(...window.map(b=>b.high));
  const low  = Math.min(...window.map(b=>b.low));
  const range = high - low;
  if (range > COMPRESSION_MAX_RANGE) continue;

  const signalTs = window[COMPRESSION_BARS-1]!.ts + BAR_MS;  // signal at next bar open
  if (signalTs < RTH_START || signalTs >= RTH_END) continue;
  if (signalTs < cooldownUntil) { skipReasons['COOLDOWN'] = (skipReasons['COOLDOWN']??0)+1; continue; }
  if (etMinute(signalTs) >= TOD_CUTOFF_MIN) { skipReasons['LATE_DAY'] = (skipReasons['LATE_DAY']??0)+1; continue; }

  // Real-bid-wall: in last 60s, find bid orders with lifetime>5s, size>=20, within ±2pt of low
  const wallSearchStart = signalTs - WALL_LOOKBACK_MS;
  let wallCount = 0;
  for (const bo of bidOrders) {
    if (bo.ts_send > signalTs) break;
    if (bo.ts_send < wallSearchStart) continue;
    if (Math.abs(bo.price - low) > WALL_PRICE_BUFFER) continue;
    const lifetime = bo.ts_last - bo.ts_send;
    if (lifetime >= WALL_MIN_LIFETIME_MS) wallCount++;
  }
  if (wallCount < WALL_MIN_ORDERS) { skipReasons['NO_WALL'] = (skipReasons['NO_WALL']??0)+1; continue; }

  // Capitulation: NO sell-aggressors at range_low ±1pt in last 5s
  const capStart = signalTs - CAP_WINDOW_MS;
  let capViolations = 0;
  for (const sa of sellAggs) {
    if (sa.ts > signalTs) break;
    if (sa.ts < capStart) continue;
    if (Math.abs(sa.price - low) <= CAP_ZONE_PT) capViolations++;
  }
  if (capViolations > 0) { skipReasons['NO_CAPITULATION'] = (skipReasons['NO_CAPITULATION']??0)+1; continue; }

  // Execution
  const fillIdx = tickIdxAtOrAfter(signalTs);
  if (fillIdx >= ticks.length) continue;
  const lastPx = ticks[fillIdx]!.price;
  const fillPx = lastPx + (SPREAD/2 + ENTRY_SLIP);   // LONG market entry
  const slPx = fillPx - SL_PTS;
  const tpPx = fillPx + TP_PTS;
  const fillTs = ticks[fillIdx]!.ts;

  let outcome: 'WIN'|'LOSS'|'TIMESTOP' = 'TIMESTOP';
  let exitPx = fillPx;
  let effSL = slPx;
  let trailed = false;
  const startIdx = tickIdxAtOrAfter(fillTs+1);
  const hardStop = fillTs + TIMESTOP;
  for (let j = startIdx; j < ticks.length; j++) {
    const t = ticks[j]!;
    if (t.ts > hardStop) { exitPx = t.price; break; }
    const move = t.price - fillPx;
    if (!trailed && move >= TRAIL) { effSL = fillPx; trailed = true; }
    if (t.price >= tpPx) { outcome='WIN'; exitPx=tpPx; break; }
    if (t.price <= effSL) {
      outcome = trailed && Math.abs(effSL - fillPx) < 0.01 ? 'TIMESTOP' : 'LOSS';
      exitPx = effSL;
      break;
    }
  }

  const pnlSlip = outcome === 'WIN' ? TP_PTS
    : outcome === 'LOSS' ? -(SL_PTS + SL_SLIP)
    : (exitPx - fillPx) - 0.5;

  trades.push({
    ts: signalTs, entry: fillPx, sl: slPx, tp: tpPx,
    outcome, exit: exitPx, pnlSlip,
    rangeLow: low, rangeHigh: high, wallOrders: wallCount,
  });
  cooldownUntil = signalTs + COOLDOWN_MS;
}

console.log(`\nSkip reasons:`);
for (const [k,v] of Object.entries(skipReasons)) console.log(`  ${k}: ${v}`);

console.log(`\nSignals fired: ${trades.length}`);
const wins = trades.filter(t=>t.outcome==='WIN').length;
const losses = trades.filter(t=>t.outcome==='LOSS').length;
const tstops = trades.filter(t=>t.outcome==='TIMESTOP').length;
const totalSlip = trades.reduce((s,t)=>s+t.pnlSlip,0);
const wr = (wins+losses) > 0 ? wins/(wins+losses)*100 : 0;
console.log(`WIN=${wins}  LOSS=${losses}  TIMESTOP=${tstops}`);
console.log(`WR: ${wr.toFixed(1)}%`);
console.log(`Slipped: ${totalSlip.toFixed(1)}pts ($${(totalSlip*2).toFixed(0)} on 1 MNQ)`);

console.log(`\n── Trades ──`);
const fmtEt = (ms: number) => new Date(ms - 4*60*60_000).toISOString().substring(11, 19);
console.log(`  time(ET)  entry    SL      TP      outcome  exit     wall  rng    pnl`);
for (const t of trades) {
  console.log(`  ${fmtEt(t.ts)}  ${t.entry.toFixed(2)}  ${t.sl.toFixed(2)}  ${t.tp.toFixed(2)}  ${t.outcome.padEnd(8)} ${t.exit.toFixed(2)}  ${t.wallOrders.toString().padStart(3)}  ${(t.rangeHigh-t.rangeLow).toFixed(1)}  ${(t.pnlSlip>=0?'+':'')+t.pnlSlip.toFixed(1)}`);
}

console.log(`\n══ Verdict ══`);
if (wr >= 70 && totalSlip > 0) {
  console.log(`✅ ${wr.toFixed(1)}% slipped WR with +${totalSlip.toFixed(1)} pts/day — SHIP TO V3 SHADOW`);
} else if (wr >= 50) {
  console.log(`⚠ ${wr.toFixed(1)}% WR — iterate confluence further`);
} else {
  console.log(`❌ ${wr.toFixed(1)}% WR — kill, or relax conditions`);
}
console.log(`Done.`);
