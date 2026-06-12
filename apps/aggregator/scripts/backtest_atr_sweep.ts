// backtest_atr_sweep.ts — vary ONE variable: the (SL_mult, TP_mult, floor)
// combination on ATR-adaptive TP/SL. Cohort held constant (QUALIFIED only)
// so any improvement vs FIXED is attributable to the multiplier set alone.
//
// Scientific method: same 112 trades, same simulation rules, only the
// TP/SL formula changes per row.
//
// Floors: 'floored' = min(SL_pts, max-floor) — protects against absurdly
// small SLs in low-vol periods (which got hammered in the previous run).
// 'nofloor' = pure ATR scaling, no minimum.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tradingDb = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb   = new Database(path.resolve(__dirname, '../../../data/ticks.db'),   { readonly: true });

const DOLLAR_PER_PT = 2;

function fixedTpsl(ruleId: string, direction: 'long'|'short'): { tp: number; sl: number } {
  if (ruleId === 'clean-impulse') return { tp: 80, sl: direction === 'long' ? 55 : 105 };
  if (ruleId === 'cont-reentry')  return { tp: 80, sl: 70 };
  throw new Error(`No fixed TP/SL for ${ruleId}`);
}

const atrTickStmt = ticksDb.prepare(`SELECT ts, price FROM trades WHERE symbol=? AND ts > ? AND ts <= ?`);
function atr20(symbol: string, atTs: number): number {
  const ticks = atrTickStmt.all(symbol, atTs - 20 * 60_000, atTs) as { ts: number; price: number }[];
  if (ticks.length === 0) return 0;
  const bars = new Map<number, { hi: number; lo: number }>();
  for (const t of ticks) {
    const bucket = Math.floor(t.ts / 60_000) * 60_000;
    const b = bars.get(bucket);
    if (!b) bars.set(bucket, { hi: t.price, lo: t.price });
    else { if (t.price > b.hi) b.hi = t.price; if (t.price < b.lo) b.lo = t.price; }
  }
  if (bars.size === 0) return 0;
  let sum = 0;
  for (const b of bars.values()) sum += (b.hi - b.lo);
  return sum / bars.size;
}

const tickRangeStmt = ticksDb.prepare(`SELECT ts, price FROM trades WHERE symbol=? AND ts > ? AND ts <= ? ORDER BY ts ASC`);
function walkExit(symbol: string, openTs: number, untilTs: number, entry: number, dir: 'long'|'short', tp: number, sl: number) {
  const tpPx = dir === 'long' ? entry + tp : entry - tp;
  const slPx = dir === 'long' ? entry - sl : entry + sl;
  for (const r of tickRangeStmt.iterate(symbol, openTs, untilTs) as IterableIterator<{ ts: number; price: number }>) {
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
const lastTickStmt = ticksDb.prepare(`SELECT price FROM trades WHERE symbol=? AND ts <= ? ORDER BY ts DESC LIMIT 1`);

const fmtEtDate = (tsMs: number) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(tsMs));
  const [mm, dd, yyyy] = p.split('/');
  return `${yyyy}-${mm}-${dd}`;
};
const rthCloseTsFor = (tsMs: number) => Date.parse(`${fmtEtDate(tsMs)}T15:54:00-04:00`);

interface Sig { signal_id: number; ts: number; symbol: string; rule_id: string; direction: 'long'|'short'; entry: number; }
const sigs = tradingDb.prepare(`
  SELECT s.id AS signal_id, s.ts, s.symbol, s.rule_id, s.direction,
         CAST(json_extract(s.payload, '$.entry') AS REAL) AS entry
  FROM signals s
  JOIN tradable_signals t ON t.signal_id = s.id
  WHERE s.rule_id IN ('clean-impulse','cont-reentry')
    AND s.symbol = 'NQ'
    AND t.qualified = 1
    AND CAST(json_extract(s.payload, '$.entry') AS REAL) IS NOT NULL
  ORDER BY s.ts ASC
`).all() as Sig[];

