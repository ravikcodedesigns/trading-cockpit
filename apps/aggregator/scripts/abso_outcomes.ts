// abso_outcomes.ts — Walk-forward backtest for absorption signals.
//
// Reads RAW absorption signals from trading.db `signals` table (every one
// that fired, regardless of quality gate). For each, walks forward through
// ticks.db `trades` with FIXED TP/SL — first one hit determines outcome.
//
// TP=80 SL=140 (V3 ABSO production values, asymmetric 1.75:1 R/R)
// Horizon: 4 hours (240 min) — if neither hits in that window, OPEN.
//
// Reports WR and PnL by score band × direction.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRADING_DB = path.resolve(__dirname, '../../../data/trading.db');
const TICKS_DB   = path.resolve(__dirname, '../../../data/ticks.db');

const trDb = new Database(TRADING_DB, { readonly: true });
const tkDb = new Database(TICKS_DB,   { readonly: true });

const SYMBOL = 'NQ';
const TP = 80;
const SL = 140;
const HORIZON_MS = 4 * 60 * 60_000;

// Pull all absorption signals
const sigs = trDb.prepare(`
  SELECT id, ts, direction, score
  FROM signals
  WHERE symbol = ? AND rule_id = 'absorption'
  ORDER BY ts ASC
`).all(SYMBOL) as Array<{id: number; ts: number; direction: string; score: number}>;

console.log(`\n══ ABSO outcomes — walk-forward TP=${TP} SL=${SL} ══`);
console.log(`Total ABSO signals: ${sigs.length}`);
console.log(`Date range: ${new Date(sigs[0]!.ts).toISOString()} → ${new Date(sigs[sigs.length-1]!.ts).toISOString()}\n`);

// Group signals by trading day for efficient batched trade-loading
const sigsByDay = new Map<string, typeof sigs>();
for (const s of sigs) {
  const day = new Date(s.ts - 4*60*60_000).toISOString().slice(0,10);  // ET date
  let arr = sigsByDay.get(day);
  if (!arr) { arr = []; sigsByDay.set(day, arr); }
  arr.push(s);
}
console.log(`Days with ABSO signals: ${sigsByDay.size}`);

// Walk forward for each signal
type Outcome = 'WIN' | 'LOSS' | 'OPEN' | 'NO_DATA';
interface Result {
  signal: typeof sigs[0];
  outcome: Outcome;
  signalPrice: number;
  exitPrice?: number;
  exitTs?: number;
  maxGain: number;
  maxDd: number;
}

const results: Result[] = [];
const tradeStmt = tkDb.prepare(`
  SELECT ts, price FROM trades WHERE symbol = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC
`);

let processed = 0;
for (const [day, daySigs] of sigsByDay) {
  // Load ALL trades for the day + 4h after the last signal
  const firstTs = daySigs[0]!.ts;
  const lastTs  = daySigs[daySigs.length-1]!.ts;
  const trades = tradeStmt.all(SYMBOL, firstTs - 5_000, lastTs + HORIZON_MS) as Array<{ts:number;price:number}>;

  for (const sig of daySigs) {
    // Find signal price = first trade at or after sig.ts
    let startIdx = -1;
    for (let i = 0; i < trades.length; i++) {
      if (trades[i]!.ts >= sig.ts) { startIdx = i; break; }
    }
    if (startIdx < 0) {
      results.push({ signal: sig, outcome: 'NO_DATA', signalPrice: 0, maxGain: 0, maxDd: 0 });
      continue;
    }

    const signalPrice = trades[startIdx]!.price;
    const direction = sig.direction === 'long' ? 1 : -1;
    const tpPrice = signalPrice + direction * TP;
    const slPrice = signalPrice - direction * SL;
    const horizonTs = sig.ts + HORIZON_MS;

    let outcome: Outcome = 'OPEN';
    let exitPrice: number | undefined;
    let exitTs: number | undefined;
    let maxGain = 0;
    let maxDd = 0;

    for (let i = startIdx + 1; i < trades.length; i++) {
      const t = trades[i]!;
      if (t.ts > horizonTs) break;
      const move = direction * (t.price - signalPrice);
      if (move > maxGain) maxGain = move;
      if (move < maxDd)   maxDd = move;

      const hitTP = direction === 1 ? t.price >= tpPrice : t.price <= tpPrice;
      const hitSL = direction === 1 ? t.price <= slPrice : t.price >= slPrice;
      if (hitTP) { outcome = 'WIN';  exitPrice = t.price; exitTs = t.ts; break; }
      if (hitSL) { outcome = 'LOSS'; exitPrice = t.price; exitTs = t.ts; break; }
    }

    results.push({ signal: sig, outcome, signalPrice, exitPrice, exitTs, maxGain, maxDd });
  }
  processed += daySigs.length;
}

