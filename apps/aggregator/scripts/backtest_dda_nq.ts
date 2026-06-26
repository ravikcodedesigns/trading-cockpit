// DDA backtest/SCREEN on MNQ (06-02→06-24, ~17 RTH weekdays). Per-day STRUCTURAL levels, the
// detector emits DIST/ACC (reversals) + BREAKING (separate bucket); each setup → market fill 5pts
// adverse to the emit mid, TP/SL ride from the fill; outcome resolved TICK-BY-TICK (first touch, no
// look-ahead). Regime-balanced train/test split; best TP/SL picked on TRAIN only, reported on TEST,
// vs a random-entry NULL. WIN/LOSS/OPEN only — never MFE/MAE.
// Run: pnpm --filter @trading/aggregator exec tsx scripts/backtest_dda_nq.ts
import { DuckDBInstance } from '@duckdb/node-api';
import { OrderBook } from '../src/l3/order-book.js';
import { EpisodeTracker } from '../src/l3/episode-tracker.js';

const SYM = 'MNQ';
const PROOT = '/Users/ravikumarbasker/trading-cockpit/data/mbo-parquet';
const gp = (type: string, day: string) => `read_parquet('${PROOT}/${type}/symbol=${SYM}/date=${day}/*.parquet')`;
const SANE = 'price BETWEEN 25000 AND 35000';
const THROTTLE = 200, SLIP = 5, MAXD = 120;
const TPS = [20, 30, 40, 50, 60, 80, 100], SLS = [20, 30, 40, 50, 60, 80, 100];

// RTH weekdays present in the data; prior = previous entry (06-01 used only as prior for 06-02).
const ALL = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-08', '2026-06-09',
  '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18',
  '2026-06-19', '2026-06-22', '2026-06-23', '2026-06-24'];
const et = (day: string, hm: string) => Date.parse(`${day}T${hm}:00-04:00`);   // June = EDT
const num = (v: any) => v == null ? null : Number(v);

interface Lv { price: number; label: string; kind: string; }
interface Setup { ts: number; state: string; dir: number; emitMid: number; }   // dir +1 long / -1 short
interface DayRun { day: string; regime: string; setups: Setup[]; trades: { ts: number; price: number }[]; }

const inst = await DuckDBInstance.create();
const con = await inst.connect();
const rows = async (sql: string) => (await (await con.run(sql)).getRows()) as any[];

// ── structural levels from the PRIOR RTH session + overnight ───────────────────
function valueArea(bk: { p: number; v: number }[]): { poc: number; vah: number; val: number } | null {
  if (!bk.length) return null;
  bk.sort((a, b) => a.p - b.p);
  const total = bk.reduce((s, x) => s + x.v, 0);
  let pi = 0; for (let i = 1; i < bk.length; i++) if (bk[i]!.v > bk[pi]!.v) pi = i;
  let lo = pi, hi = pi, acc = bk[pi]!.v;
  while (acc < 0.7 * total && (lo > 0 || hi < bk.length - 1)) {
    const dn = lo > 0 ? bk[lo - 1]!.v : -1, up = hi < bk.length - 1 ? bk[hi + 1]!.v : -1;
    if (up >= dn) { hi++; acc += bk[hi]!.v; } else { lo--; acc += bk[lo]!.v; }
  }
  return { poc: bk[pi]!.p, vah: bk[hi]!.p, val: bk[lo]!.p };
}

async function levelsFor(day: string, prior: string): Promise<Lv[]> {
  const [pRl, pRh] = [et(prior, '09:30'), et(prior, '16:00')];
  const [oL, oH] = [et(prior, '18:00'), et(day, '09:30')];
  const ohlc = (await rows(`SELECT min(price), max(price), arg_max(price,ts_ms) FROM ${gp('trades', prior)} WHERE ${SANE} AND ts_ms BETWEEN ${pRl} AND ${pRh}`))[0];
  const vp = (await rows(`SELECT floor(price) p, sum(size) v FROM ${gp('trades', prior)} WHERE ${SANE} AND ts_ms BETWEEN ${pRl} AND ${pRh} GROUP BY 1`)).map(r => ({ p: num(r[0])!, v: num(r[1])! }));
  const on = (await rows(`SELECT min(price), max(price), arg_min(price,ts_ms) FROM (
      SELECT price,ts_ms FROM ${gp('trades', prior)} WHERE ${SANE} AND ts_ms BETWEEN ${oL} AND ${oH}
      UNION ALL SELECT price,ts_ms FROM ${gp('trades', day)} WHERE ${SANE} AND ts_ms BETWEEN ${oL} AND ${oH})`))[0];
  const va = valueArea(vp);
  const out: Lv[] = [];
  const add = (price: any, label: string) => { const p = num(price); if (p) out.push({ price: p, label, kind: 'structural' }); };
  add(ohlc[1], 'PDH'); add(ohlc[0], 'PDL'); add(ohlc[2], 'PDC');
  if (va) { add(va.poc, 'POC'); add(va.vah, 'VAH'); add(va.val, 'VAL'); }
  add(on[1], 'ONH'); add(on[0], 'ONL'); add(on[2], 'ONO');
  return out;
}

