// Phase-A Strategy-A rebuild — Phase 2: statistical decomposition.
//
// Reads /tmp/sweep_dataset_NQ.jsonl and reports per-feature WR + expectancy
// at fixed TP/SL targets. Identifies conditional subsets where sweep
// behavior is non-random.
//
// WIN/LOSS rule per sweep: walking from endPrice in sweep direction,
//   WIN  = MFE >= TP and MFE-event happened BEFORE MAE-event at -SL
//   LOSS = MAE <= -SL and MAE-event happened BEFORE MFE-event at TP
//   OPEN = neither reached within horizon
//
// PROBLEM: dataset stores MFE/MAE as max values, not first-touch ordering.
//   We CANNOT determine the WIN/LOSS race from this dataset alone.
//
//   Practical workaround: classify outcome by the SIGN of close5m / close15m
//   (where price ended up). Also report MFE >= TP rate and MAE <= -SL rate
//   independently, which bounds the true WR.
//
//   Strict WIN/LOSS requires the tick stream — punted to phase 2b if needed.

import fs from 'node:fs';

const DATASET = '/tmp/sweep_dataset_NQ.jsonl';

interface Rec {
  startTs: number;
  endTs: number;
  symbol: string;
  direction: 'long' | 'short';
  levels: number;
  volume: number;
  durationMs: number;
  startPrice: number;
  endPrice: number;
  numTrades: number;
  day: string;
  session: 'RTH' | 'GLOBEX_PM' | 'GLOBEX_ASIA' | 'GLOBEX_EU';
  preVol60s: number;
  preRange60s: number;
  preTradeCount60s: number;
  preBuyVol60s: number;
  preSellVol60s: number;
  volMultiple: number;
  mfe1m: number;  mae1m: number;  close1m: number;
  mfe3m: number;  mae3m: number;  close3m: number;
  mfe5m: number;  mae5m: number;  close5m: number;
  mfe15m: number; mae15m: number; close15m: number;
}

const records: Rec[] = [];
const raw = fs.readFileSync(DATASET, 'utf8').trim().split('\n');
for (const line of raw) records.push(JSON.parse(line) as Rec);

console.log(`\n══ Sweep statistical decomposition ══`);
console.log(`N=${records.length.toLocaleString()} sweeps across ${new Set(records.map(r => r.day)).size} days\n`);

// =========== Helpers ===========
function quartiles(arr: number[]): { q1: number; q2: number; q3: number } {
  const sorted = [...arr].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.floor(p * (sorted.length - 1))]!;
  return { q1: q(0.25), q2: q(0.5), q3: q(0.75) };
}
function mean(arr: number[]) { return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length; }

interface SubsetMetrics {
  n: number;
  pct: number;
  // "trend follow" rates — close in sweep direction at +1/+3/+5/+15m
  trend1m: number;
  trend5m: number;
  trend15m: number;
  // MFE reach rates (price moved at least Xpt FAVORABLY at some point)
  reach5: number;   // % that hit +5pt favorable @ 5m
  reach10: number;  // % that hit +10pt favorable @ 5m
  reach20: number;  // % that hit +20pt favorable @ 5m
  // MAE reach rates (price moved at least Xpt ADVERSELY at some point)
  drawdown5: number;   // % that hit -5pt adverse @ 5m
  drawdown10: number;  // % that hit -10pt adverse @ 5m
  drawdown20: number;  // % that hit -20pt adverse @ 5m
  // Edge metric: % where MFE>=10 BEFORE MAE<=-10 cannot be computed exactly from
  // max values. Approximate with "MFE>=10 AND MAE>-10" (=clean wins where price
  // didn't drop 10pt before hitting target).
  cleanWin_10x10_5m: number;  // MFE5m>=10 AND MAE5m>-10
  cleanLoss_10x10_5m: number; // MAE5m<=-10 AND MFE5m<10
  // Expectancy proxy: median close5m
  medClose5m: number;
  medMfe5m: number;
  medMae5m: number;
}

