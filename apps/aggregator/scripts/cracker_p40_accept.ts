// CRACKER P4.0 acceptance — book-state.ts (walls, depth-beyond, gaps, tracker).
// Synthetic ground truth first; every geometry read must recover known answers
// (including the coverage-honesty cases) before touching market data.
// Run: pnpm --filter @trading/aggregator exec tsx scripts/cracker_p40_accept.ts
import { wallAt, depthBeyond, maxGapBeyond, ApproachTracker, BS_CFG, type LadderLevel, type BookSnap } from '../src/l3/book-state.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};
const mk = (entries: Array<[number, number]>): LadderLevel[] =>
  entries.map(([priceInt, size]) => ({ priceInt, price: priceInt * 0.25, size, orders: 1 }));

// ── walls ──
const L = 120000;   // level priceInt
const bids = mk([[L - 1, 10], [L - 3, 20], [L - 16, 5], [L - 17, 99], [L + 2, 7]]);
check('T1a wallAt sums within ±k inclusive', wallAt(bids, L, 16) === 10 + 20 + 5 + 7, `${wallAt(bids, L, 16)}`);
check('T1b wallAt excludes beyond k', wallAt(bids, L, 2) === 10 + 7);
check('T1c empty side → 0', wallAt([], L, 16) === 0);

// ── depth beyond (strictly behind the level) ──
const below = mk([[L, 50], [L - 1, 10], [L - 5, 20], [L - 40, 30], [L - 41, 99]]);
{
  const r = depthBeyond(below, L, -1, 40, 200);
  check('T2a depthBeyond: strict exclusion of the level itself, window inclusive', r.size === 10 + 20 + 30 && r.covered, `size ${r.size}`);
}
{
  // truncated ladder: 200 entries, none reaching L−40 → covered=false
  const trunc = mk(Array.from({ length: 200 }, (_, i) => [L - i * 0.0 - i, 1] as [number, number]).map(([p, s]) => [Math.round(p), s] as [number, number])).slice(0, 200);
  const tight = mk(Array.from({ length: 200 }, (_, i) => [L - 1 - Math.floor(i / 10), 1] as [number, number]));  // spans only 20 ticks
  const r = depthBeyond(tight, L, -1, 40, 200);
  check('T2b coverage honesty: truncated ladder → covered=false', !r.covered);
  void trunc;
}
{
  // short ladder (whole book captured) → covered even if window not reached
  const shortBook = mk([[L - 1, 4], [L - 3, 6]]);
  const r = depthBeyond(shortBook, L, -1, 40, 200);
  check('T2c whole-book capture counts as covered', r.covered && r.size === 10);
}

// ── gaps ──
{
  // occupied at d=1,2,10; empties: 3..9 (7), 11..40 (30) → max gap 30
  const side = mk([[L - 1, 5], [L - 2, 5], [L - 10, 5], ...Array.from({ length: 160 }, (_, i) => [L - 41 - i, 1] as [number, number])]);
  const r = maxGapBeyond(side, L, -1, 40, 200);
  check('T3a maxGapBeyond finds the largest empty run', r.gapTicks === 30 && r.covered, `gap ${r.gapTicks}`);
}
{
  const full = mk(Array.from({ length: 40 }, (_, i) => [L - 1 - i, 2] as [number, number]));
  const r = maxGapBeyond(full, L, -1, 40, 200);
  check('T3b fully-populated window → gap 0', r.gapTicks === 0);
}

// ── tracker (zero-lookahead time reads) ──
{
  const tr = new ApproachTracker({ ...BS_CFG, SNAP_MS: 5000, PRE_MS: 60000, RING_CAP: 40 });
  const t0 = 1_000_000_000;
  for (let i = 0; i <= 20; i++) {
    const snap: BookSnap = { ts: t0 + i * 5000, bids: mk([[L - 1, 100 + i]]), asks: mk([[L + 1, 200 + i]]) };
    const took = tr.maybeSample(t0 + i * 5000, snap, [L]);
    if (i === 0) check('T4a first sample taken', took);
  }
  check('T4b cadence self-limit: mid-interval sample refused', !tr.maybeSample(t0 + 20 * 5000 + 100, { ts: 0, bids: [], asks: [] }, [L]));
  const at = tr.wallsAt(L, t0 + 20 * 5000 + 4000);
  check('T4c wallsAt returns newest ≤ ts', at?.bid === 120 && at?.ask === 220);
  const pre = tr.wallsPre(L, t0 + 20 * 5000);         // ts−60s = t0+40s → sample i=8
  check('T4d wallsPre returns the sample from 60s before', pre?.bid === 108, `bid ${pre?.bid}`);
  check('T4e unknown price → null', tr.wallsAt(L + 999, t0 + 100000) === null);
  const snap = tr.snapAt(t0 + 20 * 5000 + 1000);
  check('T4f snapAt returns newest snapshot ≤ ts', snap?.ts === t0 + 20 * 5000);
  // staleness: a read far past the last sample must refuse
  check('T4g stale read (>3×SNAP after last sample) → null', tr.wallsAt(L, t0 + 20 * 5000 + 16_000) === null);
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ' — FAILURES ABOVE' : ''}`);
process.exit(fail ? 1 : 0);
