// Unit tests for the 2026-07-15 tape audit rebuild — pure-function coverage for the pieces the
// live smoke can't isolate: multi-level OFI, λ-regression significance, direction conventions,
// ToD bucketing, calibration tiers/floors, and the family confluence scorer.
//
//   pnpm --filter @trading/aggregator exec tsx scripts/tape_unit_tests.ts
//
// Self-asserting (node:assert), zero deps, no live data. Writes a synthetic calibration file to
// the OS tmpdir and points TAPE_CAL_PATH at it BEFORE importing the modules (env is read at load).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── synthetic calibration file (must exist before calibration.ts loads) ──────
const calPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tape-cal-')), 'tape-calibration.json');
fs.writeFileSync(calPath, JSON.stringify({
  NQ: {
    flow_delta: { n: 1000, p20: 50, p50: 100, p80: 200, p95: 400, p99: 800 },
    level_depth: { n: 1000, p20: 1, p50: 3, p80: 8, p95: 20, p99: 50 },
    thin_metric: { n: 10, p20: 1, p50: 2, p80: 3, p95: 4, p99: 5 },   // n<100 → ignored
    tod: { open: { flow_delta: { n: 500, p20: 100, p50: 200, p80: 400, p95: 800, p99: 1600 } } },
  },
}, null, 2));
process.env.TAPE_CAL_PATH = calPath;
// scorer tests exercise scoreZone synchronously; the confirmation path is tested directly via
// resolvePendingStars (flags are read once at module load)
process.env.TAPE_FEAT_CONF_CONFIRM = '0';

const { ofiStep, ofiStepDeep, regress } = await import('../src/l3/divergence.js');
const { expectedDir } = await import('../src/tape/direction.js');
const { todBucket, tierMult, calFloor, calGet } = await import('../src/tape/calibration.js');
const { newConfState, recordSignal, scoreZone, resolvePendingStars } = await import('../src/tape/confluence.js');
const { newIntensity, arrive, rateAt, burstRatio } = await import('../src/tape/intensity.js');

let n = 0;
const ok = (name: string, fn: () => void): void => { fn(); n++; console.log(`  ✓ ${name}`); };

// ── multi-level OFI ───────────────────────────────────────────────────────────
console.log('ofiStepDeep');
ok('K=1 equals classic L1 ofiStep', () => {
  const prev = { bidPx: 100.0, bidSz: 10, askPx: 100.25, askSz: 8 };
  const cur = { bidPx: 100.25, bidSz: 6, askPx: 100.5, askSz: 12 };
  const deep = ofiStepDeep(
    [{ px: prev.bidPx, sz: prev.bidSz }], [{ px: prev.askPx, sz: prev.askSz }],
    [{ px: cur.bidPx, sz: cur.bidSz }], [{ px: cur.askPx, sz: cur.askSz }], 1);
  assert.equal(deep, ofiStep(prev, cur));
});
ok('deep add behind an unchanged touch is captured', () => {
  const bidsPrev = [{ px: 100, sz: 10 }, { px: 99.75, sz: 5 }, { px: 99.5, sz: 5 }];
  const bidsCur = [{ px: 100, sz: 10 }, { px: 99.75, sz: 5 }, { px: 99.5, sz: 45 }];   // +40 at level 3
  const asks = [{ px: 100.25, sz: 8 }, { px: 100.5, sz: 6 }, { px: 100.75, sz: 7 }];
  assert.equal(ofiStepDeep(bidsPrev, asks, bidsCur, asks, 3), 40);
  assert.equal(ofiStepDeep(bidsPrev, asks, bidsCur, asks, 1), 0);   // L1-only misses it
});
ok('vanished/appeared levels signed correctly', () => {
  const asksPrev = [{ px: 100.25, sz: 8 }];
  const asksCur = [{ px: 100.25, sz: 8 }, { px: 100.5, sz: 20 }];   // ask liquidity ADDED = sell pressure
  const bids = [{ px: 100, sz: 10 }];
  assert.equal(ofiStepDeep(bids, asksPrev, bids, asksCur, 2), -20);
});

