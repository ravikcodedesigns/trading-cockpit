// Conditional EV: do trades fired AFTER a losing morning still hold a positive edge?
//
// For every Variant A trade across history:
//   - Replay the day tick-accurately (TP/SL checked on every tick, not deferred)
//   - Apply per-day RTH 15:54 ET close between days (resets running P&L)
//   - At entry time of each trade, snapshot the day's running P&L SO FAR
//   - Bucket the trade by that snapshot
//   - Report WR, avg PnL, total PnL per bucket → tells you whether a daily
//     loss-limit would help or hurt
//
// MNQ = $2/pt.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tradingDb = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb   = new Database(path.resolve(__dirname, '../../../data/ticks.db'),   { readonly: true });

const DOLLAR_PER_PT = 2;

function tpsl(ruleId: string, direction: 'long' | 'short'): { tp: number; sl: number } {
  if (ruleId === 'clean-impulse') return { tp: 80, sl: direction === 'long' ? 55 : 105 };
  if (ruleId === 'cont-reentry')  return { tp: 80, sl: 70 };
  throw new Error(`No TP/SL for ${ruleId}`);
}
const fmtEtDate = (tsMs: number) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(tsMs));
  const [mm, dd, yyyy] = p.split('/');
  return `${yyyy}-${mm}-${dd}`;
};
const rthCloseTs = (tsMs: number): number => Date.parse(`${fmtEtDate(tsMs)}T15:54:00-04:00`);

interface OpenSig { ts: number; symbol: string; rule_id: string; direction: 'long'|'short'; entry: number; }
const allSigs = tradingDb.prepare(`
  SELECT signal_ts AS ts, symbol, rule_id, direction, entry
  FROM tradable_signals
  WHERE action='OPEN' AND rule_id IN ('clean-impulse','cont-reentry') AND entry IS NOT NULL
  ORDER BY signal_ts ASC
`).all() as OpenSig[];

const tickQuery = ticksDb.prepare('SELECT ts, price FROM trades WHERE symbol = ? AND ts > ? AND ts <= ? ORDER BY ts ASC');
function walkForExit(symbol: string, openTs: number, exitTs: number, entry: number, dir: 'long'|'short', tp: number, sl: number) {
  const tpPx = dir === 'long' ? entry + tp : entry - tp;
  const slPx = dir === 'long' ? entry - sl : entry + sl;
  for (const r of tickQuery.iterate(symbol, openTs, exitTs) as IterableIterator<{ts:number; price:number}>) {
    if (dir === 'long') {
      if (r.price <= slPx) return { ts: r.ts, price: slPx, reason: 'SL' as const };
      if (r.price >= tpPx) return { ts: r.ts, price: tpPx, reason: 'TP' as const };
    } else {
      if (r.price >= slPx) return { ts: r.ts, price: slPx, reason: 'SL' as const };
      if (r.price <= tpPx) return { ts: r.ts, price: tpPx, reason: 'TP' as const };
    }
  }
  return null;
}
const lastTickStmt = ticksDb.prepare('SELECT price FROM trades WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT 1');

interface Trade {
  symbol: string; rule_id: string; direction: 'long'|'short';
  open_ts: number; entry: number; et_date: string;
  close_ts: number; close_price: number; close_reason: 'TP'|'SL'|'OPP'|'RTH';
  pnl_pts: number;
  running_pnl_before_pts: number; // sum of pnl_pts of trades earlier today and already closed by open_ts
}
const completed: Trade[] = [];
const open = new Map<string, Trade>();
// Per ET-date, running sum of CLOSED-trade pnl_pts as of "now".
const dayRunningPts = new Map<string, number>();

function finalizeAndCredit(t: Trade, closeTs: number, closePx: number, reason: Trade['close_reason']) {
  t.close_ts = closeTs; t.close_price = closePx; t.close_reason = reason;
  t.pnl_pts = t.direction === 'long' ? closePx - t.entry : t.entry - closePx;
  completed.push(t);
  dayRunningPts.set(t.et_date, (dayRunningPts.get(t.et_date) ?? 0) + t.pnl_pts);
}
function tryCloseOpenTradeByTick(symbol: string, untilTs: number) {
  const t = open.get(symbol);
  if (!t) return;
  const { tp, sl } = tpsl(t.rule_id, t.direction);
  const hit = walkForExit(symbol, t.open_ts, untilTs, t.entry, t.direction, tp, sl);
  if (hit) {
    finalizeAndCredit(t, hit.ts, hit.price, hit.reason);
    open.delete(symbol);
  }
}
function closeAllAtRth(rthTs: number) {
  for (const sym of [...open.keys()]) {
    tryCloseOpenTradeByTick(sym, rthTs);
    if (!open.has(sym)) continue;
    const t = open.get(sym)!;
    const r = lastTickStmt.get(sym, rthTs) as { price: number } | undefined;
    const px = r?.price ?? t.entry;
    finalizeAndCredit(t, rthTs, px, 'RTH');
    open.delete(sym);
  }
}

let prevEtDate: string | null = null;
for (const s of allSigs) {
  const etDate = fmtEtDate(s.ts);

  // Day boundary: close out everything still open at the prior day's RTH bell.
  if (prevEtDate && etDate !== prevEtDate) {
    closeAllAtRth(rthCloseTs(allSigs[allSigs.indexOf(s) - 1]!.ts));
  }
  prevEtDate = etDate;

  // Settle TP/SL on the open trade up to NOW (s.ts).
  tryCloseOpenTradeByTick(s.symbol, s.ts);

  const ex = open.get(s.symbol);
  if (ex) {
    if (ex.direction === s.direction) continue; // same-side cooldown
    // Opposite direction → OPP-close at incoming entry, then open new.
    finalizeAndCredit(ex, s.ts, s.entry, 'OPP');
    open.delete(s.symbol);
  }

  open.set(s.symbol, {
    symbol: s.symbol, rule_id: s.rule_id, direction: s.direction,
    open_ts: s.ts, entry: s.entry, et_date: etDate,
    close_ts: 0, close_price: 0, close_reason: 'TP', pnl_pts: 0,
    running_pnl_before_pts: dayRunningPts.get(etDate) ?? 0,
  });
}
// Final day's RTH close.
if (prevEtDate) closeAllAtRth(rthCloseTs(allSigs[allSigs.length - 1]!.ts));

