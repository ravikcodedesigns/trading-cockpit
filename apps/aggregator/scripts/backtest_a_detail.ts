// Per-exit-reason breakdown of Variant A backtest, plus per-trade detail
// for OPP and RTH exits so the user can verify W/L bucketing.

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
function rthCloseTs(tsMs: number): number {
  const datePart = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(tsMs));
  const [mm, dd, yyyy] = datePart.split('/');
  return Date.parse(`${yyyy}-${mm}-${dd}T15:54:00-04:00`);
}

const tickQuery = ticksDb.prepare('SELECT ts, price FROM trades WHERE symbol = ? AND ts > ? AND ts <= ? ORDER BY ts ASC');
function walkForExit(symbol: string, openTs: number, exitTs: number, entry: number, dir: 'long'|'short', tp: number, sl: number) {
  const tpPx = dir === 'long' ? entry + tp : entry - tp;
  const slPx = dir === 'long' ? entry - sl : entry + sl;
  for (const r of tickQuery.iterate(symbol, openTs, exitTs) as IterableIterator<{ts:number; price:number}>) {
    if (dir === 'long') {
      if (r.price >= tpPx) return { ts: r.ts, price: tpPx, reason: 'TP' as const };
      if (r.price <= slPx) return { ts: r.ts, price: slPx, reason: 'SL' as const };
    } else {
      if (r.price <= tpPx) return { ts: r.ts, price: tpPx, reason: 'TP' as const };
      if (r.price >= slPx) return { ts: r.ts, price: slPx, reason: 'SL' as const };
    }
  }
  return null;
}
const lastTickStmt = ticksDb.prepare('SELECT price FROM trades WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT 1');

interface OpenSig { signal_id: number; ts: number; symbol: string; rule_id: string; direction: 'long'|'short'; entry: number; }
interface Trade { signal_id: number; symbol: string; rule_id: string; direction: 'long'|'short'; open_ts: number; entry: number; close_ts: number; close_price: number; close_reason: 'TP'|'SL'|'OPP'|'RTH'; pnl_pts: number; }

const opens = tradingDb.prepare(`
  SELECT signal_id, signal_ts AS ts, symbol, rule_id, direction, entry
  FROM tradable_signals
  WHERE action='OPEN' AND rule_id IN ('clean-impulse','cont-reentry') AND entry IS NOT NULL
  ORDER BY signal_ts ASC
`).all() as OpenSig[];

const isClosing = (od: string, id_: string, ir: string) =>
  od !== id_ && (ir === 'clean-impulse' || ir === 'cont-reentry');

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

for (const s of opens) {
  const ex = openMap.get(s.symbol);
  if (ex) {
    if (ex.direction === s.direction) continue;
    if (!isClosing(ex.direction, s.direction, s.rule_id)) continue;
    closeAt(ex, s.ts, s.entry, 'OPP');
    openMap.delete(s.symbol);
  }
  openMap.set(s.symbol, {
    signal_id: s.signal_id, symbol: s.symbol, rule_id: s.rule_id,
    direction: s.direction, open_ts: s.ts, entry: s.entry,
    close_ts: 0, close_price: 0, close_reason: 'TP', pnl_pts: 0,
  });
}
for (const [_, t] of openMap) {
  const closeTs = rthCloseTs(t.open_ts);
  const ts = closeTs > t.open_ts ? closeTs : rthCloseTs(t.open_ts + 86_400_000);
  const r = lastTickStmt.get(t.symbol, ts) as { price: number } | undefined;
  if (r?.price != null) closeAt(t, ts, r.price, 'RTH');
}

// Per-exit-reason breakdown
const byReason: Record<string, { count: number; wins: number; losses: number; pnl: number }> = {};
for (const t of completed) {
  const r = t.close_reason;
  byReason[r] = byReason[r] ?? { count: 0, wins: 0, losses: 0, pnl: 0 };
  byReason[r].count++;
  if (t.pnl_pts > 0)      byReason[r].wins++;
  else if (t.pnl_pts < 0) byReason[r].losses++;
  byReason[r].pnl += t.pnl_pts;
}

console.log('\n──────── Per exit reason ────────');
console.log('Reason  Count   W    L   PnL (pts)');
for (const r of ['TP','SL','OPP','RTH']) {
  const b = byReason[r];
  if (!b) continue;
  console.log(`${r.padEnd(7)} ${String(b.count).padStart(5)} ${String(b.wins).padStart(4)} ${String(b.losses).padStart(4)}  ${(b.pnl >= 0 ? '+' : '') + b.pnl.toFixed(1)}`);
}
const tW = Object.values(byReason).reduce((s,b) => s + b.wins, 0);
const tL = Object.values(byReason).reduce((s,b) => s + b.losses, 0);
const tP = Object.values(byReason).reduce((s,b) => s + b.pnl, 0);
console.log(`TOTAL   ${String(completed.length).padStart(5)} ${String(tW).padStart(4)} ${String(tL).padStart(4)}  ${(tP >= 0 ? '+' : '') + tP.toFixed(1)}`);
console.log(`WR = ${tW}/${tW+tL} = ${(tW/(tW+tL)*100).toFixed(1)}%`);

console.log('\n──────── OPP-EXIT trade-by-trade ────────');
console.log('open_time            rule           dir     entry      close     pnl_pts   W/L');
for (const t of completed.filter(x => x.close_reason === 'OPP').sort((a,b) => a.open_ts - b.open_ts)) {
  const wl = t.pnl_pts > 0 ? 'WIN' : t.pnl_pts < 0 ? 'LOSS' : 'FLAT';
  const ts = new Date(t.open_ts).toISOString().slice(0, 19);
  const p = (t.pnl_pts >= 0 ? '+' : '') + t.pnl_pts.toFixed(2);
  console.log(`${ts}  ${t.rule_id.padEnd(14)} ${t.direction.padEnd(6)} ${String(t.entry).padStart(9)} ${String(t.close_price).padStart(9)}  ${p.padStart(8)}  ${wl}`);
}

console.log('\n──────── RTH-EXIT trade-by-trade ────────');
console.log('open_time            rule           dir     entry      close     pnl_pts   W/L');
for (const t of completed.filter(x => x.close_reason === 'RTH').sort((a,b) => a.open_ts - b.open_ts)) {
  const wl = t.pnl_pts > 0 ? 'WIN' : t.pnl_pts < 0 ? 'LOSS' : 'FLAT';
  const ts = new Date(t.open_ts).toISOString().slice(0, 19);
  const p = (t.pnl_pts >= 0 ? '+' : '') + t.pnl_pts.toFixed(2);
  console.log(`${ts}  ${t.rule_id.padEnd(14)} ${t.direction.padEnd(6)} ${String(t.entry).padStart(9)} ${String(t.close_price).padStart(9)}  ${p.padStart(8)}  ${wl}`);
}
