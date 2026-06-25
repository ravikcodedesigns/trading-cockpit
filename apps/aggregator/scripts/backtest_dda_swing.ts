// DDA backtest/SCREEN — REACTIVE swing zones, NQ ticks-parquet (L2+trades, 33 RTH days 05-05→06-23).
// Levels = causally-confirmed swing highs/lows (supply/demand fossils), grown through the session and
// fed to the EpisodeTracker; absorption is read on the RETEST (DIST/ACC reversals + BREAKING, separate
// buckets). Setup → fill 5pt adverse to the emit mid, TP/SL ride from the fill, outcome TICK-BY-TICK
// (first touch, no look-ahead). Regime-balanced train/test; best TP/SL on TRAIN only, reported on TEST,
// vs a random-entry NULL. WIN/LOSS/OPEN only. Run: pnpm --filter @trading/aggregator exec tsx scripts/backtest_dda_swing.ts
import { DuckDBInstance } from '@duckdb/node-api';
import { OrderBook } from '../src/l3/order-book.js';
import { EpisodeTracker, EPISODE_CFG } from '../src/l3/episode-tracker.js';
import { SwingDetector } from '../src/l3/swing-levels.js';
import { diffusionScale } from '../src/l3/divergence.js';

const SYM = 'NQ', TICK = 0.25;
const PROOT = '/Users/ravikumarbasker/trading-cockpit/data/ticks-parquet';
const gp = (type: string, day: string) => `read_parquet('${PROOT}/${type}/symbol=${SYM}/date=${day}/*.parquet')`;
const SANE = 'price BETWEEN 20000 AND 40000';
const THROTTLE = 200, RV_MS = 1000, SLIP = 5, MAXD = 120, SWING_MULT = 3, WARM_RV = 30;
const TAU = (EPISODE_CFG as any).TAU_SEC ?? 45;
const TPS = [20, 30, 40, 50, 60, 80, 100], SLS = [20, 30, 40, 50, 60, 80, 100];
const DAYS = ['2026-05-05', '2026-05-08', '2026-05-11', '2026-05-12', '2026-05-13', '2026-05-14', '2026-05-15',
  '2026-05-19', '2026-05-20', '2026-05-21', '2026-05-22', '2026-05-25', '2026-05-26', '2026-05-27', '2026-05-28',
  '2026-05-29', '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-08', '2026-06-09',
  '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-19',
  '2026-06-22', '2026-06-23'];
