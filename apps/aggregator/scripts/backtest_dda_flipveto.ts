// Test the DDA absorption signal as a FLIP VETO filter (like trap→FLIP veto). Hypothesis: a FLIP is
// less reliable when OPPOSITE-direction absorption fired recently near its level (flip-long fighting
// active distribution / flip-short fighting accumulation). Run the DDA on each flip's day, tag each
// flip vetoed/kept, compare WR+PnL vs a random-drop NULL. WIN/LOSS only (flip outcomes = sim_pnl_pts).
// Prereq: scripts/_flips.csv (NQ OPEN FLIPs w/ outcomes). Run: pnpm --filter @trading/aggregator exec tsx scripts/backtest_dda_flipveto.ts
import { DuckDBInstance } from '@duckdb/node-api';
import { readFileSync } from 'fs';
import { OrderBook } from '../src/l3/order-book.js';
import { EpisodeTracker, EPISODE_CFG } from '../src/l3/episode-tracker.js';
import { SwingDetector } from '../src/l3/swing-levels.js';
import { diffusionScale } from '../src/l3/divergence.js';

const SYM = 'NQ', TICK = 0.25;
const PROOT = '/Users/ravikumarbasker/trading-cockpit/data/ticks-parquet';
const gp = (t: string, d: string) => `read_parquet('${PROOT}/${t}/symbol=${SYM}/date=${d}/*.parquet')`;
const SANE = 'price BETWEEN 20000 AND 40000';
const THROTTLE = 200, RV_MS = 1000, SWING_MULT = 3, WARM_RV = 30;
const TAU = (EPISODE_CFG as any).TAU_SEC ?? 45;
const WINDOW = 30 * 60_000;                          // a-priori: opposite absorption within prior 30 min
const COVERED = new Set(['2026-05-05', '2026-05-08', '2026-05-11', '2026-05-12', '2026-05-13', '2026-05-14', '2026-05-15',
  '2026-05-19', '2026-05-20', '2026-05-21', '2026-05-22', '2026-05-26', '2026-05-27', '2026-05-28', '2026-05-29',
  '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-08', '2026-06-09', '2026-06-10',
  '2026-06-11', '2026-06-12', '2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-19', '2026-06-22', '2026-06-23']);
