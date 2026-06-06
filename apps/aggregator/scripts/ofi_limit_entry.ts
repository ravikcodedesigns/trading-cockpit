// OFI scalp v3 — LIMIT-order entry.
//
// Strategy:
//   1. Compute 30s OFI windows (the best cell from grid search).
//   2. Filter top-40% |OFI| magnitude → FADE direction.
//   3. Place a LIMIT order at the window-end price (entry_target).
//   4. Wait up to FILL_TIMEOUT_MS for price to TOUCH entry_target.
//      Limit fills at exactly entry_target if touched (zero entry slip).
//      Limit cancels if not filled within timeout (signal stale).
//   5. Once filled, walk forward to TP/SL as before.
//
// Output: fill rate, of-filled stats (WR, theo, slipped).
// Tested at multiple fill timeouts to see fill-rate vs edge tradeoff.

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

const WINDOW_MS  = 30_000;     // 30s — best cell from grid
const TP_PTS     = 10;
const SL_BUFFER  = 0.50;
const SLIPPAGE_SL = 1.0;       // 1pt slip on SL (entry slip = 0 because limit)
const TRADE_HORIZON_MS = 5 * 60_000;
const FILL_TIMEOUTS = [15_000, 30_000, 60_000, 120_000];  // 15s, 30s, 60s, 2m

const mbo = new Database(MBO_DB, { readonly: true });
const tk  = new Database(TK_DB,  { readonly: true });
function pad(s: any, w: number, left = true) { return left ? String(s).padStart(w) : String(s).padEnd(w); }

console.log('═══ OFI v3 — LIMIT-order entry (zero entry slip if filled) ═══');
console.log(`Window=${WINDOW_MS/1000}s  FADE direction  Top-40% OFI quintile`);
console.log(`TP=${TP_PTS}pts  SL=window-extreme ±${SL_BUFFER}pt  Slip on SL=${SLIPPAGE_SL}pt (entry slip = 0)`);
console.log(`Trade horizon=${TRADE_HORIZON_MS/60_000}min after fill`);
console.log(`Testing fill timeouts: ${FILL_TIMEOUTS.map(t => t/1000+'s').join(', ')}\n`);

const t0 = Date.now();
const trades = mbo.prepare(`
  SELECT ts_ms, price, size, is_bid_aggressor FROM mbo_trades
  WHERE symbol=? AND contract=? AND ts_ms BETWEEN ? AND ? ORDER BY ts_ms ASC
`).all(SYMBOL_MBO, CONTRACT, RTH_START, RTH_END) as Array<{ts_ms:number;price:number;size:number;is_bid_aggressor:number}>;
console.log(`Loaded ${trades.length.toLocaleString()} mbo trades`);

const ticks = tk.prepare(`
  SELECT ts, price FROM trades WHERE symbol=? AND ts BETWEEN ? AND ? ORDER BY ts ASC
`).all(SYMBOL_TK, RTH_START, RTH_END + 10*60_000) as Array<{ts:number;price:number}>;
console.log(`Loaded ${ticks.length.toLocaleString()} NQ ticks\n`);

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

// Build 30s OFI windows
const windows: Array<{startTs:number;endTs:number;ofi:number;n:number;hi:number;lo:number}> = [];
let cursor = RTH_START;
while (cursor < RTH_END) {
  windows.push({ startTs: cursor, endTs: cursor + WINDOW_MS, ofi: 0, n: 0, hi: -Infinity, lo: Infinity });
  cursor += WINDOW_MS;
}
let tIdx = 0;
for (const w of windows) {
  while (tIdx < trades.length && trades[tIdx]!.ts_ms < w.endTs) {
    const t = trades[tIdx]!;
    if (t.ts_ms >= w.startTs && t.ts_ms < w.endTs) {
      w.ofi += (t.is_bid_aggressor === 1 ? 1 : -1) * t.size;
      w.n++;
      if (t.price > w.hi) w.hi = t.price;
      if (t.price < w.lo) w.lo = t.price;
    }
    tIdx++;
  }
}
const filled = windows.filter(w => w.n > 0 && w.hi > -Infinity);
const sortedOfi = filled.map(w => Math.abs(w.ofi)).sort((a,b)=>a-b);
const q60 = sortedOfi[Math.floor(sortedOfi.length * 0.6)] ?? 0;
const signals = filled.filter(w => Math.abs(w.ofi) >= q60);
console.log(`Total 30s windows: ${windows.length} | non-empty: ${filled.length} | Q4Q5 signals: ${signals.length}\n`);

