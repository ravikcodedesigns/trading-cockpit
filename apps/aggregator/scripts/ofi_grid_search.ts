// OFI wider grid search — find where edge actually lives on the time-scale spectrum.
//
// Grid: 7 windows × 5 horizons × 2 directions × top-2 quintiles = 140 cells.
// For each cell: WR, R:R, theoretical expectancy, slipped expectancy.
// Highlight cells where slipped expectancy > 0.

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
const SL_BUFFER = 0.50;
const SLIPPAGE  = 1.0;

// Wider grid
const WINDOWS_S  = [1, 5, 15, 30, 60, 120, 300];          // sec
const HORIZONS_S = [60, 300, 900, 1800, 3600];            // 1m, 5m, 15m, 30m, 60m

const mbo = new Database(MBO_DB, { readonly: true });
const tk  = new Database(TK_DB,  { readonly: true });
function pad(s: any, w: number, left = true) { return left ? String(s).padStart(w) : String(s).padEnd(w); }

console.log('═══ OFI grid search — windows × horizons × directions ═══');
console.log(`TP=${TP_PTS}pts  SL=window-extreme ±${SL_BUFFER}pt  Slip=${SLIPPAGE}pt each side`);
console.log(`Windows(s): ${WINDOWS_S.join(',')}`);
console.log(`Horizons(s): ${HORIZONS_S.join(',')}\n`);

// Load all trades + ticks once
const t0 = Date.now();
const trades = mbo.prepare(`
  SELECT ts_ms, price, size, is_bid_aggressor FROM mbo_trades
  WHERE symbol=? AND contract=? AND ts_ms BETWEEN ? AND ? ORDER BY ts_ms ASC
`).all(SYMBOL_MBO, CONTRACT, RTH_START, RTH_END) as Array<{ts_ms:number;price:number;size:number;is_bid_aggressor:number}>;
console.log(`Loaded ${trades.length.toLocaleString()} mbo trades, ${((Date.now()-t0)/1000).toFixed(1)}s`);

const t1 = Date.now();
const ticks = tk.prepare(`
  SELECT ts, price FROM trades WHERE symbol=? AND ts BETWEEN ? AND ? ORDER BY ts ASC
`).all(SYMBOL_TK, RTH_START, RTH_END + 70*60_000) as Array<{ts:number;price:number}>;
console.log(`Loaded ${ticks.length.toLocaleString()} NQ ticks, ${((Date.now()-t1)/1000).toFixed(1)}s\n`);

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

interface Cell {
  windowS: number; horizonS: number; mode: 'FOLLOW'|'FADE';
  quintile: 'Q5'|'Q4Q5';   // top 20% or top 40%
  n: number; win: number; loss: number; open: number;
  avgSL: number;  // average SL distance from entry (pts)
}
const cells: Cell[] = [];

