// perf_flip_cont_walkforward.ts — walk-forward perf for live FLIP + CONT tradables.
//
// Engine is the canonical Variant A model (same as backtest_a_detail.ts):
//   - source: tradable_signals, action=OPEN, rule ∈ {clean-impulse, cont-reentry}
//   - single position per symbol; same-direction signals while open are ignored
//   - an OPPOSING tradable signal CLOSES the current trade and FLIPS into the
//     opposing direction (close-and-reverse)
//   - tick-by-tick walk over ticks.db; RTH force-close at 15:54 ET
//
// Outcome classification (per Ravi):
//   WIN            — TP hit first
//   LOSS           — SL hit first
//   DRAW           — neither by 15:54 ET (mark-to-close at last tick)
//   Positive Close — closed by the reversing signal with +PnL  (OPP, pnl>0)
//   Negative Close — closed by the reversing signal with -PnL  (OPP, pnl<0)
// All PnL (every category) is added to the total. WR = WIN/(WIN+LOSS).
// Draws and OPP closes are listed individually with their signal (trigger) time.
// Time-of-day buckets use the SIGNAL TRIGGER TIME, not the close time.
//
// TP/SL: clean-impulse 80/55(long)·105(short); cont-reentry 80/70.
// PnL $: MNQ = $2/pt.
//
// Run: pnpm --filter @trading/aggregator exec tsx scripts/perf_flip_cont_walkforward.ts

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tradingDb = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb   = new Database(path.resolve(__dirname, '../../../data/ticks.db'),   { readonly: true });

const USD_PER_PT = 2; // MNQ

function tpsl(ruleId: string, direction: 'long' | 'short'): { tp: number; sl: number } {
  if (ruleId === 'clean-impulse') return { tp: 80, sl: direction === 'long' ? 55 : 105 };
  if (ruleId === 'cont-reentry')  return { tp: 80, sl: 70 };
  throw new Error(`No TP/SL for ${ruleId}`);
}
function rthCloseTs(tsMs: number): number {
  const datePart = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(tsMs));
  const [mm, dd, yyyy] = datePart.split('/');
  return Date.parse(`${yyyy}-${mm}-${dd}T15:54:00-04:00`); // EDT (dataset is May–Jun)
}
const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function etStr(tsMs: number): string {
  const p: Record<string, string> = {};
  for (const x of etFmt.formatToParts(new Date(tsMs))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
function etHour(tsMs: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(new Date(tsMs)).padStart(2, '0');
}
function etMin(tsMs: number): number {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(tsMs))) p[x.type] = x.value;
  return parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10);
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

type Reason = 'TP' | 'SL' | 'OPP' | 'RTH';
interface OpenSig { signal_id: number; ts: number; symbol: string; rule_id: string; direction: 'long'|'short'; entry: number; }
interface Trade { signal_id: number; symbol: string; rule_id: string; direction: 'long'|'short'; open_ts: number; entry: number; close_ts: number; close_price: number; close_reason: Reason; pnl_pts: number; }

const opens = tradingDb.prepare(`
  SELECT signal_id, signal_ts AS ts, symbol, rule_id, direction, entry
  FROM tradable_signals
  WHERE action='OPEN' AND rule_id IN ('clean-impulse','cont-reentry') AND entry IS NOT NULL
    AND symbol='NQ'   -- live MNQ tradables; ES clean-impulse (7 sigs) excluded (MES is $5/pt, diff scale)
  ORDER BY signal_ts ASC
`).all() as OpenSig[];

const openMap = new Map<string, Trade>();
const completed: Trade[] = [];

