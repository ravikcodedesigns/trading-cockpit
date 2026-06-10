// backtest_structural_tp_v2.ts
//
// Re-run of backtest_structural_tp.ts with two methodology fixes:
//   1. EXCLUDES same-session-derived levels (IBH/IBL/VWAP/HVN/LVN/RTHO/nPOC)
//      from TP candidates. Those were added to historical daily_levels.json
//      by the evening cron / backfill but are derived from the same day's
//      RTH session — using them as a TP target is look-ahead.
//   2. REMOVES the "OPP" exit (closing a trade at the next opposing signal's
//      entry). Per Ravi's spec: each trade walks from entry until TP hits,
//      SL hits, or 15:54 ET auto-close — independent of other signals.
//      Cooldown is preserved (one position max per symbol) so we keep
//      apples-to-apples cohort with the prior backtest's n=112.
//
// Cohort: QUALIFIED FLIP+CONT (clean-impulse / cont-reentry), symbol=NQ.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tradingDb = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb   = new Database(path.resolve(__dirname, '../../../data/ticks.db'),   { readonly: true });

const DOLLAR_PER_PT = 2;
const REPO_ROOT = path.resolve(__dirname, '../../..');

// ── Same-session-derived labels — exclude from TP candidates ────────────────
// These were computed from THAT day's RTH (IBH/IBL/VWAP/HVN/LVN), or use
// today's POC scan (nPOC), or get written 17:55 evening cron AFTER RTH close.
// Either way: a trade entering during RTH could not have known these.
// WkH/WkL: previously look-ahead (i=0 included today); fixed to i=1 in
// computeWeekly (2026-06-10) and re-backfilled. Now safe.
const LOOKAHEAD_LABELS = new Set([
  'IBH', 'IBL', 'RTHO', 'VWAP', 'HVN1', 'HVN2', 'LVN↑', 'LVN↓', 'nPOC',
]);

// ── Load all levels from daily_levels files, keyed by ET date ───────────────
interface LevelEntry { price: number; label: string; }
interface DayLevels { NQ: LevelEntry[]; ES: LevelEntry[]; }
const allDayLevels = new Map<string, DayLevels>();
function loadLevelsFile(file: string) {
  if (!fs.existsSync(file)) return;
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as any;
  for (const [date, day] of Object.entries(data.days ?? {})) {
    const d = day as any;
    const existing = allDayLevels.get(date) ?? { NQ: [], ES: [] };
    for (const block of d.levels ?? []) {
      const sym = block.symbol as 'NQ' | 'ES';
      const arr = existing[sym];
      if (block.hedgePressure) arr.push({ price: block.hedgePressure, label: 'HP' });
      if (block.mhp)           arr.push({ price: block.mhp,           label: 'MHP' });
      if (block.ddBands?.upper) arr.push({ price: block.ddBands.upper, label: 'DD↑' });
      if (block.ddBands?.lower) arr.push({ price: block.ddBands.lower, label: 'DD↓' });
      if (block.bullZone?.low)  arr.push({ price: block.bullZone.low,  label: 'BullL' });
      if (block.bullZone?.high) arr.push({ price: block.bullZone.high, label: 'BullH' });
      if (block.bearZone?.low)  arr.push({ price: block.bearZone.low,  label: 'BearL' });
      if (block.bearZone?.high) arr.push({ price: block.bearZone.high, label: 'BearH' });
      for (const lvl of block.additionalLevels ?? []) {
        if (typeof lvl.price === 'number') arr.push({ price: lvl.price, label: lvl.label });
      }
      existing[sym] = arr;
    }
    allDayLevels.set(date, existing);
  }
}
loadLevelsFile(path.join(REPO_ROOT, 'daily_levels.json'));
loadLevelsFile(path.join(REPO_ROOT, 'daily_levels_es.json'));
console.log(`Loaded levels for ${allDayLevels.size} days`);

function structuralTpRange(
  symbol: 'NQ'|'ES', etDate: string, entry: number,
  direction: 'long'|'short', minPt: number, maxPt: number,
): { tp: number; label: string } | null {
  const day = allDayLevels.get(etDate);
  if (!day) return null;
  const levels = day[symbol];
  if (!levels || levels.length === 0) return null;
  let best: { distPts: number; label: string } | null = null;
  for (const lvl of levels) {
    if (LOOKAHEAD_LABELS.has(lvl.label)) continue;     // ← look-ahead guard
    const distPts = direction === 'long' ? lvl.price - entry : entry - lvl.price;
    if (distPts < minPt || distPts > maxPt) continue;
    if (!best || distPts < best.distPts) best = { distPts, label: lvl.label };
  }
  return best ? { tp: best.distPts, label: best.label } : null;
}

