// Integration test for episode-tracker.ts — drives the REAL OrderBook through a synthetic
// distribution episode and asserts the whole chain (state machine → book features → divergence →
// setup) fires DISTRIBUTION-short. Proves the plumbing the pure unit tests can't.
// Run: pnpm --filter @trading/aggregator exec tsx scripts/test_episode_tracker.ts
import { OrderBook } from '../src/l3/order-book.js';
import { EpisodeTracker, type EpisodeSetup } from '../src/l3/episode-tracker.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const TICK = 0.25;
const book = new OrderBook('NQ', TICK);
// Fixed 8pt band (BAND_K:0 → band = MIN_BAND_TICKS·tick) so this test exercises the STATE MACHINE +
// classification deterministically. The diffusion band estimator (σ·√τ) is unit-tested separately.
const tracker = new EpisodeTracker({ BAND_K: 0, MIN_BAND_TICKS: 32 });
const L = 10000, levels = [{ price: L, label: 'TEST-RES', kind: 'structural' }];
const Lint = book.intFromPrice(L);            // 40000

let ts = 1_000_000;
let curBidI: number | null = null, curAskI: number | null = null;
function quoteI(bidI: number, bidSz: number, askI: number, askSz: number): EpisodeSetup[] {
  ts += 100; book.lastTs = ts;
  if (curBidI !== null && curBidI !== bidI) book.applyDepth({ is_bid: true, size: 0, price_int: curBidI });
  if (curAskI !== null && curAskI !== askI) book.applyDepth({ is_bid: false, size: 0, price_int: curAskI });
  book.applyDepth({ is_bid: true, size: bidSz, price_int: bidI });
  book.applyDepth({ is_bid: false, size: askSz, price_int: askI });
  curBidI = bidI; curAskI = askI;
  return tracker.observe('NQ', book, levels, ts);
}

// DISTRIBUTION at the 10000 resistance: each retest rises into it with net BUYING (OFI>0), price
// fails to make higher highs (caps at 10000), and λ COLLAPSES across retests (later tests = much
// more buy size for the same 1-tick move = price-impact absorbed). Exit the band in one big drop so
// the dwell's OFI stays buy-dominated (the passive seller absorbs; no aggressive sell leg sampled).
const setups: EpisodeSetup[] = [];
const QbySize = [3, 9, 19, 39, 39];           // bid size grows each retest → λ = 0.25/(Q+1) collapses
const bottomI = book.intFromPrice(9985);      // drop target (out of band; 15pt swing > 8pt band)
for (let r = 0; r < QbySize.length; r++) {
  const Q = QbySize[r]!;
  for (let bI = bottomI; bI <= Lint; bI++) setups.push(...quoteI(bI, Q, bI + 1, 1));   // rise to the cap, buying
  setups.push(...quoteI(bottomI, 5, bottomI + 1, 5));                                  // one big drop out of band
}

const snap = tracker.snapshot('NQ');
const ep = snap.find(s => s.key.startsWith('TEST-RES'));
console.log('episode snapshot:', ep ? { side: ep.side, retests: ep.retests.length, baseLambda: +ep.baseLambda.toFixed(5), verdict: ep.verdict?.state, conf: ep.verdict?.confidence?.toFixed(2) } : 'none');
if (ep) {
  console.log('per-retest λ:', ep.retests.map(r => +r.lambda.toFixed(5)));
  console.log('per-retest ofiNet:', ep.retests.map(r => r.ofiNet));
  console.log('per-retest extreme:', ep.retests.map(r => +r.priceExtreme.toFixed(2)));
}

ok(!!ep, 'an episode was tracked at the 10000 resistance');
ok(!!ep && ep.side === 'resistance', 'classified the level as resistance (tested from below)');
ok(!!ep && ep.retests.length >= 3, `accumulated ≥3 retests (got ${ep?.retests.length})`);
ok(!!ep && ep.retests.every(r => r.ofiNet > 0), 'every retest was net-buying (OFI>0)');
ok(!!ep && ep.retests.every(r => Number.isFinite(r.lambda)), 'every retest produced a finite λ');
ok(!!ep && ep.verdict?.state === 'DISTRIBUTION', `episode classifies as DISTRIBUTION (got ${ep?.verdict?.state})`);

const dist = setups.find(s => s.state === 'DISTRIBUTION');
ok(!!dist, 'a DISTRIBUTION setup was EMITTED during the episode');
ok(!!dist && dist.direction === 'short', `the setup direction is short (got ${dist?.direction})`);
if (dist) console.log('emitted setup:', { state: dist.state, dir: dist.direction, conf: dist.confidence, retests: dist.retests, note: dist.note });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