// ── λ regression significance surface ─────────────────────────────────────────
console.log('regress');
ok('clean linear relation → λ, tiny SE, R²≈1', () => {
  const x = [1, 2, 3, 4, 5, 6, 7, 8], y = x.map((v) => 2 * v);
  const r = regress(x, y)!;
  assert.ok(Math.abs(r.lambda - 2) < 1e-9 && r.se < 1e-6 && r.r2 > 0.999);
});
ok('no x-variation → null (undefined impact)', () => {
  assert.equal(regress([3, 3, 3, 3], [1, 2, 3, 4]), null);
});
ok('noisy flat relation → λ≈0 with LARGE SE (the sig-gate rationale)', () => {
  const x = [10, -8, 12, -11, 9, -10, 11, -9];
  const y = [0.5, 0.4, -0.6, 0.5, -0.4, -0.5, 0.6, 0.4];   // no real relation
  const r = regress(x, y)!;
  assert.ok(Math.abs(r.lambda) < 0.05 && r.se > Math.abs(r.lambda));   // CI spans zero
});

// ── direction conventions ─────────────────────────────────────────────────────
console.log('expectedDir');
ok('continuation kinds follow side', () => {
  assert.equal(expectedDir({ kind: 'sweep', side: 'buy' }), 1);
  assert.equal(expectedDir({ kind: 'block', side: 'sell' }), -1);
  assert.equal(expectedDir({ kind: 'stacked', side: 'buy' }), 1);
});
ok('iceberg: defender while held/active, FLIPPED on broke', () => {
  assert.equal(expectedDir({ kind: 'iceberg', side: 'buy', state: 'active' }), 1);
  assert.equal(expectedDir({ kind: 'iceberg', side: 'buy', state: 'held' }), 1);
  assert.equal(expectedDir({ kind: 'iceberg', side: 'buy', state: 'broke' }), -1);   // the audit bug
  assert.equal(expectedDir({ kind: 'iceberg', side: 'sell', state: 'broke' }), 1);
});
ok('spoof flips; wall side is final at emit; trapped follows puke side', () => {
  assert.equal(expectedDir({ kind: 'spoof', side: 'buy' }), -1);
  assert.equal(expectedDir({ kind: 'wall', side: 'sell', state: 'break' }), -1);
  assert.equal(expectedDir({ kind: 'wall', side: 'buy', state: 'hold' }), 1);
  assert.equal(expectedDir({ kind: 'trapped', side: 'sell' }), -1);
});
ok('stoprun: accepted follows the cascade, RECLAIMED flips (spring)', () => {
  assert.equal(expectedDir({ kind: 'stoprun', side: 'buy', state: 'accepted' }), 1);
  assert.equal(expectedDir({ kind: 'stoprun', side: 'buy', state: 'reclaimed' }), -1);
  assert.equal(expectedDir({ kind: 'stoprun', side: 'sell', state: 'reclaimed' }), 1);
});

// ── ToD buckets (EDT session) ─────────────────────────────────────────────────
console.log('todBucket');
ok('09:35 ET open · 13:00 ET mid · 15:30 ET late · 03:14 ET OVERNIGHT', () => {
  assert.equal(todBucket(Date.parse('2026-07-15T13:35:00Z')), 'open');
  assert.equal(todBucket(Date.parse('2026-07-15T17:00:00Z')), 'mid');
  assert.equal(todBucket(Date.parse('2026-07-15T19:30:00Z')), 'late');
  assert.equal(todBucket(Date.parse('2026-07-15T07:14:00Z')), 'overnight');  // the 03:14 star's hour
  assert.equal(todBucket(Date.parse('2026-07-15T21:30:00Z')), 'overnight');  // post-close
});

// ── calibration tiers + floors ────────────────────────────────────────────────
console.log('calibration');
const MID = Date.parse('2026-07-15T17:00:00Z');
const OPEN = Date.parse('2026-07-15T13:40:00Z');
ok('tierMult maps the percentile bands', () => {
  assert.equal(tierMult('NQ', 'flow_delta', 30, MID), 0.4);    // < p20
  assert.equal(tierMult('NQ', 'flow_delta', 70, MID), 0.7);    // < p50
  assert.equal(tierMult('NQ', 'flow_delta', 150, MID), 1.0);   // < p80
  assert.equal(tierMult('NQ', 'flow_delta', 250, MID), 1.5);   // < p95
  assert.equal(tierMult('NQ', 'flow_delta', 500, MID), 2.5);   // ≥ p95
});
ok('ToD bucket overrides whole-RTH when present + populated', () => {
  assert.equal(tierMult('NQ', 'flow_delta', 150, OPEN), 0.7);  // open p50=200 → 150 is "small" at the open
});
ok('graceful fallbacks: unknown metric/symbol/thin sample → ×1, legacy floor', () => {
  assert.equal(tierMult('NQ', 'nope_metric', 500, MID), 1);
  assert.equal(tierMult('ES', 'flow_delta', 500, MID), 1);
  assert.equal(tierMult('NQ', 'thin_metric', 500, MID), 1);
  assert.equal(calFloor('NQ', 'flow_delta', 'p80', 80, MID), 200);
  assert.equal(calFloor('ES', 'flow_delta', 'p80', 80, MID), 80);
  assert.ok(calGet('NQ', 'level_depth', MID)!.p50 === 3);
});

