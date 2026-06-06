// Today's wall-broken-fade signals — outcome analysis.
// Walks forward in ticks.db from each FADE signal applying the canonical
// TP=20 / SL=10 grid to classify WIN / LOSS / OPEN.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const trDb = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const tkDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'),   { readonly: true });

const SYMBOL = 'NQ';
const TP = 20;
const SL = 10;
const HORIZON_MS = 15 * 60_000;

// Today's RTH window
const RTH_OPEN = Date.parse('2026-06-02T09:30:00-04:00');
const RTH_CLOSE = Date.parse('2026-06-02T16:00:00-04:00');

const sigs = trDb.prepare(`
  SELECT id, ts, direction, score,
         json_extract(payload, '$.peakSize')    as peakSize,
         json_extract(payload, '$.wallSide')    as wallSide,
         json_extract(payload, '$.persistMs')   as persistMs,
         json_extract(payload, '$.wallPrice')   as wallPrice,
         json_extract(payload, '$.entry')       as entry,
         json_extract(payload, '$.rationale')   as rationale
  FROM signals
  WHERE symbol = ?
    AND rule_id = 'wall-broken-fade'
    AND ts >= ? AND ts <= ?
  ORDER BY ts ASC
`).all(SYMBOL, RTH_OPEN, RTH_CLOSE) as Array<any>;

console.log(`\n══ Wall-Broken-Fade Signals — Today's RTH (2026-06-02 09:30 → 16:00 ET) ══`);
console.log(`Found ${sigs.length} signals\n`);

if (sigs.length === 0) {
  console.log('No fade signals fired yet this RTH.');
  process.exit(0);
}

const tradesStmt = tkDb.prepare(`
  SELECT ts, price FROM trades WHERE symbol = ? AND ts > ? AND ts <= ? ORDER BY ts ASC
`);

interface Result {
  sig: any;
  outcome: 'WIN' | 'LOSS' | 'OPEN';
  exitPrice?: number;
  exitTs?: number;
  msToExit?: number;
  maxGain: number;
  maxDd: number;
  realizedPnl: number;
}

const results: Result[] = [];
let totalWins = 0, totalLosses = 0, totalOpen = 0, netPts = 0;

for (const sig of sigs) {
  const entry = Number(sig.entry ?? sig.wallPrice);
  const direction = sig.direction === 'long' ? 1 : -1;
  const tpPrice = entry + direction * TP;
  const slPrice = entry - direction * SL;
  const horizonTs = sig.ts + HORIZON_MS;

  const trades = tradesStmt.all(SYMBOL, sig.ts, horizonTs) as Array<{ts: number; price: number}>;
  let outcome: Result['outcome'] = 'OPEN';
  let exitPrice: number | undefined;
  let exitTs: number | undefined;
  let maxGain = 0, maxDd = 0;
  for (const t of trades) {
    const move = direction * (t.price - entry);
    if (move > maxGain) maxGain = move;
    if (move < maxDd) maxDd = move;
    const hitTP = direction === 1 ? t.price >= tpPrice : t.price <= tpPrice;
    const hitSL = direction === 1 ? t.price <= slPrice : t.price >= slPrice;
    if (hitTP) { outcome = 'WIN'; exitPrice = t.price; exitTs = t.ts; break; }
    if (hitSL) { outcome = 'LOSS'; exitPrice = t.price; exitTs = t.ts; break; }
  }

  // Realized PnL — open positions: use last trade price for mark-to-market
  let realizedPnl = 0;
  if (outcome === 'WIN')  { realizedPnl = TP;  totalWins++;   netPts += TP; }
  if (outcome === 'LOSS') { realizedPnl = -SL; totalLosses++; netPts -= SL; }
  if (outcome === 'OPEN') {
    totalOpen++;
    const lastTrade = trades[trades.length - 1];
    if (lastTrade) realizedPnl = direction * (lastTrade.price - entry);
  }

  results.push({ sig, outcome, exitPrice, exitTs, msToExit: exitTs ? exitTs - sig.ts : undefined,
                 maxGain, maxDd, realizedPnl });
}

// Print table
console.log(`  time(ET)    dir   entry      side  peak  score   outcome   exit       MFE   MAE   ms→exit`);
console.log(`  ─────────────────────────────────────────────────────────────────────────────────────`);
for (const r of results) {
  const et = new Date(r.sig.ts - 4*60*60_000).toISOString().substring(11, 19);
  const dir = r.sig.direction === 'long' ? 'LONG' : 'SHRT';
  const side = r.sig.wallSide === 0 ? 'BID' : 'ASK';
  const peak = String(r.sig.peakSize ?? '?').padStart(4);
  const score = String(r.sig.score).padStart(3);
  const mark = r.outcome === 'WIN' ? '✓ WIN' : r.outcome === 'LOSS' ? '✗ LOSS' : `· OPEN(${r.realizedPnl.toFixed(1)})`;
  const exit = r.exitPrice ? r.exitPrice.toFixed(2).padStart(9) : '       —';
  const msToExit = r.msToExit ? `${(r.msToExit/1000).toFixed(0)}s` : '—';
  console.log(
    `  ${et}   ${dir}  ${Number(r.sig.entry ?? r.sig.wallPrice).toFixed(2).padStart(9)}   ${side}   ${peak}    ${score}   ${mark.padEnd(15)}  ${exit}   ${r.maxGain.toFixed(1).padStart(5)}  ${r.maxDd.toFixed(1).padStart(5)}   ${msToExit}`
  );
}

const closed = totalWins + totalLosses;
const wr = closed > 0 ? totalWins/closed*100 : 0;
console.log(`\n══ Today's Stats ══`);
console.log(`  Total fade signals:  ${sigs.length}`);
console.log(`  WIN: ${totalWins} | LOSS: ${totalLosses} | OPEN (in window): ${totalOpen}`);
console.log(`  WR (closed): ${wr.toFixed(1)}%`);
console.log(`  Net pts (closed-only): ${netPts > 0 ? '+' : ''}${netPts}`);
console.log(`  Backtest baseline (peak ≥ 100): ~70% WR, +11 pts/signal expected`);

// Per-tier breakdown
console.log(`\n  Score tier breakdown:`);
for (const minScore of [70, 80, 90, 100]) {
  const tier = results.filter(r => r.sig.score >= minScore);
  if (tier.length === 0) continue;
  const w = tier.filter(r => r.outcome === 'WIN').length;
  const l = tier.filter(r => r.outcome === 'LOSS').length;
  const o = tier.filter(r => r.outcome === 'OPEN').length;
  const c = w + l;
  const tierWR = c > 0 ? w/c*100 : 0;
  const tierPnl = w*TP - l*SL;
  console.log(`    score ≥ ${minScore}:  n=${tier.length}  W=${w} L=${l} OPEN=${o}  WR=${tierWR.toFixed(1)}%  netPts=${tierPnl > 0 ? '+' : ''}${tierPnl}`);
}

trDb.close(); tkDb.close();