console.log(`Processed ${processed} signals\n`);

// Score bands
interface BandStats {
  band: string;
  n: number;
  wins: number;
  losses: number;
  open: number;
  noData: number;
  pnlPts: number;
  avgWinPts: number;
  avgLossPts: number;
}

function emptyStats(band: string): BandStats {
  return { band, n: 0, wins: 0, losses: 0, open: 0, noData: 0, pnlPts: 0, avgWinPts: 0, avgLossPts: 0 };
}

function scoreBand(score: number): string {
  if (score < 50) return '<50';
  if (score < 60) return '50-59';
  if (score < 70) return '60-69';
  if (score < 80) return '70-79';
  if (score < 90) return '80-89';
  if (score < 100) return '90-99';
  return '100';
}

function tabulate(filterFn: (r: Result) => boolean, label: string): void {
  const bandMap = new Map<string, BandStats>();
  const filtered = results.filter(filterFn);

  for (const r of filtered) {
    const b = scoreBand(r.signal.score);
    let st = bandMap.get(b);
    if (!st) { st = emptyStats(b); bandMap.set(b, st); }
    st.n++;
    if (r.outcome === 'WIN')   { st.wins++;   st.pnlPts += TP; }
    if (r.outcome === 'LOSS')  { st.losses++; st.pnlPts -= SL; }
    if (r.outcome === 'OPEN')  st.open++;
    if (r.outcome === 'NO_DATA') st.noData++;
  }

  console.log(`── ${label} ──`);
  console.log(`  band      n      W      L     OPEN  NO_DATA   WR(closed)   PnL(pts)   exp/sig`);
  const bands = ['<50','50-59','60-69','70-79','80-89','90-99','100'];
  let totN = 0, totW = 0, totL = 0, totO = 0, totPnl = 0;
  for (const b of bands) {
    const st = bandMap.get(b);
    if (!st) continue;
    totN += st.n; totW += st.wins; totL += st.losses; totO += st.open; totPnl += st.pnlPts;
    const closed = st.wins + st.losses;
    const wr = closed > 0 ? (st.wins / closed * 100) : 0;
    const expPerSig = st.n > 0 ? (st.pnlPts / st.n) : 0;
    console.log(
      `  ${b.padEnd(8)} ${String(st.n).padStart(5)} ${String(st.wins).padStart(5)} ` +
      `${String(st.losses).padStart(5)} ${String(st.open).padStart(5)} ${String(st.noData).padStart(7)}  ` +
      `${wr.toFixed(1).padStart(7)}%  ${(st.pnlPts>0?'+':'')+st.pnlPts.toString().padStart(9)}  ${(expPerSig>0?'+':'')+expPerSig.toFixed(1).padStart(6)}`
    );
  }
  const closedAll = totW + totL;
  const wrAll = closedAll > 0 ? (totW / closedAll * 100) : 0;
  const expAll = totN > 0 ? (totPnl / totN) : 0;
  console.log(`  ─────────────────────────────────────────────────────────────────────────────`);
  console.log(
    `  ${'TOTAL'.padEnd(8)} ${String(totN).padStart(5)} ${String(totW).padStart(5)} ` +
    `${String(totL).padStart(5)} ${String(totO).padStart(5)} ${''.padStart(7)}  ` +
    `${wrAll.toFixed(1).padStart(7)}%  ${(totPnl>0?'+':'')+totPnl.toString().padStart(9)}  ${(expAll>0?'+':'')+expAll.toFixed(1).padStart(6)}`
  );
  console.log('');
}

tabulate(r => r.signal.direction === 'long',  'ABSO LONG by score band');
tabulate(r => r.signal.direction === 'short', 'ABSO SHORT by score band');
tabulate(r => true,                            'ABSO ALL (both directions) by score band');

// Bonus: RTH-only breakdown for context
function isRTH(ts: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(new Date(ts));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const m = parseInt(get('hour'),10)*60 + parseInt(get('minute'),10);
  return ['Mon','Tue','Wed','Thu','Fri'].includes(get('weekday')) && m >= 570 && m < 960;
}
tabulate(r => r.signal.direction === 'long'  && isRTH(r.signal.ts), 'ABSO LONG · RTH only');
tabulate(r => r.signal.direction === 'short' && isRTH(r.signal.ts), 'ABSO SHORT · RTH only');

trDb.close(); tkDb.close();