const HOLIDAYS = new Set(['2026-05-25']);   // Memorial Day — closed
const et = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-04:00`);
const num = (v: any) => v == null ? null : Number(v);

interface Setup { ts: number; state: string; dir: number; emitMid: number; }
interface DayRun { day: string; regime: string; setups: Setup[]; trades: { ts: number; price: number }[]; }

const inst = await DuckDBInstance.create();
const con = await inst.connect();
const rows = async (s: string) => (await (await con.run(s)).getRows()) as any[];
const push = <T>(b: T[], x: T, cap: number) => { b.push(x); if (b.length > cap) b.shift(); };

async function regimeOf(day: string): Promise<string> {
  const r = (await rows(`SELECT arg_min(price,ts) o, arg_max(price,ts) c, min(price) lo, max(price) hi
    FROM ${gp('trades', day)} WHERE ${SANE} AND ts BETWEEN ${et(day, '09:30')} AND ${et(day, '16:00')}`))[0];
  const o = num(r[0])!, c = num(r[1])!, lo = num(r[2])!, hi = num(r[3])!;
  const de = (hi - lo) > 0 ? (c - o) / (hi - lo) : 0;
  return de >= 0.4 ? 'up' : de <= -0.4 ? 'down' : 'chop';
}

async function runDay(day: string, regime: string): Promise<DayRun> {
  const [warm, rthLo, rthHi, end] = [et(day, '09:00'), et(day, '09:30'), et(day, '16:00'), et(day, '17:00')];
  const book = new OrderBook(SYM, TICK);
  const tracker = new EpisodeTracker({ EARLY_ENTRY: true });   // EARLY-ENTRY diagnostic (first reclaim/rejection)
  const swing = new SwingDetector();
  const setups: Setup[] = [], trades: { ts: number; price: number }[] = [];
  const mids: number[] = [], midTs: number[] = [];
  let lastObs = 0, lastRv = 0, checked = false;
  const SQL = `
    SELECT ts,'D' s, price, size, side, CAST(NULL AS BOOLEAN) iba FROM ${gp('depth', day)} WHERE ${SANE} AND ts BETWEEN ${warm} AND ${end}
    UNION ALL SELECT ts,'T', price, size, CAST(NULL AS BIGINT), is_bid_aggressor FROM ${gp('trades', day)} WHERE size>0 AND ${SANE} AND ts BETWEEN ${warm} AND ${end}
    ORDER BY ts`;
  const stream = await con.stream(SQL);
  let chunk;
  while ((chunk = await stream.fetchChunk()) && chunk.rowCount > 0) {
    for (const row of chunk.getRows() as any[]) {
      const ts = Number(row[0]);
      book.lastTs = ts;
      if (row[1] === 'D') { const sz = num(row[3]); if (sz != null) book.applyDepth({ is_bid: Number(row[4]) === 0, size: sz, price_int: book.intFromPrice(num(row[2])!) }); }
      else { book.applyTrade({ price_int: book.intFromPrice(num(row[2])!), price: num(row[2])!, size: num(row[3])!, is_bid_aggressor: !!row[5] }); if (ts >= rthLo) trades.push({ ts, price: num(row[2])! }); }
      if (ts - lastObs < THROTTLE) continue;
      lastObs = ts;
      const bb = book.bestBid(), ba = book.bestAsk();
      if (bb == null || ba == null) continue;
      if (!checked && bb >= ba) throw new Error(`${day}: bid>=ask (${bb}/${ba}) — side mapping inverted`);
      checked = true;
      const mid = (book.priceFromInt(bb) + book.priceFromInt(ba)) / 2;
      if (ts - lastRv >= RV_MS) { push(mids, mid, 120); push(midTs, ts, 120); lastRv = ts; }
      // swing zones (vol-scaled δ = SWING_MULT × band); skip until σ warmed
      if (mids.length >= WARM_RV) { const band = diffusionScale(mids, midTs) * Math.sqrt(TAU); if (band > 0) swing.update(mid, ts, SWING_MULT * band); }
      for (const s of tracker.observe(SYM, book, swing.levels(), ts)) {
        if (ts < rthLo || ts > rthHi) continue;
        if (s.state !== 'DISTRIBUTION' && s.state !== 'ACCUMULATION' && s.state !== 'BREAKING') continue;
        setups.push({ ts, state: s.state, dir: s.direction === 'long' ? 1 : -1, emitMid: mid });
      }
    }
  }
  return { day, regime, setups, trades };
}

function firstTouch(s: Setup, trades: { ts: number; price: number }[]): { fav: number[]; adv: number[] } {
  const fill = s.emitMid + s.dir * SLIP;
  const fav = new Array(MAXD + 1).fill(Infinity), adv = new Array(MAXD + 1).fill(Infinity);
  let favMax = 0, advMax = 0, i = lowerBound(trades, s.ts);
  for (; i < trades.length; i++) {
    const ex = s.dir * (trades[i]!.price - fill);
    if (ex > favMax) { for (let k = Math.floor(favMax) + 1; k <= Math.min(MAXD, Math.floor(ex)); k++) fav[k] = trades[i]!.ts; favMax = ex; }
    if (-ex > advMax) { for (let k = Math.floor(advMax) + 1; k <= Math.min(MAXD, Math.floor(-ex)); k++) adv[k] = trades[i]!.ts; advMax = -ex; }
    if (favMax >= MAXD && advMax >= MAXD) break;
  }
  return { fav, adv };
}
function lowerBound(t: { ts: number }[], ts: number): number { let lo = 0, hi = t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m]!.ts <= ts) lo = m + 1; else hi = m; } return lo; }
function outcome(ft: { fav: number[]; adv: number[] }, tp: number, sl: number): 'WIN' | 'LOSS' | 'OPEN' {
  const t = ft.fav[tp]!, a = ft.adv[sl]!;
  if (!isFinite(t) && !isFinite(a)) return 'OPEN';
  return t <= a ? 'WIN' : 'LOSS';
}

interface Stat { w: number; l: number; o: number; pnl: number; }
const blank = (): Stat => ({ w: 0, l: 0, o: 0, pnl: 0 });
const wr = (s: Stat) => s.w + s.l ? s.w / (s.w + s.l) : 0;
function tally(st: Stat, oc: string, tp: number, sl: number) { if (oc === 'WIN') { st.w++; st.pnl += tp; } else if (oc === 'LOSS') { st.l++; st.pnl -= sl; } else st.o++; }

// ── run ──
process.stderr.write(`replaying ${DAYS.length} NQ days (swing zones)...\n`);
const runs: DayRun[] = [];
const ftOf = new Map<Setup, { fav: number[]; adv: number[] }>();
for (const day of DAYS) {
  if (HOLIDAYS.has(day)) { process.stderr.write(`  ${day} SKIP (holiday)\n`); continue; }
  const regime = await regimeOf(day);
  const r = await runDay(day, regime);
  for (const s of r.setups) ftOf.set(s, firstTouch(s, r.trades));   // resolve outcomes now, then free the tape
  r.trades = [];
  runs.push(r);
  process.stderr.write(`  ${day} [${regime}] → ${r.setups.length} setups (${r.setups.filter(s => s.state !== 'BREAKING').length} rev / ${r.setups.filter(s => s.state === 'BREAKING').length} brk)\n`);
}

const isTest = new Map<string, boolean>();
for (const reg of ['up', 'down', 'chop']) runs.filter(r => r.regime === reg).map(r => r.day).forEach((d, i) => isTest.set(d, i % 3 === 2));
const train = runs.filter(r => !isTest.get(r.day)), test = runs.filter(r => isTest.get(r.day));
console.log(`\nDAYS ${runs.length} (${runs.map(r => r.regime[0]).join('')}) | TRAIN ${train.length} | TEST ${test.length} [${test.map(r => r.day.slice(5)).join(',')}]`);

function grid(ds: DayRun[], bucket: (s: Setup) => boolean) {
  return TPS.flatMap(tp => SLS.map(sl => {
    const st = blank();
    for (const r of ds) for (const s of r.setups) if (bucket(s)) tally(st, outcome(ftOf.get(s)!, tp, sl), tp, sl);
    return { tp, sl, st };
  }));
}
const REV = (s: Setup) => s.state !== 'BREAKING', BRK = (s: Setup) => s.state === 'BREAKING';

function report(name: string, bucket: (s: Setup) => boolean) {
  const gT = grid(train, bucket);
  const n = gT.reduce((a, b) => a + b.st.w + b.st.l + b.st.o, 0) / gT.length;
  if (!n) { console.log(`\n══ ${name}: no trades ══`); return; }
  const bestWR = [...gT].filter(g => g.st.w + g.st.l >= 10).sort((a, b) => wr(b.st) - wr(a.st) || b.st.pnl - a.st.pnl)[0] ?? gT[0]!;
  const bestPnL = [...gT].sort((a, b) => b.st.pnl - a.st.pnl)[0]!;
  console.log(`\n══ ${name} ══ (train trades/combo ≈ ${n.toFixed(0)})`);
  console.log('  TRAIN WR%/PnL (row=TP, col=SL):');
  console.log('         ' + SLS.map(s => ('SL' + s).padStart(9)).join(''));
  for (const tp of TPS) console.log(`  TP${String(tp).padStart(3)} ` + gT.filter(g => g.tp === tp).map(g => `${(wr(g.st) * 100).toFixed(0)}/${g.st.pnl >= 0 ? '+' : ''}${g.st.pnl}`.padStart(9)).join(''));
  for (const [tag, b] of [['maxWR', bestWR], ['maxPnL', bestPnL]] as const) {
    const tr = grid(test, bucket).find(g => g.tp === b.tp && g.sl === b.sl)!;
    console.log(`  → ${tag} TP${b.tp}/SL${b.sl}: TRAIN ${(wr(b.st) * 100).toFixed(0)}%WR ${b.st.w}W/${b.st.l}L/${b.st.o}O ${b.st.pnl >= 0 ? '+' : ''}${b.st.pnl}pt || TEST ${(wr(tr.st) * 100).toFixed(0)}%WR ${tr.st.w}W/${tr.st.l}L/${tr.st.o}O ${tr.st.pnl >= 0 ? '+' : ''}${tr.st.pnl}pt`);
  }
}
report('REVERSALS (DIST short / ACC long)', REV);
report('BREAKING (separate bucket)', BRK);

// ARTIFACT CHECK: is the wide-target PnL a real reversal edge, or just longs catching upward drift?
function breakdown(tp: number, sl: number) {
  const cat: Record<string, Stat> = { long: blank(), short: blank(), up: blank(), down: blank(), chop: blank() };
  for (const r of runs) for (const s of r.setups) {
    if (s.state === 'BREAKING') continue;
    const oc = outcome(ftOf.get(s)!, tp, sl);
    tally(s.dir > 0 ? cat.long! : cat.short!, oc, tp, sl);
    tally(cat[r.regime]!, oc, tp, sl);
  }
  console.log(`\n  TP${tp}/SL${sl} reversal breakdown (pooled, all ${runs.length} days):`);
  for (const k of ['long', 'short', 'up', 'down', 'chop']) {
    const s = cat[k]!;
    console.log(`    ${k.padEnd(6)} ${(wr(s) * 100).toFixed(0)}%WR ${s.w}W/${s.l}L/${s.o}O  ${s.pnl >= 0 ? '+' : ''}${s.pnl}pt`);
  }
}
console.log('\n══ ARTIFACT CHECK ══');
breakdown(50, 50);     // symmetric (no wide-target drift capture)
breakdown(80, 100);    // the "positive" wide-target combo
console.log('\nWIN/LOSS/OPEN only; PnL in NQ points (×$20 = $). Screen on 33 days — forward shadow is the gate.');
process.exit(0);