for (const windowS of WINDOWS_S) {
  const winMs = windowS * 1000;
  // Build OFI windows (one pass per window size)
  const windows: Array<{startTs:number;endTs:number;ofi:number;n:number;hi:number;lo:number}> = [];
  let cursor = RTH_START;
  while (cursor < RTH_END) {
    windows.push({ startTs: cursor, endTs: cursor + winMs, ofi: 0, n: 0, hi: -Infinity, lo: Infinity });
    cursor += winMs;
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
  if (filled.length < 20) continue;

  // Quintile thresholds (Q5 = top 20%, Q4Q5 = top 40%)
  const sortedOfi = filled.map(w => Math.abs(w.ofi)).sort((a,b)=>a-b);
  const q80 = sortedOfi[Math.floor(sortedOfi.length * 0.8)] ?? 0;
  const q60 = sortedOfi[Math.floor(sortedOfi.length * 0.6)] ?? 0;

  for (const horizonS of HORIZONS_S) {
    const horizonMs = horizonS * 1000;
    for (const mode of ['FOLLOW','FADE'] as const) {
      const cellQ5: Cell = { windowS, horizonS, mode, quintile: 'Q5', n:0, win:0, loss:0, open:0, avgSL: 0 };
      const cellQ4Q5: Cell = { windowS, horizonS, mode, quintile: 'Q4Q5', n:0, win:0, loss:0, open:0, avgSL: 0 };
      let q5SLSum = 0, q4q5SLSum = 0;
      for (const w of filled) {
        const mag = Math.abs(w.ofi);
        if (mag < q60) continue;  // bottom 60% always discarded
        const ofiDir: 1|-1 = w.ofi > 0 ? 1 : -1;
        const tradeDir: 1|-1 = mode === 'FOLLOW' ? ofiDir : -ofiDir as 1|-1;
        const entryPx = priceAt(w.endTs);
        if (entryPx === null) continue;
        const tpPx = entryPx + tradeDir * TP_PTS;
        const slPx = tradeDir === 1 ? w.lo - SL_BUFFER : w.hi + SL_BUFFER;
        if (tradeDir === 1 && slPx >= entryPx) continue;
        if (tradeDir === -1 && slPx <= entryPx) continue;
        const slDist = tradeDir === 1 ? entryPx - slPx : slPx - entryPx;
        if (slDist < 1.0 || slDist > 8.0) continue;
        const startIdx = tickIdxAtOrAfter(w.endTs);
        const out = walkOutcome(startIdx, w.endTs + horizonMs, tpPx, slPx, tradeDir);

        if (mag >= q80) {
          cellQ5.n++; q5SLSum += slDist;
          if (out === 'WIN') cellQ5.win++; else if (out === 'LOSS') cellQ5.loss++; else cellQ5.open++;
        }
        // Q4Q5 = top 40% (includes Q5)
        cellQ4Q5.n++; q4q5SLSum += slDist;
        if (out === 'WIN') cellQ4Q5.win++; else if (out === 'LOSS') cellQ4Q5.loss++; else cellQ4Q5.open++;
      }
      cellQ5.avgSL = cellQ5.n > 0 ? q5SLSum / cellQ5.n : 0;
      cellQ4Q5.avgSL = cellQ4Q5.n > 0 ? q4q5SLSum / cellQ4Q5.n : 0;
      cells.push(cellQ5, cellQ4Q5);
    }
  }
}

// Rank by slipped expectancy
function expectancy(c: Cell, slip: number) {
  const closed = c.win + c.loss;
  if (closed === 0) return { theo: 0, slip: 0, wr: 0 };
  const theo = (c.win * TP_PTS - c.loss * c.avgSL) / closed;
  const slipExp = (c.win * (TP_PTS - slip) - c.loss * (c.avgSL + 2 * slip)) / closed;
  return { theo, slip: slipExp, wr: c.win/closed*100 };
}

console.log(`Total cells: ${cells.length}\n`);

// ── Top 10 by slipped expectancy ──
console.log(`══ TOP 20 cells by SLIPPED expectancy (must have n ≥ 30) ══`);
console.log(`${pad('win',6)} ${pad('horiz',6)} ${pad('dir',7)} ${pad('quint',6)} ${pad('n',5)} ${pad('W',4)} ${pad('L',4)} ${pad('O',4)} ${pad('WR',7)} ${pad('avgSL',6)} ${pad('theo',8)} ${pad('slipped',8)}`);
const scored = cells.map(c => ({ c, ...expectancy(c, SLIPPAGE) })).filter(s => s.c.n >= 30);
scored.sort((a,b) => b.slip - a.slip);
for (const s of scored.slice(0, 20)) {
  const c = s.c;
  console.log(
    `${pad(c.windowS+'s',6)} ${pad(c.horizonS+'s',6)} ${pad(c.mode,7)} ${pad(c.quintile,6)} ${pad(c.n,5)} ${pad(c.win,4)} ${pad(c.loss,4)} ${pad(c.open,4)} ${pad(s.wr.toFixed(1)+'%',7)} ${pad(c.avgSL.toFixed(2),6)} ${pad((s.theo>=0?'+':'')+s.theo.toFixed(2),8)} ${pad((s.slip>=0?'+':'')+s.slip.toFixed(2),8)}`
  );
}

console.log(`\n══ TOP 20 by THEORETICAL expectancy (zero-slip ideal) ══`);
const sortedTheo = [...scored].sort((a,b) => b.theo - a.theo);
console.log(`${pad('win',6)} ${pad('horiz',6)} ${pad('dir',7)} ${pad('quint',6)} ${pad('n',5)} ${pad('W',4)} ${pad('L',4)} ${pad('WR',7)} ${pad('avgSL',6)} ${pad('theo',8)} ${pad('slipped',8)}`);
for (const s of sortedTheo.slice(0, 20)) {
  const c = s.c;
  console.log(
    `${pad(c.windowS+'s',6)} ${pad(c.horizonS+'s',6)} ${pad(c.mode,7)} ${pad(c.quintile,6)} ${pad(c.n,5)} ${pad(c.win,4)} ${pad(c.loss,4)} ${pad(s.wr.toFixed(1)+'%',7)} ${pad(c.avgSL.toFixed(2),6)} ${pad((s.theo>=0?'+':'')+s.theo.toFixed(2),8)} ${pad((s.slip>=0?'+':'')+s.slip.toFixed(2),8)}`
  );
}

console.log(`\n══ Cells with POSITIVE slipped expectancy (n ≥ 30) ══`);
const profitable = scored.filter(s => s.slip > 0);
console.log(`Found ${profitable.length} profitable cells`);
if (profitable.length > 0) {
  for (const s of profitable) {
    const c = s.c;
    console.log(
      `  ${pad(c.windowS+'s',5)} ${pad(c.horizonS+'s',6)} ${pad(c.mode,7)} ${pad(c.quintile,6)} n=${pad(c.n,4)} WR=${pad(s.wr.toFixed(1)+'%',6)} theo=${pad((s.theo>=0?'+':'')+s.theo.toFixed(2),6)} slip=${pad((s.slip>=0?'+':'')+s.slip.toFixed(2),6)}`
    );
  }
}

console.log(`\nDone.`);
