// backtest_structural_tp_v3.ts
//
// Corrected per Ravi's spec (2026-06-10):
//   - Look-ahead labels EXCLUDED from TP candidates (same as v2)
//   - OPP behavior restored: an opposing-direction signal closes the
//     open position at that signal's entry price, then opens a new
//     position in the opposite direction
//   - Same-direction handling: TWO modes compared side-by-side
//       (a) COOLDOWN — skip the same-dir signal (no new position)
//       (b) STACK    — open a NEW concurrent position in same dir
//   - Each position walks from its own entry to:
//         TP hit  → win
//         SL hit  → loss
//         opposing signal → close at OPP entry (counted as exit, not W/L)
//         15:54 ET reached → auto-close at last tick (RTH exit)
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

const LOOKAHEAD_LABELS = new Set([
  'IBH', 'IBL', 'RTHO', 'VWAP', 'HVN1', 'HVN2', 'LVN↑', 'LVN↓', 'nPOC',
]);

// ── Load levels ─────────────────────────────────────────────────────────────
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

function structuralTpRange(symbol: 'NQ'|'ES', etDate: string, entry: number, direction: 'long'|'short', minPt: number, maxPt: number): number | null {
  const day = allDayLevels.get(etDate);
  if (!day) return null;
  const levels = day[symbol];
  if (!levels || levels.length === 0) return null;
  let best: number | null = null;
  for (const lvl of levels) {
    if (LOOKAHEAD_LABELS.has(lvl.label)) continue;
    const distPts = direction === 'long' ? lvl.price - entry : entry - lvl.price;
    if (distPts < minPt || distPts > maxPt) continue;
    if (best == null || distPts < best) best = distPts;
  }
  return best;
}

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
const rthCloseTsFor = (tsMs: number) => Date.parse(`${fmtEtDate(tsMs)}T15:54:00-04:00`);

// ── Cohort selection (CLI flag) ─────────────────────────────────────────────
// --cohort=qualified  : t.qualified = 1 (passed quality gate; 148 signals)
// --cohort=tradable   : t.qualified = 1 AND t.action = 'OPEN' (107 signals)
//                       — what the live pipeline would have actually traded
const cohortArg = process.argv.find(a => a.startsWith('--cohort='))?.split('=')[1] ?? 'qualified';
if (cohortArg !== 'qualified' && cohortArg !== 'tradable') {
  console.error(`Unknown --cohort '${cohortArg}'. Use 'qualified' or 'tradable'.`);
  process.exit(1);
}
const cohortFilter = cohortArg === 'tradable' ? `AND t.action = 'OPEN'` : '';

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
    ${cohortFilter}
    AND CAST(json_extract(s.payload, '$.entry') AS REAL) IS NOT NULL
  ORDER BY s.ts ASC