// Pre-compute ATR per signal once (used by all multiplier strategies)
const atrCache = new Map<number, number>();
for (const s of sigs) atrCache.set(s.signal_id, atr20(s.symbol, s.ts));

console.log(`\n══ ATR sweep on QUALIFIED cohort — ${sigs.length} signals ══`);
console.log(`   (cohort held constant; only SL/TP multipliers vary)`);

interface Trade { pnl_pts: number; reason: 'TP'|'SL'|'OPP'|'RTH'; }
type TpslFn = (sig: Sig) => { tp: number; sl: number };
function simulate(tpslFn: TpslFn): Trade[] {
  const completed: Trade[] = [];
  let open: { sig: Sig; tp: number; sl: number } | null = null;
  let prevDate: string | null = null;

  function closeOpenAtRth(rthTs: number) {
    if (!open) return;
    const o = open;
    const hit = walkExit(o.sig.symbol, o.sig.ts, rthTs, o.sig.entry, o.sig.direction, o.tp, o.sl);
    if (hit) {
      const pnl = o.sig.direction === 'long' ? hit.price - o.sig.entry : o.sig.entry - hit.price;
      completed.push({ pnl_pts: pnl, reason: hit.reason });
    } else {
      const r = lastTickStmt.get(o.sig.symbol, rthTs) as { price: number } | undefined;
      const px = r?.price ?? o.sig.entry;
      const pnl = o.sig.direction === 'long' ? px - o.sig.entry : o.sig.entry - px;
      completed.push({ pnl_pts: pnl, reason: 'RTH' });
    }
    open = null;
  }

  for (let i = 0; i < sigs.length; i++) {
    const s = sigs[i]!;
    const etDate = fmtEtDate(s.ts);
    if (prevDate && etDate !== prevDate) closeOpenAtRth(rthCloseTsFor(sigs[i - 1]!.ts));
    prevDate = etDate;

    if (open) {
      const o = open;
      const hit = walkExit(o.sig.symbol, o.sig.ts, s.ts, o.sig.entry, o.sig.direction, o.tp, o.sl);
      if (hit) {
        const pnl = o.sig.direction === 'long' ? hit.price - o.sig.entry : o.sig.entry - hit.price;
        completed.push({ pnl_pts: pnl, reason: hit.reason });
        open = null;
      }
    }
    if (open) {
      if (open.sig.direction === s.direction) continue;
      const o = open;
      const pnl = o.sig.direction === 'long' ? s.entry - o.sig.entry : o.sig.entry - s.entry;
      completed.push({ pnl_pts: pnl, reason: 'OPP' });
      open = null;
    }
    const { tp, sl } = tpslFn(s);
    open = { sig: s, tp, sl };
  }
  if (prevDate) closeOpenAtRth(rthCloseTsFor(sigs[sigs.length - 1]!.ts));
  return completed;
}

interface Stats { n: number; w: number; l: number; wr: number; usd: number; ev: number; tpHits: number; slHits: number; oppExits: number; rthExits: number; }
const statsOf = (trades: Trade[]): Stats => {
  const n = trades.length;
  const w = trades.filter(t => t.pnl_pts > 0).length;
  const l = trades.filter(t => t.pnl_pts < 0).length;
  const usd = trades.reduce((s, t) => s + t.pnl_pts, 0) * DOLLAR_PER_PT;
  const wr = (w + l) ? (w / (w + l)) * 100 : 0;
  return {
    n, w, l, wr, usd, ev: n ? usd / n : 0,
    tpHits:   trades.filter(t => t.reason === 'TP').length,
    slHits:   trades.filter(t => t.reason === 'SL').length,
    oppExits: trades.filter(t => t.reason === 'OPP').length,
    rthExits: trades.filter(t => t.reason === 'RTH').length,
  };
};

