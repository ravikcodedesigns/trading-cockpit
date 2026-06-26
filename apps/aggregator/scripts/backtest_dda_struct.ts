// DDA re-test with CORRECT trade construction + conviction stratification (the implementation fixes).
// Entry = market on the DDA signal (5pt adverse). STOP = structural — just beyond the swing level
// (level ∓ STOP_K·band, where the thesis is invalidated). TARGET = R-multiple of that risk (next-level
// proxy). Outcome tick-by-tick first-touch (no look-ahead). Reported in R-units (risk-normalized) so
// varying stop sizes are comparable, stratified by the episode's CONFIDENCE — to find whether a
// high-conviction subset, traded correctly, has edge (vs the noise-diluted aggregate). WIN/LOSS/OPEN only.
import { DuckDBInstance } from '@duckdb/node-api';
import { OrderBook } from '../src/l3/order-book.js';
import { EpisodeTracker, EPISODE_CFG } from '../src/l3/episode-tracker.js';
import { SwingDetector } from '../src/l3/swing-levels.js';
import { diffusionScale } from '../src/l3/divergence.js';

const SYM = 'NQ', TICK = 0.25;
const PROOT = '/Users/ravikumarbasker/trading-cockpit/data/ticks-parquet';
const gp = (t: string, d: string) => `read_parquet('${PROOT}/${t}/symbol=${SYM}/date=${d}/*.parquet')`;
const SANE = 'price BETWEEN 20000 AND 40000';
const THROTTLE = 200, RV_MS = 1000, SLIP = 5, MAXD = 300, SWING_MULT = 3, WARM_RV = 30;
const TAU = (EPISODE_CFG as any).TAU_SEC ?? 45;
const STOP_KS = [0.5, 1.0], RRS = [2, 3, 4];
const CONF_TIERS = [0, 0.5, 0.7, 0.85];
const DAYS = ['2026-05-05', '2026-05-08', '2026-05-11', '2026-05-12', '2026-05-13', '2026-05-14', '2026-05-15',
  '2026-05-19', '2026-05-20', '2026-05-21', '2026-05-22', '2026-05-26', '2026-05-27', '2026-05-28', '2026-05-29',
  '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-08', '2026-06-09', '2026-06-10',
  '2026-06-11', '2026-06-12', '2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-19', '2026-06-22', '2026-06-23'];
