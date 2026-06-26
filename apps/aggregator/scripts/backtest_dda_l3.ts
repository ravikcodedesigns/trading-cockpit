// DDA v2 — DIRECT absorption on COMPLETE data (L2 displayed depth + trades), detected EARLY (first
// defended retest), structural trade construction. The MBO order reconstruction is INCOMPLETE (only
// orders whose send we saw) AND the source of huge slowness — and it isn't needed: absorption is fully
// visible in the 100% displayed feed. If heavy volume executes INTO a level but the DISPLAYED size
// doesn't deplete (it reloads), that's the iceberg absorbing — and it's execution-gated, so spoofs
// (no execution) can't fake it. Metrics: intensity = executed ÷ displayed wall (>1 ⇒ traded THROUGH it
// = reloaded); held = wallEnd ÷ wallStart (≥1 ⇒ survived). Strong absorption = held & hit hard. Emit on
// the first favorable retest, STRATIFY the structural outcome by absorption strength. NQ ticks, 33 days.
import { DuckDBInstance } from '@duckdb/node-api';
import { OrderBook } from '../src/l3/order-book.js';
import { SwingDetector } from '../src/l3/swing-levels.js';
import { diffusionScale } from '../src/l3/divergence.js';

const SYM = 'NQ', TICK = 0.25;
const PROOT = '/Users/ravikumarbasker/trading-cockpit/data/ticks-parquet';
const gp = (t: string, d: string) => `read_parquet('${PROOT}/${t}/symbol=${SYM}/date=${d}/*.parquet')`;
const SANE = 'price BETWEEN 20000 AND 40000';
const THROTTLE = 200, RV_MS = 1000, SLIP = 5, MAXD = 300, SWING_MULT = 3, WARM_RV = 30, TAU = 45;
const WALL_TICKS = 4, NEAR_TICKS = 16, MIN_BAND_TICKS = 2, STOP_K = 1.0, RRS = [2, 3];
const DAYS = ['2026-05-05', '2026-05-08', '2026-05-11', '2026-05-12', '2026-05-13', '2026-05-14', '2026-05-15',
  '2026-05-19', '2026-05-20', '2026-05-21', '2026-05-22', '2026-05-26', '2026-05-27', '2026-05-28', '2026-05-29',
  '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-08', '2026-06-09', '2026-06-10',
  '2026-06-11', '2026-06-12', '2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-19', '2026-06-22', '2026-06-23'];
