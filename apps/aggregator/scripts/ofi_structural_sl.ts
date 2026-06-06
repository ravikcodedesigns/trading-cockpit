// OFI scalp v2 — structural SL at the window extreme.
//
// Entry = price at end of OFI window.
// TP    = entry ± 10pts (in trade direction).
// SL    = 2 ticks (0.5pt) beyond the window's price extreme in the OFI direction.
//
// Two directions tested per window:
//   FOLLOW = trade in OFI direction (positive OFI → LONG, negative → SHORT).
//            SL is on the OPPOSITE side of the window range (where momentum failed).
//   FADE   = trade AGAINST OFI direction.
//            SL is on the SAME side as OFI's extreme push (where OFI continues).
//
// Filter by OFI quintile to focus on strong signals.

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

const TP_PTS    = 10;
const SL_BUFFER = 0.50;  // 2 ticks
const SLIPPAGE  = 1.0;   // 1pt each side realistic for MNQ market entry/SL
const HORIZON_MS = 5 * 60_000;  // 5 min — give the 10pt TP room to develop

const WINDOWS = [1_000, 2_000, 5_000];

const mbo = new Database(MBO_DB, { readonly: true });
const tk  = new Database(TK_DB,  { readonly: true });
function pad(s: any, w: number, left = true) { return left ? String(s).padStart(w) : String(s).padEnd(w); }

console.log('═══ OFI v2 — structural SL at window extreme ═══');
console.log(`TP=${TP_PTS}pts  SL_buffer=${SL_BUFFER}pt beyond window extreme  Slip=${SLIPPAGE}pt each side`);
console.log(`Horizon=${HORIZON_MS/60_000}min  RTH 09:30–16:00 ET 2026-06-02\n`);

// Pull trades + ticks
const t0 = Date.now();
const trades = mbo.prepare(`
  SELECT ts_ms, price, size, is_bid_aggressor FROM mbo_trades
  WHERE symbol=? AND contract=? AND ts_ms BETWEEN ? AND ? ORDER BY ts_ms ASC
`).all(SYMBOL_MBO, CONTRACT, RTH_START, RTH_END) as Array<any>;
console.log(`Loaded ${trades.length.toLocaleString()} mbo trades, ${((Date.now()-t0)/1000).toFixed(1)}s`);