function finalize(t: Trade, closeTs: number, closePx: number, reason: Reason) {
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

// --tick-accurate: TP/SL frees the position slot the instant it hits (matches
// live tradeManager.onTick), so a later same-direction signal opens a fresh
// re-entry. Default (lazy) frees the slot only on an opposing signal / RTH, so
// same-direction signals fired while the prior trade is still notionally open
// are dropped — undercounts re-entries vs live.
const TICK_ACCURATE = process.argv.includes('--tick-accurate');

// --fl-window: apply the flip-long-pmcore rule — FLIP-long only in 10:30–13:30 ET
// (630–810 min). Filtered at the signal level so out-of-window flip-longs never
// open and never act as an opposing/flip signal. Shorts and CONT untouched.
const FL_WINDOW = process.argv.includes('--fl-window');
const flKept = (s: OpenSig) => !(s.rule_id === 'clean-impulse' && s.direction === 'long') || (etMin(s.ts) >= 630 && etMin(s.ts) < 810);
const sigs = FL_WINDOW ? opens.filter(flKept) : opens;
const flDropped = opens.length - sigs.length;

for (const s of sigs) {
  const ex = openMap.get(s.symbol);
  if (ex) {
    if (TICK_ACCURATE) {
      const { tp, sl } = tpsl(ex.rule_id, ex.direction);
      const hit = walkForExit(ex.symbol, ex.open_ts, s.ts, ex.entry, ex.direction, tp, sl);
      if (hit) {                                   // TP/SL already resolved → slot free, open s below
        finalize(ex, hit.ts, hit.price, hit.reason);
        openMap.delete(s.symbol);
      } else if (ex.direction === s.direction) {
        continue;                                  // still open, same dir → no stacking
      } else {
        finalize(ex, s.ts, s.entry, 'OPP');        // still open, opposing → OPP close + flip
        openMap.delete(s.symbol);
      }
    } else {
      if (ex.direction === s.direction) continue;  // lazy: same dir while open → ignore
      closeAt(ex, s.ts, s.entry, 'OPP');           // lazy: opposing → close (walk finds TP/SL or OPP)
      openMap.delete(s.symbol);
    }
  }
  openMap.set(s.symbol, {                          // open (or flip into) the signal's direction
    signal_id: s.signal_id, symbol: s.symbol, rule_id: s.rule_id,
    direction: s.direction, open_ts: s.ts, entry: s.entry,
    close_ts: 0, close_price: 0, close_reason: 'TP', pnl_pts: 0,
  });
}
for (const [, t] of openMap) {
  const closeTs = rthCloseTs(t.open_ts);
  const ts = closeTs > t.open_ts ? closeTs : rthCloseTs(t.open_ts + 86_400_000);
  const r = lastTickStmt.get(t.symbol, ts) as { price: number } | undefined;
  if (r?.price != null) closeAt(t, ts, r.price, 'RTH');
}

// ── Classify ───────────────────────────────────────────────────────────────
type Cat = 'WIN' | 'LOSS' | 'DRAW' | 'POS' | 'NEG';
function cat(t: Trade): Cat {
  if (t.close_reason === 'TP') return 'WIN';
  if (t.close_reason === 'SL') return 'LOSS';
  if (t.close_reason === 'RTH') return 'DRAW';
  return t.pnl_pts >= 0 ? 'POS' : 'NEG'; // OPP
}

interface Agg { n: number; WIN: number; LOSS: number; DRAW: number; POS: number; NEG: number; pnl: number; }
const blank = (): Agg => ({ n: 0, WIN: 0, LOSS: 0, DRAW: 0, POS: 0, NEG: 0, pnl: 0 });
function add(a: Agg, t: Trade) { a.n++; a[cat(t)]++; a.pnl += t.pnl_pts; }
function wr(a: Agg): string { const d = a.WIN + a.LOSS; return d ? (a.WIN / d * 100).toFixed(1) + '%' : '—'; }
const usd = (pts: number) => (pts >= 0 ? '+' : '') + '$' + (pts * USD_PER_PT).toFixed(0);
const pp  = (pts: number) => (pts >= 0 ? '+' : '') + pts.toFixed(1);

console.log(`\nWalk-forward FLIP + CONT tradables — ${completed.length} trades  [${TICK_ACCURATE ? 'TICK-ACCURATE: TP/SL frees slot (≈live)' : 'LAZY: slot freed only on opposing signal/RTH'}]`);
if (FL_WINDOW) console.log(`FLIP-LONG WINDOW FILTER ON: flip-longs kept only 10:30–13:30 ET — dropped ${flDropped} out-of-window flip-long signals`);
const dr = `${etStr(Math.min(...completed.map(t => t.open_ts)))}  →  ${etStr(Math.max(...completed.map(t => t.open_ts)))} ET`;
console.log(`signals ${sigs.length}${FL_WINDOW ? ` (of ${opens.length})` : ''} | trades ${completed.length} | ${dr}`);
console.log('TP/SL: clean-impulse 80/55L·105S, cont-reentry 80/70 | $ = MNQ $2/pt | WR = WIN/(WIN+LOSS)');

function table(title: string, rows: Array<[string, Agg]>) {
  console.log(`\n──────── ${title} ────────`);
  console.log('group           n   WIN  LOSS  DRAW  +Cls  -Cls    WR      PnL(pts)     PnL($)');
  for (const [name, a] of rows) {
    console.log(
      `${name.padEnd(14)} ${String(a.n).padStart(3)}  ${String(a.WIN).padStart(4)} ${String(a.LOSS).padStart(5)} ${String(a.DRAW).padStart(5)} ${String(a.POS).padStart(5)} ${String(a.NEG).padStart(5)}  ${wr(a).padStart(6)}   ${pp(a.pnl).padStart(9)}  ${usd(a.pnl).padStart(9)}`,
    );
  }
}

// By rule (+ combined)
const byRule = new Map<string, Agg>();
const combined = blank();
for (const t of completed) {
  const k = t.rule_id === 'clean-impulse' ? 'FLIP' : 'CONT';
  if (!byRule.has(k)) byRule.set(k, blank());
  add(byRule.get(k)!, t); add(combined, t);
}
table('By rule', [...byRule.entries(), ['COMBINED', combined]]);

// By rule × direction
const byRD = new Map<string, Agg>();
for (const t of completed) {
  const k = `${t.rule_id === 'clean-impulse' ? 'FLIP' : 'CONT'} ${t.direction}`;
  if (!byRD.has(k)) byRD.set(k, blank());
  add(byRD.get(k)!, t);
}
table('By rule × direction', [...byRD.entries()].sort());

// Time of day (by SIGNAL trigger time), combined + per rule
function todTable(title: string, filter: (t: Trade) => boolean) {
  const m = new Map<string, Agg>();
  for (const t of completed) {
    if (!filter(t)) continue;
    const h = etHour(t.open_ts);
    if (!m.has(h)) m.set(h, blank());
    add(m.get(h)!, t);
  }
  table(title, [...m.entries()].sort());
}
todTable('Time of day — COMBINED (by signal time, ET hour)', () => true);
todTable('Time of day — FLIP', t => t.rule_id === 'clean-impulse');
todTable('Time of day — CONT', t => t.rule_id === 'cont-reentry');

// FLIP by direction × the flip-long-pmcore window (signal time) — answers the
// "flip-longs before 10:30 are bad / skipped" question directly.
const winOf = (t: Trade) => { const m = etMin(t.open_ts); return m < 630 ? 'before 10:30' : m < 810 ? '10:30–13:30' : '13:30–close'; };
for (const dir of ['long', 'short'] as const) {
  const m = new Map<string, Agg>();
  for (const t of completed) {
    if (t.rule_id !== 'clean-impulse' || t.direction !== dir) continue;
    const w = winOf(t);
    if (!m.has(w)) m.set(w, blank());
    add(m.get(w)!, t);
  }
  const order = ['before 10:30', '10:30–13:30', '13:30–close'];
  table(`FLIP ${dir} by window (signal time)`, order.filter(o => m.has(o)).map(o => [o, m.get(o)!] as [string, Agg]));
}

// ── Lists: DRAWs and OPP closes (with signal trigger time) ──────────────────
function detailList(title: string, rows: Trade[], tagFn?: (t: Trade) => string) {
  console.log(`\n──────── ${title} (${rows.length}) ────────`);
  if (!rows.length) { console.log('  (none)'); return; }
  console.log('signal_time (ET)      rule   dir     entry      close     pnl(pts)    pnl($)' + (tagFn ? '   tag' : ''));
  for (const t of rows.sort((a, b) => a.open_ts - b.open_ts)) {
    const k = t.rule_id === 'clean-impulse' ? 'FLIP' : 'CONT';
    console.log(
      `${etStr(t.open_ts)}  ${k}   ${t.direction.padEnd(5)} ${String(t.entry).padStart(9)} ${t.close_price.toFixed(2).padStart(9)}  ${pp(t.pnl_pts).padStart(9)}  ${usd(t.pnl_pts).padStart(8)}` + (tagFn ? `   ${tagFn(t)}` : ''),
    );
  }
}
detailList('DRAWs — RTH 15:54 close', completed.filter(t => t.close_reason === 'RTH'));
detailList('OPP closes — closed by reversing signal', completed.filter(t => t.close_reason === 'OPP'),
  t => (t.pnl_pts >= 0 ? 'Positive Close' : 'Negative Close'));

console.log(`\nTOTAL PnL: ${pp(combined.pnl)} pts = ${usd(combined.pnl)}  (all categories included)\n`);