async function regimeOf(day: string): Promise<string> {
  const r = (await rows(`SELECT arg_min(price,ts_ms) o, arg_max(price,ts_ms) c, min(price) lo, max(price) hi
    FROM ${gp('trades', day)} WHERE ${SANE} AND ts_ms BETWEEN ${et(day, '09:30')} AND ${et(day, '16:00')}`))[0];
  const o = num(r[0])!, c = num(r[1])!, lo = num(r[2])!, hi = num(r[3])!;
  const de = (hi - lo) > 0 ? (c - o) / (hi - lo) : 0;          // directional efficiency
  return de >= 0.4 ? 'up' : de <= -0.4 ? 'down' : 'chop';
}

// ── replay one day → setups (during RTH) + trade tape (for outcomes) ───────────
async function runDay(day: string, levels: Lv[], regime: string): Promise<DayRun> {
  const [warm, rthLo, rthHi, end] = [et(day, '09:00'), et(day, '09:30'), et(day, '16:00'), et(day, '17:00')];
  const book = new OrderBook(SYM, 0.25);
  const tracker = new EpisodeTracker();
  const setups: Setup[] = [], trades: { ts: number; price: number }[] = [];
  let lastObs = 0;
  const SQL = `
    SELECT ts_ms,'D' s, price_int, price, size, is_bid, CAST(NULL AS BOOLEAN) iba FROM ${gp('depth', day)} WHERE ${SANE} AND ts_ms BETWEEN ${warm} AND ${end}
    UNION ALL SELECT ts_ms,'T', price_int, price, size, CAST(NULL AS BOOLEAN), is_bid_aggressor FROM ${gp('trades', day)} WHERE size>0 AND ${SANE} AND ts_ms BETWEEN ${warm} AND ${end}
    ORDER BY ts_ms`;
  const stream = await con.stream(SQL);
  let chunk;
  while ((chunk = await stream.fetchChunk()) && chunk.rowCount > 0) {
    for (const row of chunk.getRows() as any[]) {
      const ts = Number(row[0]);
      book.lastTs = ts;
      if (row[1] === 'D') { const sz = num(row[4]); if (sz != null) book.applyDepth({ is_bid: !!row[5], size: sz, price_int: num(row[2])! }); }
      else {
        book.applyTrade({ price_int: num(row[2])!, price: num(row[3])!, size: num(row[4])!, is_bid_aggressor: !!row[6] });
        if (ts >= rthLo) trades.push({ ts, price: num(row[3])! });
      }
      if (ts - lastObs >= THROTTLE) {
        lastObs = ts;
        for (const s of tracker.observe(SYM, book, levels, ts)) {
          if (ts < rthLo || ts > rthHi) continue;       // only trade RTH-emitted setups
          if (s.state !== 'DISTRIBUTION' && s.state !== 'ACCUMULATION' && s.state !== 'BREAKING') continue;
          const bb = book.bestBid(), ba = book.bestAsk();
          if (bb == null || ba == null) continue;
          setups.push({ ts, state: s.state, dir: s.direction === 'long' ? 1 : -1, emitMid: (book.priceFromInt(bb) + book.priceFromInt(ba)) / 2 });
        }
      }
    }
  }
  return { day, regime, setups, trades };
}

