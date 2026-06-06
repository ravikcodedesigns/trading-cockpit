// OFI (Order-Flow Imbalance) scalp edge validation — Phase 1
//
// Question: in short windows (1s/2s/5s), does net signed aggressor volume
// predict the NEXT short price move? If yes → foundation of an MBO-scalp engine.
//
// Method:
//   1. Slice today's MBO trades into fixed windows.
//   2. For each window, compute OFI = sum(size if buy-aggressor, -size if sell).
//   3. For each window's END timestamp, walk forward 5s/10s/30s.
//      Outcome WIN if price moves TP_PTS in OFI sign direction WITHOUT
//      hitting -SL_PTS first; LOSS if SL hit first; OPEN otherwise.
//   4. Stratify by OFI magnitude quintile.
//   5. Report WR + expectancy + slipped expectancy per quintile per horizon.
//
// Read-only. No DB writes.

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

const SYMBOL_MBO = 'MNQM';
const CONTRACT   = 'MNQM6_CME_BMD';
const SYMBOL_TK  = 'NQ';

// RTH only — 09:30 to 16:00 ET = 13:30 to 20:00 UTC
const RTH_START = 1780405800000;
const RTH_END   = 1780425600000;

// Targets we'll test (use tight scalp-style)
const TP_PTS = 2;
const SL_PTS = 1;
const SLIPPAGE = 0.5;  // 0.5pt each side at the tight end

// Window sizes (ms) and lookforward horizons (ms) we'll grid-test
const WINDOWS    = [1_000, 2_000, 5_000];
const HORIZONS   = [5_000, 10_000, 30_000];

const mbo = new Database(MBO_DB, { readonly: true });
const tk  = new Database(TK_DB,  { readonly: true });

function pad(s: any, w: number, left = true) {
  const str = String(s);
  return left ? str.padStart(w) : str.padEnd(w);
}

console.log('═══ OFI Scalp Edge Validation — Phase 1 ═══');
console.log(`Symbol: ${SYMBOL_MBO}  RTH window: 09:30–16:00 ET 2026-06-02`);
console.log(`TP=${TP_PTS}pts  SL=${SL_PTS}pts  Slip=${SLIPPAGE}pts each side\n`);

// ── Pull all RTH trades ──────────────────────────────────────────────────
const t0 = Date.now();
console.log(`Loading mbo_trades for RTH...`);
const trades = mbo.prepare(`
  SELECT ts_ms, price, size, is_bid_aggressor
  FROM mbo_trades
  WHERE symbol=? AND contract=? AND ts_ms BETWEEN ? AND ?
  ORDER BY ts_ms ASC
`).all(SYMBOL_MBO, CONTRACT, RTH_START, RTH_END) as Array<{
  ts_ms: number; price: number; size: number; is_bid_aggressor: number;
}>;
console.log(`  Loaded ${trades.length.toLocaleString()} trades in ${((Date.now()-t0)/1000).toFixed(1)}s`);

// ── NQ tick lookup (price proxy) ─────────────────────────────────────────
console.log(`Loading NQ ticks for RTH lookforward...`);
const t1 = Date.now();
const ticks = tk.prepare(`
  SELECT ts, price FROM trades
  WHERE symbol=? AND ts BETWEEN ? AND ?
  ORDER BY ts ASC
`).all(SYMBOL_TK, RTH_START, RTH_END + 60_000) as Array<{ts: number; price: number}>;
console.log(`  Loaded ${ticks.length.toLocaleString()} NQ ticks in ${((Date.now()-t1)/1000).toFixed(1)}s`);

// Binary-search helper for tick prices
function priceAt(ts: number): number | null {
  // Find the first tick at or before ts
  let lo = 0, hi = ticks.length - 1, res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid]!.ts <= ts) { res = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return res >= 0 ? ticks[res]!.price : null;
}

function walkOutcome(startTs: number, startPx: number, dir: 1|-1, horizonMs: number): 'WIN'|'LOSS'|'OPEN' {
  const tp = startPx + dir * TP_PTS;
  const sl = startPx - dir * SL_PTS;
  // Linear scan from binary-searched start index
  let lo = 0, hi = ticks.length - 1, startIdx = ticks.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid]!.ts > startTs) { startIdx = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  const endTs = startTs + horizonMs;
  for (let i = startIdx; i < ticks.length; i++) {
    const t = ticks[i]!;
    if (t.ts > endTs) break;
    const hitTP = dir === 1 ? t.price >= tp : t.price <= tp;
    const hitSL = dir === 1 ? t.price <= sl : t.price >= sl;
    if (hitTP) return 'WIN';
    if (hitSL) return 'LOSS';
  }
  return 'OPEN';
}