const ticks = tk.prepare(`
  SELECT ts, price FROM trades WHERE symbol=? AND ts BETWEEN ? AND ? ORDER BY ts ASC
`).all(SYMBOL_TK, RTH_START, RTH_END + 10*60_000) as Array<{ts: number; price: number}>;
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
function walkOutcome(startIdx: number, endTs: number, entryPx: number, tpPx: number, slPx: number, dir: 1|-1): 'WIN'|'LOSS'|'OPEN' {
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

interface Window {
  startTs: number; endTs: number; ofi: number; n: number;
  hi: number; lo: number;  // price range during the window (from MBO trades)
}

for (const winMs of WINDOWS) {
  console.log(`══ Window=${winMs/1000}s ══`);
  const windows: Window[] = [];
  let cursor = RTH_START;
  while (cursor < RTH_END) {
    windows.push({ startTs: cursor, endTs: cursor + winMs, ofi: 0, n: 0, hi: -Infinity, lo: Infinity });
    cursor += winMs;
  }
  let tIdx = 0;
  for (const w of windows) {
    while (tIdx < trades.length && trades[tIdx].ts_ms < w.endTs) {
      const t = trades[tIdx];
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
  console.log(`  ${filled.length} non-empty windows`);

  const sortedOfi = filled.map(w => Math.abs(w.ofi)).sort((a,b)=>a-b);
  const q = [0.2, 0.4, 0.6, 0.8].map(p => sortedOfi[Math.floor(sortedOfi.length * p)] ?? 0);
  const bucket = (mag: number) => mag >= q[3]! ? 4 : mag >= q[2]! ? 3 : mag >= q[1]! ? 2 : mag >= q[0]! ? 1 : 0;

  // Evaluate FOLLOW and FADE per quintile
  for (const mode of ['FOLLOW', 'FADE'] as const) {
    console.log(`\n  ── ${mode} OFI direction ──`);
    console.log(`  ${pad('Q', 4)} ${pad('n', 5)} ${pad('WIN', 5)} ${pad('LOSS', 5)} ${pad('OPEN', 5)} ${pad('WR', 7)} ${pad('avg_R:R', 8)} ${pad('exp(theo)', 11)} ${pad('exp(slip)', 11)}`);
    const stats = [0,1,2,3,4].map(_ => ({ n: 0, win: 0, loss: 0, open: 0, totalRR: 0 }));

    for (const w of filled) {
      if (w.ofi === 0) continue;
      const ofiDir: 1|-1 = w.ofi > 0 ? 1 : -1;
      const tradeDir: 1|-1 = mode === 'FOLLOW' ? ofiDir : -ofiDir as 1|-1;
      const entryPx = priceAt(w.endTs);
      if (entryPx === null) continue;
      const tpPx = entryPx + tradeDir * TP_PTS;
      // SL placement: tradeDir defines our position direction
      //   If we're LONG (tradeDir=1), SL is BELOW entry.
      //   If we're SHORT (tradeDir=-1), SL is ABOVE entry.
      // Structural: SL = OPPOSITE-side extreme of the window (low if long, high if short),
      //   minus/plus the buffer.
      const slPx = tradeDir === 1
        ? w.lo - SL_BUFFER   // long: stop below window low
        : w.hi + SL_BUFFER;  // short: stop above window high

      // Reject trade if SL is on the wrong side of entry (extreme already breached)
      if (tradeDir === 1 && slPx >= entryPx) continue;
      if (tradeDir === -1 && slPx <= entryPx) continue;

      const slDist = tradeDir === 1 ? entryPx - slPx : slPx - entryPx;
      // Reject if SL distance is too narrow (< 1pt) or too wide (> 8pts; absurd R:R)
      if (slDist < 1.0 || slDist > 8.0) continue;

      const startIdx = tickIdxAtOrAfter(w.endTs);
      const outcome = walkOutcome(startIdx, w.endTs + HORIZON_MS, entryPx, tpPx, slPx, tradeDir);
      const b = bucket(Math.abs(w.ofi));
      stats[b]!.n++;
      stats[b]!.totalRR += TP_PTS / slDist;
      if (outcome === 'WIN') stats[b]!.win++;
      else if (outcome === 'LOSS') stats[b]!.loss++;
      else stats[b]!.open++;
    }

    for (let i = 4; i >= 0; i--) {
      const s = stats[i]!;
      const closed = s.win + s.loss;
      if (s.n === 0) continue;
      const wr = closed > 0 ? (s.win / closed * 100) : 0;
      const avgRR = s.totalRR / s.n;
      // Expectancy: per-trade theo = WIN*TP - LOSS*avgSL_dist; use avg SL distance
      const avgSL = TP_PTS / avgRR;
      const expTheo = closed > 0 ? (s.win * TP_PTS - s.loss * avgSL) / closed : 0;
      const expSlip = closed > 0
        ? (s.win * (TP_PTS - SLIPPAGE) - s.loss * (avgSL + 2 * SLIPPAGE)) / closed
        : 0;
      console.log(`  ${pad(`Q${i+1}`, 4)} ${pad(s.n, 5)} ${pad(s.win, 5)} ${pad(s.loss, 5)} ${pad(s.open, 5)} ${pad(wr.toFixed(1)+'%', 7)} ${pad('1:'+avgRR.toFixed(1), 8)} ${pad((expTheo>=0?'+':'')+expTheo.toFixed(2), 11)} ${pad((expSlip>=0?'+':'')+expSlip.toFixed(2), 11)}`);
    }
  }
  console.log('');
}

console.log('Done.');
