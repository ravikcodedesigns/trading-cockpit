// backtest_tpsl_cohorts.ts — 3 cohorts × 2 TP/SL strategies = 6-cell comparison.
//
// Cohorts:
//   QUALIFIED  : tradable_signals.qualified=1                 (~114 NQ FLIP+CONT today)
//   SILENCED   : tradable_signals.qualified=0                 (~99)
//   ALL RAW    : every raw FLIP+CONT in signals (both above)  (~213)
//
// TP/SL strategies:
//   FIXED       : today's per-rule constants (clean-impulse FLIP 80/55 long, 80/105 short; cont-reentry 80/70 sym)
//   ATR_ADAPT   : SL = max(20pt, 1.0 × ATR(20-min)), TP = max(30pt, 1.5 × ATR(20-min))
//
// Simulation rules (consistent across all 6 cells so the cohort × strategy
// effect is isolated):
//   - Per-day RTH reset at 15:54 ET (force-close any open trade).
//   - Chronological signal walk; for each signal:
//       * if open trade same direction → SKIP (cooldown)
//       * if open trade opposite direction → CLOSE at this signal's entry
//         price (OPP exit, unconditional — applies same in all cohorts so we
//         don't conflate the gate-question with the TP/SL question)
//       * open new trade at signal.entry
//   - Walk ticks tick-by-tick for TP/SL hit on every open trade up to the
//     next signal or RTH bell.
//   - ATR(20) computed from 20 prior 1-min bar high-low ranges, mean.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tradingDb = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb   = new Database(path.resolve(__dirname, '../../../data/ticks.db'),   { readonly: true });

const DOLLAR_PER_PT = 2;
const TICK_SIZE = 0.25;

// ── Per-rule fixed TP/SL ────────────────────────────────────────────────────
function fixedTpsl(ruleId: string, direction: 'long'|'short'): { tp: number; sl: number } {
  if (ruleId === 'clean-impulse') return { tp: 80, sl: direction === 'long' ? 55 : 105 };
  if (ruleId === 'cont-reentry')  return { tp: 80, sl: 70 };
  throw new Error(`No fixed TP/SL for ${ruleId}`);
}

// ── ATR(20) proxy: avg of 20 prior 1-min bar high-low ranges ────────────────
const atrTickStmt = ticksDb.prepare(`SELECT ts, price FROM trades WHERE symbol=? AND ts > ? AND ts <= ?`);
function atr20(symbol: string, atTs: number): number {
  const ticks = atrTickStmt.all(symbol, atTs - 20 * 60_000, atTs) as { ts: number; price: number }[];
  if (ticks.length === 0) return 0;
  // Group into 1-min buckets, find high-low per bucket
  const bars = new Map<number, { hi: number; lo: number }>();
  for (const t of ticks) {
    const bucket = Math.floor(t.ts / 60_000) * 60_000;
    const b = bars.get(bucket);
    if (!b) bars.set(bucket, { hi: t.price, lo: t.price });
    else {
      if (t.price > b.hi) b.hi = t.price;
      if (t.price < b.lo) b.lo = t.price;
    }
  }
  if (bars.size === 0) return 0;
  let sumTr = 0;
  for (const b of bars.values()) sumTr += (b.hi - b.lo);
  return sumTr / bars.size;
}
function atrTpsl(symbol: string, atTs: number): { tp: number; sl: number } {
  const atr = atr20(symbol, atTs);
  const sl  = Math.max(20, atr * 1.0);
  const tp  = Math.max(30, atr * 1.5);
  return { tp, sl };
}

// ── Tick walker for TP/SL hit ───────────────────────────────────────────────
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

// ── Date helpers ────────────────────────────────────────────────────────────
const fmtEtDate = (tsMs: number) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(tsMs));
  const [mm, dd, yyyy] = p.split('/');
  return `${yyyy}-${mm}-${dd}`;
};
const rthCloseTsFor = (tsMs: number) => Date.parse(`${fmtEtDate(tsMs)}T15:54:00-04:00`);

// ── Load signals — joined with tradable_signals for qualified flag ──────────
interface Sig {
  signal_id: number;
  ts: number;
  symbol: string;
  rule_id: string;
  direction: 'long' | 'short';
  entry: number;
  qualified: number;   // 0 or 1
}
const allSigs = tradingDb.prepare(`
  SELECT
    s.id AS signal_id,
    s.ts,
    s.symbol,
    s.rule_id,
    s.direction,
    CAST(json_extract(s.payload, '$.entry') AS REAL) AS entry,
    COALESCE(t.qualified, 0) AS qualified
  FROM signals s
  LEFT JOIN tradable_signals t ON t.signal_id = s.id
  WHERE s.rule_id IN ('clean-impulse','cont-reentry')
    AND s.symbol = 'NQ'
    AND CAST(json_extract(s.payload, '$.entry') AS REAL) IS NOT NULL
  ORDER BY s.ts ASC
`).all() as Sig[];

console.log(`\n══ Loaded ${allSigs.length} raw NQ FLIP+CONT signals ══`);
console.log(`   qualified=1 : ${allSigs.filter(s => s.qualified === 1).length}`);
console.log(`   qualified=0 : ${allSigs.filter(s => s.qualified === 0).length}`);

// ── Simulation ──────────────────────────────────────────────────────────────
type TpslFn = (sig: Sig) => { tp: number; sl: number };
interface Trade { signal_id: number; pnl_pts: number; close_reason: 'TP'|'SL'|'OPP'|'RTH'; }