// Bucket by running $ P&L at entry
interface Bucket { label: string; lo: number; hi: number; trades: Trade[]; }
const buckets: Bucket[] = [
  { label: '+$200 or more     ', lo:  200,        hi: Infinity, trades: [] },
  { label: '$0 to +$200       ', lo:  0,          hi: 200,      trades: [] },
  { label: '-$200 to $0       ', lo: -200,        hi: 0,        trades: [] },
  { label: '-$400 to -$200    ', lo: -400,        hi: -200,     trades: [] },
  { label: '-$500 to -$400    ', lo: -500,        hi: -400,     trades: [] },
  { label: '-$700 to -$500    ', lo: -700,        hi: -500,     trades: [] },
  { label: 'below -$700       ', lo: -Infinity,   hi: -700,     trades: [] },
];

for (const t of completed) {
  const runningDollar = t.running_pnl_before_pts * DOLLAR_PER_PT;
  for (const b of buckets) {
    if (runningDollar >= b.lo && runningDollar < b.hi) { b.trades.push(t); break; }
  }
}

console.log('\n──────── Conditional EV by running-day P&L at entry ────────');
console.log('Running P&L at entry │  n   │  W   │  L   │  WR%   │  TotPnL($)  │  AvgPnL($)/trade');
console.log('─────────────────────┼──────┼──────┼──────┼────────┼─────────────┼──────────────────');
for (const b of buckets) {
  const n = b.trades.length;
  const w = b.trades.filter(t => t.pnl_pts > 0).length;
  const l = b.trades.filter(t => t.pnl_pts < 0).length;
  const totPts = b.trades.reduce((a, t) => a + t.pnl_pts, 0);
  const totDol = totPts * DOLLAR_PER_PT;
  const avgDol = n ? totDol / n : 0;
  const wr = (w + l) ? (w / (w + l)) * 100 : 0;
  const wrStr = (w + l) ? `${wr.toFixed(1)}%` : '   —';
  console.log(`${b.label} │ ${String(n).padStart(4)} │ ${String(w).padStart(4)} │ ${String(l).padStart(4)} │ ${wrStr.padStart(6)} │ ${(totDol>=0?'+':'') + '$' + totDol.toFixed(0).padStart(6)} │ ${(avgDol>=0?'+':'') + '$' + avgDol.toFixed(1).padStart(6)}`);
}
const allN = completed.length;
const allW = completed.filter(t => t.pnl_pts > 0).length;
const allL = completed.filter(t => t.pnl_pts < 0).length;
const allTotDol = completed.reduce((a, t) => a + t.pnl_pts, 0) * DOLLAR_PER_PT;
console.log('─────────────────────┼──────┼──────┼──────┼────────┼─────────────┼──────────────────');
console.log(`OVERALL              │ ${String(allN).padStart(4)} │ ${String(allW).padStart(4)} │ ${String(allL).padStart(4)} │ ${((allW/(allW+allL))*100).toFixed(1).padStart(5)}% │ ${(allTotDol>=0?'+':'') + '$' + allTotDol.toFixed(0).padStart(6)} │ ${(allTotDol/allN>=0?'+':'') + '$' + (allTotDol/allN).toFixed(1).padStart(6)}`);

// Also: what would each $-loss-limit have done? Drop all trades whose
// running_pnl_before_pts*$2 < -limit.
console.log('\n──────── Hypothetical daily loss-limit impact ────────');
console.log('Limit       │ trades kept │ trades cut │ WR (kept) │ Net $ (kept) │ Net $ cut (foregone P&L)');
console.log('────────────┼─────────────┼────────────┼───────────┼──────────────┼─────────────────────────');
for (const lim of [200, 300, 400, 500, 700, 1000]) {
  const kept = completed.filter(t => t.running_pnl_before_pts * DOLLAR_PER_PT > -lim);
  const cut  = completed.filter(t => t.running_pnl_before_pts * DOLLAR_PER_PT <= -lim);
  const keptW = kept.filter(t => t.pnl_pts > 0).length;
  const keptL = kept.filter(t => t.pnl_pts < 0).length;
  const keptDol = kept.reduce((a, t) => a + t.pnl_pts, 0) * DOLLAR_PER_PT;
  const cutDol = cut.reduce((a, t) => a + t.pnl_pts, 0) * DOLLAR_PER_PT;
  const wr = (keptW + keptL) ? `${((keptW / (keptW + keptL)) * 100).toFixed(1)}%` : '—';
  console.log(`-$${String(lim).padEnd(7)} │  ${String(kept.length).padStart(10)} │ ${String(cut.length).padStart(10)} │  ${wr.padStart(7)} │  ${((keptDol>=0?'+':'')+'$'+keptDol.toFixed(0)).padStart(10)} │  ${((cutDol>=0?'+':'')+'$'+cutDol.toFixed(0)).padStart(10)}`);
}
console.log(`(no limit) │  ${String(allN).padStart(10)} │          0 │  ${((allW/(allW+allL))*100).toFixed(1)}% │  ${((allTotDol>=0?'+':'')+'$'+allTotDol.toFixed(0)).padStart(10)} │  $0`);
