// Smoke test: run the heatmap engine against the live log for ~4s, print a sample column.
import { startHeatmapEngine, stopHeatmapEngine } from '../src/heatmap/heatmap-engine.js';
import type { Symbol as Sym, HeatmapColumn } from '@trading/contracts';

let nqCount = 0, esCount = 0;
startHeatmapEngine((sym: Sym, col: HeatmapColumn) => {
  if (sym === 'NQ') {
    nqCount++;
    if (nqCount === 25) {   // ~2.5s in, book should be seeded near touch
      console.log(`NQ column @ t=${col.t} anchor_int=${col.a} price=${(col.a * 0.25).toFixed(2)} levels=${col.s.length / 2} trades=${col.x.length / 2}`);
      const sample: string[] = [];
      for (let i = 0; i < Math.min(col.s.length, 24); i += 2) sample.push(`${col.s[i]! >= 0 ? '+' : ''}${col.s[i]}:${col.s[i + 1]}`);
      console.log('  near-touch [offTicks:size]:', sample.join(' '));
      if (col.x.length) console.log('  trades [off:signedSize]:', col.x.join(' '));
    }
  } else esCount++;
});

setTimeout(() => {
  console.log(`\nColumns emitted in ~4s: NQ=${nqCount} ES=${esCount} (≈40 each expected at 100ms)`);
  stopHeatmapEngine();
  process.exit(0);
}, 4000);
