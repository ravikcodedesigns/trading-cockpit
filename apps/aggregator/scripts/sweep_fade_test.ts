// Sweep FADE strategy validation (inverse of continuation).
//
// PRIOR RESULT: continuation test had 97% LOSS rate — sweeps overwhelmingly REVERSE.
// THIS TEST: trade AGAINST the sweep direction, with structural SL at the sweep's extreme.
//
// SETUP:
//   BUY-aggressor sweep (price went UP)  → SHORT entry, TP = entry - 10, SL = max_price + 0.5
//   SELL-aggressor sweep (price went DOWN) → LONG entry, TP = entry + 10, SL = min_price - 0.5
//   Entry: market order at end-of-sweep — for a fade, the market is moving AGAINST our entry
//          so slip would actually be FAVORABLE. Conservative: assume 0pt entry slip.
//   Horizon: 5min

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
const SLIP_ENTRY    = 0.5;    // half-tick favorable / unfavorable depending on book state
const SLIP_SL       = 1.0;
const HORIZON_MS    = 5 * 60_000;

const mbo = new Database(MBO_DB, { readonly: true });
const tk  = new Database(TK_DB,  { readonly: true });
function pad(s: any, w: number, left = true) { return left ? String(s).padStart(w) : String(s).padEnd(w); }

console.log('═══ Sweep FADE test (invert of continuation) ═══');
console.log(`MIN_LEVELS=${MIN_LEVELS}  TP=${TP_PTS}pts  SL=0.5pt beyond sweep EXTREME  Slip: entry=${SLIP_ENTRY} / SL=${SLIP_SL}`);
console.log(`Horizon=${HORIZON_MS/60_000}min  RTH 09:30–16:00 ET 2026-06-02\n`);

const ticks = tk.prepare(`
  SELECT ts, price FROM trades WHERE symbol=? AND ts BETWEEN ? AND ? ORDER BY ts ASC
`).all(SYMBOL_TK, RTH_START, RTH_END + 10*60_000) as Array<{ts:number;price:number}>;
console.log(`Loaded ${ticks.length.toLocaleString()} NQ ticks`);

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
console.log(`Loaded ${sweeps.length.toLocaleString()} multi-level sweeps\n`);

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
  slDistSum: number;
}
const buckets: Record<string, Bucket> = {
  '3':    { label: '3 lvls',  n: 0, win: 0, loss: 0, open: 0, slDistSum: 0 },
  '4':    { label: '4 lvls',  n: 0, win: 0, loss: 0, open: 0, slDistSum: 0 },
  '5':    { label: '5 lvls',  n: 0, win: 0, loss: 0, open: 0, slDistSum: 0 },
  '6-9':  { label: '6-9 lvl', n: 0, win: 0, loss: 0, open: 0, slDistSum: 0 },
  '10+':  { label: '10+ lvl', n: 0, win: 0, loss: 0, open: 0, slDistSum: 0 },
};
const bucketOf = (lvl: number) =>
  lvl === 3 ? '3' : lvl === 4 ? '4' : lvl === 5 ? '5' : lvl < 10 ? '6-9' : '10+';

let skipped = 0;
for (const s of sweeps) {
  // FADE direction: opposite of sweep
  //   BUY sweep (is_bid_aggressor=1, price went up) → SHORT (dir=-1)
  //   SELL sweep → LONG (dir=+1)
  const dir: 1|-1 = s.is_bid_aggressor === 1 ? -1 : 1;
  const lastNqPx = priceAt(s.end_ts_ms);
  if (lastNqPx === null) { skipped++; continue; }
  // Entry: market at end-of-sweep. For fade, slip can be favorable or unfavorable.
  // Conservative: 0.5pt UNFAVORABLE (we're entering when market is still volatile)
  const entryPx = lastNqPx + dir * SLIP_ENTRY;  // dir=+1 long: pay +0.5; dir=-1 short: pay -0.5 (worse fill)
  // SL: structural — sweep's extreme price (max for BUY sweep, min for SELL sweep)
  //   BUY sweep → max_price + 0.5 buffer (above the high)
  //   SELL sweep → min_price - 0.5 buffer (below the low)
  const slPx = dir === -1 ? s.max_price + SL_BUFFER : s.min_price - SL_BUFFER;
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
  if (outcome === 'WIN') b.win++;
  else if (outcome === 'LOSS') b.loss++;
  else b.open++;
}
console.log(`Skipped (no tick / invalid SL): ${skipped}\n`);