const et = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-04:00`);
const num = (v: any) => v == null ? null : Number(v);
const push = <T>(b: T[], x: T, cap: number) => { b.push(x); if (b.length > cap) b.shift(); };

interface Setup { ts: number; dir: number; emitMid: number; level: number; band: number; conf: number; }
interface DayRun { setups: Setup[]; trades: { ts: number; price: number }[]; }

const inst = await DuckDBInstance.create();
const con = await inst.connect();

async function runDay(day: string): Promise<DayRun> {
  const [warm, rthLo, rthHi, end] = [et(day, '09:00'), et(day, '09:30'), et(day, '16:00'), et(day, '17:30')];
  const book = new OrderBook(SYM, TICK), tracker = new EpisodeTracker(), swing = new SwingDetector();
  const setups: Setup[] = [], trades: { ts: number; price: number }[] = [], mids: number[] = [], midTs: number[] = [];
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
      else { book.applyTrade({ price_int: book.intFromPrice(num(row[2])!), price: num(row[2])!, size: num(row[3])!, is_bid_aggressor: !!row[5] }); if (ts >= rthLo) trades.push({ ts, price: num(row[2])! }); }
      if (ts - lastObs < THROTTLE) continue;
      lastObs = ts;
      const bb = book.bestBid(), ba = book.bestAsk(); if (bb == null || ba == null) continue;
      const mid = (book.priceFromInt(bb) + book.priceFromInt(ba)) / 2;
      if (ts - lastRv >= RV_MS) { push(mids, mid, 120); push(midTs, ts, 120); lastRv = ts; }
      if (mids.length >= WARM_RV) { const band = diffusionScale(mids, midTs) * Math.sqrt(TAU); if (band > 0) swing.update(mid, ts, SWING_MULT * band); }
      for (const s of tracker.observe(SYM, book, swing.levels(), ts)) {
        if (ts < rthLo || ts > rthHi) continue;
        if (s.state !== 'DISTRIBUTION' && s.state !== 'ACCUMULATION') continue;     // reversals only
        setups.push({ ts, dir: s.direction === 'long' ? 1 : -1, emitMid: mid, level: s.levelPrice, band: tracker.lastBand(SYM), conf: s.confidence });
      }
    }
  }
  return { setups, trades };
}

function firstTouch(s: Setup, trades: { ts: number; price: number }[]): { fav: number[]; adv: number[] } {
  const fill = s.emitMid + s.dir * SLIP;
  const fav = new Array(MAXD + 1).fill(Infinity), adv = new Array(MAXD + 1).fill(Infinity);
  let favMax = 0, advMax = 0, i = lb(trades, s.ts);
  for (; i < trades.length; i++) {
    const ex = s.dir * (trades[i]!.price - fill);
    if (ex > favMax) { for (let k = Math.floor(favMax) + 1; k <= Math.min(MAXD, Math.floor(ex)); k++) fav[k] = trades[i]!.ts; favMax = ex; }
    if (-ex > advMax) { for (let k = Math.floor(advMax) + 1; k <= Math.min(MAXD, Math.floor(-ex)); k++) adv[k] = trades[i]!.ts; advMax = -ex; }
    if (favMax >= MAXD && advMax >= MAXD) break;
  }
  return { fav, adv };
}
function lb(t: { ts: number }[], ts: number): number { let lo = 0, hi = t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m]!.ts <= ts) lo = m + 1; else hi = m; } return lo; }

// structural outcome → 'WIN' (+RR), 'LOSS' (-1R), 'OPEN', or null (out of range)
function structR(s: Setup, ft: { fav: number[]; adv: number[] }, stopK: number, rr: number): 'WIN' | 'LOSS' | 'OPEN' | null {
  const fill = s.emitMid + s.dir * SLIP;
  const stopPrice = s.level - s.dir * stopK * s.band;        // beyond the swing
  const risk = s.dir * (fill - stopPrice);                    // points
  if (risk <= 0) return null;
  const sdist = Math.round(risk), tdist = Math.round(rr * risk);
  if (sdist < 1 || sdist > MAXD || tdist < 1 || tdist > MAXD) return null;
  const t = ft.fav[tdist]!, a = ft.adv[sdist]!;
  if (!isFinite(t) && !isFinite(a)) return 'OPEN';
  return t <= a ? 'WIN' : 'LOSS';
}

process.stderr.write(`replaying ${DAYS.length} NQ days (confirmation DDA, structural R)...\n`);
const all: Setup[] = []; const ftOf = new Map<Setup, { fav: number[]; adv: number[] }>();
for (const day of DAYS) {
  const r = await runDay(day);
  for (const s of r.setups) ftOf.set(s, firstTouch(s, r.trades));
  all.push(...r.setups);
  process.stderr.write(`  ${day}: ${r.setups.length} setups\n`);
}
console.log(`\nTotal confirmation reversal setups: ${all.length}`);
console.log('conviction → structural R:R outcome (risk-normalized; random netR≈0, random WR=1/(1+RR)):');
for (const stopK of STOP_KS) for (const rr of RRS) {
  console.log(`\n  STOP_K=${stopK} (stop = ${stopK}×band beyond level), RR=${rr}  [random WR=${(100 / (1 + rr)).toFixed(0)}%]`);
  for (const tier of CONF_TIERS) {
    let w = 0, l = 0, o = 0, nu = 0;
    for (const s of all) {
      if (s.conf < tier) continue;
      const oc = structR(s, ftOf.get(s)!, stopK, rr);
      if (oc === 'WIN') w++; else if (oc === 'LOSS') l++; else if (oc === 'OPEN') o++; else nu++;
    }
    const n = w + l, wr = n ? w / n : 0, netR = w * rr - l, exp = n ? netR / n : 0;
    console.log(`    conf≥${tier.toFixed(2)}: ${String(w + l + o).padStart(4)} trades  ${(wr * 100).toFixed(0)}%WR  netR ${netR >= 0 ? '+' : ''}${netR.toFixed(0)}  exp ${exp >= 0 ? '+' : ''}${exp.toFixed(2)}R/trade${o ? `  (${o} open)` : ''}`);
  }
}
console.log('\nKEY: does WR/expectancy RISE with conviction? if yes → precision is the path; if flat/random → absorption detection is the problem (→ L3).');
process.exit(0);