// For each fill timeout, simulate
for (const fillTimeoutMs of FILL_TIMEOUTS) {
  let fills = 0, misses = 0, wins = 0, losses = 0, open = 0;
  let theoSum = 0, slipSum = 0;
  let slDistSum = 0;

  for (const w of signals) {
    if (w.ofi === 0) continue;
    const ofiDir: 1|-1 = w.ofi > 0 ? 1 : -1;
    const tradeDir: 1|-1 = -ofiDir as 1|-1;  // FADE
    const entryPx = priceAt(w.endTs);
    if (entryPx === null) continue;
    // SL: opposite side of window extreme + buffer
    //   FADE SHORT (tradeDir=-1): SL above window high
    //   FADE LONG  (tradeDir=+1): SL below window low
    const slPx = tradeDir === 1 ? w.lo - SL_BUFFER : w.hi + SL_BUFFER;
    if (tradeDir === 1 && slPx >= entryPx) continue;
    if (tradeDir === -1 && slPx <= entryPx) continue;
    const slDist = tradeDir === 1 ? entryPx - slPx : slPx - entryPx;
    if (slDist < 1.0 || slDist > 8.0) continue;
    const tpPx = entryPx + tradeDir * TP_PTS;

    // Walk forward to detect LIMIT FILL (price touches entryPx)
    const fillSearchEnd = w.endTs + fillTimeoutMs;
    const fillStartIdx = tickIdxAtOrAfter(w.endTs);
    let fillTs: number | null = null;
    for (let i = fillStartIdx; i < ticks.length; i++) {
      const t = ticks[i]!;
      if (t.ts > fillSearchEnd) break;
      // For SHORT limit, fill when ask reaches our level → price >= entryPx
      // For LONG limit, fill when bid reaches our level → price <= entryPx
      const touched = tradeDir === -1 ? t.price >= entryPx : t.price <= entryPx;
      if (touched) {
        // BUT: avoid trivial first-tick fills (price at window end already at entry).
        // Require the touch to happen AT or AFTER the next NQ tick.
        // Also: if price already breached the SL before our entry filled, skip.
        const sideBreached = tradeDir === -1 ? t.price >= slPx : t.price <= slPx;
        if (sideBreached) { fillTs = null; break; }
        fillTs = t.ts;
        break;
      }
      // Or if SL was hit before limit was filled, no fill possible
      const slHit = tradeDir === -1 ? t.price >= slPx : t.price <= slPx;
      if (slHit) break;
    }

    if (fillTs === null) { misses++; continue; }
    fills++;

    // Walk forward from fill time to find TP or SL outcome
    const walkEnd = fillTs + TRADE_HORIZON_MS;
    const walkStartIdx = tickIdxAtOrAfter(fillTs + 1);  // ticks AFTER fill
    let outcome: 'WIN'|'LOSS'|'OPEN' = 'OPEN';
    for (let i = walkStartIdx; i < ticks.length; i++) {
      const t = ticks[i]!;
      if (t.ts > walkEnd) break;
      const hitTP = tradeDir === 1 ? t.price >= tpPx : t.price <= tpPx;
      const hitSL = tradeDir === 1 ? t.price <= slPx : t.price >= slPx;
      if (hitTP) { outcome = 'WIN'; break; }
      if (hitSL) { outcome = 'LOSS'; break; }
    }
    if (outcome === 'WIN')  { wins++;   theoSum += TP_PTS;            slipSum += TP_PTS; /* limit-TP fills exact */ }
    else if (outcome === 'LOSS') { losses++; theoSum -= slDist;         slipSum -= (slDist + SLIPPAGE_SL); }
    else                    { open++; }
    slDistSum += slDist;
  }

  const closed = wins + losses;
  const wr = closed > 0 ? (wins / closed * 100) : 0;
  const fillRate = (fills + misses) > 0 ? (fills / (fills + misses) * 100) : 0;
  const theoExp = closed > 0 ? theoSum / closed : 0;
  const slipExp = closed > 0 ? slipSum / closed : 0;
  const avgSL = fills > 0 ? slDistSum / fills : 0;

  console.log(`── Fill timeout=${fillTimeoutMs/1000}s ──`);
  console.log(`  Signals:         ${signals.length}`);
  console.log(`  Filled:          ${fills}  (${fillRate.toFixed(1)}% fill rate)`);
  console.log(`  Missed:          ${misses}`);
  console.log(`  Of filled: WIN=${wins}  LOSS=${losses}  OPEN=${open}  WR=${wr.toFixed(1)}%  avgSL=${avgSL.toFixed(2)}pts`);
  console.log(`  Theoretical exp: ${theoExp >= 0 ? '+' : ''}${theoExp.toFixed(2)} pts/trade   (slip on SL only: 1pt)`);
  console.log(`  Slipped exp:     ${slipExp >= 0 ? '+' : ''}${slipExp.toFixed(2)} pts/trade`);
  console.log(`  Day total (slipped, 1 MNQ × $2/pt): $${(slipExp * fills * 2).toFixed(0)}`);
  console.log(``);
}

console.log(`Done.`);