function metricsFor(subset: Rec[], totalN: number): SubsetMetrics {
  if (subset.length === 0) return {
    n: 0, pct: 0,
    trend1m: 0, trend5m: 0, trend15m: 0,
    reach5: 0, reach10: 0, reach20: 0,
    drawdown5: 0, drawdown10: 0, drawdown20: 0,
    cleanWin_10x10_5m: 0, cleanLoss_10x10_5m: 0,
    medClose5m: 0, medMfe5m: 0, medMae5m: 0,
  };
  const close5m = subset.map(r => r.close5m);
  const mfe5m = subset.map(r => r.mfe5m);
  const mae5m = subset.map(r => r.mae5m);
  const trendCount = (arr: Rec[], fn: (r: Rec) => number) => arr.filter(r => fn(r) > 0).length / arr.length * 100;
  const mfeReach = (arr: Rec[], thresh: number) => arr.filter(r => r.mfe5m >= thresh).length / arr.length * 100;
  const maeReach = (arr: Rec[], thresh: number) => arr.filter(r => r.mae5m <= -thresh).length / arr.length * 100;
  const cleanWin = subset.filter(r => r.mfe5m >= 10 && r.mae5m > -10).length / subset.length * 100;
  const cleanLoss = subset.filter(r => r.mae5m <= -10 && r.mfe5m < 10).length / subset.length * 100;
  return {
    n: subset.length,
    pct: subset.length / totalN * 100,
    trend1m: trendCount(subset, r => r.close1m),
    trend5m: trendCount(subset, r => r.close5m),
    trend15m: trendCount(subset, r => r.close15m),
    reach5: mfeReach(subset, 5),
    reach10: mfeReach(subset, 10),
    reach20: mfeReach(subset, 20),
    drawdown5: maeReach(subset, 5),
    drawdown10: maeReach(subset, 10),
    drawdown20: maeReach(subset, 20),
    cleanWin_10x10_5m: cleanWin,
    cleanLoss_10x10_5m: cleanLoss,
    medClose5m: quartiles(close5m).q2,
    medMfe5m: quartiles(mfe5m).q2,
    medMae5m: quartiles(mae5m).q2,
  };
}

function printRow(label: string, m: SubsetMetrics, total: number): void {
  console.log(
    `  ${label.padEnd(28)}` +
    `n=${m.n.toString().padStart(6)} ` +
    `(${m.pct.toFixed(1).padStart(4)}%) | ` +
    `trend5m ${m.trend5m.toFixed(1).padStart(4)}% | ` +
    `reach10 ${m.reach10.toFixed(1).padStart(4)}% | ` +
    `dd10 ${m.drawdown10.toFixed(1).padStart(4)}% | ` +
    `cleanW ${m.cleanWin_10x10_5m.toFixed(1).padStart(4)}% / cleanL ${m.cleanLoss_10x10_5m.toFixed(1).padStart(4)}% | ` +
    `medC5m ${m.medClose5m.toFixed(2).padStart(6)}`
  );
}

// =========== Baseline ===========
const total = records.length;
const baseline = metricsFor(records, total);
console.log(`── Baseline (ALL sweeps) ──`);
console.log(`  trend@5m=${baseline.trend5m.toFixed(1)}% | reach+10=${baseline.reach10.toFixed(1)}% | dd-10=${baseline.drawdown10.toFixed(1)}%`);
console.log(`  median MFE@5m=${baseline.medMfe5m.toFixed(2)}pt, median MAE@5m=${baseline.medMae5m.toFixed(2)}pt, median close@5m=${baseline.medClose5m.toFixed(2)}pt`);
console.log(`  cleanWin(mfe>=10 & mae>-10)@5m=${baseline.cleanWin_10x10_5m.toFixed(1)}% | cleanLoss=${baseline.cleanLoss_10x10_5m.toFixed(1)}%`);

// =========== Distributions ===========
const vols = records.map(r => r.volume);
const lvls = records.map(r => r.levels);
const durs = records.map(r => r.durationMs);
const vMult = records.map(r => r.volMultiple);
console.log(`\n── Distributions ──`);
console.log(`  volume:        q1=${quartiles(vols).q1} q2=${quartiles(vols).q2} q3=${quartiles(vols).q3} max=${Math.max(...vols)}`);
console.log(`  levels:        q1=${quartiles(lvls).q1} q2=${quartiles(lvls).q2} q3=${quartiles(lvls).q3} max=${Math.max(...lvls)}`);
console.log(`  durationMs:    q1=${quartiles(durs).q1} q2=${quartiles(durs).q2} q3=${quartiles(durs).q3} max=${Math.max(...durs)}`);
console.log(`  volMultiple:   q1=${quartiles(vMult).q1.toFixed(2)} q2=${quartiles(vMult).q2.toFixed(2)} q3=${quartiles(vMult).q3.toFixed(2)}`);