interface Variant { label: string; fn: TpslFn; }
const variants: Variant[] = [
  { label: 'FIXED 80/55/70/105 (control)',    fn: (s) => fixedTpsl(s.rule_id, s.direction) },
  { label: 'ATR  1.0×SL 1.5×TP  floor20/30',  fn: (s) => { const a = atrCache.get(s.signal_id)!; return { sl: Math.max(20, a * 1.0), tp: Math.max(30, a * 1.5) }; } },
  { label: 'ATR  1.5×SL 2.0×TP  floor25/40',  fn: (s) => { const a = atrCache.get(s.signal_id)!; return { sl: Math.max(25, a * 1.5), tp: Math.max(40, a * 2.0) }; } },
  { label: 'ATR  2.0×SL 2.5×TP  floor30/50',  fn: (s) => { const a = atrCache.get(s.signal_id)!; return { sl: Math.max(30, a * 2.0), tp: Math.max(50, a * 2.5) }; } },
  { label: 'ATR  2.0×SL 3.0×TP  floor30/50',  fn: (s) => { const a = atrCache.get(s.signal_id)!; return { sl: Math.max(30, a * 2.0), tp: Math.max(50, a * 3.0) }; } },
  { label: 'ATR  1.5×SL 3.0×TP  floor25/50',  fn: (s) => { const a = atrCache.get(s.signal_id)!; return { sl: Math.max(25, a * 1.5), tp: Math.max(50, a * 3.0) }; } },
  { label: 'ATR  2.5×SL 3.5×TP  floor40/60',  fn: (s) => { const a = atrCache.get(s.signal_id)!; return { sl: Math.max(40, a * 2.5), tp: Math.max(60, a * 3.5) }; } },
  { label: 'ATR  3.0×SL 4.0×TP  floor50/70',  fn: (s) => { const a = atrCache.get(s.signal_id)!; return { sl: Math.max(50, a * 3.0), tp: Math.max(70, a * 4.0) }; } },
  { label: 'ATR  2.0×SL 2.5×TP  NO FLOOR',    fn: (s) => { const a = atrCache.get(s.signal_id)!; return { sl: a * 2.0, tp: a * 2.5 }; } },
  { label: 'ATR  2.0×SL 3.0×TP  NO FLOOR',    fn: (s) => { const a = atrCache.get(s.signal_id)!; return { sl: a * 2.0, tp: a * 3.0 }; } },
];

const pad = (s: string, n: number, right = false): string => right ? s.padStart(n) : s.padEnd(n);
console.log(`\n┌──────────────────────────────────────┬─────┬─────┬─────┬────────┬───────────┬──────────┬─────────────────────────────┐`);
console.log(`│ Variant                              │  n  │  W  │  L  │   WR   │  Total $  │ EV/trade │ Exits  TP / SL / OPP / RTH  │`);
console.log(`├──────────────────────────────────────┼─────┼─────┼─────┼────────┼───────────┼──────────┼─────────────────────────────┤`);

for (const v of variants) {
  const trades = simulate(v.fn);
  const s = statsOf(trades);
  const wrStr = `${s.wr.toFixed(1)}%`;
  const usdStr = `${s.usd >= 0 ? '+$' : '-$'}${Math.abs(s.usd).toFixed(0)}`;
  const evStr  = `${s.ev >= 0 ? '+$' : '-$'}${Math.abs(s.ev).toFixed(1)}`;
  const exits = `${s.tpHits.toString().padStart(3)} / ${s.slHits.toString().padStart(3)} / ${s.oppExits.toString().padStart(3)} / ${s.rthExits.toString().padStart(3)}`;
  console.log(`│ ${pad(v.label, 36)} │ ${pad(String(s.n),3,true)} │ ${pad(String(s.w),3,true)} │ ${pad(String(s.l),3,true)} │ ${pad(wrStr,6,true)} │ ${pad(usdStr,9,true)} │ ${pad(evStr,8,true)} │ ${exits.padEnd(27)} │`);
}
console.log(`└──────────────────────────────────────┴─────┴─────┴─────┴────────┴───────────┴──────────┴─────────────────────────────┘\n`);