// ── Hawkes arrival intensity (stop-run burst gate) ────────────────────────────
console.log('intensity (Hawkes)');
ok('steady arrivals → burst ratio stays in the calm band (≈1.5–2 at-arrival, ≪ gate 4)', () => {
  const f = newIntensity(), s = newIntensity();
  let t = 1_000_000;
  for (let i = 0; i < 200; i++) { t += 1000; arrive(f, t, 800); arrive(s, t, 60_000); }   // 1 arrival/s
  const r = burstRatio(f, s, t, 800, 60_000, 30)!;
  assert.ok(r > 0.6 && r < 2.5, `steady ratio ${r}`);
});
ok('cascade (30ms spacing after 1/s baseline) → burst ratio ≫ threshold', () => {
  const f = newIntensity(), s = newIntensity();
  let t = 1_000_000;
  for (let i = 0; i < 100; i++) { t += 1000; arrive(f, t, 800); arrive(s, t, 60_000); }   // baseline
  for (let i = 0; i < 10; i++) { t += 30; arrive(f, t, 800); arrive(s, t, 60_000); }      // the cascade
  const r = burstRatio(f, s, t, 800, 60_000, 30)!;
  assert.ok(r > 4, `cascade ratio ${r} should exceed the gate (4)`);
});
ok('immature baseline → null (the gate must not bind blind)', () => {
  const f = newIntensity(), s = newIntensity();
  let t = 1_000_000;
  for (let i = 0; i < 5; i++) { t += 50; arrive(f, t, 800); arrive(s, t, 60_000); }
  assert.equal(burstRatio(f, s, t, 800, 60_000, 30), null);
});
ok('intensity decays between arrivals', () => {
  const f = newIntensity();
  arrive(f, 1000, 800);
  const atArrival = rateAt(f, 1000, 800);
  const later = rateAt(f, 3000, 800);   // 2.5 taus later
  assert.ok(later < atArrival * 0.1 && later > 0);
});

// ── confluence V2 — the decision-grade scorer ─────────────────────────────────
console.log('confluence V2');
const TICK = 0.25;
// far from any real daily level (levels files sit near live prices) — struct gate stays out of
// the way except where a test targets it
const FAR = 4_000_000;
const env0 = (over: Partial<{ flowDelta: number; imbNet: number; curPi: number }> = {}) =>
  ({ flowDelta: 0, imbNet: 0, curPi: 0, ...over });

