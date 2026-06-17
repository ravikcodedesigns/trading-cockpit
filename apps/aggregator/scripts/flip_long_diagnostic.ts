// flip_long_diagnostic.ts — deep-dive on tradable FLIP LONGs (clean-impulse long, NQ).
// Each tradable OPEN walked independently: TP=80, SL=55, RTH 15:54 = OPEN (mark-to-close).
// WIN=TP first, LOSS=SL first. No MFE/MAE. $ = MNQ $2/pt. Breakeven WR = 55/135 = 40.7%.
// Slices: by date (trend), time-of-day window, score band, CVD regime; + recent losers.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tradingDb = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb = new Database(path.resolve(__dirname, '../../../data/ticks.db'), { readonly: true });
const TP = 80, SL = 55, USD = 2;

function rthCloseTs(tsMs: number): number {
  const dp = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(tsMs));
  const [mm, dd, yyyy] = dp.split('/');
  return Date.parse(`${yyyy}-${mm}-${dd}T15:54:00-04:00`);
}
function etDate(tsMs: number): string {
  const dp = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(tsMs));
  const [mm, dd, yyyy] = dp.split('/'); return `${yyyy}-${mm}-${dd}`;
}
function etMin(tsMs: number): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(tsMs));
  const h = +(p.find(x => x.type === 'hour')!.value), m = +(p.find(x => x.type === 'minute')!.value); return h * 60 + m;
}
function etHHMM(tsMs: number): string {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(tsMs)); return p;
}

const tickQ = ticksDb.prepare('SELECT ts, price FROM trades WHERE symbol=? AND ts>? AND ts<=? ORDER BY ts ASC');
const lastTick = ticksDb.prepare('SELECT price FROM trades WHERE symbol=? AND ts<=? ORDER BY ts DESC LIMIT 1');

interface Row { signal_id: number; signal_ts: number; score: number | null; cvd_session: number | null; entry: number; }
const rows = tradingDb.prepare(`
  SELECT signal_id, signal_ts, score, cvd_session, entry
  FROM tradable_signals
  WHERE rule_id='clean-impulse' AND direction='long' AND action='OPEN' AND symbol='NQ' AND entry IS NOT NULL
  ORDER BY signal_ts ASC
`).all() as Row[];

interface Tr extends Row { reason: 'WIN' | 'LOSS' | 'OPEN'; pnl: number; et: string; min: number; }
const trades: Tr[] = [];
for (const r of rows) {
  const close = rthCloseTs(r.signal_ts);
  const exitTs = close > r.signal_ts ? close : rthCloseTs(r.signal_ts + 86_400_000);
  const tpPx = r.entry + TP, slPx = r.entry - SL;
  let reason: Tr['reason'] = 'OPEN', cl = r.entry;
  for (const t of tickQ.iterate(r.symbol ? 'NQ' : 'NQ', r.signal_ts, exitTs) as IterableIterator<{ ts: number; price: number }>) {
    if (t.price >= tpPx) { reason = 'WIN'; cl = tpPx; break; }
    if (t.price <= slPx) { reason = 'LOSS'; cl = slPx; break; }
  }
  if (reason === 'OPEN') cl = (lastTick.get('NQ', exitTs) as { price: number } | undefined)?.price ?? r.entry;
  trades.push({ ...r, reason, pnl: cl - r.entry, et: etDate(r.signal_ts), min: etMin(r.signal_ts) });
}

function stat(ts: Tr[]) {
  const W = ts.filter(t => t.reason === 'WIN').length, L = ts.filter(t => t.reason === 'LOSS').length, O = ts.filter(t => t.reason === 'OPEN').length;
  const pnl = ts.reduce((s, t) => s + t.pnl, 0);
  const wr = (W + L) ? (W / (W + L) * 100).toFixed(1) + '%' : '—';
  return { n: ts.length, W, L, O, wr, pnl };
}
function line(label: string, ts: Tr[]) {
  const s = stat(ts);
  console.log(`${label.padEnd(16)} n=${String(s.n).padStart(3)}  W=${String(s.W).padStart(3)} L=${String(s.L).padStart(3)} O=${String(s.O).padStart(2)}  WR=${s.wr.padStart(6)}  ${(s.pnl >= 0 ? '+' : '') + s.pnl.toFixed(0)}pts  ${(s.pnl >= 0 ? '+' : '') + '$' + (s.pnl * USD).toFixed(0)}`);
}

