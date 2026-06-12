// backtest_struct_floor.ts — test what happens when the nearest structural
// level is closer than 50pt (poor R:R territory).
//
// Variants (all live-decidable at entry time — no look-ahead):
//   FIXED           : TP = 80pt always (control)
//   STRUCT 20-200   : TP = nearest level 20-200pt, fallback 80 (today's best)
//   STRUCT-SKIP-50  : if nearest level < 50pt → SKIP trade entirely
//                     else TP = nearest level in 50-200pt range (fallback 80)
//   STRUCT-FALLBACK : if nearest level < 50pt → take trade w/ TP = 80 (ignore close level)
//                     else TP = nearest level in 50-200pt range
//
// Same SL (fixed per rule). Same cohort (148 QUALIFIED).

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tradingDb = new Database(path.resolve(__dirname, '../../../data/trading.db'), { readonly: true });
const ticksDb   = new Database(path.resolve(__dirname, '../../../data/ticks.db'),   { readonly: true });
const DOLLAR_PER_PT = 2;
const REPO_ROOT = path.resolve(__dirname, '../../..');

interface LevelEntry { price: number; label: string; }
const allDayLevels = new Map<string, { NQ: LevelEntry[]; ES: LevelEntry[] }>();
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
      if (block.mhp)           arr.push({ price: block.mhp, label: 'MHP' });
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

function nearestLevelDistPts(symbol: 'NQ'|'ES', etDate: string, entry: number, direction: 'long'|'short', minPt: number, maxPt: number): number | null {
  const day = allDayLevels.get(etDate);
  if (!day) return null;
  const levels = day[symbol];
  if (!levels || levels.length === 0) return null;
  let bestDist: number | null = null;
  for (const lvl of levels) {
    const distPts = direction === 'long' ? lvl.price - entry : entry - lvl.price;
    if (distPts < minPt || distPts > maxPt) continue;
    if (bestDist === null || distPts < bestDist) bestDist = distPts;
  }
  return bestDist;
}

