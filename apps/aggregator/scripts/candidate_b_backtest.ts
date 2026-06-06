// Candidate B — HFT Cancel-Burst Trend Continuation
//
// Thesis: When HFT firms pull quotes en masse from one side of the book
// (mass <100ms cancellations), an institutional-sized move is incoming in
// the OPPOSITE direction. Combine with simple 5min-VWAP trend filter.
//
// TRIGGER (LONG candidate — mirror for SHORT):
//   1. RTH only (09:30-16:00 ET)
//   2. Last-trade price > 5min VWAP (uptrend established)
//   3. 5min high-low range >= 8pt (sufficient volatility)
//   4. In last 500ms: ≥ N=30 ask-side orders with lifetime <100ms cancelled
//      AND ≥ 1 buy-aggressor order with size ≥ 10 contracts hits in same window
//   5. NO opposite cancel-burst on bid side in same 500ms window
//   6. No active candidate-B trade open
//
// EXECUTION:
//   ENTRY: limit BUY at current bid; require fill within 1000ms or skip signal
//   SL: 0.5pt below entry-bid - max(spread, 2pt) → ~3pt SL distance
//   TP: 12pt; trail to BE after +6pt
//   Hard time-stop: close at market if open > 5min
//   R:R ≥ 1:4

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const _origLog = console.log;
console.log = (...args: any[]) => {
  fs.writeSync(1, args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n');
};

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const MBO_DB = path.resolve(__dirname, '../../../data/mbo.db');
const TK_DB  = path.resolve(__dirname, '../../../data/ticks.db');

// ── Strategy params ────────────────────────────────────────────────────────
const SYMBOL_MBO = 'MNQM';
const CONTRACT   = 'MNQM6_CME_BMD';
const SYMBOL_TK  = 'NQ';

// RTH only
const RTH_START_OFFSET_MIN = 9*60 + 30;
const RTH_END_OFFSET_MIN   = 16*60;

// MBO day: 2026-06-02
const MBO_DAY_START = 1780358400000;
const MBO_DAY_END   = 1780444800000;

const SCAN_RTH_START = 1780405800000;  // 09:30 ET = 13:30 UTC
const SCAN_RTH_END   = 1780425600000;  // 16:00 ET = 20:00 UTC

// Cancel-burst trigger params (loosened from initial run for sample size)
const CANCEL_BURST_WINDOW_MS = 500;
const CANCEL_BURST_LIFETIME_MS = 100;
const CANCEL_BURST_MIN_COUNT = 15;     // ≥15 quick-cancels on one side
const AGGRESSOR_MIN_SIZE = 3;          // institutional aggressor minimum
const FILL_TIMEOUT_MS = 1000;

// Trend filter
const VWAP_WINDOW_MS = 5 * 60_000;
const MIN_5MIN_RANGE = 5.0;   // pt

// Exit params — fixed 3pt SL for hard 1:4 R:R
const TP_PTS = 12;
const SL_PTS = 3;
const TRAIL_TRIGGER = 6;
const HARD_TIMESTOP_MS = 5 * 60_000;

// Execution: MARKET entry with 0.5pt slip (continuation trades chase)
const ENTRY_SLIP_PT = 0.5;
const SPREAD_PT = 0.25;
const SL_SLIP_PT = 1.0;

// ── Loaders ────────────────────────────────────────────────────────────────
console.log('═══ Candidate B Backtest — HFT Cancel-Burst Trend Continuation ═══');
console.log(`Window=${CANCEL_BURST_WINDOW_MS}ms  Cancel-life<${CANCEL_BURST_LIFETIME_MS}ms  Min=${CANCEL_BURST_MIN_COUNT}`);
console.log(`Trend: 5min VWAP, range ≥ ${MIN_5MIN_RANGE}pt`);
console.log(`TP=${TP_PTS}pt  SL=${SL_PTS}pt (R:R 1:4)  Trail BE after +${TRAIL_TRIGGER}pt  Timestop ${HARD_TIMESTOP_MS/60000}min`);
console.log(`Slippage: spread ${SPREAD_PT}pt, SL slip ${SL_SLIP_PT}pt\n`);

const mbo = new Database(MBO_DB, { readonly: true });
const tk  = new Database(TK_DB,  { readonly: true });

// Index mbo_orders by send_ts for fast queries
console.log('Loading order lifecycle data...');
const t0 = Date.now();

// Per-side cancel events with their lifetime (cancel_ts - send_ts).
// We'll only care about orders that were canceled (not filled).
const quickCancels = mbo.prepare(`
  SELECT cancel_ts_ms as ts, is_bid, send_price as price,
         (cancel_ts_ms - send_ts_ms) as lifetime_ms
  FROM mbo_orders
  WHERE symbol = ? AND status = 'cancelled' AND is_bid IS NOT NULL
    AND send_ts_ms IS NOT NULL AND cancel_ts_ms IS NOT NULL
    AND cancel_ts_ms BETWEEN ? AND ?
    AND (cancel_ts_ms - send_ts_ms) < ?
  ORDER BY cancel_ts_ms ASC
`).all(SYMBOL_MBO, SCAN_RTH_START, SCAN_RTH_END, CANCEL_BURST_LIFETIME_MS) as Array<{
  ts: number; is_bid: number; price: number; lifetime_ms: number;
}>;
console.log(`  Loaded ${quickCancels.length.toLocaleString()} quick-cancel events (lifetime <${CANCEL_BURST_LIFETIME_MS}ms)`);

// Aggressor trades for confirmation
const aggressorTrades = mbo.prepare(`
  SELECT ts_ms as ts, is_bid_aggressor as is_bid_agg, size, aggressor_order_id
  FROM mbo_trades
  WHERE symbol = ? AND ts_ms BETWEEN ? AND ?
    AND aggressor_order_id IS NOT NULL AND aggressor_order_id != ''
    AND size >= ?
  ORDER BY ts_ms ASC
`).all(SYMBOL_MBO, SCAN_RTH_START, SCAN_RTH_END, AGGRESSOR_MIN_SIZE) as Array<{
  ts: number; is_bid_agg: number; size: number; aggressor_order_id: string;
}>;
console.log(`  Loaded ${aggressorTrades.length.toLocaleString()} aggressor trades (size ≥ ${AGGRESSOR_MIN_SIZE})`);

// NQ ticks for entry simulation + walk-forward
const ticks = tk.prepare(`
  SELECT ts, price FROM trades WHERE symbol = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC
`).all(SYMBOL_TK, SCAN_RTH_START - VWAP_WINDOW_MS, SCAN_RTH_END + 10*60_000) as Array<{
  ts: number; price: number;
}>;
console.log(`  Loaded ${ticks.length.toLocaleString()} NQ ticks`);

// NQ trade-volume + signed for VWAP
const ticksWithVol = tk.prepare(`
  SELECT ts, price, size, is_bid_aggressor FROM trades
  WHERE symbol = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC
`).all(SYMBOL_TK, SCAN_RTH_START - VWAP_WINDOW_MS, SCAN_RTH_END + 10*60_000) as Array<{
  ts: number; price: number; size: number; is_bid_aggressor: number;
}>;
console.log(`  Loaded ${ticksWithVol.length.toLocaleString()} NQ trade-vol rows`);
console.log(`Load complete in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);

// ── Helpers ────────────────────────────────────────────────────────────────
function tickIdxAtOrAfter(ts: number): number {
  let lo = 0, hi = ticks.length - 1, res = ticks.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid]!.ts >= ts) { res = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  return res;
}
function priceAt(ts: number): number | null {
  let lo = 0, hi = ticks.length - 1, res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid]!.ts <= ts) { res = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return res >= 0 ? ticks[res]!.price : null;
}

// Compute 5-min VWAP + range at a timestamp. Uses ticksWithVol.
function vwapAndRange(ts: number): { vwap: number; high: number; low: number } | null {
  const start = ts - VWAP_WINDOW_MS;
  // Linear scan with binary-search start
  let lo = 0, hi = ticksWithVol.length - 1, startIdx = ticksWithVol.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ticksWithVol[mid]!.ts >= start) { startIdx = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  let sumPV = 0, sumV = 0, high = -Infinity, low = Infinity, n = 0;
  for (let i = startIdx; i < ticksWithVol.length; i++) {
    const t = ticksWithVol[i]!;
    if (t.ts > ts) break;
    sumPV += t.price * t.size;
    sumV += t.size;
    if (t.price > high) high = t.price;
    if (t.price < low) low = t.price;
    n++;
  }
  if (sumV === 0 || n < 10) return null;
  return { vwap: sumPV / sumV, high, low };
}

// ── Main loop: scan for cancel-burst triggers using sliding-window indices ──
// Process all unique candidate timestamps (each aggressor trade is a potential trigger)
console.log('Scanning for triggers...');
const tScan = Date.now();

interface Trade {
  triggerTs: number;
  direction: 'long' | 'short';
  entryTs: number | null;     // null if limit didn't fill
  entryPx: number | null;
  slPx: number;
  tpPx: number;
  outcome: 'WIN' | 'LOSS' | 'TIMESTOP' | 'NO_FILL';
  exitTs: number | null;
  exitPx: number | null;
  pnlTheo: number;
  pnlSlip: number;
}

const trades: Trade[] = [];
let triggerCount = 0;
let skipReasons: Record<string, number> = {};

// Cancel buckets per side — index by side (0/1)
let cancelWindowStart = 0;

// We'll iterate over aggressor trades as candidate trigger points.
// For each one, check (a) cancel-burst on opposite side in last 500ms,
// (b) no opposing cancel-burst on aggressor's side in same window,
// (c) trend filter conditions.

// Pre-sort quickCancels by ts (already sorted)
// For each aggressor trade at ts:
//   Find all quickCancels in [ts-500, ts]
//   Count by side
let cancelIdx = 0;
let activeTradeUntil = 0;  // hard cooldown — no overlapping trades

let openTradeExitProcessed = true;  // for back-to-back signal handling

for (const agg of aggressorTrades) {
  const ts = agg.ts;
  if (ts < activeTradeUntil) { skipReasons['IN_TRADE'] = (skipReasons['IN_TRADE'] ?? 0) + 1; continue; }
  if (agg.size < AGGRESSOR_MIN_SIZE) continue;

  // Slide window
  const windowStart = ts - CANCEL_BURST_WINDOW_MS;
  while (cancelIdx < quickCancels.length && quickCancels[cancelIdx]!.ts < windowStart) cancelIdx++;

  // Count cancels by side within window
  let askSideCancels = 0, bidSideCancels = 0;
  for (let i = cancelIdx; i < quickCancels.length; i++) {
    const c = quickCancels[i]!;
    if (c.ts > ts) break;
    if (c.is_bid === 0) askSideCancels++;
    else bidSideCancels++;
  }

  // INVERTED: FADE the cancel-burst direction (initial test showed inverse correlation).
  // ASK-side cancel-burst → SHORT (asks pulled = vacuum, price drops)
  // BID-side cancel-burst → LONG (bids pulled = bottom, but buyers step in)
  // Aggressor must align with the FADE direction.
  const isShortTrigger = askSideCancels >= CANCEL_BURST_MIN_COUNT
                        && bidSideCancels < CANCEL_BURST_MIN_COUNT
                        && agg.is_bid_agg === 0;  // sell-aggressor on ask-cancel-burst
  const isLongTrigger = bidSideCancels >= CANCEL_BURST_MIN_COUNT
                       && askSideCancels < CANCEL_BURST_MIN_COUNT
                       && agg.is_bid_agg === 1;   // buy-aggressor on bid-cancel-burst

  if (!isLongTrigger && !isShortTrigger) {
    skipReasons['NO_BURST'] = (skipReasons['NO_BURST'] ?? 0) + 1;
    continue;
  }

  // Trend filter
  const vr = vwapAndRange(ts);
  if (!vr) { skipReasons['NO_VWAP'] = (skipReasons['NO_VWAP'] ?? 0) + 1; continue; }
  const lastPx = priceAt(ts);
  if (lastPx === null) { skipReasons['NO_PX'] = (skipReasons['NO_PX'] ?? 0) + 1; continue; }
  const range = vr.high - vr.low;
  if (range < MIN_5MIN_RANGE) { skipReasons['LOW_RANGE'] = (skipReasons['LOW_RANGE'] ?? 0) + 1; continue; }

  const direction: 'long'|'short' = isLongTrigger ? 'long' : 'short';
  // Fade variant doesn't need trend alignment — keep filter loose

  triggerCount++;

  // Entry: MARKET order (continuation = chase). LONG fills at ask = lastPx + spread/2 + slip.
  // Fill is immediate (next tick).
  const fillStartIdx = tickIdxAtOrAfter(ts);
  if (fillStartIdx >= ticks.length) {
    trades.push({ triggerTs: ts, direction, entryTs: null, entryPx: null,
      slPx: 0, tpPx: 0, outcome: 'NO_FILL', exitTs: null, exitPx: null, pnlTheo: 0, pnlSlip: 0 });
    continue;
  }
  const fillTickPx = ticks[fillStartIdx]!.price;
  const fillTs = ticks[fillStartIdx]!.ts;
  const dir = direction === 'long' ? 1 : -1;
  // LONG: pay ask + slip = lastTrade + SPREAD/2 + ENTRY_SLIP_PT
  // SHORT: pay bid - slip
  const fillPx = fillTickPx + dir * (SPREAD_PT/2 + ENTRY_SLIP_PT);

  // SL: fixed 3pt below entry for LONG (above for SHORT) — gives hard 1:4 R:R
  const slPx = fillPx - dir * SL_PTS;
  const tpPx = fillPx + dir * TP_PTS;
  const slDist = SL_PTS;

  // Walk forward to determine outcome (with trailing BE)
  let outcome: 'WIN'|'LOSS'|'TIMESTOP' = 'TIMESTOP';
  let exitTs: number | null = null;
  let exitPx: number | null = null;
  let effectiveSL = slPx;
  let trailMoved = false;
  const startIdx = tickIdxAtOrAfter(fillTs + 1);
  const hardStopTs = fillTs + HARD_TIMESTOP_MS;
  for (let i = startIdx; i < ticks.length; i++) {
    const t = ticks[i]!;
    if (t.ts > hardStopTs) { exitTs = t.ts; exitPx = t.price; break; }
    const move = dir * (t.price - fillPx);
    if (!trailMoved && move >= TRAIL_TRIGGER) {
      effectiveSL = fillPx;  // move to BE
      trailMoved = true;
    }
    const hitTP = dir === 1 ? t.price >= tpPx : t.price <= tpPx;
    const hitSL = dir === 1 ? t.price <= effectiveSL : t.price >= effectiveSL;
    if (hitTP) { outcome = 'WIN'; exitTs = t.ts; exitPx = tpPx; break; }
    if (hitSL) {
      // BE-trail SL outcome: positive move turned negative back to BE = "scratch"
      outcome = trailMoved && Math.abs(effectiveSL - fillPx) < 0.01 ? 'TIMESTOP' : 'LOSS';
      exitTs = t.ts;
      exitPx = effectiveSL;
      break;
    }
  }

  // Block overlapping trades during the position
  activeTradeUntil = (exitTs ?? hardStopTs) + 1000;

  const pnlTheo = outcome === 'WIN' ? TP_PTS
                : outcome === 'LOSS' ? -slDist
                : outcome === 'TIMESTOP' ? (exitPx !== null ? dir * (exitPx - fillPx) : 0)
                : 0;
  // Slipped: SL slips additional 1pt past; entry was limit at 0 slip; TP exact
  const pnlSlip = outcome === 'WIN' ? TP_PTS
                : outcome === 'LOSS' ? -(slDist + SL_SLIP_PT)
                : outcome === 'TIMESTOP' ? (exitPx !== null ? dir * (exitPx - fillPx) - 0.5 : 0)  // half-tick exit slip on market timestop
                : 0;

  trades.push({
    triggerTs: ts, direction,
    entryTs: fillTs, entryPx: fillPx,
    slPx, tpPx,
    outcome, exitTs, exitPx,
    pnlTheo, pnlSlip,
  });
}

console.log(`Scanned ${aggressorTrades.length.toLocaleString()} aggressor candidates in ${((Date.now()-tScan)/1000).toFixed(1)}s`);
console.log(`Triggers fired: ${triggerCount}, Trades simulated: ${trades.filter(t => t.entryTs !== null).length}`);
console.log(`Skip reasons:`);
for (const [k,v] of Object.entries(skipReasons)) {
  console.log(`  ${k}: ${v.toLocaleString()}`);
}

// ── Report ─────────────────────────────────────────────────────────────────
const filled = trades.filter(t => t.outcome !== 'NO_FILL');
const wins = filled.filter(t => t.outcome === 'WIN').length;
const losses = filled.filter(t => t.outcome === 'LOSS').length;
const timestops = filled.filter(t => t.outcome === 'TIMESTOP').length;
const closed = wins + losses + timestops;

const theoSum = filled.reduce((s,t) => s + t.pnlTheo, 0);
const slipSum = filled.reduce((s,t) => s + t.pnlSlip, 0);
const noFills = trades.filter(t => t.outcome === 'NO_FILL').length;
const fillRate = trades.length > 0 ? (filled.length / trades.length * 100) : 0;

console.log(`\n══ Results ══`);
console.log(`  Signals fired:    ${trades.length}`);
console.log(`  Limit fills:      ${filled.length} (${fillRate.toFixed(1)}% fill rate)`);
console.log(`  WIN:              ${wins}`);
console.log(`  LOSS:             ${losses}`);
console.log(`  TIMESTOP:         ${timestops}  (BE-scratch or time-up)`);
console.log(`  WR (W/W+L):       ${losses + wins > 0 ? (wins/(wins+losses)*100).toFixed(1) : '—'}%`);
console.log(`  WR (W/closed):    ${closed > 0 ? (wins/closed*100).toFixed(1) : '—'}%`);
console.log(`  Theoretical PnL:  ${theoSum >= 0 ? '+' : ''}${theoSum.toFixed(1)} pts`);
console.log(`  Slipped PnL:      ${slipSum >= 0 ? '+' : ''}${slipSum.toFixed(1)} pts`);
console.log(`  Per-trade slip:   ${filled.length > 0 ? (slipSum/filled.length).toFixed(2) : '—'} pts/trade`);
console.log(`  Day $/MNQ slip:   $${(slipSum * 2).toFixed(0)}`);

console.log(`\n── First 20 trades ──`);
console.log('  trig(ET)        dir  entry    SL      TP      outcome  exit     theo  slip');
const fmtEt = (ms: number) => new Date(ms - 4*60*60_000).toISOString().substring(11, 19);
for (const t of trades.filter(t => t.outcome !== 'NO_FILL').slice(0, 20)) {
  console.log(`  ${fmtEt(t.triggerTs)}  ${t.direction[0]!.toUpperCase()}  ${(t.entryPx??0).toFixed(2)}  ${t.slPx.toFixed(2)}  ${t.tpPx.toFixed(2)}  ${t.outcome.padEnd(8)} ${(t.exitPx??0).toFixed(2)}  ${(t.pnlTheo>=0?'+':'')+t.pnlTheo.toFixed(1)}  ${(t.pnlSlip>=0?'+':'')+t.pnlSlip.toFixed(1)}`);
}

// Direction split
const longs = filled.filter(t => t.direction === 'long');
const shorts = filled.filter(t => t.direction === 'short');
const lw = longs.filter(t => t.outcome === 'WIN').length;
const ll = longs.filter(t => t.outcome === 'LOSS').length;
const sw = shorts.filter(t => t.outcome === 'WIN').length;
const sl = shorts.filter(t => t.outcome === 'LOSS').length;
console.log(`\n── Direction split ──`);
console.log(`  LONG:  n=${longs.length}  W=${lw}  L=${ll}  WR=${lw+ll>0?(lw/(lw+ll)*100).toFixed(1):'—'}%  slip=${longs.reduce((s,t)=>s+t.pnlSlip,0).toFixed(1)}pts`);
console.log(`  SHORT: n=${shorts.length}  W=${sw}  L=${sl}  WR=${sw+sl>0?(sw/(sw+sl)*100).toFixed(1):'—'}%  slip=${shorts.reduce((s,t)=>s+t.pnlSlip,0).toFixed(1)}pts`);

console.log(`\n══ VERDICT ══`);
const wrPct = (wins+losses) > 0 ? wins/(wins+losses)*100 : 0;
if (wrPct >= 70 && slipSum > 0) {
  console.log(`  ✅ ≥70% slipped WR achieved with positive expectancy. SHIP TO V3 SHADOW.`);
} else if (wrPct >= 60) {
  console.log(`  ⚠ ${wrPct.toFixed(1)}% WR — below 70% target. ITERATE: tighten confluence conditions.`);
} else {
  console.log(`  ❌ ${wrPct.toFixed(1)}% WR — well below target. RETHINK trigger structure.`);
}
console.log(`Done.`);