// ── Standard simulation helpers ─────────────────────────────────────────────
function fixedSl(ruleId: string, direction: 'long'|'short'): number {
  if (ruleId === 'clean-impulse') return direction === 'long' ? 55 : 105;
  if (ruleId === 'cont-reentry')  return 70;
  throw new Error(`No SL for ${ruleId}`);
}

const tickRangeStmt = ticksDb.prepare(
  `SELECT ts, price FROM trades WHERE symbol=? AND ts > ? AND ts <= ? ORDER BY ts ASC`
);
function walkExit(symbol: string, fromTs: number, untilTs: number, entry: number, dir: 'long'|'short', tp: number, sl: number) {
  const tpPx = dir === 'long' ? entry + tp : entry - tp;
  const slPx = dir === 'long' ? entry - sl : entry + sl;
  for (const r of tickRangeStmt.iterate(symbol, fromTs, untilTs) as IterableIterator<{ ts: number; price: number }>) {
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
const lastTickStmt = ticksDb.prepare(
  `SELECT price FROM trades WHERE symbol=? AND ts <= ? ORDER BY ts DESC LIMIT 1`
);

const fmtEtDate = (tsMs: number) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(tsMs));
  const [mm, dd, yyyy] = p.split('/');
  return `${yyyy}-${mm}-${dd}`;
};
// 15:54 ET on the trade's day. Handles EDT/EST via the parse step.
const rthCloseTsFor = (tsMs: number) => Date.parse(`${fmtEtDate(tsMs)}T15:54:00-04:00`);

// ── Signals ─────────────────────────────────────────────────────────────────
interface Sig { signal_id: number; ts: number; symbol: 'NQ'|'ES'; rule_id: string; direction: 'long'|'short'; entry: number; }
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

console.log(`\n══ Structural-TP v2 — QUALIFIED ${sigs.length} signals (no look-ahead, no OPP exit) ══`);
console.log(`   SL fixed per rule. TP varies by variant. Cooldown ON.`);

// ── Simulation: cooldown only, no OPP exit, walk to TP/SL/15:54 ─────────────
interface Trade { pnl_pts: number; reason: 'TP'|'SL'|'RTH'; tp_pts: number; structural: boolean; }
type TpFn = (sig: Sig) => { tp: number; structural: boolean };

function simulate(tpFn: TpFn): Trade[] {
  const completed: Trade[] = [];
  let openTrade: { sig: Sig; tp: number; sl: number; structural: boolean } | null = null;

  function closeOpen(rthClose: number) {
    if (!openTrade) return;
    const o = openTrade;
    const hit = walkExit(o.sig.symbol, o.sig.ts, rthClose, o.sig.entry, o.sig.direction, o.tp, o.sl);
    if (hit) {
      const pnl = o.sig.direction === 'long' ? hit.price - o.sig.entry : o.sig.entry - hit.price;
      completed.push({ pnl_pts: pnl, reason: hit.reason, tp_pts: o.tp, structural: o.structural });
    } else {
      const r = lastTickStmt.get(o.sig.symbol, rthClose) as { price: number } | undefined;
      const px = r?.price ?? o.sig.entry;
      const pnl = o.sig.direction === 'long' ? px - o.sig.entry : o.sig.entry - px;
      completed.push({ pnl_pts: pnl, reason: 'RTH', tp_pts: o.tp, structural: o.structural });
    }
    openTrade = null;
  }

  for (const s of sigs) {
    // Settle any open trade up to this signal's ts. If the open trade's
    // RTH-close cutoff has already passed, close it at that cutoff first.
    if (openTrade) {
      const rthClose = rthCloseTsFor(openTrade.sig.ts);
      if (s.ts > rthClose) {
        // Open trade spans into a new day → close at its own RTH cutoff.
        closeOpen(rthClose);
      } else {
        // Same RTH session — partial walk to s.ts to check TP/SL.
        const o = openTrade;
        const hit = walkExit(o.sig.symbol, o.sig.ts, s.ts, o.sig.entry, o.sig.direction, o.tp, o.sl);
        if (hit) {
          const pnl = o.sig.direction === 'long' ? hit.price - o.sig.entry : o.sig.entry - hit.price;
          completed.push({ pnl_pts: pnl, reason: hit.reason, tp_pts: o.tp, structural: o.structural });
          openTrade = null;
        }
      }
    }

    // Cooldown — don't overlap positions.
    if (openTrade) continue;

    // Open new trade.
    const { tp, structural } = tpFn(s);
    const sl = fixedSl(s.rule_id, s.direction);
    openTrade = { sig: s, tp, sl, structural };
  }

  // End of all signals: walk remaining open trade to 15:54.
  if (openTrade) closeOpen(rthCloseTsFor(openTrade.sig.ts));
  return completed;
}

