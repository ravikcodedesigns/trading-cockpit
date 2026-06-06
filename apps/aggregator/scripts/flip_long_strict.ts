// FLIP-long strict — find the high-WR subset of historical FLIP-long signals.
//
// Approach: walk forward each historical FLIP-long signal in ticks.db, compute
// outcome (WIN/LOSS/OPEN at TP/SL/horizon). Then find feature filters that
// select for the win subset. Ship as v3 confluence layer on top of FLIP-long.
//
// Per goal: TP ≥ 12pt, R:R ≥ 1:4. So tightest SL = 3pt. But FLIP-long's
// inherent SL is wider (stop at bar low ~55pt). We have two choices:
//   A) Use FLIP's natural SL and TP=80 → R:R ~1.45 (violates goal)
//   B) Re-set SL=3pt, TP=12pt (meets goal) → measure WR
//
// We'll try BOTH; if (B) hits 70%+ on filtered subset, ship.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

console.log = (...a:any[]) => { fs.writeSync(1, a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')+'\n'); };

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TR_DB = path.resolve(__dirname, '../../../data/trading.db');
const TK_DB = path.resolve(__dirname, '../../../data/ticks.db');

const tr = new Database(TR_DB, { readonly: true });
const tk = new Database(TK_DB, { readonly: true });

const TP_PTS = 12;
const SL_PTS = 3;
const TRAIL = 6;
const TIMESTOP = 30 * 60_000;     // give bar-pattern signals 30min to develop
const ENTRY_SLIP = 0.5;
const SPREAD = 0.25;
const SL_SLIP = 1.0;

console.log('═══ FLIP-long strict — historical signal filter search ═══');
console.log(`TP=${TP_PTS}  SL=${SL_PTS} (R:R 1:4)  Trail BE +${TRAIL}  Timestop ${TIMESTOP/60_000}min\n`);

// Load FLIP-long signals from last 30 days
const signals = tr.prepare(`
  SELECT q.signal_ts ts, q.symbol, q.score, s.payload
  FROM qualified_signals q
  JOIN signals s ON s.id = q.signal_id
  WHERE q.rule_id = 'clean-impulse'
    AND q.direction = 'long'
    AND q.symbol = 'NQ'
    AND json_extract(s.payload, '$.pattern') = 'FLIP'
    AND q.signal_ts > strftime('%s', 'now', '-60 days') * 1000
  ORDER BY q.signal_ts ASC
`).all() as Array<{ts:number;symbol:string;score:number;payload:string}>;

console.log(`Found ${signals.length} historical FLIP-long signals across last 60 days\n`);
if (signals.length < 10) {
  console.log('Not enough signals to filter-search. Halting.');
  process.exit(0);
}

// Walk each signal forward in NQ ticks
interface SigOutcome {
  ts: number; entry: number; outcome: 'WIN'|'LOSS'|'TIMESTOP'; pnlSlip: number;
  score: number; compPos: number; deltaT: number; body: number;
  deltaLast3: number; etMinute: number; etDate: string;
}

const trades: SigOutcome[] = [];

for (const sig of signals) {
  const payload = JSON.parse(sig.payload);
  const entry = payload.entry;
  if (!entry || entry <= 0) continue;

  // Walk forward in ticks
  const fillPx = entry + SPREAD/2 + ENTRY_SLIP;
  const slPx = fillPx - SL_PTS;
  const tpPx = fillPx + TP_PTS;
  const fillTs = sig.ts;
  const hardStop = fillTs + TIMESTOP;
  const ticks = tk.prepare(`
    SELECT ts, price FROM trades WHERE symbol='NQ' AND ts > ? AND ts <= ? ORDER BY ts ASC
  `).all(fillTs, hardStop) as Array<{ts:number;price:number}>;
  if (!ticks.length) continue;

  let outcome: 'WIN'|'LOSS'|'TIMESTOP' = 'TIMESTOP';
  let exitPx = fillPx;
  let effSL = slPx;
  let trailed = false;
  for (const t of ticks) {
    const move = t.price - fillPx;
    if (!trailed && move >= TRAIL) { effSL = fillPx; trailed = true; }
    if (t.price >= tpPx) { outcome = 'WIN'; exitPx = tpPx; break; }
    if (t.price <= effSL) {
      outcome = trailed && Math.abs(effSL - fillPx) < 0.01 ? 'TIMESTOP' : 'LOSS';
      exitPx = effSL; break;
    }
  }
  if (outcome === 'TIMESTOP') exitPx = ticks[ticks.length-1]!.price;

  const pnlSlip = outcome === 'WIN' ? TP_PTS
    : outcome === 'LOSS' ? -(SL_PTS + SL_SLIP)
    : (exitPx - fillPx) - 0.5;

  const d = new Date(sig.ts - 4*60*60_000);
  const etMin = d.getUTCHours()*60 + d.getUTCMinutes();
  const etDate = d.toISOString().substring(0,10);

  trades.push({
    ts: sig.ts, entry: fillPx, outcome, pnlSlip,
    score: sig.score,
    compPos: payload.compPos ?? -1,
    deltaT: payload.deltaT ?? 0,
    body: payload.body ?? 0,
    deltaLast3: payload.deltaLast3 ?? 0,
    etMinute: etMin,
    etDate,
  });
}

console.log(`Walked ${trades.length}/${signals.length} signals through ticks.db`);
const wins = trades.filter(t=>t.outcome==='WIN').length;
const losses = trades.filter(t=>t.outcome==='LOSS').length;
const tstops = trades.filter(t=>t.outcome==='TIMESTOP').length;
const totSlip = trades.reduce((s,t)=>s+t.pnlSlip,0);
const wr = (wins+losses) > 0 ? wins/(wins+losses)*100 : 0;
console.log(`\nBase: WIN=${wins}  LOSS=${losses}  TIMESTOP=${tstops}  WR=${wr.toFixed(1)}%  slipped=${totSlip.toFixed(1)}pts`);

if (wins === 0) {
  console.log(`\nNo wins at TP=${TP_PTS}/SL=${SL_PTS}. The TP=12 is too far to typically hit before SL=3 trips.`);
  console.log(`Trying wider params: TP=20, SL=5...`);

  // Re-run with TP=20/SL=5 (R:R 1:4 still)
  const TP2 = 20, SL2 = 5;
  const trades2: SigOutcome[] = [];
  for (const sig of signals) {
    const payload = JSON.parse(sig.payload);
    const entry = payload.entry;
    if (!entry || entry <= 0) continue;
    const fillPx = entry + SPREAD/2 + ENTRY_SLIP;
    const slPx = fillPx - SL2;
    const tpPx = fillPx + TP2;
    const fillTs = sig.ts;
    const hardStop = fillTs + TIMESTOP;
    const t2 = tk.prepare(`SELECT ts, price FROM trades WHERE symbol='NQ' AND ts > ? AND ts <= ? ORDER BY ts ASC`)
      .all(fillTs, hardStop) as Array<{ts:number;price:number}>;
    if (!t2.length) continue;
    let outcome: 'WIN'|'LOSS'|'TIMESTOP' = 'TIMESTOP';
    let exitPx = fillPx, effSL = slPx, trailed = false;
    for (const t of t2) {
      const move = t.price - fillPx;
      if (!trailed && move >= 8) { effSL = fillPx; trailed = true; }
      if (t.price >= tpPx) { outcome='WIN'; exitPx=tpPx; break; }
      if (t.price <= effSL) {
        outcome = trailed && Math.abs(effSL-fillPx)<0.01 ? 'TIMESTOP' : 'LOSS';
        exitPx = effSL; break;
      }
    }
    if (outcome === 'TIMESTOP') exitPx = t2[t2.length-1]!.price;
    const pnlSlip = outcome === 'WIN' ? TP2 : outcome === 'LOSS' ? -(SL2 + SL_SLIP) : (exitPx-fillPx)-0.5;
    const d = new Date(sig.ts - 4*60*60_000);
    trades2.push({
      ts: sig.ts, entry: fillPx, outcome, pnlSlip,
      score: sig.score, compPos: payload.compPos ?? -1, deltaT: payload.deltaT ?? 0,
      body: payload.body ?? 0, deltaLast3: payload.deltaLast3 ?? 0,
      etMinute: d.getUTCHours()*60 + d.getUTCMinutes(),
      etDate: d.toISOString().substring(0,10),
    });
  }
  const w2 = trades2.filter(t=>t.outcome==='WIN').length;
  const l2 = trades2.filter(t=>t.outcome==='LOSS').length;
  const wr2 = (w2+l2)>0 ? w2/(w2+l2)*100 : 0;
  const slip2 = trades2.reduce((s,t)=>s+t.pnlSlip,0);
  console.log(`TP=${TP2}/SL=${SL2}: WIN=${w2} LOSS=${l2} WR=${wr2.toFixed(1)}% slipped=${slip2.toFixed(1)}pts`);

  // Try filtering by features
  console.log(`\n══ Filter search on TP=20/SL=5 trades ══`);
  console.log(`${'filter'.padEnd(40)} ${'n'.padStart(4)} ${'W'.padStart(3)} ${'L'.padStart(3)} ${'WR%'.padStart(6)} ${'slip'.padStart(8)} verdict`);
  const filters = [
    { name: 'score >= 80',                 pred: (t: SigOutcome) => t.score >= 80 },
    { name: 'score >= 90',                 pred: (t: SigOutcome) => t.score >= 90 },
    { name: 'score >= 95',                 pred: (t: SigOutcome) => t.score >= 95 },
    { name: 'compPos <= 0.20',             pred: (t: SigOutcome) => t.compPos >= 0 && t.compPos <= 0.20 },
    { name: 'compPos <= 0.10',             pred: (t: SigOutcome) => t.compPos >= 0 && t.compPos <= 0.10 },
    { name: 'deltaT >= 500',               pred: (t: SigOutcome) => t.deltaT >= 500 },
    { name: 'deltaT >= 800',               pred: (t: SigOutcome) => t.deltaT >= 800 },
    { name: 'body >= 10',                  pred: (t: SigOutcome) => t.body >= 10 },
    { name: 'body >= 15',                  pred: (t: SigOutcome) => t.body >= 15 },
    { name: 'deltaLast3 <= -300',          pred: (t: SigOutcome) => t.deltaLast3 <= -300 },
    { name: 'deltaLast3 <= -500',          pred: (t: SigOutcome) => t.deltaLast3 <= -500 },
    { name: 'et 09:54-12:00',              pred: (t: SigOutcome) => t.etMinute >= 594 && t.etMinute < 720 },
    { name: 'et 10:00-13:00',              pred: (t: SigOutcome) => t.etMinute >= 600 && t.etMinute < 780 },
    { name: 'score≥90 & compPos<=0.20',    pred: (t: SigOutcome) => t.score >= 90 && t.compPos >= 0 && t.compPos <= 0.20 },
    { name: 'score≥90 & deltaT>=500',      pred: (t: SigOutcome) => t.score >= 90 && t.deltaT >= 500 },
    { name: 'score≥95 & deltaT>=500',      pred: (t: SigOutcome) => t.score >= 95 && t.deltaT >= 500 },
    { name: 'score≥90 & compPos<=0.20 & deltaT>=500', pred: (t: SigOutcome) => t.score >= 90 && t.compPos >= 0 && t.compPos <= 0.20 && t.deltaT >= 500 },
    { name: 'score≥90 & body>=10',         pred: (t: SigOutcome) => t.score >= 90 && t.body >= 10 },
    { name: 'score≥90 & et 10:00-13:00',   pred: (t: SigOutcome) => t.score >= 90 && t.etMinute >= 600 && t.etMinute < 780 },
    { name: 'score≥95 & body>=10 & et 10-13', pred: (t: SigOutcome) => t.score >= 95 && t.body >= 10 && t.etMinute >= 600 && t.etMinute < 780 },
  ];
  for (const f of filters) {
    const subset = trades2.filter(f.pred);
    const w = subset.filter(t=>t.outcome==='WIN').length;
    const l = subset.filter(t=>t.outcome==='LOSS').length;
    const fwr = (w+l) > 0 ? w/(w+l)*100 : 0;
    const fslip = subset.reduce((s,t)=>s+t.pnlSlip,0);
    const v = (fwr >= 70 && fslip > 0) ? '✅ SHIPPABLE' : fwr >= 50 ? 'iterate' : 'kill';
    console.log(`${f.name.padEnd(40)} ${subset.length.toString().padStart(4)} ${w.toString().padStart(3)} ${l.toString().padStart(3)} ${fwr.toFixed(1).padStart(5)}% ${('$'+(fslip*2|0)).padStart(8)} ${v}`);
  }
  process.exit(0);
}

// If wins exist at TP=12/SL=3, do the filter search
console.log(`\n══ Filter search ══`);
const filters = [
  { name: 'score >= 80',                 pred: (t: SigOutcome) => t.score >= 80 },
  { name: 'score >= 90',                 pred: (t: SigOutcome) => t.score >= 90 },
  { name: 'compPos <= 0.20',             pred: (t: SigOutcome) => t.compPos >= 0 && t.compPos <= 0.20 },
  { name: 'deltaT >= 500',               pred: (t: SigOutcome) => t.deltaT >= 500 },
  { name: 'body >= 10',                  pred: (t: SigOutcome) => t.body >= 10 },
  { name: 'deltaLast3 <= -300',          pred: (t: SigOutcome) => t.deltaLast3 <= -300 },
  { name: 'et 09:54-13:00',              pred: (t: SigOutcome) => t.etMinute >= 594 && t.etMinute < 780 },
  { name: 'score≥90 & compPos<=0.20',    pred: (t: SigOutcome) => t.score >= 90 && t.compPos >= 0 && t.compPos <= 0.20 },
  { name: 'score≥90 & deltaT>=500',      pred: (t: SigOutcome) => t.score >= 90 && t.deltaT >= 500 },
];
console.log(`${'filter'.padEnd(40)} ${'n'.padStart(4)} ${'W'.padStart(3)} ${'L'.padStart(3)} ${'WR%'.padStart(6)} verdict`);
for (const f of filters) {
  const subset = trades.filter(f.pred);
  const w = subset.filter(t=>t.outcome==='WIN').length;
  const l = subset.filter(t=>t.outcome==='LOSS').length;
  const fwr = (w+l) > 0 ? w/(w+l)*100 : 0;
  const v = (fwr >= 70) ? '✅' : fwr >= 50 ? 'iterate' : 'kill';
  console.log(`${f.name.padEnd(40)} ${subset.length.toString().padStart(4)} ${w.toString().padStart(3)} ${l.toString().padStart(3)} ${fwr.toFixed(1).padStart(5)}% ${v}`);
}

console.log(`\nDone.`);
