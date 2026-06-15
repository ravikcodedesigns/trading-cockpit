// Phase 1G — Permutation test on the corrected FRESH cohort.
//
// Null hypothesis: the FRESH vs POST_BREACH label is unrelated to outcome —
// any subset of N touches from the pool would produce the same WR / $/trade
// distribution as the actual FRESH cohort.
//
// Procedure (label-shuffle permutation):
//   1. Pool = all non-IB touches across train+test (PDH/PDL/PDC/POC/VAH/VAL).
//      Outcomes are computed under FADE direction × 20/5 TP/SL with 5pt slip.
//   2. Observed metric: FRESH-cohort WR and $/trade.
//   3. For N_PERM iterations:
//        Shuffle the outcomes across the pool (or equivalently: randomly pick
//        |FRESH| outcomes from the pool with the same count, no replacement).
//        Compute "random FRESH" WR / $/trade.
//   4. p-value = fraction of shuffles where random metric >= observed.
//
// Two test variants:
//   • WR-test (binary outcome): observed WR ≥ random?
//   • $-test ($/trade): observed $/trade ≥ random?
//
// Also produces a Wilson 95% CI on the observed WR for sample-size context.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../../..');
const DOLLAR_PER_PT = 2;
const N_PERM = 50000;
const TPSL = '20/5';
const DIR = 'fade';
const NON_IB = ['PDH', 'PDL', 'PDC', 'POC', 'VAH', 'VAL'];

interface OutcomeResult { result: 'TP'|'SL'|'TIMEOUT'; raw_pnl_pts: number; slip_pnl_pts: number }
interface Event {
  touch_ts: number;
  touch_type: string;
  level_label: string;
  outcomes: Record<string, { fade: OutcomeResult; breakout: OutcomeResult }>;
}

interface Outcome { result: 'TP'|'SL'|'TIMEOUT'; pts: number }

function loadPool(setName: 'train' | 'test' | 'combined'): { pool: Outcome[]; freshIdx: number[]; postBreachIdx: number[] } {
  let events: Event[] = [];
  if (setName === 'train' || setName === 'combined') {
    events = events.concat(JSON.parse(fs.readFileSync(path.join(REPO, 'phase1-events-train.json'), 'utf8')).events as Event[]);
  }
  if (setName === 'test' || setName === 'combined') {
    events = events.concat(JSON.parse(fs.readFileSync(path.join(REPO, 'phase1-events-test.json'), 'utf8')).events as Event[]);
  }
  const all = events.filter(e => NON_IB.includes(e.level_label));
  const pool: Outcome[] = [];
  const freshIdx: number[] = [];
  const postBreachIdx: number[] = [];
  for (const e of all) {
    const o = e.outcomes[TPSL]![DIR];
    pool.push({ result: o.result, pts: o.slip_pnl_pts });
    if (e.touch_type === 'FRESH') freshIdx.push(pool.length - 1);
    else if (e.touch_type === 'POST_BREACH') postBreachIdx.push(pool.length - 1);
  }
  return { pool, freshIdx, postBreachIdx };
}

function statsFor(outcomes: Outcome[]): { wr: number; closedN: number; wrClosed: number; usd: number; perTrade: number } {
  const w = outcomes.filter(o => o.result === 'TP').length;
  const l = outcomes.filter(o => o.result === 'SL').length;
  const closedN = w + l;
  const ptsSum = outcomes.reduce((s, o) => s + o.pts, 0);
  return {
    wr: outcomes.length ? w / outcomes.length : 0,
    closedN,
    wrClosed: closedN ? w / closedN : 0,
    usd: ptsSum * DOLLAR_PER_PT,
    perTrade: outcomes.length ? (ptsSum * DOLLAR_PER_PT) / outcomes.length : 0,
  };
}

function wilsonCi(w: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = w / n;
  const denom = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const half = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function runOne(setName: 'train' | 'test' | 'combined') {
  const { pool, freshIdx, postBreachIdx } = loadPool(setName);
  const nFresh = freshIdx.length;
  const N = pool.length;

  console.log(`\n═══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`Permutation test — set=${setName.toUpperCase()}`);
  console.log(`Direction: FADE   TP/SL: ${TPSL}   Slippage: 5pt per trade`);
  console.log(`═══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`Pool size (non-IB touches): ${N}`);
  console.log(`  FRESH:        ${nFresh}`);
  console.log(`  POST_BREACH:  ${postBreachIdx.length}`);
  console.log(`  Other:        ${N - nFresh - postBreachIdx.length}`);

  if (nFresh === 0 || N === 0) { console.log('  Empty cohort — skipping'); return; }

  const observedFresh = freshIdx.map(i => pool[i]!);
  const obs = statsFor(observedFresh);
  const wRaw = observedFresh.filter(o => o.result === 'TP').length;
  const lRaw = observedFresh.filter(o => o.result === 'SL').length;
  const [wrLo, wrHi] = wilsonCi(wRaw, nFresh);

  console.log(`\n  Observed FRESH:  n=${nFresh}  W=${wRaw}  L=${lRaw}  WR=${(obs.wr*100).toFixed(1)}%  Wilson95=[${(wrLo*100).toFixed(1)}%, ${(wrHi*100).toFixed(1)}%]`);
  console.log(`                   Net $=$${obs.usd.toFixed(0)}  $/trade=$${obs.perTrade.toFixed(2)}`);

  let nWRGte = 0, nUSDGte = 0;
  const wrDist: number[] = [];
  const usdDist: number[] = [];
  const indices: number[] = pool.map((_, i) => i);
  for (let iter = 0; iter < N_PERM; iter++) {
    shuffleInPlace(indices);
    const randomFresh = indices.slice(0, nFresh).map(i => pool[i]!);
    const s = statsFor(randomFresh);
    wrDist.push(s.wr);
    usdDist.push(s.usd);
    if (s.wr >= obs.wr) nWRGte++;
    if (s.usd >= obs.usd) nUSDGte++;
  }
  wrDist.sort((a, b) => a - b);
  usdDist.sort((a, b) => a - b);

  const pUSD = nUSDGte / N_PERM;
  const pWR = nWRGte / N_PERM;
  console.log(`\n  Permutation (N=${N_PERM}):`);
  console.log(`    P(random WR >= ${(obs.wr*100).toFixed(1)}%)  = ${pWR.toFixed(4)}`);
  console.log(`    P(random $  >= $${obs.usd.toFixed(0)})  = ${pUSD.toFixed(4)}`);
  console.log(`  Null distribution:`);
  console.log(`    WR  median=${(wrDist[Math.floor(N_PERM*0.5)]!*100).toFixed(1)}%  p95=${(wrDist[Math.floor(N_PERM*0.95)]!*100).toFixed(1)}%  p99=${(wrDist[Math.floor(N_PERM*0.99)]!*100).toFixed(1)}%  max=${(wrDist[wrDist.length-1]!*100).toFixed(1)}%`);
  console.log(`    $   median=$${usdDist[Math.floor(N_PERM*0.5)]!.toFixed(0)}  p95=$${usdDist[Math.floor(N_PERM*0.95)]!.toFixed(0)}  p99=$${usdDist[Math.floor(N_PERM*0.99)]!.toFixed(0)}  max=$${usdDist[usdDist.length-1]!.toFixed(0)}`);
}

function main() {
  runOne('train');
  runOne('test');
  runOne('combined');
}

main();
