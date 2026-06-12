// backtest_stacking.ts — test allowing same-direction signals to STACK
// positions instead of cooldown-skipping. Variants:
//
//   COOLDOWN  : current behavior — 1 position max per symbol+direction
//   STACK-N   : allow up to N concurrent same-direction positions
//
// On opposite-direction signal: close ALL open positions, then open new
// in opposite direction.
//
// Each stacked position tracked independently with its own TP/SL (same per-rule
// FIXED values) and its own outcome. Cohort = QUALIFIED 148 signals. Only the
// stacking behavior varies — everything else held constant.

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
  throw new Error(`No TP/SL for ${ruleId}`);
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

console.log(`\n══ Stacking-vs-cooldown backtest — QUALIFIED ${sigs.length} signals ══`);

interface OpenPos { sig: Sig; tp: number; sl: number; }
interface Trade { pnl_pts: number; reason: 'TP'|'SL'|'OPP'|'RTH'; opened_ts: number; stackedWith: number; }   // stackedWith = how many other positions were open at fire time

function simulate(maxConcurrentSameDir: number): { trades: Trade[]; maxStackObserved: number } {
  const completed: Trade[] = [];
  const positions: OpenPos[] = [];
  let prevDate: string | null = null;
  let maxStackObserved = 0;

  function tryCloseEachByTick(untilTs: number) {
    // Walk ticks: any position whose TP or SL hit by `untilTs` closes
    for (let i = positions.length - 1; i >= 0; i--) {
      const p = positions[i]!;
      const hit = walkExit(p.sig.symbol, p.sig.ts, untilTs, p.sig.entry, p.sig.direction, p.tp, p.sl);
      if (hit) {
        const pnl = p.sig.direction === 'long' ? hit.price - p.sig.entry : p.sig.entry - hit.price;
        completed.push({ pnl_pts: pnl, reason: hit.reason, opened_ts: p.sig.ts, stackedWith: positions.length - 1 });
        positions.splice(i, 1);
      }
    }
  }

  function closeAllAtRth(rthTs: number) {
    // Try TP/SL up to RTH bell first, then any remaining close at last-tick price
    tryCloseEachByTick(rthTs);
    for (const p of positions) {
      const r = lastTickStmt.get(p.sig.symbol, rthTs) as { price: number } | undefined;
      const px = r?.price ?? p.sig.entry;
      const pnl = p.sig.direction === 'long' ? px - p.sig.entry : p.sig.entry - px;
      completed.push({ pnl_pts: pnl, reason: 'RTH', opened_ts: p.sig.ts, stackedWith: positions.length - 1 });
    }
    positions.length = 0;
  }

  for (let i = 0; i < sigs.length; i++) {
    const s = sigs[i]!;
    const etDate = fmtEtDate(s.ts);
    if (prevDate && etDate !== prevDate) closeAllAtRth(rthCloseTsFor(sigs[i - 1]!.ts));
    prevDate = etDate;

    // Settle existing positions up to this signal
    tryCloseEachByTick(s.ts);

    // Handle this signal's direction vs current positions
    const sameDirCount = positions.filter(p => p.sig.direction === s.direction).length;
    const oppDirOpen   = positions.some(p => p.sig.direction !== s.direction);

    if (oppDirOpen) {
      // Close all opposing positions at this signal's entry (OPP exit)
      for (let j = positions.length - 1; j >= 0; j--) {
        const p = positions[j]!;
        if (p.sig.direction !== s.direction) {
          const pnl = p.sig.direction === 'long' ? s.entry - p.sig.entry : p.sig.entry - s.entry;
          completed.push({ pnl_pts: pnl, reason: 'OPP', opened_ts: p.sig.ts, stackedWith: positions.length - 1 });
          positions.splice(j, 1);
        }
      }
    }

    // Same-direction: only open if under cap
    if (sameDirCount >= maxConcurrentSameDir) continue;

    const { tp, sl } = fixedTpsl(s.rule_id, s.direction);
    positions.push({ sig: s, tp, sl });
    if (positions.length > maxStackObserved) maxStackObserved = positions.length;
  }
  if (prevDate) closeAllAtRth(rthCloseTsFor(sigs[sigs.length - 1]!.ts));
  return { trades: completed, maxStackObserved };
}

interface Stats { n: number; w: number; l: number; wr: number; usd: number; ev: number; tpHits: number; slHits: number; oppExits: number; rthExits: number; maxStack: number; }
const statsOf = (trades: Trade[], maxStack: number): Stats => {
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
    maxStack,
  };
};

interface Variant { label: string; cap: number; }
const variants: Variant[] = [
  { label: 'COOLDOWN (control, 1 max)', cap: 1 },
  { label: 'STACK up to 2 concurrent',  cap: 2 },
  { label: 'STACK up to 3 concurrent',  cap: 3 },
  { label: 'STACK up to 5 concurrent',  cap: 5 },
  { label: 'STACK unlimited',           cap: 999 },
];

const pad = (s: string, n: number, right = false): string => right ? s.padStart(n) : s.padEnd(n);
console.log(`\n┌────────────────────────────────────┬─────┬─────┬─────┬────────┬───────────┬──────────┬───────────┬──────────────────────┐`);
console.log(`│ Variant                            │  n  │  W  │  L  │   WR   │  Total $  │ EV/trade │ max stack │ TP / SL / OPP / RTH  │`);
console.log(`├────────────────────────────────────┼─────┼─────┼─────┼────────┼───────────┼──────────┼───────────┼──────────────────────┤`);
for (const v of variants) {
  const { trades, maxStackObserved } = simulate(v.cap);
  const s = statsOf(trades, maxStackObserved);
  const wrStr = `${s.wr.toFixed(1)}%`;
  const usdStr = `${s.usd >= 0 ? '+$' : '-$'}${Math.abs(s.usd).toFixed(0)}`;
  const evStr  = `${s.ev >= 0 ? '+$' : '-$'}${Math.abs(s.ev).toFixed(1)}`;
  const exits = `${s.tpHits.toString().padStart(3)} / ${s.slHits.toString().padStart(3)} / ${s.oppExits.toString().padStart(3)} / ${s.rthExits.toString().padStart(3)}`;
  console.log(`│ ${pad(v.label, 34)} │ ${pad(String(s.n),3,true)} │ ${pad(String(s.w),3,true)} │ ${pad(String(s.l),3,true)} │ ${pad(wrStr,6,true)} │ ${pad(usdStr,9,true)} │ ${pad(evStr,8,true)} │ ${pad(String(s.maxStack),9,true)} │ ${exits.padEnd(20)} │`);
}
console.log(`└────────────────────────────────────┴─────┴─────┴─────┴────────┴───────────┴──────────┴───────────┴──────────────────────┘`);
console.log(`\nNote: each stacked position has its own entry / TP / SL and is tracked independently.`);
console.log(`'max stack' = peak number of simultaneously-open positions observed during the run.\n`);
