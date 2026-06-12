// Variant A backtest, filtered to today's (ET) trades only.
// Same engine as backtest_a_detail.ts; prints only trades whose open_ts
// falls in today's ET calendar day.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tradingDb = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb   = new Database(path.resolve(__dirname, '../../../data/ticks.db'),   { readonly: true });

function tpsl(ruleId: string, direction: 'long' | 'short'): { tp: number; sl: number } {
  if (ruleId === 'clean-impulse') return { tp: 80, sl: direction === 'long' ? 55 : 105 };
  if (ruleId === 'cont-reentry')  return { tp: 80, sl: 70 };
  throw new Error(`No TP/SL for ${ruleId}`);
}
function etDateOf(tsMs: number): string {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(tsMs));
  const [mm, dd, yyyy] = p.split('/');
  return `${yyyy}-${mm}-${dd}`;
}
function rthCloseTs(tsMs: number): number {
  const d = etDateOf(tsMs);
  return Date.parse(`${d}T15:54:00-04:00`);
}

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

interface OpenSig { signal_id: number; ts: number; symbol: string; rule_id: string; direction: 'long'|'short'; entry: number; }
interface Trade { signal_id: number; symbol: string; rule_id: string; direction: 'long'|'short'; open_ts: number; entry: number; close_ts: number; close_price: number; close_reason: 'TP'|'SL'|'OPP'|'RTH'|'OPEN_STILL'; pnl_pts: number; }

const opens = tradingDb.prepare(`
  SELECT signal_id, signal_ts AS ts, symbol, rule_id, direction, entry
  FROM tradable_signals
  WHERE action='OPEN' AND rule_id IN ('clean-impulse','cont-reentry') AND entry IS NOT NULL
  ORDER BY signal_ts ASC
`).all() as OpenSig[];

const openMap = new Map<string, Trade>();
const completed: Trade[] = [];

function finalize(t: Trade, closeTs: number, closePx: number, reason: Trade['close_reason']) {
  t.close_ts = closeTs; t.close_price = closePx; t.close_reason = reason;
  t.pnl_pts = t.direction === 'long' ? closePx - t.entry : t.entry - closePx;
  completed.push(t);
}
function closeAt(t: Trade, exitTs: number, fallbackPx: number, fallbackReason: 'OPP'|'RTH') {
  const { tp, sl } = tpsl(t.rule_id, t.direction);
  const hit = walkForExit(t.symbol, t.open_ts, exitTs, t.entry, t.direction, tp, sl);
  if (hit) finalize(t, hit.ts, hit.price, hit.reason);
  else finalize(t, exitTs, fallbackPx, fallbackReason);
}

const TODAY_ET = etDateOf(Date.now());

for (const s of opens) {
  const ex = openMap.get(s.symbol);
  if (ex) {
    if (ex.direction !== s.direction) {
      closeAt(ex, s.ts, s.entry, 'OPP');
      openMap.delete(s.symbol);
    } else {
      continue; // cooldown
    }
  }
  openMap.set(s.symbol, {
    signal_id: s.signal_id, symbol: s.symbol, rule_id: s.rule_id,
    direction: s.direction, open_ts: s.ts, entry: s.entry,
    close_ts: 0, close_price: 0, close_reason: 'TP', pnl_pts: 0,
  });
}
// Still-open trades: attempt TP/SL walk up to now; if untouched mark OPEN_STILL.
const NOW = Date.now();
for (const [, t] of openMap) {
  const { tp, sl } = tpsl(t.rule_id, t.direction);
  const hit = walkForExit(t.symbol, t.open_ts, NOW, t.entry, t.direction, tp, sl);
  if (hit) {
    finalize(t, hit.ts, hit.price, hit.reason);
  } else {
    const r = lastTickStmt.get(t.symbol, NOW) as { price: number } | undefined;
    const px = r?.price ?? t.entry;
    t.close_ts = NOW; t.close_price = px; t.close_reason = 'OPEN_STILL';
    t.pnl_pts = t.direction === 'long' ? px - t.entry : t.entry - px;
    completed.push(t);
  }
}

