// flip_long_cvd_validation.ts — validate the cvd_session >= -1000 filter on flip longs.
// Regime-stratified train/test split (trending-up / -down / range days mixed into each),
// + 10,000-iteration permutation test: does cvd<-1000 select worse-than-random trades?
// Walk TP=80/SL=55, RTH 15:54 = OPEN. $ = MNQ $2/pt. NQ clean-impulse longs only.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tradingDb = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'), { readonly: true });
const TP = 80, SL = 55, USD = 2, FLOOR = -1000, NPERM = 10_000;

const dpFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
function ymd(tsMs: number) { const [mm, dd, yyyy] = dpFmt.format(new Date(tsMs)).split('/'); return `${yyyy}-${mm}-${dd}`; }
function rthOpenTs(tsMs: number) { const [mm, dd, yyyy] = dpFmt.format(new Date(tsMs)).split('/'); return Date.parse(`${yyyy}-${mm}-${dd}T09:30:00-04:00`); }
function rthCloseTs(tsMs: number) { const [mm, dd, yyyy] = dpFmt.format(new Date(tsMs)).split('/'); return Date.parse(`${yyyy}-${mm}-${dd}T15:54:00-04:00`); }

const tickQ = ticksDb.prepare('SELECT ts, price FROM trades WHERE symbol=? AND ts>? AND ts<=? ORDER BY ts ASC');
const lastTick = ticksDb.prepare('SELECT price FROM trades WHERE symbol=? AND ts<=? ORDER BY ts DESC LIMIT 1');
const firstTick = ticksDb.prepare('SELECT price FROM trades WHERE symbol=? AND ts>=? ORDER BY ts ASC LIMIT 1');
const dayOHLC = ticksDb.prepare('SELECT max(price) hi, min(price) lo FROM trades WHERE symbol=? AND ts>=? AND ts<=?');

interface Tr { day: string; cvd: number; entry: number; reason: 'WIN' | 'LOSS' | 'OPEN'; pnl: number; }
const sigs = tradingDb.prepare(`
  SELECT signal_ts, cvd_session, entry FROM tradable_signals
  WHERE rule_id='clean-impulse' AND direction='long' AND action='OPEN' AND symbol='NQ' AND entry IS NOT NULL
  ORDER BY signal_ts ASC`).all() as { signal_ts: number; cvd_session: number | null; entry: number }[];

const trades: Tr[] = [];
for (const s of sigs) {
  const close = rthCloseTs(s.signal_ts);
  const exitTs = close > s.signal_ts ? close : rthCloseTs(s.signal_ts + 86_400_000);
  const tpPx = s.entry + TP, slPx = s.entry - SL;
  let reason: Tr['reason'] = 'OPEN', cl = s.entry;
  for (const t of tickQ.iterate('NQ', s.signal_ts, exitTs) as IterableIterator<{ ts: number; price: number }>) {
    if (t.price >= tpPx) { reason = 'WIN'; cl = tpPx; break; }
    if (t.price <= slPx) { reason = 'LOSS'; cl = slPx; break; }
  }
  if (reason === 'OPEN') cl = (lastTick.get('NQ', exitTs) as { price: number } | undefined)?.price ?? s.entry;
  trades.push({ day: ymd(s.signal_ts), cvd: s.cvd_session ?? 0, entry: s.entry, reason, pnl: cl - s.entry });
}