function fixedSl(ruleId: string, direction: 'long'|'short'): number {
  if (ruleId === 'clean-impulse') return direction === 'long' ? 55 : 105;
  if (ruleId === 'cont-reentry')  return 70;
  throw new Error(`No SL for ${ruleId}`);
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

interface Sig { signal_id: number; ts: number; symbol: 'NQ'|'ES'; rule_id: string; direction: 'long'|'short'; entry: number; }
const sigs = tradingDb.prepare(`
  SELECT s.id AS signal_id, s.ts, s.symbol, s.rule_id, s.direction,
         CAST(json_extract(s.payload, '$.entry') AS REAL) AS entry
  FROM signals s JOIN tradable_signals t ON t.signal_id = s.id
  WHERE s.rule_id IN ('clean-impulse','cont-reentry') AND s.symbol = 'NQ'
    AND t.qualified = 1 AND CAST(json_extract(s.payload, '$.entry') AS REAL) IS NOT NULL
  ORDER BY s.ts ASC
`).all() as Sig[];

// Per-signal TP decision returns: { tp, skip }
type TpDecision = { tp: number; skip: false } | { tp: number; skip: true };

interface Trade { pnl_pts: number; reason: 'TP'|'SL'|'OPP'|'RTH'; tp_pts: number; }

function simulate(tpFn: (s: Sig) => TpDecision): { trades: Trade[]; skipped: number } {
  const completed: Trade[] = [];
  let open: { sig: Sig; tp: number; sl: number } | null = null;
  let prevDate: string | null = null;
  let skipped = 0;

  function closeAtRth(rthTs: number) {
    if (!open) return;
    const o = open;
    const hit = walkExit(o.sig.symbol, o.sig.ts, rthTs, o.sig.entry, o.sig.direction, o.tp, o.sl);
    if (hit) {
      const pnl = o.sig.direction === 'long' ? hit.price - o.sig.entry : o.sig.entry - hit.price;
      completed.push({ pnl_pts: pnl, reason: hit.reason, tp_pts: o.tp });
    } else {
      const r = lastTickStmt.get(o.sig.symbol, rthTs) as { price: number } | undefined;
      const px = r?.price ?? o.sig.entry;
      const pnl = o.sig.direction === 'long' ? px - o.sig.entry : o.sig.entry - px;
      completed.push({ pnl_pts: pnl, reason: 'RTH', tp_pts: o.tp });
    }
    open = null;
  }

  for (let i = 0; i < sigs.length; i++) {
    const s = sigs[i]!;
    const etDate = fmtEtDate(s.ts);
    if (prevDate && etDate !== prevDate) closeAtRth(rthCloseTsFor(sigs[i - 1]!.ts));
    prevDate = etDate;

    if (open) {
      const o = open;
      const hit = walkExit(o.sig.symbol, o.sig.ts, s.ts, o.sig.entry, o.sig.direction, o.tp, o.sl);
      if (hit) {
        const pnl = o.sig.direction === 'long' ? hit.price - o.sig.entry : o.sig.entry - hit.price;
        completed.push({ pnl_pts: pnl, reason: hit.reason, tp_pts: o.tp });
        open = null;
      }
    }
    if (open) {
      if (open.sig.direction === s.direction) continue;
      const o = open;
      const pnl = o.sig.direction === 'long' ? s.entry - o.sig.entry : o.sig.entry - s.entry;
      completed.push({ pnl_pts: pnl, reason: 'OPP', tp_pts: o.tp });
      open = null;
    }
    const dec = tpFn(s);
    if (dec.skip) { skipped++; continue; }
    const sl = fixedSl(s.rule_id, s.direction);
    open = { sig: s, tp: dec.tp, sl };
  }
  if (prevDate) closeAtRth(rthCloseTsFor(sigs[sigs.length - 1]!.ts));
  return { trades: completed, skipped };
}

interface Stats { n: number; w: number; l: number; wr: number; usd: number; ev: number; }
const statsOf = (trades: Trade[]): Stats => {
  const n = trades.length;
  const w = trades.filter(t => t.pnl_pts > 0).length;
  const l = trades.filter(t => t.pnl_pts < 0).length;
  const usd = trades.reduce((s, t) => s + t.pnl_pts, 0) * DOLLAR_PER_PT;
  const wr = (w + l) ? (w / (w + l)) * 100 : 0;
  return { n, w, l, wr, usd, ev: n ? usd / n : 0 };
};

const variants: { label: string; fn: (s: Sig) => TpDecision }[] = [
  { label: 'FIXED TP=80 (control)',                       fn: () => ({ tp: 80, skip: false }) },
  { label: 'STRUCT 20-200 ALL (today best)',              fn: (s) => { const d = nearestLevelDistPts(s.symbol, fmtEtDate(s.ts), s.entry, s.direction, 20, 200); return d != null ? { tp: d, skip: false } : { tp: 80, skip: false }; } },
  { label: 'STRUCT-SKIP-50 (skip if nearest <50pt)',      fn: (s) => { const dClose = nearestLevelDistPts(s.symbol, fmtEtDate(s.ts), s.entry, s.direction, 20, 50); if (dClose != null) return { tp: 0, skip: true }; const d = nearestLevelDistPts(s.symbol, fmtEtDate(s.ts), s.entry, s.direction, 50, 200); return d != null ? { tp: d, skip: false } : { tp: 80, skip: false }; } },
  { label: 'STRUCT-FALLBACK-50 (if <50pt → use 80)',      fn: (s) => { const d = nearestLevelDistPts(s.symbol, fmtEtDate(s.ts), s.entry, s.direction, 50, 200); return d != null ? { tp: d, skip: false } : { tp: 80, skip: false }; } },
];

const pad = (s: string, n: number, right = false): string => right ? s.padStart(n) : s.padEnd(n);
console.log(`\n══ STRUCT TP w/ 50pt floor — QUALIFIED 148 signals ══\n`);
console.log(`┌──────────────────────────────────────────────────┬─────┬─────┬─────┬────────┬───────────┬──────────┬─────────┐`);
console.log(`│ Variant                                          │  n  │  W  │  L  │   WR   │  Total $  │ EV/trade │ skipped │`);
console.log(`├──────────────────────────────────────────────────┼─────┼─────┼─────┼────────┼───────────┼──────────┼─────────┤`);
for (const v of variants) {
  const { trades, skipped } = simulate(v.fn);
  const s = statsOf(trades);
  const wrStr = `${s.wr.toFixed(1)}%`;
  const usdStr = `${s.usd >= 0 ? '+$' : '-$'}${Math.abs(s.usd).toFixed(0)}`;
  const evStr  = `${s.ev >= 0 ? '+$' : '-$'}${Math.abs(s.ev).toFixed(1)}`;
  console.log(`│ ${pad(v.label, 48)} │ ${pad(String(s.n),3,true)} │ ${pad(String(s.w),3,true)} │ ${pad(String(s.l),3,true)} │ ${pad(wrStr,6,true)} │ ${pad(usdStr,9,true)} │ ${pad(evStr,8,true)} │ ${pad(String(skipped),7,true)} │`);
}
console.log(`└──────────────────────────────────────────────────┴─────┴─────┴─────┴────────┴───────────┴──────────┴─────────┘\n`);