console.log(`\n════ TRADABLE FLIP LONGS (clean-impulse long, NQ) — TP${TP}/SL${SL}, breakeven WR 40.7% ════`);
line('OVERALL', trades);

console.log('\n──── by DATE (chronological — is failure rate growing?) ────');
const days = [...new Set(trades.map(t => t.et))].sort();
for (const d of days) line(d, trades.filter(t => t.et === d));

console.log('\n──── by TIME-OF-DAY window (signal time) ────');
line('before 10:30', trades.filter(t => t.min < 630));
line('10:30-13:30', trades.filter(t => t.min >= 630 && t.min < 810));
line('13:30-close', trades.filter(t => t.min >= 810));
line('TRADER-GATED ≥10:30', trades.filter(t => t.min >= 630));

console.log('\n──── by SCORE band ────');
line('score <90', trades.filter(t => (t.score ?? 0) < 90));
line('score 90-99', trades.filter(t => (t.score ?? 0) >= 90 && (t.score ?? 0) < 100));
line('score ≥100', trades.filter(t => (t.score ?? 0) >= 100));

console.log('\n──── by CVD-session regime at entry ────');
line('cvd_session <0', trades.filter(t => (t.cvd_session ?? 0) < 0));
line('cvd_session ≥0', trades.filter(t => (t.cvd_session ?? 0) >= 0));

console.log('\n──── cvd_session < 0 cohort (full detail — winners I would cut) ────');
console.log('date        time   score   cvd_sess   entry      reason  pnl');
for (const t of trades.filter(t => (t.cvd_session ?? 0) < 0).sort((a, b) => (a.cvd_session ?? 0) - (b.cvd_session ?? 0))) {
  console.log(`${t.et}  ${etHHMM(t.signal_ts)}  ${String(t.score ?? '').padStart(5)}  ${String(Math.round(t.cvd_session ?? 0)).padStart(8)}  ${String(t.entry).padStart(9)}  ${t.reason.padEnd(5)} ${(t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(1)}`);
}

console.log('\n──── FILTER SCENARIOS (overfit caveat: n is small, thresholds are not reliable) ────');
console.log('filter                               n   W   L   O    WR      PnL$    (cut: W/L)');
function scenario(label: string, pred: (t: Tr) => boolean) {
  const kept = trades.filter(pred), cut = trades.filter(t => !pred(t));
  const cW = cut.filter(t => t.reason === 'WIN').length, cL = cut.filter(t => t.reason === 'LOSS').length;
  const s = stat(kept);
  console.log(`${label.padEnd(34)} ${String(s.n).padStart(3)} ${String(s.W).padStart(3)} ${String(s.L).padStart(3)} ${String(s.O).padStart(2)}  ${s.wr.padStart(6)}  ${((s.pnl >= 0 ? '+' : '') + '$' + (s.pnl * USD).toFixed(0)).padStart(7)}    (${cW}W/${cL}L)`);
}
const cvdOk = (t: Tr) => (t.cvd_session ?? 0) >= -1000;
const notMid = (t: Tr) => !((t.score ?? 0) >= 90 && (t.score ?? 0) < 100);
const hi = (t: Tr) => (t.score ?? 0) >= 100;
const core = (t: Tr) => t.min >= 630 && t.min < 810;
scenario('BASELINE (all)', () => true);
scenario('cvd ≥ -1000', cvdOk);
scenario('score ≥ 100 (cuts <90 winners!)', hi);
scenario('exclude 90-99 band', notMid);
scenario('cvd≥-1000 + score≥100', t => cvdOk(t) && hi(t));
scenario('cvd≥-1000 + exclude 90-99', t => cvdOk(t) && notMid(t));
scenario('cvd≥-1000 + 10:30-13:30', t => cvdOk(t) && core(t));

console.log('\n──── recent 12 (chronological tail) ────');
console.log('date        time   score   cvd_sess   entry      reason  pnl');
for (const t of trades.slice(-12)) {
  console.log(`${t.et}  ${etHHMM(t.signal_ts)}  ${String(t.score ?? '').padStart(5)}  ${String(Math.round(t.cvd_session ?? 0)).padStart(8)}  ${String(t.entry).padStart(9)}  ${t.reason.padEnd(5)} ${(t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(1)}`);
}
console.log('');