// ── classify each day's regime ──
const days = [...new Set(trades.map(t => t.day))].sort();
const regime: Record<string, string> = {};
console.log('\n──── day regimes (RTH net vs range) ────');
console.log('date         open      close     net    range   net/rng  regime');
for (const d of days) {
  const anyTs = Date.parse(`${d}T12:00:00-04:00`);
  const o = (firstTick.get('NQ', rthOpenTs(anyTs)) as { price: number } | undefined)?.price ?? 0;
  const c = (lastTick.get('NQ', rthCloseTs(anyTs)) as { price: number } | undefined)?.price ?? 0;
  const { hi, lo } = dayOHLC.get('NQ', rthOpenTs(anyTs), rthCloseTs(anyTs)) as { hi: number; lo: number };
  const net = c - o, range = (hi - lo) || 1, eff = net / range;
  const reg = Math.abs(eff) >= 0.4 ? (net > 0 ? 'UP' : 'DOWN') : 'RANGE';
  regime[d] = reg;
  console.log(`${d}  ${o.toFixed(2).padStart(9)} ${c.toFixed(2).padStart(9)} ${net.toFixed(0).padStart(6)} ${range.toFixed(0).padStart(6)}  ${eff.toFixed(2).padStart(6)}   ${reg}`);
}

// ── regime-stratified split: alternate days within each regime ──
const TRAIN = new Set<string>(), TEST = new Set<string>();
for (const reg of ['UP', 'DOWN', 'RANGE']) {
  const g = days.filter(d => regime[d] === reg);
  g.forEach((d, i) => (i % 2 === 0 ? TRAIN : TEST).add(d));
}
const comp = (S: Set<string>) => ['UP', 'DOWN', 'RANGE'].map(r => `${r}:${[...S].filter(d => regime[d] === r).length}`).join(' ');
console.log(`\nTRAIN days ${TRAIN.size} (${comp(TRAIN)})   TEST days ${TEST.size} (${comp(TEST)})`);

function stat(ts: Tr[]) {
  const W = ts.filter(t => t.reason === 'WIN').length, L = ts.filter(t => t.reason === 'LOSS').length;
  const pnl = ts.reduce((s, t) => s + t.pnl, 0);
  return { n: ts.length, W, L, wr: (W + L) ? (W / (W + L) * 100).toFixed(1) + '%' : '—', pnl };
}
function show(label: string, ts: Tr[]) {
  const b = stat(ts), f = stat(ts.filter(t => t.cvd >= FLOOR));
  console.log(`${label.padEnd(12)} BASE n=${String(b.n).padStart(3)} WR=${b.wr.padStart(6)} ${('$' + (b.pnl * USD).toFixed(0)).padStart(7)}   |  cvd≥${FLOOR} n=${String(f.n).padStart(3)} WR=${f.wr.padStart(6)} ${('$' + (f.pnl * USD).toFixed(0)).padStart(7)}`);
}
console.log('\n──── baseline vs cvd≥-1000 filter, by split ────');
const trainT = trades.filter(t => TRAIN.has(t.day)), testT = trades.filter(t => TEST.has(t.day));
show('TRAIN', trainT); show('TEST', testT); show('ALL', trades);

// ── permutation test: does cvd<-1000 pick worse-than-random trades? ──
function perm(ts: Tr[], label: string) {
  const removed = ts.filter(t => t.cvd < FLOOR);
  const k = removed.length;
  if (k === 0) { console.log(`${label}: no cvd<${FLOOR} trades — n/a`); return; }
  const obs = removed.reduce((s, t) => s + t.pnl, 0);
  const pnls = ts.map(t => t.pnl);
  let le = 0;
  for (let i = 0; i < NPERM; i++) {
    // random k distinct indices
    const idx = new Set<number>();
    while (idx.size < k) idx.add(Math.floor(Math.random() * pnls.length));
    let s = 0; for (const j of idx) s += pnls[j]!;
    if (s <= obs) le++;
  }
  const p = le / NPERM;
  console.log(`${label}: removed ${k} trades, observed ΣPnL=${obs.toFixed(0)}pts | permutation p(random-${k} ΣPnL ≤ obs)=${p.toFixed(4)}  (${NPERM} iters)`);
}
console.log(`\n──── permutation test (${NPERM} iters): cvd<${FLOOR} cohort vs random removal ────`);
perm(trades, 'ALL  ');
perm(trainT, 'TRAIN');
perm(testT, 'TEST ');
console.log('');