// =========== Slice tables ===========
function slice(label: string, predicates: Array<[string, (r: Rec) => boolean]>) {
  console.log(`\n── Slice: ${label} ──`);
  console.log(`  ${'subset'.padEnd(28)}${'n'.padStart(6)}        | trend5m | reach10 |  dd10 | cleanW / cleanL | medC5m`);
  for (const [name, pred] of predicates) {
    const subset = records.filter(pred);
    const m = metricsFor(subset, total);
    printRow(name, m, total);
  }
}

slice('Direction', [
  ['long  (buyers aggressing)',  r => r.direction === 'long'],
  ['short (sellers aggressing)', r => r.direction === 'short'],
]);

slice('Session', [
  ['RTH',         r => r.session === 'RTH'],
  ['GLOBEX_PM',   r => r.session === 'GLOBEX_PM'],
  ['GLOBEX_ASIA', r => r.session === 'GLOBEX_ASIA'],
  ['GLOBEX_EU',   r => r.session === 'GLOBEX_EU'],
]);

slice('Volume buckets', [
  ['vol 50-99',     r => r.volume >= 50 && r.volume < 100],
  ['vol 100-199',   r => r.volume >= 100 && r.volume < 200],
  ['vol 200-499',   r => r.volume >= 200 && r.volume < 500],
  ['vol 500+',      r => r.volume >= 500],
]);

slice('Levels buckets', [
  ['levels 3',      r => r.levels === 3],
  ['levels 4',      r => r.levels === 4],
  ['levels 5',      r => r.levels === 5],
  ['levels 6-9',    r => r.levels >= 6 && r.levels < 10],
  ['levels 10+',    r => r.levels >= 10],
]);

slice('Duration buckets', [
  ['dur < 100ms',     r => r.durationMs < 100],
  ['dur 100-300ms',   r => r.durationMs >= 100 && r.durationMs < 300],
  ['dur 300-1000ms',  r => r.durationMs >= 300 && r.durationMs < 1000],
  ['dur 1-5s',        r => r.durationMs >= 1000 && r.durationMs < 5000],
  ['dur 5s+',         r => r.durationMs >= 5000],
]);

slice('volMultiple buckets', [
  ['vmult <1 (slow)',     r => r.volMultiple < 1],
  ['vmult 1-3',           r => r.volMultiple >= 1 && r.volMultiple < 3],
  ['vmult 3-10',          r => r.volMultiple >= 3 && r.volMultiple < 10],
  ['vmult 10-30',         r => r.volMultiple >= 10 && r.volMultiple < 30],
  ['vmult 30+ (huge)',    r => r.volMultiple >= 30],
]);

// =========== Conditional pairs ===========
console.log(`\n── 2D Slice: Session × Direction ──`);
console.log(`  ${'subset'.padEnd(28)}${'n'.padStart(6)}        | trend5m | reach10 |  dd10 | cleanW / cleanL | medC5m`);
for (const ses of ['RTH', 'GLOBEX_PM', 'GLOBEX_ASIA', 'GLOBEX_EU'] as const) {
  for (const dir of ['long', 'short'] as const) {
    const subset = records.filter(r => r.session === ses && r.direction === dir);
    const m = metricsFor(subset, total);
    printRow(`${ses}+${dir}`, m, total);
  }
}

console.log(`\n── 2D Slice: High-conviction sweeps (vol>=200 AND vmult>=10) by session ──`);
const highConv = records.filter(r => r.volume >= 200 && r.volMultiple >= 10);
console.log(`  Total high-conviction: ${highConv.length} (${(highConv.length/total*100).toFixed(2)}%)`);
console.log(`  ${'subset'.padEnd(28)}${'n'.padStart(6)}        | trend5m | reach10 |  dd10 | cleanW / cleanL | medC5m`);
for (const ses of ['RTH', 'GLOBEX_PM', 'GLOBEX_ASIA', 'GLOBEX_EU'] as const) {
  const subset = highConv.filter(r => r.session === ses);
  const m = metricsFor(subset, total);
  printRow(`HC ${ses}`, m, total);
}

console.log(`\n══ Read of results ══`);
console.log(`Baseline (all sweeps) trend@5m = ${baseline.trend5m.toFixed(1)}% — if ~50%, sweep alone has no directional edge.`);
console.log(`Look for any subset with trend5m > 55% AND cleanW > cleanL by a meaningful margin → that's where edge lives.\n`);
