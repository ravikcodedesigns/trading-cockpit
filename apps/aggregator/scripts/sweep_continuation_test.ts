// Sweep continuation strategy validation.
//
// SWEEP DEFINITION: a single aggressor_order_id consuming ≥ N distinct price levels
// in a single execution (i.e., one market order swept multiple ticks of resting liquidity).
// This is structurally informational — a non-spoofer took out N levels of defense in one shot.
//
// THESIS: post-sweep, the move continues in the sweep direction (continuation), not reverses.
// This contrasts with the wall-fade thesis (which we proved doesn't work).
//
// TEST: for each sweep meeting filter:
//   Direction: BUY-aggressor sweep → LONG; SELL-aggressor sweep → SHORT
//   Entry: price at end-of-sweep + 1pt slippage (chasing market)
//   TP: entry + 10pts in trade direction
//   SL: structural — 0.5pt beyond the START of the sweep (i.e., if price retraces all the
//       way back through the sweep, momentum is dead — thesis invalidated)
//   Horizon: 5min
//
// Stratify by sweep "size" — number of levels consumed:
//   3 levels (min), 4, 5, 6+, 10+

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
const RTH_START = 1780405800000;
const RTH_END   = 1780425600000;

const MIN_LEVELS    = 3;
const TP_PTS        = 10;
const SL_BUFFER     = 0.50;
const SLIP_ENTRY    = 1.0;    // 1pt market chase to enter (continuation = chase)
const SLIP_SL       = 1.0;
const HORIZON_MS    = 5 * 60_000;

const mbo = new Database(MBO_DB, { readonly: true });
const tk  = new Database(TK_DB,  { readonly: true });
function pad(s: any, w: number, left = true) { return left ? String(s).padStart(w) : String(s).padEnd(w); }

console.log('═══ Sweep continuation test ═══');
console.log(`MIN_LEVELS=${MIN_LEVELS}  TP=${TP_PTS}pts  SL=0.5pt beyond sweep start  Slip: entry=${SLIP_ENTRY} / SL=${SLIP_SL}`);
console.log(`Horizon=${HORIZON_MS/60_000}min  RTH 09:30–16:00 ET 2026-06-02\n`);

// Load all NQ ticks for outcome walks
const ticks = tk.prepare(`
  SELECT ts, price FROM trades WHERE symbol=? AND ts BETWEEN ? AND ? ORDER BY ts ASC
`).all(SYMBOL_TK, RTH_START, RTH_END + 10*60_000) as Array<{ts:number;price:number}>;
console.log(`Loaded ${ticks.length.toLocaleString()} NQ ticks`);

// Pull all multi-level sweeps from mbo_executions (already aggregated by mbo_ingest)
const sweeps = mbo.prepare(`
  SELECT aggressor_order_id, start_ts_ms, end_ts_ms, is_bid_aggressor,
         num_legs, total_size, first_price, last_price, min_price, max_price,
         distinct_prices
  FROM mbo_executions
  WHERE symbol=? AND start_ts_ms BETWEEN ? AND ?
    AND distinct_prices >= ?
  ORDER BY start_ts_ms ASC
`).all(SYMBOL_MBO, RTH_START, RTH_END, MIN_LEVELS) as Array<{
  aggressor_order_id: string; start_ts_ms: number; end_ts_ms: number;
  is_bid_aggressor: number; num_legs: number; total_size: number;
  first_price: number; last_price: number; min_price: number; max_price: number;
  distinct_prices: number;
}>;
console.log(`Loaded ${sweeps.length.toLocaleString()} multi-level sweeps (≥${MIN_LEVELS} levels)\n`);

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
function walkOutcome(startIdx: number, endTs: number, tpPx: number, slPx: number, dir: 1|-1): 'WIN'|'LOSS'|'OPEN' {
  for (let i = startIdx; i < ticks.length; i++) {
    const t = ticks[i]!;
    if (t.ts > endTs) break;
    const hitTP = dir === 1 ? t.price >= tpPx : t.price <= tpPx;
    const hitSL = dir === 1 ? t.price <= slPx : t.price >= slPx;
    if (hitTP) return 'WIN';
    if (hitSL) return 'LOSS';
  }
  return 'OPEN';
}