console.log(`══ Sweep FADE Results ══`);
console.log(`${pad('bucket', 8)} ${pad('n', 5)} ${pad('WIN', 5)} ${pad('LOSS', 5)} ${pad('OPEN', 5)} ${pad('WR', 7)} ${pad('avgSL', 6)} ${pad('theo', 9)} ${pad('slipped', 9)} ${pad('$/day', 8)}`);
for (const key of ['3','4','5','6-9','10+']) {
  const b = buckets[key]!;
  const closed = b.win + b.loss;
  if (b.n === 0) continue;
  const wr = closed > 0 ? (b.win / closed * 100) : 0;
  const avgSL = b.slDistSum / b.n;
  // theoreticalProfitPerWin: TP_PTS (no slip assumed in theo)
  // slippedProfitPerWin: TP_PTS - SLIP_ENTRY (entry slip already baked into entryPx)
  // theoLossPerLoss: avgSL
  // slipLossPerLoss: avgSL + SLIP_SL + SLIP_ENTRY (entry was unfavorable, SL also slips)
  const theoExp = closed > 0 ? (b.win * TP_PTS - b.loss * avgSL) / closed : 0;
  const slipExp = closed > 0 ? (b.win * (TP_PTS - SLIP_ENTRY) - b.loss * (avgSL + SLIP_SL + SLIP_ENTRY)) / closed : 0;
  const dailyMnq = slipExp * b.n * 2;
  console.log(`${pad(b.label, 8)} ${pad(b.n, 5)} ${pad(b.win, 5)} ${pad(b.loss, 5)} ${pad(b.open, 5)} ${pad(wr.toFixed(1)+'%', 7)} ${pad(avgSL.toFixed(2), 6)} ${pad((theoExp>=0?'+':'')+theoExp.toFixed(2), 9)} ${pad((slipExp>=0?'+':'')+slipExp.toFixed(2), 9)} ${pad('$'+dailyMnq.toFixed(0), 8)}`);
}

let totN=0, totW=0, totL=0, totO=0, totSlDist=0;
for (const b of Object.values(buckets)) { totN+=b.n; totW+=b.win; totL+=b.loss; totO+=b.open; totSlDist+=b.slDistSum; }
const aggClosed = totW + totL;
const aggWR = aggClosed > 0 ? (totW/aggClosed*100) : 0;
const aggAvgSL = totN > 0 ? totSlDist/totN : 0;
const aggTheo = aggClosed > 0 ? (totW * TP_PTS - totL * aggAvgSL) / aggClosed : 0;
const aggSlip = aggClosed > 0 ? (totW * (TP_PTS - SLIP_ENTRY) - totL * (aggAvgSL + SLIP_SL + SLIP_ENTRY)) / aggClosed : 0;
console.log(`${pad('TOTAL', 8)} ${pad(totN, 5)} ${pad(totW, 5)} ${pad(totL, 5)} ${pad(totO, 5)} ${pad(aggWR.toFixed(1)+'%', 7)} ${pad(aggAvgSL.toFixed(2), 6)} ${pad((aggTheo>=0?'+':'')+aggTheo.toFixed(2), 9)} ${pad((aggSlip>=0?'+':'')+aggSlip.toFixed(2), 9)} ${pad('$'+(aggSlip*totN*2).toFixed(0), 8)}`);

console.log(`\nBreakeven WR at avgSL=${aggAvgSL.toFixed(2)}pts: ${(aggAvgSL/(aggAvgSL+TP_PTS)*100).toFixed(1)}% theoretical / ${((aggAvgSL+SLIP_SL+SLIP_ENTRY)/(aggAvgSL+SLIP_SL+SLIP_ENTRY + TP_PTS - SLIP_ENTRY)*100).toFixed(1)}% slipped`);

console.log(`\nDone.`);