const fmtEt = (ts: number) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }).format(new Date(ts));

console.log(`\n──────── Trades OPENED today (${TODAY_ET} ET) — part of Variant A cohort ────────`);
console.log('et_open               rule           dir     entry      close     pnl_pts   reason   W/L');
let oC = 0, oW = 0, oL = 0, oP = 0;
for (const t of completed.filter(x => etDateOf(x.open_ts) === TODAY_ET).sort((a,b) => a.open_ts - b.open_ts)) {
  const wl = t.pnl_pts > 0 ? 'WIN' : t.pnl_pts < 0 ? 'LOSS' : 'FLAT';
  const p = (t.pnl_pts >= 0 ? '+' : '') + t.pnl_pts.toFixed(2);
  console.log(`${fmtEt(t.open_ts)}  ${t.rule_id.padEnd(14)} ${t.direction.padEnd(6)} ${String(t.entry).padStart(9)} ${String(t.close_price).padStart(9)}  ${p.padStart(8)}  ${t.close_reason.padEnd(8)} ${wl}`);
  oC++; if (t.pnl_pts > 0) oW++; else if (t.pnl_pts < 0) oL++; oP += t.pnl_pts;
}
console.log(`SUBTOTAL: ${oC} trades — ${oW}W / ${oL}L — net ${(oP>=0?'+':'')+oP.toFixed(2)} pts`);

console.log(`\n──────── Trades CLOSED today (opened earlier, P&L attributed today) ────────`);
console.log('et_open               et_close              rule           dir     entry      close     pnl_pts   reason   W/L');
let cC = 0, cW = 0, cL = 0, cP = 0;
for (const t of completed.filter(x => etDateOf(x.open_ts) !== TODAY_ET && etDateOf(x.close_ts) === TODAY_ET).sort((a,b) => a.close_ts - b.close_ts)) {
  const wl = t.pnl_pts > 0 ? 'WIN' : t.pnl_pts < 0 ? 'LOSS' : 'FLAT';
  const p = (t.pnl_pts >= 0 ? '+' : '') + t.pnl_pts.toFixed(2);
  console.log(`${fmtEt(t.open_ts)}  ${fmtEt(t.close_ts)}  ${t.rule_id.padEnd(14)} ${t.direction.padEnd(6)} ${String(t.entry).padStart(9)} ${String(t.close_price).padStart(9)}  ${p.padStart(8)}  ${t.close_reason.padEnd(8)} ${wl}`);
  cC++; if (t.pnl_pts > 0) cW++; else if (t.pnl_pts < 0) cL++; cP += t.pnl_pts;
}
console.log(`SUBTOTAL: ${cC} trades — ${cW}W / ${cL}L — net ${(cP>=0?'+':'')+cP.toFixed(2)} pts`);

// Also show today's SKIP rows from tradable_signals so the user sees the full picture.
const skipsToday = tradingDb.prepare(`
  SELECT signal_ts, symbol, rule_id, pattern, direction, action, reason
  FROM tradable_signals
  WHERE rule_id IN ('clean-impulse','cont-reentry')
    AND action != 'OPEN'
    AND signal_ts >= ?
  ORDER BY signal_ts
`).all(Date.parse(`${TODAY_ET}T00:00:00-04:00`)) as { signal_ts: number; symbol: string; rule_id: string; pattern: string|null; direction: string; action: string; reason: string }[];
console.log(`\n──────── FLIP/CONT signals today that were SKIPPED ────────`);
console.log('et                    rule           dir     action               reason');
for (const s of skipsToday) {
  console.log(`${fmtEt(s.signal_ts)}  ${s.rule_id.padEnd(14)} ${s.direction.padEnd(6)} ${s.action.padEnd(20)} ${s.reason}`);
}