interface Bucket {
  label: string; n: number; win: number; loss: number; open: number;
  theoSum: number; slipSum: number; slDistSum: number;
}
const buckets: Record<string, Bucket> = {
  '3':    { label: '3 lvls',  n: 0, win: 0, loss: 0, open: 0, theoSum: 0, slipSum: 0, slDistSum: 0 },
  '4':    { label: '4 lvls',  n: 0, win: 0, loss: 0, open: 0, theoSum: 0, slipSum: 0, slDistSum: 0 },
  '5':    { label: '5 lvls',  n: 0, win: 0, loss: 0, open: 0, theoSum: 0, slipSum: 0, slDistSum: 0 },
  '6-9':  { label: '6-9 lvl', n: 0, win: 0, loss: 0, open: 0, theoSum: 0, slipSum: 0, slDistSum: 0 },
  '10+':  { label: '10+ lvl', n: 0, win: 0, loss: 0, open: 0, theoSum: 0, slipSum: 0, slDistSum: 0 },
};
const bucketOf = (lvl: number) =>
  lvl === 3 ? '3' : lvl === 4 ? '4' : lvl === 5 ? '5' : lvl < 10 ? '6-9' : '10+';

let skipped = 0;
for (const s of sweeps) {
  // Direction: buy aggressor (is_bid_aggressor=1) → LONG continuation
  //            sell aggressor                    → SHORT continuation
  const dir: 1|-1 = s.is_bid_aggressor === 1 ? 1 : -1;

  // Entry: last_price + 1pt chase slip (market order chasing after sweep)
  // For LONG: entry = last_price + 1 (worse fill, higher)
  // For SHORT: entry = last_price - 1 (worse fill, lower)
  const lastNqPx = priceAt(s.end_ts_ms);
  if (lastNqPx === null) { skipped++; continue; }
  const entryPx = lastNqPx + dir * SLIP_ENTRY;

  // SL: structural — start of the sweep (first_price) + 0.5pt buffer on the WRONG side
  //   LONG continuation:  sweep went UP. Start price < last price. SL = first_price - 0.5
  //   SHORT continuation: sweep went DOWN. Start price > last price. SL = first_price + 0.5
  const slPx = dir === 1 ? s.first_price - SL_BUFFER : s.first_price + SL_BUFFER;
  if (dir === 1 && slPx >= entryPx) { skipped++; continue; }
  if (dir === -1 && slPx <= entryPx) { skipped++; continue; }
  const slDist = dir === 1 ? entryPx - slPx : slPx - entryPx;
  if (slDist < 1.0 || slDist > 10.0) { skipped++; continue; }

  const tpPx = entryPx + dir * TP_PTS;
  const startIdx = tickIdxAtOrAfter(s.end_ts_ms);
  const outcome = walkOutcome(startIdx, s.end_ts_ms + HORIZON_MS, tpPx, slPx, dir);

  const b = buckets[bucketOf(s.distinct_prices)]!;
  b.n++;
  b.slDistSum += slDist;
  if (outcome === 'WIN') {
    b.win++;
    b.theoSum += TP_PTS;
    // limit-TP would fill at TP exactly; we're using market entry so we paid entry slip
    // theoretical assumes no slip on either side; slipped includes entry slip already in entry calc
    b.slipSum += TP_PTS;  // entry slip already paid via entryPx adjustment
  } else if (outcome === 'LOSS') {
    b.loss++;
    b.theoSum -= slDist;
    b.slipSum -= (slDist + SLIP_SL);  // stop slips an extra 1pt past
  } else {
    b.open++;
  }
}
console.log(`Skipped (no tick / invalid SL): ${skipped}\n`);