const et = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-04:00`);
const num = (v: any) => v == null ? null : Number(v);
const push = <T>(b: T[], x: T, cap: number) => { b.push(x); if (b.length > cap) b.shift(); };

interface Setup { ts: number; dir: number; emitMid: number; level: number; band: number; intensity: number; held: number; executed: number; }
interface LvState { side: 'resistance' | 'support'; active: boolean; startTs: number; wallStart: number; extreme: number; emitted: boolean; }

const inst = await DuckDBInstance.create();
const con = await inst.connect();

async function runDay(day: string): Promise<{ setups: Setup[]; trades: { ts: number; price: number }[] }> {
  const [warm, rthLo, rthHi, end] = [et(day, '09:00'), et(day, '09:30'), et(day, '16:00'), et(day, '17:00')];
  const book = new OrderBook(SYM, TICK), swing = new SwingDetector();
  const setups: Setup[] = [], trades: { ts: number; price: number }[] = [], mids: number[] = [], midTs: number[] = [];
  const lvs = new Map<string, LvState>();
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
      const mid = (book.priceFromInt(bb) + book.priceFromInt(ba)) / 2, tick = book.priceFromInt(1);
      if (ts - lastRv >= RV_MS) { push(mids, mid, 120); push(midTs, ts, 120); lastRv = ts; }
      if (mids.length < WARM_RV) continue;
      const band = Math.max(MIN_BAND_TICKS * tick, diffusionScale(mids, midTs) * Math.sqrt(TAU));
      if (band <= 0) continue;
      swing.update(mid, ts, SWING_MULT * band);
      for (const lv of swing.levels()) {
        const lvInt = book.intFromPrice(lv.price), key = lv.label;
        let st = lvs.get(key);
        const dist = mid - lv.price, inBand = Math.abs(dist) <= band;
        const side: 'resistance' | 'support' = dist < 0 ? 'resistance' : 'support';
        if (inBand) {
          if (!st) { st = { side, active: false, startTs: 0, wallStart: 0, extreme: mid, emitted: false }; lvs.set(key, st); }
          if (!st.active) { st.active = true; st.startTs = ts; st.wallStart = book.depthNear(lvInt, WALL_TICKS, st.side === 'resistance' ? 'ask' : 'bid').size; st.extreme = mid; }
          st.extreme = st.side === 'resistance' ? Math.max(st.extreme, mid) : Math.min(st.extreme, mid);
        } else if (st?.active) {
          st.active = false;
          if (ts < rthLo || ts > rthHi || st.emitted) continue;
          const reclaim = Math.sign(dist);
          const favRev = (st.side === 'resistance' && reclaim < 0) || (st.side === 'support' && reclaim > 0);
          if (!favRev) continue;
          const defend: 'bid' | 'ask' = st.side === 'resistance' ? 'ask' : 'bid';
          let executed = 0; for (const p of book.tapeNear(lvInt, NEAR_TICKS, st.startTs)) { const into = st.side === 'resistance' ? p.buy : !p.buy; if (into) executed += p.size; }
          const wallEnd = book.depthNear(lvInt, WALL_TICKS, defend).size;          // L2 DISPLAYED (complete)
          const intensity = executed / Math.max(1, st.wallStart);
          const held = wallEnd / Math.max(1, st.wallStart);
          if (executed <= 0 || st.wallStart <= 0) continue;
          st.emitted = true;
          setups.push({ ts, dir: st.side === 'resistance' ? -1 : 1, emitMid: mid, level: lv.price, band, intensity, held, executed });
        }
      }
    }
  }
  return { setups, trades };
}

function firstTouch(s: Setup, trades: { ts: number; price: number }[]) {
  const fill = s.emitMid + s.dir * SLIP, fav = new Array(MAXD + 1).fill(Infinity), adv = new Array(MAXD + 1).fill(Infinity);
  let favMax = 0, advMax = 0, i = lb(trades, s.ts);
  for (; i < trades.length; i++) { const ex = s.dir * (trades[i]!.price - fill);
    if (ex > favMax) { for (let k = Math.floor(favMax) + 1; k <= Math.min(MAXD, Math.floor(ex)); k++) fav[k] = trades[i]!.ts; favMax = ex; }
    if (-ex > advMax) { for (let k = Math.floor(advMax) + 1; k <= Math.min(MAXD, Math.floor(-ex)); k++) adv[k] = trades[i]!.ts; advMax = -ex; }
    if (favMax >= MAXD && advMax >= MAXD) break; }
  return { fav, adv };
}
function lb(t: { ts: number }[], ts: number) { let lo = 0, hi = t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m]!.ts <= ts) lo = m + 1; else hi = m; } return lo; }
function riskOf(s: Setup, stopK: number): number { const fill = s.emitMid + s.dir * SLIP, stopPrice = s.level - s.dir * stopK * s.band; return s.dir * (fill - stopPrice); }
function structR(s: Setup, ft: { fav: number[]; adv: number[] }, stopK: number, rr: number): 'WIN' | 'LOSS' | 'OPEN' | null {
  const risk = riskOf(s, stopK);
  if (risk <= 0) return null;
  const sdist = Math.round(risk), tdist = Math.round(rr * risk);
  if (sdist < 1 || sdist > MAXD || tdist < 1 || tdist > MAXD) return null;
  const t = ft.fav[tdist]!, a = ft.adv[sdist]!;
  if (!isFinite(t) && !isFinite(a)) return 'OPEN';
  return t <= a ? 'WIN' : 'LOSS';
}
function med(v: number[]) { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]!; }

process.stderr.write(`replaying ${DAYS.length} NQ days (displayed-depth absorption)...\n`);
const all: Setup[] = []; const ftOf = new Map<Setup, { fav: number[]; adv: number[] }>();
for (const day of DAYS) {
  const r = await runDay(day);
  for (const s of r.setups) ftOf.set(s, firstTouch(s, r.trades));
  all.push(...r.setups);
  process.stderr.write(`  ${day}: ${r.setups.length} setups (median intensity ${med(r.setups.map(s => s.intensity)).toFixed(1)}x)\n`);
}

console.log(`\nTotal early reversal setups: ${all.length}`);
const tiers: [string, (s: Setup) => boolean][] = [
  ['all', () => true],
  ['ABSORB (held+hit≥3x)', s => s.held >= 0.7 && s.intensity >= 3],
  ['held hit 1-3x', s => s.held >= 0.7 && s.intensity >= 1 && s.intensity < 3],
  ['vacated (held<0.5)', s => s.held < 0.5],
];
const line = (f: (s: Setup) => boolean, stopK: number, rr: number) => {
  let w = 0, l = 0, o = 0;
  for (const s of all) { if (!f(s)) continue; const oc = structR(s, ftOf.get(s)!, stopK, rr); if (oc === 'WIN') w++; else if (oc === 'LOSS') l++; else if (oc === 'OPEN') o++; }
  const n = w + l, netR = w * rr - l;
  return `${(n ? 100 * w / n : 0).toFixed(0)}%/${netR >= 0 ? '+' : ''}${(n ? netR / n : 0).toFixed(2)}R`;
};
console.log('WIDER-STOP SWEEP — does giving the swing more room rescue it? (cell = WR% / expectancy-per-trade)');
for (const stopK of [1, 2, 3, 4]) {
  const medStop = med(all.map(s => riskOf(s, stopK)).filter(r => r > 0));
  console.log(`\nSTOP_K=${stopK}  (stop = ${stopK}×band beyond swing → median stop ≈ ${medStop.toFixed(0)}pt)`);
  for (const rr of RRS) {
    console.log(`  RR=${rr} [random ${(100 / (1 + rr)).toFixed(0)}%]:  ` + tiers.map(([name, f]) => `${name} ${line(f, stopK, rr)}`).join('   |   '));
  }
}
console.log('\nKEY: if a WIDER stop (K=3,4) flips ABSORB/all to positive expectancy → the tight stop was chopping real reversals. If still ≤random at every width → the entry has no reversal edge (the move continues, not reverses).');
process.exit(0);