const et = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-04:00`);
const dayOf = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const num = (v: any) => v == null ? null : Number(v);

interface Flip { ts: number; dir: number; entry: number; pnl: number; day: string; }
interface Dda { ts: number; bias: number; level: number; }   // bias +1 ACC(long) / -1 DIST(short)

// ── load flips ──
const flips: Flip[] = readFileSync('scripts/_flips.csv', 'utf8').trim().split('\n').slice(1).map(l => {
  const [ts, dir, entry, pnl] = l.split(',');
  return { ts: +ts!, dir: dir === 'long' ? 1 : -1, entry: +entry!, pnl: +pnl!, day: dayOf(+ts!) };
}).filter(f => COVERED.has(f.day));
const flipDays = [...new Set(flips.map(f => f.day))].sort();

const inst = await DuckDBInstance.create();
const con = await inst.connect();
const push = <T>(b: T[], x: T, cap: number) => { b.push(x); if (b.length > cap) b.shift(); };

async function collectDda(day: string): Promise<Dda[]> {
  const [warm, rthLo, rthHi, end] = [et(day, '09:00'), et(day, '09:30'), et(day, '16:00'), et(day, '17:00')];
  const book = new OrderBook(SYM, TICK), tracker = new EpisodeTracker(), swing = new SwingDetector();
  const mids: number[] = [], midTs: number[] = [], out: Dda[] = [];
  let lastObs = 0, lastRv = 0;
  const SQL = `
    SELECT ts,'D' s, price, size, side, CAST(NULL AS BOOLEAN) iba FROM ${gp('depth', day)} WHERE ${SANE} AND ts BETWEEN ${warm} AND ${end}
    UNION ALL SELECT ts,'T', price, size, CAST(NULL AS BIGINT), is_bid_aggressor FROM ${gp('trades', day)} WHERE size>0 AND ${SANE} AND ts BETWEEN ${warm} AND ${end}
    ORDER BY ts`;
  const stream = await con.stream(SQL); let chunk;
  while ((chunk = await stream.fetchChunk()) && chunk.rowCount > 0) {
    for (const row of chunk.getRows() as any[]) {
      const ts = Number(row[0]); book.lastTs = ts;
      if (row[1] === 'D') { const sz = num(row[3]); if (sz != null) book.applyDepth({ is_bid: Number(row[4]) === 0, size: sz, price_int: book.intFromPrice(num(row[2])!) }); }
      else book.applyTrade({ price_int: book.intFromPrice(num(row[2])!), price: num(row[2])!, size: num(row[3])!, is_bid_aggressor: !!row[5] });
      if (ts - lastObs < THROTTLE) continue;
      lastObs = ts;
      const bb = book.bestBid(), ba = book.bestAsk(); if (bb == null || ba == null) continue;
      const mid = (book.priceFromInt(bb) + book.priceFromInt(ba)) / 2;
      if (ts - lastRv >= RV_MS) { push(mids, mid, 120); push(midTs, ts, 120); lastRv = ts; }
      if (mids.length >= WARM_RV) { const band = diffusionScale(mids, midTs) * Math.sqrt(TAU); if (band > 0) swing.update(mid, ts, SWING_MULT * band); }
      for (const s of tracker.observe(SYM, book, swing.levels(), ts)) {
        if (ts < rthLo || ts > rthHi) continue;
        if (s.state === 'DISTRIBUTION') out.push({ ts, bias: -1, level: s.levelPrice });
        else if (s.state === 'ACCUMULATION') out.push({ ts, bias: 1, level: s.levelPrice });
      }
    }
  }
  return out;
}

process.stderr.write(`replaying DDA on ${flipDays.length} flip-days (${flips.length} flips)...\n`);
const ddaByDay = new Map<string, Dda[]>();
for (const day of flipDays) { ddaByDay.set(day, await collectDda(day)); process.stderr.write(`  ${day}: ${ddaByDay.get(day)!.length} DDA signals\n`); }

// ── veto matching ──
function vetoed(f: Flip, prox: number, opposite: boolean): boolean {
  const want = opposite ? -f.dir : f.dir;     // opposite (contradiction) or same (crowding) bias
  return (ddaByDay.get(f.day) ?? []).some(d => d.bias === want && d.ts >= f.ts - WINDOW && d.ts <= f.ts && Math.abs(d.level - f.entry) <= prox);
}
const stat = (fs: Flip[]) => { const w = fs.filter(f => f.pnl > 0).length, l = fs.filter(f => f.pnl < 0).length; return { n: fs.length, w, l, wr: w + l ? w / (w + l) : 0, pnl: Math.round(fs.reduce((a, f) => a + f.pnl, 0)) }; };
const base = stat(flips);
console.log(`\nBASELINE (all ${base.n} flips): ${(base.wr * 100).toFixed(0)}%WR ${base.w}W/${base.l}L  ${base.pnl >= 0 ? '+' : ''}${base.pnl}pt`);

function evalVeto(label: string, prox: number, opposite: boolean) {
  const drop = flips.filter(f => vetoed(f, prox, opposite)), keep = flips.filter(f => !vetoed(f, prox, opposite));
  const d = stat(drop), k = stat(keep);
  // permutation: random drops of size d.n, p = P(random-drop WR <= dropped WR)
  let le = 0, K = 5000; const pn = drop.length;
  const idx = flips.map((_, i) => i);
  for (let r = 0; r < K; r++) {
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(((r * 1103515245 + i * 12345 + 7) % 2147483647) / 2147483647 * (i + 1)); [idx[i], idx[j]] = [idx[j]!, idx[i]!]; }
    const samp = idx.slice(0, pn).map(i => flips[i]!);
    if (stat(samp).wr <= d.wr) le++;
  }
  console.log(`\n${label} (prox ${prox === 9999 ? '∞' : prox + 'pt'}):`);
  console.log(`  VETOED ${d.n}: ${(d.wr * 100).toFixed(0)}%WR ${d.w}W/${d.l}L ${d.pnl >= 0 ? '+' : ''}${d.pnl}pt  (perm p=${(le / K).toFixed(3)} that random drops do this bad)`);
  console.log(`  KEPT   ${k.n}: ${(k.wr * 100).toFixed(0)}%WR ${k.w}W/${k.l}L ${k.pnl >= 0 ? '+' : ''}${k.pnl}pt  (Δ vs baseline ${((k.wr - base.wr) * 100).toFixed(1)}pp)`);
}
console.log('\n══ OPPOSITE-direction absorption (contradiction veto) ══');
for (const prox of [15, 30, 50, 9999]) evalVeto('opp', prox, true);
console.log('\n══ SAME-direction absorption (crowding veto, control) ══');
for (const prox of [30, 9999]) evalVeto('same', prox, false);
process.exit(0);