console.log(`══ Results by sweep size ══`);
console.log(`${pad('bucket', 8)} ${pad('n', 5)} ${pad('WIN', 5)} ${pad('LOSS', 5)} ${pad('OPEN', 5)} ${pad('WR', 7)} ${pad('avgSL', 6)} ${pad('theo', 9)} ${pad('slipped', 9)} ${pad('$/day', 8)}`);
for (const key of ['3','4','5','6-9','10+']) {
  const b = buckets[key]!;
  const closed = b.win + b.loss;
  if (b.n === 0) continue;
  const wr = closed > 0 ? (b.win / closed * 100) : 0;
  const avgSL = b.slDistSum / b.n;
  // theoExp from theoSum (no slip): WINs add +10, LOSSes subtract avgSL
  // slipExp from slipSum: WINs add +10 (limit), LOSSes subtract avgSL+SLIP_SL
  // BUT entry slip already baked into entryPx → WIN profit = TP-entry_slip = 10-1 = 9pt realized
  // Let me recompute properly:
  //   theoreticalProfitPerWin = TP_PTS (10) — assuming 0 entry slip
  //   slippedProfitPerWin = TP_PTS - SLIP_ENTRY = 9
  //   theoreticalLossPerLoss = avgSL — assuming 0 SL slip + 0 entry slip
  //   slippedLossPerLoss = avgSL + SLIP_ENTRY + SLIP_SL = avgSL + 2
  const theoExp = closed > 0 ? (b.win * TP_PTS - b.loss * avgSL) / closed : 0;
  const slipExp = closed > 0 ? (b.win * (TP_PTS - SLIP_ENTRY) - b.loss * (avgSL + SLIP_SL + SLIP_ENTRY)) / closed : 0;
  const dailyMnq = slipExp * b.n * 2;  // $2/pt MNQ
  console.log(`${pad(b.label, 8)} ${pad(b.n, 5)} ${pad(b.win, 5)} ${pad(b.loss, 5)} ${pad(b.open, 5)} ${pad(wr.toFixed(1)+'%', 7)} ${pad(avgSL.toFixed(2), 6)} ${pad((theoExp>=0?'+':'')+theoExp.toFixed(2), 9)} ${pad((slipExp>=0?'+':'')+slipExp.toFixed(2), 9)} ${pad('$'+dailyMnq.toFixed(0), 8)}`);
}

// Aggregate across all
let totN=0, totW=0, totL=0, totO=0, totSlDist=0;
for (const b of Object.values(buckets)) {
  totN+=b.n; totW+=b.win; totL+=b.loss; totO+=b.open; totSlDist+=b.slDistSum;
}
const aggClosed = totW + totL;
const aggWR = aggClosed > 0 ? (totW/aggClosed*100) : 0;
const aggAvgSL = totN > 0 ? totSlDist/totN : 0;
const aggTheo = aggClosed > 0 ? (totW * TP_PTS - totL * aggAvgSL) / aggClosed : 0;
const aggSlip = aggClosed > 0 ? (totW * (TP_PTS - SLIP_ENTRY) - totL * (aggAvgSL + SLIP_SL + SLIP_ENTRY)) / aggClosed : 0;
console.log(`${pad('TOTAL', 8)} ${pad(totN, 5)} ${pad(totW, 5)} ${pad(totL, 5)} ${pad(totO, 5)} ${pad(aggWR.toFixed(1)+'%', 7)} ${pad(aggAvgSL.toFixed(2), 6)} ${pad((aggTheo>=0?'+':'')+aggTheo.toFixed(2), 9)} ${pad((aggSlip>=0?'+':'')+aggSlip.toFixed(2), 9)} ${pad('$'+(aggSlip*totN*2).toFixed(0), 8)}`);

console.log(`\nDone.`);
