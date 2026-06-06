// Diagnose which iceberg filter is the bottleneck. Counts how many matched
// trades survive each successive filter on 5/28 NQ data.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchTrades, type MatchedTrade } from './lib/trade-book-matcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TICKS_DB = path.resolve(__dirname, '../../../data/ticks.db');
const xdb = new Database(TICKS_DB, { readonly: true });

const SYMBOL = 'NQ';
const DAY_START_MS = Date.UTC(2026, 4, 28, 13, 30, 0);
const DAY_END_MS   = Date.UTC(2026, 4, 28, 20, 0, 0);

const filterCounts = {
  total: 0,
  stale: 0,
  passStaleCheck: 0,
  hiddenGeq5: 0,
  hiddenGeq10: 0,
  hiddenGeq20: 0,
  hiddenGeq50: 0,
  preSizeGeq5: 0,
  preSizeGeq10: 0,
  preSizeGeq20: 0,
  depletionGeq0: 0,
  depletionGeqMinus5: 0,
  postGeq50pctPre: 0,
  // Combined progressive filters
  passAll_loose:  0,  // pre>=5  + hidden>=10 + dep>=0
  passAll_medium: 0,  // pre>=10 + hidden>=15 + dep>=0 + post>=30%pre
  passAll_strict: 0,  // pre>=15 + hidden>=20 + dep>=0 + post>=50%pre
};

// Bucket hidden volume distribution
const hiddenBins = [0, 5, 10, 20, 50, 100, 200, 500];
const hiddenHistogram = new Array(hiddenBins.length).fill(0);

matchTrades({
  ticksDb: xdb, symbol: SYMBOL,
  fromTs: DAY_START_MS, toTs: DAY_END_MS,
  onMatch: (m: MatchedTrade) => {
    filterCounts.total++;
    if (m.staleAfter) { filterCounts.stale++; return; }
    filterCounts.passStaleCheck++;

    const h = m.hiddenVolumeEstimate ?? 0;
    const d = m.impliedDepletion ?? 0;
    const pre = m.preSizeAtPrice;
    const post = m.postSizeAtPrice ?? 0;

    if (h >= 5)  filterCounts.hiddenGeq5++;
    if (h >= 10) filterCounts.hiddenGeq10++;
    if (h >= 20) filterCounts.hiddenGeq20++;
    if (h >= 50) filterCounts.hiddenGeq50++;
    if (pre >= 5)  filterCounts.preSizeGeq5++;
    if (pre >= 10) filterCounts.preSizeGeq10++;
    if (pre >= 20) filterCounts.preSizeGeq20++;
    if (d >= 0)    filterCounts.depletionGeq0++;
    if (d >= -5)   filterCounts.depletionGeqMinus5++;
    if (m.postSizeAtPrice != null && post >= pre * 0.5) filterCounts.postGeq50pctPre++;

    // Histogram of hidden volume
    for (let i = hiddenBins.length - 1; i >= 0; i--) {
      if (h >= hiddenBins[i]!) { hiddenHistogram[i]++; break; }
    }

    // Progressive combined filters
    if (pre >= 5 && h >= 10 && d >= 0) filterCounts.passAll_loose++;
    if (pre >= 10 && h >= 15 && d >= 0 && post >= pre * 0.3) filterCounts.passAll_medium++;
    if (pre >= 15 && h >= 20 && d >= 0 && post >= pre * 0.5) filterCounts.passAll_strict++;
  },
});

const total = filterCounts.total;
const pct = (n: number) => `${(n/total*100).toFixed(2)}%`;
console.log(`\n== Filter pass rates (out of ${total.toLocaleString()} matched trades) ==\n`);
console.log(`  stale:                ${filterCounts.stale.toLocaleString().padStart(9)}  (${pct(filterCounts.stale)})`);
console.log(`  non-stale:            ${filterCounts.passStaleCheck.toLocaleString().padStart(9)}  (${pct(filterCounts.passStaleCheck)})\n`);
console.log(`  hidden ≥ 5:           ${filterCounts.hiddenGeq5.toLocaleString().padStart(9)}  (${pct(filterCounts.hiddenGeq5)})`);
console.log(`  hidden ≥ 10:          ${filterCounts.hiddenGeq10.toLocaleString().padStart(9)}  (${pct(filterCounts.hiddenGeq10)})`);
console.log(`  hidden ≥ 20:          ${filterCounts.hiddenGeq20.toLocaleString().padStart(9)}  (${pct(filterCounts.hiddenGeq20)})`);
console.log(`  hidden ≥ 50:          ${filterCounts.hiddenGeq50.toLocaleString().padStart(9)}  (${pct(filterCounts.hiddenGeq50)})\n`);
console.log(`  preSize ≥ 5:          ${filterCounts.preSizeGeq5.toLocaleString().padStart(9)}  (${pct(filterCounts.preSizeGeq5)})`);
console.log(`  preSize ≥ 10:         ${filterCounts.preSizeGeq10.toLocaleString().padStart(9)}  (${pct(filterCounts.preSizeGeq10)})`);
console.log(`  preSize ≥ 20:         ${filterCounts.preSizeGeq20.toLocaleString().padStart(9)}  (${pct(filterCounts.preSizeGeq20)})\n`);
console.log(`  depletion ≥ 0:        ${filterCounts.depletionGeq0.toLocaleString().padStart(9)}  (${pct(filterCounts.depletionGeq0)})`);
console.log(`  depletion ≥ -5:       ${filterCounts.depletionGeqMinus5.toLocaleString().padStart(9)}  (${pct(filterCounts.depletionGeqMinus5)})\n`);
console.log(`  post ≥ 50% × pre:     ${filterCounts.postGeq50pctPre.toLocaleString().padStart(9)}  (${pct(filterCounts.postGeq50pctPre)})\n`);

console.log(`== Combined progressive filters ==\n`);
console.log(`  loose  (pre≥5,  hidden≥10, dep≥0):                    ${filterCounts.passAll_loose.toLocaleString().padStart(9)}  (${pct(filterCounts.passAll_loose)})`);
console.log(`  medium (pre≥10, hidden≥15, dep≥0, post≥30% pre):       ${filterCounts.passAll_medium.toLocaleString().padStart(9)}  (${pct(filterCounts.passAll_medium)})`);
console.log(`  strict (pre≥15, hidden≥20, dep≥0, post≥50% pre):       ${filterCounts.passAll_strict.toLocaleString().padStart(9)}  (${pct(filterCounts.passAll_strict)})`);

console.log(`\n== Hidden-volume histogram (non-stale events only) ==`);
for (let i = 0; i < hiddenBins.length; i++) {
  const lo = hiddenBins[i];
  const hi = i+1 < hiddenBins.length ? hiddenBins[i+1] : Infinity;
  const label = hi === Infinity ? `≥${lo}` : `${lo}–${hi-1}`;
  const count = hiddenHistogram[i];
  console.log(`  ${label.padStart(8)}:  ${count.toLocaleString().padStart(9)}  (${pct(count)})`);
}

xdb.close();
