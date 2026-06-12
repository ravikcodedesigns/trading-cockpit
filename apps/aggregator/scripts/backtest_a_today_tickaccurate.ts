// Tick-accurate Variant A replay for today's signals only.
// Difference from backtest_a_today.ts: when a trade is open, every same-symbol
// tick is checked for TP/SL — so the open trade gets cleared at the actual hit
// time (not deferred until the next opposite signal). This matches live behavior
// (tradeManager.onTick()).

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
const TODAY_ET = '2026-06-08';
const dayStartMs = Date.parse(`${TODAY_ET}T00:00:00-04:00`);
const dayEndMs   = Date.parse(`${TODAY_ET}T23:59:59-04:00`);
const rthCloseMs = Date.parse(`${TODAY_ET}T15:54:00-04:00`);
const fmtEt = (ts: number) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }).format(new Date(ts));

interface OpenSig { ts: number; symbol: string; rule_id: string; direction: 'long'|'short'; entry: number; }
const todaySigs = tradingDb.prepare(`
  SELECT signal_ts AS ts, symbol, rule_id, direction, entry
  FROM tradable_signals
  WHERE action='OPEN' AND rule_id IN ('clean-impulse','cont-reentry') AND entry IS NOT NULL
    AND signal_ts >= ? AND signal_ts <= ?
  ORDER BY signal_ts ASC
`).all(dayStartMs, dayEndMs) as OpenSig[];

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
  open_ts: number; entry: number;
  close_ts: number; close_price: number; close_reason: 'TP'|'SL'|'OPP'|'RTH'|'OPEN_STILL';
  pnl_pts: number;
}
const completed: Trade[] = [];
const open = new Map<string, Trade>();

function tryCloseByTick(symbol: string, untilTs: number): boolean {
  // Walk ticks from open_ts → untilTs; if TP/SL hit, finalize trade and return true.
  const t = open.get(symbol);
  if (!t) return false;
  const { tp, sl } = tpsl(t.rule_id, t.direction);
  const hit = walkForExit(symbol, t.open_ts, untilTs, t.entry, t.direction, tp, sl);
  if (!hit) return false;
  t.close_ts = hit.ts; t.close_price = hit.price; t.close_reason = hit.reason;
  t.pnl_pts = t.direction === 'long' ? hit.price - t.entry : t.entry - hit.price;
  completed.push(t);
  open.delete(symbol);
  return true;
}

for (const s of todaySigs) {
  // First: see if an open trade was already SL/TP'd by ticks since it opened.
  tryCloseByTick(s.symbol, s.ts);

  const ex = open.get(s.symbol);
  if (ex) {
    if (ex.direction === s.direction) {
      // Real same-direction cooldown — skip this signal entirely.
      continue;
    }
    // Opposite direction. In production V3 also requires this rule_id ∈ tradableExitRules.
    // We're already filtering to FLIP+CONT, so all qualify.
    ex.close_ts = s.ts; ex.close_price = s.entry; ex.close_reason = 'OPP';
    ex.pnl_pts = ex.direction === 'long' ? s.entry - ex.entry : ex.entry - s.entry;
    completed.push(ex);
    open.delete(s.symbol);
  }

  open.set(s.symbol, {
    symbol: s.symbol, rule_id: s.rule_id, direction: s.direction,
    open_ts: s.ts, entry: s.entry,
    close_ts: 0, close_price: 0, close_reason: 'TP', pnl_pts: 0,
  });
}

// After all signals, check for TP/SL hits on any still-open trade, then RTH close.
for (const sym of [...open.keys()]) {
  if (tryCloseByTick(sym, rthCloseMs)) continue;
  const t = open.get(sym)!;
  const r = lastTickStmt.get(sym, rthCloseMs) as { price: number } | undefined;
  const px = r?.price ?? t.entry;
  t.close_ts = rthCloseMs; t.close_price = px; t.close_reason = 'RTH';
  t.pnl_pts = t.direction === 'long' ? px - t.entry : t.entry - px;
  completed.push(t);
  open.delete(sym);
}

console.log(`\n──────── Tick-accurate Variant A replay — TODAY ONLY (${TODAY_ET} ET) ────────`);
console.log('et_open    et_close   rule           dir     entry      close     pnl_pts   reason   W/L');
let n = 0, w = 0, l = 0, p = 0;
for (const t of completed.sort((a,b) => a.open_ts - b.open_ts)) {
  const wl = t.pnl_pts > 0 ? 'WIN' : t.pnl_pts < 0 ? 'LOSS' : 'FLAT';
  const pn = (t.pnl_pts >= 0 ? '+' : '') + t.pnl_pts.toFixed(2);
  console.log(`${fmtEt(t.open_ts).padEnd(9)}  ${fmtEt(t.close_ts).padEnd(9)}  ${t.rule_id.padEnd(14)} ${t.direction.padEnd(6)} ${String(t.entry).padStart(9)} ${String(t.close_price).padStart(9)}  ${pn.padStart(8)}  ${t.close_reason.padEnd(8)} ${wl}`);
  n++; if (t.pnl_pts > 0) w++; else if (t.pnl_pts < 0) l++; p += t.pnl_pts;
}
console.log(`\nTOTAL: ${n} trades — ${w}W / ${l}L — net ${(p>=0?'+':'')+p.toFixed(2)} pts`);
console.log(`(Compare to backtest_a_today.ts which deferred TP/SL checks until next opp signal → 2 trades, -160 pts)`);