ok('three same-family signals = ONE family → no star (the triple-count fix)', () => {
  const st = newConfState();
  const ts = MID, pi = FAR;
  recordSignal(st, 'NQ', ts, pi, 1, 'iceberg', 50, 'active');
  recordSignal(st, 'NQ', ts, pi, 1, 'absorption', 200);
  recordSignal(st, 'NQ', ts, pi + 2, 1, 'wall', 300, 'hold');
  assert.equal(scoreZone(st, 'NQ', ts, pi, env0(), TICK), null);
});
ok('THE 03:14 REGRESSION: broke-iceberg + block + flow = one buy burst → NO star', () => {
  const st = newConfState();
  const ts = MID, pi = FAR;
  // engine feeds the FLIPPED direction for a broke sell-iceberg (+1); V2 homes it in AGGRESSION
  recordSignal(st, 'NQ', ts, pi, 1, 'iceberg', 17, 'broke');
  recordSignal(st, 'NQ', ts + 1000, pi + 1, 1, 'block', 49);
  // broke-ice and block dedup into AGGRESSION; + FLOW = 2 families, zero PASSIVE → abstain
  assert.equal(scoreZone(st, 'NQ', ts + 1000, pi, env0({ flowDelta: 300 }), TICK), null);
});
ok('pure taker alignment (3 ACTIVE families) → no star; adding PASSIVE book → star', () => {
  const st = newConfState();
  const ts = MID, pi = FAR;
  recordSignal(st, 'NQ', ts, pi, 1, 'sweep', 40);
  recordSignal(st, 'NQ', ts, pi - 2, 1, 'trapped', 60);
  // AGGRESSION + EXHAUSTION + FLOW = 3 families but ALL active → abstain
  assert.equal(scoreZone(st, 'NQ', ts, pi, env0({ flowDelta: 300 }), TICK), null);
  // near-touch book stacked the same way (PASSIVE) → action area
  const ev = scoreZone(st, 'NQ', ts + 1, pi, env0({ flowDelta: 300, imbNet: 500 }), TICK)!;
  assert.ok(ev && ev.side === 'buy' && ev.families!.includes('BOOK'));
});
ok('held iceberg (PASSIVE) + takers → star with families + passive ANCHOR price', () => {
  const st = newConfState();
  const ts = MID, pi = FAR;
  recordSignal(st, 'NQ', ts, pi - 5, 1, 'iceberg', 50, 'active');   // the defended level
  recordSignal(st, 'NQ', ts, pi + 1, 1, 'sweep', 40);
  recordSignal(st, 'NQ', ts, pi - 2, 1, 'trapped', 60);
  const ev = scoreZone(st, 'NQ', ts, pi, env0(), TICK)!;
  assert.ok(ev && ev.side === 'buy' && ev.levels === 3);
  assert.deepEqual([...ev.families!].sort(), ['AGGRESSION', 'DEFENSE', 'EXHAUSTION']);
  assert.equal(ev.price, (pi - 5) * TICK);   // star prints at the level you can lean against
});
ok('calibrated FLOW floor still respected (150 < p80 200 → FLOW mute)', () => {
  const st = newConfState();
  const ts = MID, pi = FAR;
  recordSignal(st, 'NQ', ts, pi, 1, 'iceberg', 50, 'active');
  assert.equal(scoreZone(st, 'NQ', ts, pi, env0({ flowDelta: 150, imbNet: 500 }), TICK), null);  // 2 families
  const ev = scoreZone(st, 'NQ', ts + 1, pi, env0({ flowDelta: 300, imbNet: 500 }), TICK)!;
  assert.ok(ev && ev.families!.includes('FLOW') && ev.families!.includes('BOOK'));
});
ok('CONTESTED zone → abstain (opposition ratio gate)', () => {
  const st = newConfState();
  const ts = MID, pi = FAR;
  recordSignal(st, 'NQ', ts, pi, 1, 'iceberg', 50, 'active');    // bull DEFENSE 2.0
  recordSignal(st, 'NQ', ts, pi, 1, 'sweep', 40);                // bull AGGRESSION 1.5
  recordSignal(st, 'NQ', ts, pi, 1, 'imb', 0);                   // (via env below)
  recordSignal(st, 'NQ', ts, pi, -1, 'trapped', 60);             // bear EXHAUSTION 1.5
  recordSignal(st, 'NQ', ts, pi, -1, 'unfinished', 60);          // not a scoring kind — ignored
  // bull 2+1.5+1(imb) = 4.5 vs bear 1.5 → ratio 0.33 → fires
  const ev = scoreZone(st, 'NQ', ts, pi, env0({ imbNet: 500 }), TICK)!;
  assert.ok(ev && ev.side === 'buy');
  // add a strong opposing FLOW (bear 1.5×1.5=2.25 → bear 3.75 vs bull 4.5 → ratio 0.83 > 0.5) → abstain
  const st2 = newConfState();
  recordSignal(st2, 'NQ', ts, pi, 1, 'iceberg', 50, 'active');
  recordSignal(st2, 'NQ', ts, pi, 1, 'sweep', 40);
  recordSignal(st2, 'NQ', ts, pi, -1, 'trapped', 60);
  assert.equal(scoreZone(st2, 'NQ', ts, pi, env0({ flowDelta: -300, imbNet: 500 }), TICK), null);
});
ok('confirmation: still-valid area emits with durMs; price-drifted area dies silently', () => {
  const ts = MID, pi = FAR;
  const mk = () => {
    const st = newConfState();
    recordSignal(st, 'NQ', ts, pi - 5, 1, 'iceberg', 50, 'active');
    recordSignal(st, 'NQ', ts, pi + 1, 1, 'sweep', 40);
    recordSignal(st, 'NQ', ts, pi - 2, 1, 'trapped', 60);
    st.pending.push({ t0: ts, pi, dir: 1, anchorPi: pi - 5 });
    return st;
  };
  const good = resolvePendingStars(mk(), 'NQ', ts + 3500, env0({ curPi: pi - 3 }), TICK);
  assert.ok(good.length === 1 && good[0]!.durMs! >= 3500);
  const drifted = resolvePendingStars(mk(), 'NQ', ts + 3500, env0({ curPi: pi - 60 }), TICK);   // price left
  assert.equal(drifted.length, 0);
  const faded = mk(); faded.win.length = 0;   // evidence evaporated during the wait
  assert.equal(resolvePendingStars(faded, 'NQ', ts + 3500, env0({ curPi: pi }), TICK).length, 0);
});
ok('distance throttle suppresses a same-zone same-direction refire', () => {
  const st = newConfState();
  const ts = MID, pi = FAR;
  const seed = (at: number, t: number) => {
    recordSignal(st, 'NQ', t, at - 1, 1, 'iceberg', 50, 'active');
    recordSignal(st, 'NQ', t, at + 1, 1, 'sweep', 40);
    recordSignal(st, 'NQ', t, at - 2, 1, 'trapped', 60);
  };
  seed(pi, ts);
  assert.ok(scoreZone(st, 'NQ', ts, pi, env0(), TICK));
  assert.equal(scoreZone(st, 'NQ', ts + 5000, pi + 3, env0(), TICK), null);  // 3 ticks away, 5s later
  seed(pi + 40, ts + 5000);
  assert.ok(scoreZone(st, 'NQ', ts + 5000, pi + 40, env0(), TICK) !== null); // far zone → allowed
});
ok('RECLAIMED stop run votes EXHAUSTION toward the reversal — the post-cascade-low star', () => {
  const st = newConfState();
  const ts = MID, pi = FAR;
  // sell cascade failed at the low: engine feeds FLIPPED dir (+1) with state 'reclaimed';
  // an iceberg defends the same zone (PASSIVE) and buy flow returns (ACTIVE)
  recordSignal(st, 'NQ', ts, pi, 1, 'stoprun', 69, 'reclaimed');        // magnitude = trapped cohort
  recordSignal(st, 'NQ', ts, pi - 2, 1, 'iceberg', 51, 'active');
  const ev = scoreZone(st, 'NQ', ts, pi, env0({ flowDelta: 300 }), TICK)!;
  assert.ok(ev && ev.side === 'buy');
  assert.deepEqual([...ev.families!].sort(), ['DEFENSE', 'EXHAUSTION', 'FLOW']);
  assert.equal(ev.price, (pi - 2) * TICK);   // anchored at the defending iceberg
});
ok('ACTIVE (unresolved) stop run never scores — even if recorded directly', () => {
  const st = newConfState();
  const ts = MID, pi = FAR;
  recordSignal(st, 'NQ', ts, pi, 1, 'stoprun', 69, 'active');   // excluded state → no family
  recordSignal(st, 'NQ', ts, pi - 2, 1, 'iceberg', 51, 'active');
  // DEFENSE + FLOW = 2 families only → no star (the open coin contributed nothing)
  assert.equal(scoreZone(st, 'NQ', ts, pi, env0({ flowDelta: 300 }), TICK), null);
});
ok('FLIP semantics: an opposite star in the zone EMITS tagged flip — fresh evidence supersedes', () => {
  const st = newConfState();
  const ts = MID, pi = FAR;
  const seed = (d: 1 | -1, at: number, t: number) => {
    recordSignal(st, 'NQ', t, at - 1, d, 'iceberg', 50, 'active');
    recordSignal(st, 'NQ', t, at + 1, d, 'sweep', 40);
    recordSignal(st, 'NQ', t, at - 2, d, 'trapped', 60);
  };
  seed(1, pi, ts);
  const first = scoreZone(st, 'NQ', ts, pi, env0(), TICK)!;
  assert.ok(first && !first.flip);                                            // unopposed buy star
  seed(-1, pi + 2, ts + 60_000);                                              // 60s later: the zone flips bearish
  const flip = scoreZone(st, 'NQ', ts + 60_000, pi + 2, env0(), TICK)!;
  assert.ok(flip && flip.side === 'sell' && flip.flip === true);              // EMITS, tagged (never suppressed)
  seed(1, pi + 2, ts + 300_000);                                              // 5min later: window passed
  const later = scoreZone(st, 'NQ', ts + 300_000, pi + 2, env0(), TICK)!;
  assert.ok(later && !later.flip);                                            // unopposed again
});
ok('time decay ages contributions out of relevance (60s memory, 12.5s tau)', () => {
  const st = newConfState();
  const ts = MID, pi = FAR;
  recordSignal(st, 'NQ', ts, pi - 1, 1, 'iceberg', 50, 'active');
  recordSignal(st, 'NQ', ts, pi, 1, 'sweep', 40);
  recordSignal(st, 'NQ', ts, pi, 1, 'trapped', 60);
  // 40s later (inside the 60s memory, ~3.2 taus): 5.0 × e^(−40/12.5) ≈ 0.2 < minScore 3 → no star
  assert.equal(scoreZone(st, 'NQ', ts + 40_000, pi, env0(), TICK), null);
});

console.log(`\nALL ${n} TESTS PASSED`);
