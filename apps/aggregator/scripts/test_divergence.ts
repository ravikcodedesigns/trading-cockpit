// Unit tests for divergence.ts — proves the microstructure math on synthetic data BEFORE any
// live/historical data. Run: pnpm --filter @trading/aggregator exec tsx scripts/test_divergence.ts
import {
  ofiStep, regress, kyleLambda, mannKendall, theilSen, cusum, classifyEpisode,
  type Quote, type RetestFeatures,
} from '../src/l3/divergence.js';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; console.log(`  ✅ ${msg}`); } else { fail++; console.log(`  ❌ ${msg}`); } };
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

console.log('OFI (Cont-Kukanov-Stoikov):');
// both quotes step UP → strong buy pressure = +bidSz(new) + askSz(old)
ok(ofiStep({ bidPx: 5000, bidSz: 10, askPx: 5000.25, askSz: 8 }, { bidPx: 5000.25, bidSz: 6, askPx: 5000.5, askSz: 8 }) === 6 + 8, 'both up → +14');
// both DOWN → sell pressure = -bidSz(old) - askSz(new)
ok(ofiStep({ bidPx: 5000, bidSz: 10, askPx: 5000.25, askSz: 8 }, { bidPx: 4999.75, bidSz: 5, askPx: 5000, askSz: 12 }) === -10 - 12, 'both down → -22');
// prices flat, sizes change → +(Δbid) - (Δask)
ok(ofiStep({ bidPx: 5000, bidSz: 10, askPx: 5000.25, askSz: 8 }, { bidPx: 5000, bidSz: 15, askPx: 5000.25, askSz: 6 }) === 5 + 2, 'flat px, size shift → +7');

console.log('Kyle λ (regression recovers the true coefficient):');
{
  const x = Array.from({ length: 20 }, (_, i) => i + 1);
  const y = x.map(v => 2 * v + 3);            // Δmid = 2·OFI + 3
  const r = regress(x, y)!;
  ok(near(r.lambda, 2), `λ recovered = ${r.lambda.toFixed(4)} (true 2)`);
  ok(near(r.r2, 1), `R² = ${r.r2.toFixed(4)} (perfect fit)`);
  ok(regress([1, 2], [1, 2]) === null, 'n<3 → null');
  // through quotes end-to-end
  const q: Quote[] = [{ bidPx: 100, bidSz: 5, askPx: 100.25, askSz: 5 }];
  for (let i = 0; i < 8; i++) q.push({ bidPx: 100 + i * 0.25, bidSz: 5 + i, askPx: 100.25 + i * 0.25, askSz: 5 });
  ok(kyleLambda(q) !== null, 'kyleLambda on a quote stream returns an estimate');
}

console.log('Mann-Kendall trend (non-parametric):');
ok(mannKendall([1, 2, 3, 4, 5, 6, 7, 8]).dir === 1 && mannKendall([1, 2, 3, 4, 5, 6, 7, 8]).z > 1.64, 'monotone up → dir +1, z>1.64');
ok(mannKendall([8, 7, 6, 5, 4, 3, 2, 1]).dir === -1 && mannKendall([8, 7, 6, 5, 4, 3, 2, 1]).z < -1.64, 'monotone down → dir -1, z<-1.64');
ok(Math.abs(mannKendall([5, 5, 5, 5, 5]).z) < 1e-9, 'flat → z≈0');

console.log('Theil-Sen robust slope:');
ok(near(theilSen([3, 5, 7, 9, 11]), 2), 'slope = 2');
ok(near(theilSen([3, 5, 7, 9, 100]), 2), 'slope = 2 even with an outlier (robust)');   // OLS would be skewed

console.log('CUSUM change-point:');
ok(cusum([0.2, -0.3, 0.1, 0.2, -0.1, 2, 2.5, 2, 3, 2.5], 0, 1).fired === true, 'detects an upward level shift');
ok(cusum([0.2, -0.3, 0.1, 0.2, -0.1, 0.0, 0.1], 0, 1).fired === false, 'no shift → no fire');
ok(cusum([0.1, -0.1, 0.2, -0.2, -2, -2.5, -2, -3], 0, 1).dir === -1, 'downward shift → dir -1');

