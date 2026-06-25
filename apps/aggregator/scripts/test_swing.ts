// Unit tests for swing-levels.ts — proves causal swing confirmation, dedupe, and no-swing-on-trend.
// Run: pnpm --filter @trading/aggregator exec tsx scripts/test_swing.ts
import { SwingDetector, type Swing } from '../src/l3/swing-levels.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };
const feed = (sd: SwingDetector, series: number[], delta = 20): Swing[] => {
  const out: Swing[] = []; let t = 0;
  for (const p of series) { const s = sd.update(p, t++, delta); if (s) out.push(s); }
  return out;
};

console.log('swing confirmation (zigzag, δ=20):');
{
  const got = feed(new SwingDetector(), [100, 120, 150, 130, 110, 130, 170, 150]);
  ok(got.length === 3, `confirmed 3 swings (got ${got.length})`);
  ok(got[0]?.kind === 'high' && got[0]?.price === 150, 'swing 1 = HIGH @150');
  ok(got[1]?.kind === 'low' && got[1]?.price === 110, 'swing 2 = LOW @110');
  ok(got[2]?.kind === 'high' && got[2]?.price === 170, 'swing 3 = HIGH @170');
}

console.log('causality (extreme NOT confirmed until price reverses by δ):');
{
  const sd = new SwingDetector();
  ok(feed(sd, [100, 120, 150]).length === 0, 'at the peak (150), no swing yet — needs the reversal');
  ok(feed(sd, [140, 130]).length === 1, 'only after price falls to 130 (=150−20) does the HIGH confirm');
}

console.log('dedupe (near-duplicate same-kind zone reuses the level):');
{
  const got = feed(new SwingDetector(), [100, 150, 130, 110, 130, 155, 135]);  // high150, low110, high155(|155−150|=5<δ/2)
  const highs = got.filter(s => s.kind === 'high');
  ok(highs.length === 1, `the second high (155, within δ/2 of 150) is deduped — ${highs.length} high(s)`);
}

console.log('no swing on a clean trend (no reversal ≥ δ):');
{
  const sd = new SwingDetector();
  const got = feed(sd, Array.from({ length: 30 }, (_, i) => 100 + i * 5));   // monotone up
  ok(got.length === 0, 'monotone ramp → 0 confirmed swings');
  ok(sd.levels().length === 0, 'no levels emitted');
}

console.log('levels() format:');
{
  const sd = new SwingDetector();
  feed(sd, [100, 150, 130, 110, 130]);
  const lv = sd.levels();
  ok(lv.length === 2 && lv.every(l => l.kind === 'swing'), `2 swing levels emitted (${lv.map(l => l.label).join(', ')})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