// ── outcome: per setup, first-touch time to each fav/adv distance (one walk), no look-ahead ────
function firstTouch(s: Setup, trades: { ts: number; price: number }[]): { fav: number[]; adv: number[] } {
  const fill = s.emitMid + s.dir * SLIP;
  const fav = new Array(MAXD + 1).fill(Infinity), adv = new Array(MAXD + 1).fill(Infinity);
  let favMax = 0, advMax = 0;
  // start at the first trade strictly after the entry ts
  let i = lowerBound(trades, s.ts);
  for (; i < trades.length; i++) {
    const ex = s.dir * (trades[i]!.price - fill);          // +fav / -adv (signed excursion toward TP)
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

// ── main ───────────────────────────────────────────────────────────────────────
const PRIOR: Record<string, string> = {}; for (let i = 1; i < ALL.length; i++) PRIOR[ALL[i]!] = ALL[i - 1]!;
const TRADE_DAYS = ALL.slice(1);

process.stderr.write('computing levels + regimes + replaying days...\n');
const runs: DayRun[] = [];
for (const day of TRADE_DAYS) {
  const trCount = num((await rows(`SELECT count(*) FROM ${gp('trades', day)} WHERE ${SANE} AND ts_ms BETWEEN ${et(day, '09:30')} AND ${et(day, '16:00')}`))[0][0])!;
  if (trCount > 12_000_000) { process.stderr.write(`  SKIP ${day} (corrupt: ${trCount} RTH trades)\n`); continue; }
  const levels = await levelsFor(day, PRIOR[day]!);
  const regime = await regimeOf(day);
  const r = await runDay(day, levels, regime);
  runs.push(r);
  process.stderr.write(`  ${day} [${regime}] ${levels.length} levels → ${r.setups.length} setups (${r.setups.filter(s => s.state !== 'BREAKING').length} rev / ${r.setups.filter(s => s.state === 'BREAKING').length} brk)\n`);
}

// regime-balanced split: within each regime (date-sorted) every 3rd day → TEST, rest TRAIN
const isTest = new Map<string, boolean>();
for (const reg of ['up', 'down', 'chop']) {
  const ds = runs.filter(r => r.regime === reg).map(r => r.day);
  ds.forEach((d, i) => isTest.set(d, i % 3 === 2));
}
const train = runs.filter(r => !isTest.get(r.day)), test = runs.filter(r => isTest.get(r.day));
console.log(`\nDAYS: ${runs.length} (${runs.map(r => r.regime[0]).join('')}) | TRAIN ${train.length} [${train.map(r => r.day.slice(5)).join(',')}] | TEST ${test.length} [${test.map(r => r.day.slice(5)).join(',')}]`);

// precompute first-touch per setup (independent of TP/SL)
const ftOf = new Map<Setup, { fav: number[]; adv: number[] }>();
for (const r of runs) for (const s of r.setups) ftOf.set(s, firstTouch(s, r.trades));

function grid(daySet: DayRun[], bucket: (s: Setup) => boolean) {
  const g: { tp: number; sl: number; st: Stat }[] = [];
  for (const tp of TPS) for (const sl of SLS) {
    const st = blank();
    for (const r of daySet) for (const s of r.setups) if (bucket(s)) tally(st, outcome(ftOf.get(s)!, tp, sl), tp, sl);
    g.push({ tp, sl, st });
  }
  return g;
}
const REV = (s: Setup) => s.state !== 'BREAKING', BRK = (s: Setup) => s.state === 'BREAKING';

function report(name: string, bucket: (s: Setup) => boolean) {
  const gTrain = grid(train, bucket);
  const nTrain = gTrain.reduce((a, b) => a + b.st.w + b.st.l + b.st.o, 0) / (TPS.length * SLS.length);
  if (!nTrain) { console.log(`\n══ ${name}: no trades ══`); return; }
  const bestWR = [...gTrain].sort((a, b) => wr(b.st) - wr(a.st) || b.st.pnl - a.st.pnl)[0]!;
  const bestPnL = [...gTrain].sort((a, b) => b.st.pnl - a.st.pnl)[0]!;
  console.log(`\n══ ${name} ══  (train trades/combo ≈ ${nTrain.toFixed(0)})`);
  console.log('  TRAIN grid WR% (rows=TP, cols=SL):');
  console.log('        ' + SLS.map(s => String(s).padStart(6)).join(''));
  for (const tp of TPS) {
    const line = gTrain.filter(g => g.tp === tp).map(g => `${(wr(g.st) * 100).toFixed(0)}/${g.st.pnl >= 0 ? '+' : ''}${g.st.pnl}`.padStart(6)).join('');
    console.log(`  TP${String(tp).padStart(3)} ${line}`);
  }
  for (const [tag, b] of [['maxWR', bestWR], ['maxPnL', bestPnL]] as const) {
    const tr = grid(test, bucket).find(g => g.tp === b.tp && g.sl === b.sl)!;
    console.log(`  → ${tag} combo TP${b.tp}/SL${b.sl}: TRAIN ${(wr(b.st) * 100).toFixed(0)}%WR ${b.st.w}W/${b.st.l}L/${b.st.o}O ${b.st.pnl >= 0 ? '+' : ''}${b.st.pnl}pt  ||  TEST ${(wr(tr.st) * 100).toFixed(0)}%WR ${tr.st.w}W/${tr.st.l}L/${tr.st.o}O ${tr.st.pnl >= 0 ? '+' : ''}${tr.st.pnl}pt`);
  }
}
report('REVERSALS (DIST short / ACC long)', REV);
report('BREAKING (separate bucket)', BRK);

console.log('\nNote: WIN/LOSS/OPEN only; PnL in MNQ points (×$2 = $). Screen on ~17 days — forward shadow is the gate.');
process.exit(0);