console.log('classifyEpisode (the state classifier):');
{
  // DISTRIBUTION: resistance, buyers aggressing, no higher highs, λ collapsing, wall depleting
  const dist: RetestFeatures[] = [
    { lambda: 1.0, ofiNet: 200, priceExtreme: 29770, wall: 50, absorbedVol: 300 },
    { lambda: 0.5, ofiNet: 250, priceExtreme: 29769, wall: 40, absorbedVol: 350 },
    { lambda: 0.3, ofiNet: 300, priceExtreme: 29768, wall: 25, absorbedVol: 400 },
    { lambda: 0.15, ofiNet: 280, priceExtreme: 29768, wall: 15, absorbedVol: 380 },
  ];
  const dv = classifyEpisode(dist, { side: 'resistance', baselineLambda: 1.0 });
  ok(dv.state === 'DISTRIBUTION', `distribution scenario → ${dv.state} (conf ${dv.confidence.toFixed(2)})`);

  // ACCUMULATION: support, sellers aggressing, no lower lows, λ collapsing
  const acc: RetestFeatures[] = [
    { lambda: 1.0, ofiNet: -200, priceExtreme: 29400, wall: 40, absorbedVol: 300 },
    { lambda: 0.5, ofiNet: -250, priceExtreme: 29401, wall: 45, absorbedVol: 350 },
    { lambda: 0.3, ofiNet: -300, priceExtreme: 29402, wall: 50, absorbedVol: 400 },
    { lambda: 0.15, ofiNet: -280, priceExtreme: 29402, wall: 55, absorbedVol: 380 },
  ];
  ok(classifyEpisode(acc, { side: 'support', baselineLambda: 1.0 }).state === 'ACCUMULATION', 'accumulation scenario → ACCUMULATION');

  // BREAKING: higher highs, λ healthy (price responds to flow)
  const brk: RetestFeatures[] = [
    { lambda: 1.0, ofiNet: 200, priceExtreme: 29770, wall: 50, absorbedVol: 200 },
    { lambda: 1.1, ofiNet: 200, priceExtreme: 29790, wall: 50, absorbedVol: 200 },
    { lambda: 0.9, ofiNet: 200, priceExtreme: 29810, wall: 50, absorbedVol: 200 },
    { lambda: 1.0, ofiNet: 200, priceExtreme: 29830, wall: 50, absorbedVol: 200 },
  ];
  ok(classifyEpisode(brk, { side: 'resistance', baselineLambda: 1.0 }).state === 'BREAKING', 'breakout scenario → BREAKING');

  // HOLDING: λ healthy, flat extreme (defended, normal impact)
  const hold: RetestFeatures[] = [
    { lambda: 1.0, ofiNet: 50, priceExtreme: 29770, wall: 50, absorbedVol: 100 },
    { lambda: 1.0, ofiNet: -50, priceExtreme: 29770, wall: 50, absorbedVol: 100 },
    { lambda: 1.0, ofiNet: 30, priceExtreme: 29770, wall: 50, absorbedVol: 100 },
    { lambda: 1.0, ofiNet: -20, priceExtreme: 29770, wall: 50, absorbedVol: 100 },
  ];
  ok(classifyEpisode(hold, { side: 'resistance', baselineLambda: 1.0 }).state === 'HOLDING', 'defended scenario → HOLDING');

  // NEUTRAL: absorbing λ but no net flow direction → no decisive signature
  const neut: RetestFeatures[] = [
    { lambda: 0.3, ofiNet: 0, priceExtreme: 29770, wall: 50, absorbedVol: 100 },
    { lambda: 0.3, ofiNet: 0, priceExtreme: 29770, wall: 50, absorbedVol: 100 },
    { lambda: 0.3, ofiNet: 0, priceExtreme: 29770, wall: 50, absorbedVol: 100 },
    { lambda: 0.3, ofiNet: 0, priceExtreme: 29770, wall: 50, absorbedVol: 100 },
  ];
  ok(classifyEpisode(neut, { side: 'resistance', baselineLambda: 1.0 }).state === 'NEUTRAL', 'indecisive scenario → NEUTRAL');
  ok(classifyEpisode(dist.slice(0, 2), { side: 'resistance', baselineLambda: 1.0 }).state === 'NEUTRAL', '<3 retests → NEUTRAL');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