function simulate(signals: Sig[], tpslFn: TpslFn): Trade[] {
  const completed: Trade[] = [];
  let open: { sig: Sig; tp: number; sl: number } | null = null;
  let prevDate: string | null = null;

  function closeOpenAtRth(rthTs: number) {
    if (!open) return;
    const o = open;
    const hit = walkExit(o.sig.symbol, o.sig.ts, rthTs, o.sig.entry, o.sig.direction, o.tp, o.sl);
    if (hit) {
      const pnl = o.sig.direction === 'long' ? hit.price - o.sig.entry : o.sig.entry - hit.price;
      completed.push({ signal_id: o.sig.signal_id, pnl_pts: pnl, close_reason: hit.reason });
    } else {
      const r = lastTickStmt.get(o.sig.symbol, rthTs) as { price: number } | undefined;
      const px = r?.price ?? o.sig.entry;
      const pnl = o.sig.direction === 'long' ? px - o.sig.entry : o.sig.entry - px;
      completed.push({ signal_id: o.sig.signal_id, pnl_pts: pnl, close_reason: 'RTH' });
    }
    open = null;
  }

  for (let i = 0; i < signals.length; i++) {
    const s = signals[i]!;
    const etDate = fmtEtDate(s.ts);

    // Day boundary — force RTH close
    if (prevDate && etDate !== prevDate) {
      closeOpenAtRth(rthCloseTsFor(signals[i - 1]!.ts));
    }
    prevDate = etDate;

    // Walk ticks up to this signal — close on TP/SL if hit before now
    if (open) {
      const o = open;
      const hit = walkExit(o.sig.symbol, o.sig.ts, s.ts, o.sig.entry, o.sig.direction, o.tp, o.sl);
      if (hit) {
        const pnl = o.sig.direction === 'long' ? hit.price - o.sig.entry : o.sig.entry - hit.price;
        completed.push({ signal_id: o.sig.signal_id, pnl_pts: pnl, close_reason: hit.reason });
        open = null;
      }
    }

    // Handle current open
    if (open) {
      if (open.sig.direction === s.direction) continue;       // same-dir cooldown
      // Opposite-dir: close at this signal's entry, then open new
      const o = open;
      const pnl = o.sig.direction === 'long' ? s.entry - o.sig.entry : o.sig.entry - s.entry;
      completed.push({ signal_id: o.sig.signal_id, pnl_pts: pnl, close_reason: 'OPP' });
      open = null;
    }

    // Open new
    const { tp, sl } = tpslFn(s);
    open = { sig: s, tp, sl };
  }
  if (prevDate) closeOpenAtRth(rthCloseTsFor(signals[signals.length - 1]!.ts));
  return completed;
}

interface Stats { n: number; w: number; l: number; wr: number; pts: number; usd: number; ev: number; }
const statsOf = (trades: Trade[]): Stats => {
  const n = trades.length;
  const w = trades.filter(t => t.pnl_pts > 0).length;
  const l = trades.filter(t => t.pnl_pts < 0).length;
  const pts = trades.reduce((s, t) => s + t.pnl_pts, 0);
  const usd = pts * DOLLAR_PER_PT;
  const wr = (w + l) ? (w / (w + l)) * 100 : 0;
  const ev = n ? usd / n : 0;
  return { n, w, l, wr, pts, usd, ev };
};

// ── Run 3 × 2 grid ──────────────────────────────────────────────────────────
const cohorts: [string, Sig[]][] = [
  ['QUALIFIED', allSigs.filter(s => s.qualified === 1)],
  ['SILENCED',  allSigs.filter(s => s.qualified === 0)],
  ['ALL RAW',   allSigs],
];
const strategies: [string, TpslFn][] = [
  ['FIXED      ', (s) => fixedTpsl(s.rule_id, s.direction)],
  ['ATR_ADAPT  ', (s) => atrTpsl(s.symbol, s.ts)],
];

console.log(`\n┌─────────────┬─────────────┬─────┬─────┬─────┬────────┬───────────┬─────────────┐`);
console.log(`│ Cohort      │ Strategy    │  n  │  W  │  L  │   WR   │ Total $   │ EV/trade $  │`);
console.log(`├─────────────┼─────────────┼─────┼─────┼─────┼────────┼───────────┼─────────────┤`);
for (const [cName, cSigs] of cohorts) {
  for (const [sName, fn] of strategies) {
    const trades = simulate(cSigs, fn);
    const s = statsOf(trades);
    const wrStr = `${s.wr.toFixed(1)}%`;
    const usdStr = `${s.usd >= 0 ? '+$' : '-$'}${Math.abs(s.usd).toFixed(0)}`;
    const evStr  = `${s.ev >= 0 ? '+$' : '-$'}${Math.abs(s.ev).toFixed(1)}`;
    console.log(`│ ${cName.padEnd(11)} │ ${sName} │ ${String(s.n).padStart(3)} │ ${String(s.w).padStart(3)} │ ${String(s.l).padStart(3)} │ ${wrStr.padStart(6)} │ ${usdStr.padStart(9)} │ ${evStr.padStart(11)} │`);
  }
  if (cName !== 'ALL RAW') console.log(`├─────────────┼─────────────┼─────┼─────┼─────┼────────┼───────────┼─────────────┤`);
}
console.log(`└─────────────┴─────────────┴─────┴─────┴─────┴────────┴───────────┴─────────────┘`);
console.log(`\nNote: simulation uses TP/SL hits + RTH bell + opposing-signal exit (unconditional within cohort).`);
console.log(`No quality gate or close-on-opp filtering — isolates the TP/SL effect from gate effects.\n`);
