// EXHAUSTION signal test — the lead that fell out of the absorption study, now on a BIGGER, OUT-OF-
// SAMPLE basis (NQ + ES, ~63 instrument-days) with the IDENTICAL definition (no re-tuning), a
// permutation test, and RR≥2 (so WR+slippage sustains). Mechanism: aggressors HIT a swing level, the
// defended wall VACATES (held<0.5 — they cleared the resting size) but price REJECTS anyway → the spike
// EXHAUSTED itself and reverses. Structural stop beyond the swing, R-multiple target, tick-by-tick
// first-touch (no look-ahead). If it holds on BOTH instruments + beats permutation → real; else noise.
import { DuckDBInstance } from '@duckdb/node-api';
import { OrderBook } from '../src/l3/order-book.js';
import { SwingDetector } from '../src/l3/swing-levels.js';
import { diffusionScale } from '../src/l3/divergence.js';

const TICK = 0.25;
const PROOT = '/Users/ravikumarbasker/trading-cockpit/data/ticks-parquet';
const gp = (sym: string, t: string, d: string) => `read_parquet('${PROOT}/${t}/symbol=${sym}/date=${d}/*.parquet')`;
const THROTTLE = 200, RV_MS = 1000, SLIP = 5, MAXD = 400, SWING_MULT = 3, WARM_RV = 30, TAU = 45;
const WALL_TICKS = 4, NEAR_TICKS = 16, MIN_BAND_TICKS = 2;
const HOLIDAYS = new Set(['2026-05-25']);
const NQ_DAYS = ['2026-05-05', '2026-05-08', '2026-05-11', '2026-05-12', '2026-05-13', '2026-05-14', '2026-05-15', '2026-05-19', '2026-05-20', '2026-05-21', '2026-05-22', '2026-05-26', '2026-05-27', '2026-05-28', '2026-05-29', '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-19', '2026-06-22', '2026-06-23'];
const ES_DAYS = ['2026-05-12', '2026-05-13', '2026-05-14', '2026-05-15', '2026-05-19', '2026-05-20', '2026-05-21', '2026-05-22', '2026-05-26', '2026-05-27', '2026-05-28', '2026-05-29', '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-22', '2026-06-23', '2026-06-24'];
const SYMS = [
  { sym: 'NQ', sane: 'price BETWEEN 20000 AND 40000', days: NQ_DAYS },
  { sym: 'ES', sane: 'price BETWEEN 5000 AND 9000', days: ES_DAYS },
];
const et = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-04:00`);
const num = (v: any) => v == null ? null : Number(v);
const push = <T>(b: T[], x: T, cap: number) => { b.push(x); if (b.length > cap) b.shift(); };

interface Setup { sym: string; ts: number; dir: number; emitMid: number; level: number; band: number; intensity: number; held: number; }
interface LvState { side: 'resistance' | 'support'; active: boolean; startTs: number; wallStart: number; extreme: number; emitted: boolean; }

const inst = await DuckDBInstance.create();
const con = await inst.connect();

async function runDay(sym: string, sane: string, day: string): Promise<{ setups: Setup[]; trades: { ts: number; price: number }[] }> {
  const [warm, rthLo, rthHi, end] = [et(day, '09:00'), et(day, '09:30'), et(day, '16:00'), et(day, '17:00')];
  const book = new OrderBook(sym, TICK), swing = new SwingDetector();
  const setups: Setup[] = [], trades: { ts: number; price: number }[] = [], mids: number[] = [], midTs: number[] = [];
  const lvs = new Map<string, LvState>();
  let lastObs = 0, lastRv = 0;
  const SQL = `
    SELECT ts,'D' s, price, size, side, CAST(NULL AS BOOLEAN) iba FROM ${gp(sym, 'depth', day)} WHERE ${sane} AND ts BETWEEN ${warm} AND ${end}
    UNION ALL SELECT ts,'T', price, size, CAST(NULL AS BIGINT), is_bid_aggressor FROM ${gp(sym, 'trades', day)} WHERE size>0 AND ${sane} AND ts BETWEEN ${warm} AND ${end}
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
          const wallEnd = book.depthNear(lvInt, WALL_TICKS, defend).size;
          const intensity = executed / Math.max(1, st.wallStart);
          const held = wallEnd / Math.max(1, st.wallStart);
          if (executed <= 0 || st.wallStart <= 0) continue;
          st.emitted = true;
          setups.push({ sym, ts, dir: st.side === 'resistance' ? -1 : 1, emitMid: mid, level: lv.price, band, intensity, held });
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
function riskOf(s: Setup, stopK: number) { const fill = s.emitMid + s.dir * SLIP, sp = s.level - s.dir * stopK * s.band; return s.dir * (fill - sp); }
function outc(s: Setup, ft: { fav: number[]; adv: number[] }, stopK: number, rr: number): 'WIN' | 'LOSS' | 'OPEN' | null {
  const risk = riskOf(s, stopK); if (risk <= 0) return null;
  const sdist = Math.round(risk), tdist = Math.round(rr * risk);
  if (sdist < 1 || sdist > MAXD || tdist < 1 || tdist > MAXD) return null;
  const t = ft.fav[tdist]!, a = ft.adv[sdist]!;
  if (!isFinite(t) && !isFinite(a)) return 'OPEN';
  return t <= a ? 'WIN' : 'LOSS';
}
function med(v: number[]) { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]!; }