// ── For each window size, compute OFI per non-overlapping window ─────────
for (const winMs of WINDOWS) {
  console.log(`\n══ Window=${winMs/1000}s ══`);
  // Bucket trades into windows
  const windows: Array<{startTs: number; endTs: number; ofi: number; n: number}> = [];
  let cursor = RTH_START;
  while (cursor < RTH_END) {
    windows.push({ startTs: cursor, endTs: cursor + winMs, ofi: 0, n: 0 });
    cursor += winMs;
  }
  let tIdx = 0;
  for (const w of windows) {
    while (tIdx < trades.length && trades[tIdx]!.ts_ms < w.endTs) {
      const t = trades[tIdx]!;
      if (t.ts_ms >= w.startTs && t.ts_ms < w.endTs) {
        // is_bid_aggressor=1 means BUYER hit ask → +size (CVD convention from memory)
        w.ofi += (t.is_bid_aggressor === 1 ? 1 : -1) * t.size;
        w.n++;
      }
      tIdx++;
    }
  }

  // Filter out empty windows
  const filled = windows.filter(w => w.n > 0);
  console.log(`  ${filled.length} non-empty windows of ${windows.length} total`);

  // Stratify by |OFI| quintile
  const ofiArr = filled.map(w => Math.abs(w.ofi)).sort((a,b)=>a-b);
  const q = [0.2, 0.4, 0.6, 0.8].map(p => ofiArr[Math.floor(ofiArr.length * p)] ?? 0);
  console.log(`  |OFI| quintile thresholds (Q1→Q5):`);
  console.log(`    20%=${q[0]}  40%=${q[1]}  60%=${q[2]}  80%=${q[3]}  max=${ofiArr[ofiArr.length-1]}`);

  // For each horizon, evaluate WR + expectancy per quintile
  for (const horizonMs of HORIZONS) {
    console.log(`\n  ── horizon=${horizonMs/1000}s ──`);
    console.log(`  ${pad('quintile', 10)} ${pad('n', 6)} ${pad('WIN', 5)} ${pad('LOSS', 5)} ${pad('OPEN', 5)} ${pad('WR', 7)} ${pad('exp(theo)', 10)} ${pad('exp(slip)', 10)}`);

    const bucket = (mag: number) => {
      if (mag >= q[3]!) return 4;
      if (mag >= q[2]!) return 3;
      if (mag >= q[1]!) return 2;
      if (mag >= q[0]!) return 1;
      return 0;
    };
    const stats = [0,1,2,3,4].map(_ => ({ n: 0, win: 0, loss: 0, open: 0 }));
    for (const w of filled) {
      const mag = Math.abs(w.ofi);
      const dir: 1|-1 = w.ofi > 0 ? 1 : -1;
      const startPx = priceAt(w.endTs);
      if (startPx === null) continue;
      const outcome = walkOutcome(w.endTs, startPx, dir, horizonMs);
      const b = bucket(mag);
      stats[b]!.n++;
      if (outcome === 'WIN') stats[b]!.win++;
      else if (outcome === 'LOSS') stats[b]!.loss++;
      else stats[b]!.open++;
    }
    for (let i = 4; i >= 0; i--) {
      const s = stats[i]!;
      const closed = s.win + s.loss;
      const wr = closed > 0 ? (s.win / closed * 100) : 0;
      const expTheo = closed > 0 ? ((s.win * TP_PTS - s.loss * SL_PTS) / closed) : 0;
      // Slipped: WIN → TP exact (limit); LOSS → SL + slip; entry slips
      const expSlip = closed > 0 ? ((s.win * (TP_PTS - SLIPPAGE) - s.loss * (SL_PTS + 2*SLIPPAGE)) / closed) : 0;
      const label = `Q${i+1} (${i===4?'top20%':i===0?'low20%':'mid'})`;
      console.log(`  ${pad(label, 10)} ${pad(s.n, 6)} ${pad(s.win, 5)} ${pad(s.loss, 5)} ${pad(s.open, 5)} ${pad(wr.toFixed(1)+'%', 7)} ${pad((expTheo>=0?'+':'')+expTheo.toFixed(3), 10)} ${pad((expSlip>=0?'+':'')+expSlip.toFixed(3), 10)}`);
    }
  }
}

console.log(`\n══ Notes ══`);
console.log(`  Break-even WR for TP=${TP_PTS}/SL=${SL_PTS} (theoretical): ${(SL_PTS/(SL_PTS+TP_PTS)*100).toFixed(1)}%`);
console.log(`  Slipped break-even (entry+SL slip ${SLIPPAGE} each): ${((SL_PTS+SLIPPAGE)/(SL_PTS+TP_PTS)*100).toFixed(1)}% needed`);
console.log(`Done.`);