// ── Stats ───────────────────────────────────────────────────────────────────
interface Stats { n: number; w: number; l: number; wr: number; usd: number; ev: number; structUsed: number; tpAvg: number; tpHits: number; slHits: number; rthExits: number; }
const statsOf = (trades: Trade[]): Stats => {
  const n = trades.length;
  const w = trades.filter(t => t.pnl_pts > 0).length;
  const l = trades.filter(t => t.pnl_pts < 0).length;
  const usd = trades.reduce((sum, t) => sum + t.pnl_pts, 0) * DOLLAR_PER_PT;
  const wr = (w + l) ? (w / (w + l)) * 100 : 0;
  return {
    n, w, l, wr, usd, ev: n ? usd / n : 0,
    structUsed: trades.filter(t => t.structural).length,
    tpAvg: n ? trades.reduce((sum, t) => sum + t.tp_pts, 0) / n : 0,
    tpHits:   trades.filter(t => t.reason === 'TP').length,
    slHits:   trades.filter(t => t.reason === 'SL').length,
    rthExits: trades.filter(t => t.reason === 'RTH').length,
  };
};

// ── Variants ────────────────────────────────────────────────────────────────
interface Variant { label: string; fn: TpFn; }
const variants: Variant[] = [
  { label: 'FIXED TP=80 (control)',                fn: (_s) => ({ tp: 80, structural: false }) },
  { label: 'STRUCT 20-200pt, fallback 80',          fn: (s) => { const r = structuralTpRange(s.symbol, fmtEtDate(s.ts), s.entry, s.direction, 20, 200); return r != null ? { tp: r.tp, structural: true } : { tp: 80, structural: false }; } },
  { label: 'STRUCT 30-150pt, fallback 80',          fn: (s) => { const r = structuralTpRange(s.symbol, fmtEtDate(s.ts), s.entry, s.direction, 30, 150); return r != null ? { tp: r.tp, structural: true } : { tp: 80, structural: false }; } },
  { label: 'STRUCT 40-100pt, fallback 80',          fn: (s) => { const r = structuralTpRange(s.symbol, fmtEtDate(s.ts), s.entry, s.direction, 40, 100); return r != null ? { tp: r.tp, structural: true } : { tp: 80, structural: false }; } },
];

const pad = (s: string, n: number, right = false): string => right ? s.padStart(n) : s.padEnd(n);
console.log(`\n┌────────────────────────────────────────────┬─────┬─────┬─────┬────────┬───────────┬──────────┬──────────┬─────────────────────┐`);
console.log(`│ Variant                                    │  n  │  W  │  L  │   WR   │  Total $  │ EV/trade │ avg TP   │ TP / SL / RTH       │`);
console.log(`├────────────────────────────────────────────┼─────┼─────┼─────┼────────┼───────────┼──────────┼──────────┼─────────────────────┤`);
for (const v of variants) {
  const trades = simulate(v.fn);
  const s = statsOf(trades);
  const wrStr = `${s.wr.toFixed(1)}%`;
  const usdStr = `${s.usd >= 0 ? '+$' : '-$'}${Math.abs(s.usd).toFixed(0)}`;
  const evStr  = `${s.ev >= 0 ? '+$' : '-$'}${Math.abs(s.ev).toFixed(1)}`;
  const exits = `${s.tpHits.toString().padStart(3)} / ${s.slHits.toString().padStart(3)} / ${s.rthExits.toString().padStart(3)}`;
  const tpAvg = `${s.tpAvg.toFixed(1)}pt`;
  console.log(`│ ${pad(v.label, 42)} │ ${pad(String(s.n),3,true)} │ ${pad(String(s.w),3,true)} │ ${pad(String(s.l),3,true)} │ ${pad(wrStr,6,true)} │ ${pad(usdStr,9,true)} │ ${pad(evStr,8,true)} │ ${pad(tpAvg,8,true)} │ ${exits.padEnd(19)} │`);
  if (v.label.startsWith('STRUCT')) {
    console.log(`│   ↳ ${s.structUsed}/${s.n} used structural TP (${s.n - s.structUsed} fell back to 80)${' '.repeat(60)} │`);
  }
}
console.log(`└────────────────────────────────────────────┴─────┴─────┴─────┴────────┴───────────┴──────────┴──────────┴─────────────────────┘\n`);

console.log(`Methodology:`);
console.log(`  - TP candidates exclude look-ahead labels: ${[...LOOKAHEAD_LABELS].join(', ')}`);
console.log(`  - Each trade walks from entry to 15:54 ET (no OPP exit, no time cap besides RTH close)`);
console.log(`  - Cooldown ON: one open position max at a time (matches prior n=112 cohort)`);
console.log(`  - Exit: TP = win, SL hit first = loss, neither by 15:54 → close at last tick (RTH)`);