process.stderr.write('replaying NQ + ES...\n');
const all: Setup[] = []; const ftOf = new Map<Setup, { fav: number[]; adv: number[] }>();
for (const { sym, sane, days } of SYMS) {
  let n = 0;
  for (const day of days) {
    if (HOLIDAYS.has(day)) continue;
    try { const r = await runDay(sym, sane, day); for (const s of r.setups) ftOf.set(s, firstTouch(s, r.trades)); all.push(...r.setups); n += r.setups.length; } catch (e) { process.stderr.write(`  ${sym} ${day} ERR\n`); }
  }
  process.stderr.write(`  ${sym}: ${n} setups\n`);
}

const vac = (s: Setup) => s.held < 0.5;                                   // EXHAUSTION: wall vacated
const vacHard = (s: Setup) => s.held < 0.5 && s.intensity >= 1;           // ...and hit meaningfully first
function stat(set: Setup[], stopK: number, rr: number) {
  let w = 0, l = 0, o = 0; for (const s of set) { const oc = outc(s, ftOf.get(s)!, stopK, rr); if (oc === 'WIN') w++; else if (oc === 'LOSS') l++; else if (oc === 'OPEN') o++; }
  const n = w + l; return { n, w, l, o, wr: n ? w / n : 0, exp: n ? (w * rr - l) / n : 0 };
}
// permutation: vacated WR vs random subsets of the same size from ALL setups (deterministic PRNG)
function permP(set: Setup[], stopK: number, rr: number): number {
  const resolved = all.map(s => outc(s, ftOf.get(s)!, stopK, rr)).filter(o => o === 'WIN' || o === 'LOSS') as ('WIN' | 'LOSS')[];
  const target = stat(set, stopK, rr); if (!target.n) return 1;
  let ge = 0, K = 5000, seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let r = 0; r < K; r++) {
    let w = 0; for (let i = 0; i < target.n; i++) if (resolved[Math.floor(rnd() * resolved.length)] === 'WIN') w++;
    if (w / target.n >= target.wr) ge++;
  }
  return ge / K;
}

console.log(`\nTotal setups: ${all.length} (NQ ${all.filter(s => s.sym === 'NQ').length} / ES ${all.filter(s => s.sym === 'ES').length})`);
console.log('EXHAUSTION (wall vacated, held<0.5) — out-of-sample on NQ+ES. random WR = 1/(1+RR).');
for (const rr of [2, 3]) {
  console.log(`\n══ RR=${rr}  [random WR=${(100 / (1 + rr)).toFixed(0)}%] ══`);
  for (const stopK of [2, 3, 4]) {
    const V = all.filter(vac), p = permP(V, stopK, rr);
    const c = stat(V, stopK, rr), cN = stat(V.filter(s => s.sym === 'NQ'), stopK, rr), cE = stat(V.filter(s => s.sym === 'ES'), stopK, rr), cH = stat(all.filter(vacHard), stopK, rr);
    const medStop = med(V.map(s => riskOf(s, stopK)).filter(r => r > 0));
    console.log(`  STOP_K=${stopK} (~${medStop.toFixed(0)}pt): VACATED n=${c.n} ${(c.wr * 100).toFixed(0)}%WR exp ${c.exp >= 0 ? '+' : ''}${c.exp.toFixed(2)}R  perm-p=${p.toFixed(3)}`);
    console.log(`        NQ ${(cN.wr * 100).toFixed(0)}%/${cN.exp >= 0 ? '+' : ''}${cN.exp.toFixed(2)}R (n${cN.n})   ES ${(cE.wr * 100).toFixed(0)}%/${cE.exp >= 0 ? '+' : ''}${cE.exp.toFixed(2)}R (n${cE.n})   vac+hit≥1x ${(cH.wr * 100).toFixed(0)}%/${cH.exp >= 0 ? '+' : ''}${cH.exp.toFixed(2)}R (n${cH.n})`);
  }
}
console.log('\nKEY: real if exp>0 on BOTH NQ and ES + perm-p<0.05 (beats random) at RR≥2. NQ-only or p>0.05 = it was noise.');
process.exit(0);