`).all() as Sig[];

console.log(`\n══ Structural-TP v3 — ${cohortArg.toUpperCase()} ${sigs.length} signals (no look-ahead) ══`);

// ── Simulation ──────────────────────────────────────────────────────────────
interface Position { sig: Sig; tp: number; sl: number; structural: boolean; }
interface Trade  { pnl_pts: number; reason: 'TP'|'SL'|'OPP'|'RTH'; tp_pts: number; structural: boolean; }
type TpFn = (sig: Sig) => { tp: number; structural: boolean };
type Mode = 'COOLDOWN' | 'STACK';

function simulate(tpFn: TpFn, mode: Mode): Trade[] {
  const completed: Trade[] = [];
  let open: Position[] = [];   // empty for COOLDOWN until a trade fires; multi for STACK
  let lastRthClose: number | null = null;

  function pnlOf(p: Position, exitPx: number): number {
    return p.sig.direction === 'long' ? exitPx - p.sig.entry : p.sig.entry - exitPx;
  }

  // Walk all currently-open positions from their entries to untilTs. If any
  // hits TP or SL → record and remove. Updates `open` in place.
  function settleAll(untilTs: number) {
    const stillOpen: Position[] = [];
    for (const p of open) {
      const hit = walkExit(p.sig.symbol, p.sig.ts, untilTs, p.sig.entry, p.sig.direction, p.tp, p.sl);
      if (hit) {
        completed.push({ pnl_pts: pnlOf(p, hit.price), reason: hit.reason, tp_pts: p.tp, structural: p.structural });
      } else {
        stillOpen.push(p);
      }
    }
    open = stillOpen;
  }

  // Close any open positions whose direction === closeIfDir, at exitPx as OPP.
  function closePositionsOfDir(closeIfDir: 'long'|'short', exitPx: number) {
    const remaining: Position[] = [];
    for (const p of open) {
      if (p.sig.direction === closeIfDir) {
        completed.push({ pnl_pts: pnlOf(p, exitPx), reason: 'OPP', tp_pts: p.tp, structural: p.structural });
      } else {
        remaining.push(p);
      }
    }
    open = remaining;
  }

  function closeAllAtRth(rthClose: number) {
    const r0 = lastTickStmt.get(sigs[0]!.symbol, rthClose) as { price: number } | undefined;
    const fallbackPx = r0?.price;
    for (const p of open) {
      const hit = walkExit(p.sig.symbol, p.sig.ts, rthClose, p.sig.entry, p.sig.direction, p.tp, p.sl);
      if (hit) {
        completed.push({ pnl_pts: pnlOf(p, hit.price), reason: hit.reason, tp_pts: p.tp, structural: p.structural });
      } else {
        const r = lastTickStmt.get(p.sig.symbol, rthClose) as { price: number } | undefined;
        const px = r?.price ?? fallbackPx ?? p.sig.entry;
        completed.push({ pnl_pts: pnlOf(p, px), reason: 'RTH', tp_pts: p.tp, structural: p.structural });
      }
    }
    open = [];
  }

  for (let i = 0; i < sigs.length; i++) {
    const s = sigs[i]!;

    // Day rollover: if `s.ts` is past the cached rthClose of currently-open
    // positions, close them all at the rthClose first.
    if (open.length > 0) {
      const openDay = fmtEtDate(open[0]!.sig.ts);
      const sDay = fmtEtDate(s.ts);
      if (openDay !== sDay) {
        closeAllAtRth(rthCloseTsFor(open[0]!.sig.ts));
      }
    }

    // Settle TP/SL for all open positions up to this signal's time
    if (open.length > 0) settleAll(s.ts);

    // Apply OPP logic: any open position whose direction is OPPOSITE to s
    // gets closed at s.entry. (If s is long, close any open shorts; vice versa.)
    if (open.length > 0) {
      const closeDir: 'long'|'short' = s.direction === 'long' ? 'short' : 'long';
      closePositionsOfDir(closeDir, s.entry);
    }

    // Decide whether to open a new position
    const sameDirOpen = open.some(p => p.sig.direction === s.direction);
    if (mode === 'COOLDOWN' && sameDirOpen) continue;   // skip same-dir while open
    // STACK mode (or no same-dir open): always open

    const { tp, structural } = tpFn(s);
    const sl = fixedSl(s.rule_id, s.direction);
    open.push({ sig: s, tp, sl, structural });
    lastRthClose = rthCloseTsFor(s.ts);
  }

  // Close any remaining open at last-signal's RTH close
  if (open.length > 0 && lastRthClose != null) closeAllAtRth(lastRthClose);
  return completed;
}

// ── Stats ───────────────────────────────────────────────────────────────────
interface Stats { n: number; w: number; l: number; wr: number; usd: number; ev: number; structUsed: number; tpAvg: number; tpHits: number; slHits: number; oppExits: number; rthExits: number; }
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
    oppExits: trades.filter(t => t.reason === 'OPP').length,
    rthExits: trades.filter(t => t.reason === 'RTH').length,
  };
};

interface Variant { label: string; fn: TpFn; }
const variants: Variant[] = [
  { label: 'FIXED TP=80 (control)',         fn: (_s) => ({ tp: 80, structural: false }) },
  { label: 'STRUCT 20-200pt, fallback 80',   fn: (s) => { const tp = structuralTpRange(s.symbol, fmtEtDate(s.ts), s.entry, s.direction, 20, 200); return tp != null ? { tp, structural: true } : { tp: 80, structural: false }; } },
  { label: 'STRUCT 30-150pt, fallback 80',   fn: (s) => { const tp = structuralTpRange(s.symbol, fmtEtDate(s.ts), s.entry, s.direction, 30, 150); return tp != null ? { tp, structural: true } : { tp: 80, structural: false }; } },
  { label: 'STRUCT 40-100pt, fallback 80',   fn: (s) => { const tp = structuralTpRange(s.symbol, fmtEtDate(s.ts), s.entry, s.direction, 40, 100); return tp != null ? { tp, structural: true } : { tp: 80, structural: false }; } },
];

const pad = (s: string, n: number, right = false): string => right ? s.padStart(n) : s.padEnd(n);
function printMode(mode: Mode, title: string) {
  console.log(`\n── ${title} ──`);
  console.log(`┌────────────────────────────────────────────┬─────┬─────┬─────┬────────┬───────────┬──────────┬──────────┬──────────────────────┐`);
  console.log(`│ Variant                                    │  n  │  W  │  L  │   WR   │  Total $  │ EV/trade │ avg TP   │ TP / SL / OPP / RTH  │`);
  console.log(`├────────────────────────────────────────────┼─────┼─────┼─────┼────────┼───────────┼──────────┼──────────┼──────────────────────┤`);
  for (const v of variants) {
    const trades = simulate(v.fn, mode);
    const s = statsOf(trades);
    const wrStr = `${s.wr.toFixed(1)}%`;
    const usdStr = `${s.usd >= 0 ? '+$' : '-$'}${Math.abs(s.usd).toFixed(0)}`;
    const evStr  = `${s.ev >= 0 ? '+$' : '-$'}${Math.abs(s.ev).toFixed(1)}`;
    const exits = `${s.tpHits.toString().padStart(3)} / ${s.slHits.toString().padStart(3)} / ${s.oppExits.toString().padStart(3)} / ${s.rthExits.toString().padStart(3)}`;
    const tpAvg = `${s.tpAvg.toFixed(1)}pt`;
    console.log(`│ ${pad(v.label, 42)} │ ${pad(String(s.n),3,true)} │ ${pad(String(s.w),3,true)} │ ${pad(String(s.l),3,true)} │ ${pad(wrStr,6,true)} │ ${pad(usdStr,9,true)} │ ${pad(evStr,8,true)} │ ${pad(tpAvg,8,true)} │ ${exits.padEnd(20)} │`);
    if (v.label.startsWith('STRUCT')) {
      console.log(`│   ↳ ${s.structUsed}/${s.n} used structural TP (${s.n - s.structUsed} fell back to 80)${' '.repeat(58)} │`);
    }
  }
  console.log(`└────────────────────────────────────────────┴─────┴─────┴─────┴────────┴───────────┴──────────┴──────────┴──────────────────────┘`);
}
printMode('COOLDOWN', 'MODE A — COOLDOWN (same-dir signal SKIPPED, opp-dir CLOSES+OPENS opposite)');
printMode('STACK',    'MODE B — STACK    (same-dir signal STACKS new position, opp-dir CLOSES ALL + OPENS opposite)');

console.log(`\nMethodology:`);
console.log(`  - TP candidates exclude look-ahead labels: ${[...LOOKAHEAD_LABELS].join(', ')}`);
console.log(`  - OPP exit ON: opposing-dir signal closes prior position(s) at signal entry, opens new opposite`);
console.log(`  - Same-dir behavior differs per mode (cooldown vs stack)`);
console.log(`  - Each position walks to: TP / SL / OPP / 15:54 RTH close (whichever first)`);
