// Multi-scale swings from the LIVE ticks.db (CQG trades) for a given day's RTH.
// Uses trade price as the swing sample (swings are price structure — no book needed).
// Run: pnpm --filter @trading/aggregator exec tsx scripts/dump_swings_ticksdb.ts 2026-07-02 NQ
import Database from 'better-sqlite3';
import { MultiScaleSwingDetector } from '../src/l3/swing-levels-ms.js';
import { diffusionScale } from '../src/l3/divergence.js';

const DAY = process.argv[2] ?? '2026-07-02', SYM = process.argv[3] ?? 'NQ';
const et = (hm: string) => Date.parse(`${DAY}T${hm}:00-04:00`);
const push = <T>(b: T[], x: T, cap: number) => { b.push(x); if (b.length > cap) b.shift(); };
const clock = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false }).slice(-8);

const db = new Database('/Users/ravikumarbasker/trading-cockpit/data/ticks.db', { readonly: true });
const stmt = db.prepare(`SELECT ts, price FROM trades WHERE symbol=? AND ts BETWEEN ? AND ? ORDER BY ts`);
const ms = new MultiScaleSwingDetector();
const mids: number[] = [], midTs: number[] = [];
let lastObs = 0, lastRv = 0, base = 0;
const bases: number[] = [];
const confirmed: { ts: number; price: number; kind: string; scale: number; legSize: number }[] = [];

for (const row of stmt.iterate(SYM, et('09:30'), et('16:00')) as any) {
  const ts = row.ts as number, price = row.price as number;
  if (ts - lastObs < 200) continue; lastObs = ts;
  if (ts - lastRv >= 1000) {
    push(mids, price, 600); push(midTs, ts, 600); lastRv = ts;   // 10-min base window
    if (mids.length >= 60) { const b = diffusionScale(mids, midTs) * Math.sqrt(45); if (b > 0) { base = b; bases.push(b); } }
  }
  if (base > 0) for (const sw of ms.update(price, ts, base)) confirmed.push(sw);
}

const avg = bases.length ? bases.reduce((a, b) => a + b, 0) / bases.length : NaN;
console.log(`\n=== Multi-scale swings — ${SYM} ${DAY} RTH (ticks.db; base vol ${bases.length ? Math.min(...bases).toFixed(1) + '-' + Math.max(...bases).toFixed(1) : 'n/a'}pt, avg ${avg.toFixed(1)}) ===`);
for (let s = 0; s < 3; s++) {
  const label = ['FINE', 'MEDIUM', 'COARSE'][s]!;
  const sws = confirmed.filter(c => c.scale === s && c.legSize > 5);   // drop warmup tiny-leg artifact
  console.log(`\n${label} — ${sws.length} swings:`);
  for (const c of sws) console.log(`  ${clock(c.ts)} ET  ${c.kind.toUpperCase().padEnd(4)} ${c.price.toFixed(2)}  (leg ${c.legSize.toFixed(0)}pt)`);
}
console.log('\nSWINGS_JSON=' + JSON.stringify(confirmed.filter(c => c.legSize > 5).map(c => ({ ts: c.ts, price: +c.price.toFixed(2), kind: c.kind, scale: c.scale, leg: Math.round(c.legSize) }))));
process.exit(0);
